/**
 * Précalcule, JOUR PAR JOUR, le CA perdu par (magasin, rayon) — demande explicite du 21/10/2026 :
 * "Analyse par rayon"/"Priorisation par rayon" utilisait un CA perdu PRÉCALCULÉ GLOBALEMENT (champ
 * stockoutEpisode.caPerdueEstime, maintenu par stockoutLossRecalcJob.js), jamais borné à la période
 * réellement choisie par l'utilisateur en haut de page — un filtre "15/10 → 22/10" affichait quand
 * même la perte TOTALE de chaque épisode depuis son tout premier jour. Une ligne par (magasin,
 * rayon, jour calendaire) dans StockoutDailyLossByDepartment permet de sommer INSTANTANÉMENT
 * n'importe quelle plage de dates côté lecture (getDashboardSummaryByField), sans jamais rappeler
 * estimateLoss() à la volée — même principe que stockoutLossRecalcJob.js, juste découpé par jour
 * au lieu d'agrégé sur la durée totale de l'épisode.
 *
 * Un jour déjà clos (entièrement dans le passé) n'est recalculé qu'une seule fois puis jamais
 * retouché (les ventes de ce jour-là ne changent plus) — SAUF le jour courant (encore "ouvert"),
 * recalculé à chaque passage du job tant qu'il n'est pas terminé, pour refléter les ventes au fil
 * de la journée.
 */
const prisma = require('../utils/prisma');
const { estimateLoss } = require('../services/stockoutEpisodeService');
const { mapWithConcurrency } = require('../utils/concurrency');

// Fenêtre de rattrapage : couvre le lookback max exposé côté UI (StockoutShopDetail propose
// jusqu'à "90 j"/dates libres) + une marge — un épisode plus ancien que ça reste lisible via son
// total global (StockoutEpisode.caPerdueEstime), seule l'analyse PAR PÉRIODE perd en précision
// au-delà, acceptable pour une vue historique lointaine.
const BACKFILL_DAYS = 95;
const RECALC_CONCURRENCY = 15;

function dayStartUTC(date) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function addDaysUTC(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

async function runStockoutDailyLossSnapshotJob() {
  console.log('[stockoutDailyLossSnapshotJob] Précalcul démarré...');

  const shops = await prisma.shop.findMany({ select: { rposShopId: true } });
  const today = dayStartUTC(new Date());
  const now = new Date();

  // Jours déjà calculés ET clos (strictement avant aujourd'hui) : jamais retouchés, ventes figées.
  const alreadyComputedClosedDays = new Set(
    (
      await prisma.stockoutDailyLossByDepartment.findMany({
        where: { day: { lt: today } },
        select: { rposShopId: true, day: true },
        distinct: ['rposShopId', 'day'],
      })
    ).map((r) => `${r.rposShopId}:${r.day.toISOString()}`)
  );

  let daysComputed = 0;
  let shopsProcessed = 0;

  for (const shop of shops) {
    const rposShopId = shop.rposShopId;
    const windowStart = addDaysUTC(today, -BACKFILL_DAYS);

    // Jours à traiter pour ce magasin : tout le backfill pour un premier passage (rien en base
    // encore), sinon seulement les jours manquants + le jour courant (toujours recalculé).
    const daysToProcess = [];
    for (let d = windowStart; d.getTime() <= today.getTime(); d = addDaysUTC(d, 1)) {
      const isToday = d.getTime() === today.getTime();
      const key = `${rposShopId}:${d.toISOString()}`;
      if (isToday || !alreadyComputedClosedDays.has(key)) daysToProcess.push(d);
    }
    if (!daysToProcess.length) continue;

    // Épisodes (EN_COURS ou RESOLUE) qui chevauchent la fenêtre de backfill de ce magasin — un
    // seul aller-retour DB par magasin, le découpage jour par jour se fait ensuite en mémoire.
    const episodes = await prisma.stockoutEpisode.findMany({
      where: {
        rposShopId,
        startedAt: { lt: addDaysUTC(today, 1) },
        OR: [{ status: 'EN_COURS' }, { endedAt: { gte: windowStart } }],
      },
      select: { id: true, ean: true, department: true, startedAt: true, endedAt: true, status: true },
    });
    if (!episodes.length) continue;

    // Pour chaque jour à traiter, les épisodes qui le chevauchent réellement.
    const dayEpisodePairs = [];
    for (const day of daysToProcess) {
      const dayEnd = addDaysUTC(day, 1);
      for (const e of episodes) {
        const episodeEnd = e.status === 'EN_COURS' ? now : e.endedAt;
        if (!episodeEnd) continue;
        if (e.startedAt >= dayEnd || episodeEnd <= day) continue; // pas de chevauchement avec ce jour
        dayEpisodePairs.push({ day, episode: e, overlapStart: e.startedAt > day ? e.startedAt : day, overlapEnd: episodeEnd < dayEnd ? episodeEnd : dayEnd });
      }
    }
    if (!dayEpisodePairs.length) {
      // Aucune rupture ce jour-là pour ce magasin : écrit quand même des lignes à 0 pour les jours
      // sans rayon concerné, pour que daysToProcess ne soit jamais reconsidéré au prochain passage
      // (sinon un jour "calme" resterait recalculé indéfiniment, cf. alreadyComputedClosedDays).
      await Promise.all(
        daysToProcess
          .filter((d) => d.getTime() !== today.getTime())
          .map((day) =>
            prisma.stockoutDailyLossByDepartment.upsert({
              // '' = "Sans rayon" (PAS null) — Prisma rejette un null dans le where d'une clé
              // composite @@unique (cf. commentaire sur le modèle, schema.prisma).
              where: { rposShopId_department_day: { rposShopId, department: '', day } },
              create: { rposShopId, department: '', day, caPerdue: 0, qtyPerdue: 0, episodeCount: 0 },
              update: { caPerdue: 0, qtyPerdue: 0, episodeCount: 0 },
            })
          )
      );
      continue;
    }

    const losses = await mapWithConcurrency(dayEpisodePairs, RECALC_CONCURRENCY, async (pair) => {
      if (pair.overlapEnd <= pair.overlapStart) return { ...pair, caPerdue: 0, qtyPerdue: 0 };
      const { qtyPerdue, caPerdue } = await estimateLoss(rposShopId, pair.episode.ean, pair.overlapStart, pair.overlapEnd);
      return { ...pair, caPerdue: caPerdue || 0, qtyPerdue: qtyPerdue || 0 };
    });

    // Agrégation par (jour, rayon) en mémoire avant écriture — évite un upsert par épisode.
    // '' = "Sans rayon" (jamais null, cf. commentaire sur le modèle).
    const byDayDept = new Map(); // `${dayISO}:${department}` -> { day, department, caPerdue, qtyPerdue, episodeCount }
    for (const l of losses) {
      const dept = l.episode.department || '';
      const key = `${l.day.toISOString()}:${dept}`;
      if (!byDayDept.has(key)) byDayDept.set(key, { day: l.day, department: dept, caPerdue: 0, qtyPerdue: 0, episodeCount: 0 });
      const bucket = byDayDept.get(key);
      bucket.caPerdue += l.caPerdue;
      bucket.qtyPerdue += l.qtyPerdue;
      bucket.episodeCount += 1;
    }

    await mapWithConcurrency([...byDayDept.values()], RECALC_CONCURRENCY, async (bucket) => {
      await prisma.stockoutDailyLossByDepartment.upsert({
        where: { rposShopId_department_day: { rposShopId, department: bucket.department, day: bucket.day } },
        create: { rposShopId, department: bucket.department, day: bucket.day, caPerdue: bucket.caPerdue, qtyPerdue: bucket.qtyPerdue, episodeCount: bucket.episodeCount },
        update: { caPerdue: bucket.caPerdue, qtyPerdue: bucket.qtyPerdue, episodeCount: bucket.episodeCount },
      });
    });

    daysComputed += daysToProcess.length;
    shopsProcessed += 1;
  }

  console.log(`[stockoutDailyLossSnapshotJob] Précalcul terminé : ${shopsProcessed} magasin(s) traité(s), ${daysComputed} jour(s)-magasin recalculé(s).`);
}

module.exports = { runStockoutDailyLossSnapshotJob, BACKFILL_DAYS };
