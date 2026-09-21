/**
 * Récap journalier de couverture des ventes (demande du 21/09/2026, backend/amelioration.md) :
 * compare, jour par jour, le nombre de lignes RPOS attendues au nombre réellement en base
 * (SalesLine), pour détecter précisément une journée incomplète — "les ventes du 10/09/2026 sont
 * récupérées seulement à 50%" — sans devoir rouvrir un backfill entier pour le découvrir.
 *
 * Appelé automatiquement en fin de backfill/synchro (jamais manuellement) : dès qu'un écart est
 * détecté sur un jour, une récupération ciblée est relancée UNIQUEMENT sur ce jour précis, jamais
 * sur toute la période — cohérent avec le principe déjà appliqué au niveau des tranches
 * (salesBackfillService.js), mais à la granularité du jour plutôt que de la tranche (qui peut
 * couvrir plusieurs jours d'un coup et masquer un écart localisé à une seule journée).
 */
const prisma = require('../utils/prisma');
const rpos = require('./rposClient');

const STATUS = { COMPLETE: 'COMPLETE', PARTIAL: 'PARTIAL', MISSING: 'MISSING', NO_SALES: 'NO_SALES' };

function toDayKey(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** Compte les lignes RPOS attendues pour UN jour précis (appel léger, page_size=1). */
async function countExpectedForDay(posId, shopId, day) {
  const dateStart = day.toISOString().slice(0, 19);
  const dateEnd = new Date(day.getTime() + 24 * 60 * 60 * 1000 - 1000).toISOString().slice(0, 19);
  const page = await rpos.fetchProductLinesPage(posId, shopId, dateStart, dateEnd, 1, 1);
  return page.count;
}

/** Compte les lignes réellement en base pour UN jour précis. */
async function countActualForDay(shopId, day) {
  const dateEnd = new Date(day.getTime() + 24 * 60 * 60 * 1000);
  return prisma.salesLine.count({ where: { rposShopId: shopId, date: { gte: day, lt: dateEnd } } });
}

function computeStatus(expected, actual) {
  if (expected === 0) return STATUS.NO_SALES;
  if (actual === 0) return STATUS.MISSING;
  if (actual < expected) return STATUS.PARTIAL;
  return STATUS.COMPLETE;
}

/**
 * Vérifie et enregistre la couverture d'UN jour précis pour un magasin — un appel RPOS (comptage
 * léger) + un comptage local, jamais de téléchargement de contenu ici (seulement des count()).
 * Idempotent : ré-appeler sur un jour déjà COMPLETE ne fait que confirmer/rafraîchir checkedAt.
 */
async function checkDay(posId, shopId, day) {
  const normalizedDay = toDayKey(day);
  const [expected, actual] = await Promise.all([
    countExpectedForDay(posId, shopId, normalizedDay),
    countActualForDay(shopId, normalizedDay),
  ]);
  const status = computeStatus(expected, actual);

  await prisma.salesDailyCoverage.upsert({
    where: { rposShopId_day: { rposShopId: shopId, day: normalizedDay } },
    create: { rposPosId: posId, rposShopId: shopId, day: normalizedDay, expectedLines: expected, actualLines: actual, status },
    update: { expectedLines: expected, actualLines: actual, status, checkedAt: new Date() },
  });

  return { day: normalizedDay, expected, actual, status };
}

/**
 * Vérifie tous les jours d'une période [periodStart, periodEnd] pour un magasin, et relance
 * AUTOMATIQUEMENT une récupération ciblée (via salesBackfillService, injecté en paramètre pour
 * éviter une dépendance circulaire — les deux modules s'appellent mutuellement) sur chaque jour
 * PARTIAL ou MISSING trouvé. Conçu pour être appelé en fin de backfill/synchro (demande explicite :
 * "il doit faire un recap de la journée... si y'a des écarts il doit chercher à récupérer les
 * données restantes").
 */
async function runDailyRecap(posId, shopId, periodStart, periodEnd, { startBackfillFn } = {}) {
  const days = [];
  for (let cursor = toDayKey(new Date(periodStart)); cursor < new Date(periodEnd); cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000)) {
    days.push(new Date(cursor));
  }

  console.log(`[salesDailyCoverageService] RÉCAP ${shopId} — vérification de ${days.length} jour(s) (${periodStart} -> ${periodEnd})`);

  const results = [];
  for (const day of days) {
    try {
      const result = await checkDay(posId, shopId, day);
      results.push(result);
      const dayLabel = day.toISOString().slice(0, 10);
      if (result.status === STATUS.PARTIAL || result.status === STATUS.MISSING) {
        console.warn(`[salesDailyCoverageService] ÉCART ${shopId} ${dayLabel} — ${result.actual}/${result.expected} ligne(s) (${result.status}). Relance ciblée sur cette journée précise.`);
      } else {
        console.log(`[salesDailyCoverageService] OK ${shopId} ${dayLabel} — ${result.actual}/${result.expected} ligne(s) (${result.status})`);
      }
    } catch (err) {
      console.error(`[salesDailyCoverageService] ERREUR vérification ${shopId} ${day.toISOString().slice(0, 10)} : ${err.message}`);
    }
  }

  const gaps = results.filter((r) => r.status === STATUS.PARTIAL || r.status === STATUS.MISSING);
  if (!gaps.length) {
    console.log(`[salesDailyCoverageService] FIN RÉCAP ${shopId} — aucun écart, période complète.`);
    return { checkedDays: results.length, gapsFound: 0, gapsRecovered: 0 };
  }

  console.warn(`[salesDailyCoverageService] ${gaps.length} jour(s) en écart pour ${shopId} : ${gaps.map((g) => g.day.toISOString().slice(0, 10)).join(', ')}`);

  if (!startBackfillFn) {
    console.warn(`[salesDailyCoverageService] Aucune fonction de récupération fournie — écarts enregistrés mais pas relancés automatiquement.`);
    return { checkedDays: results.length, gapsFound: gaps.length, gapsRecovered: 0 };
  }

  // Regroupe les jours en écart consécutifs en un seul run de backfill par plage contiguë, plutôt
  // qu'un run séparé par jour isolé (inutilement plus d'appels RPOS de comptage initial pour un
  // gain de précision nul — un backfill sur 3 jours consécutifs en écart reste tout aussi ciblé
  // qu'un backfill par jour, juste plus efficace à démarrer).
  const ranges = [];
  for (const gap of gaps) {
    const last = ranges[ranges.length - 1];
    if (last && gap.day.getTime() === last.end.getTime() + 24 * 60 * 60 * 1000) {
      last.end = gap.day;
    } else {
      ranges.push({ start: gap.day, end: gap.day });
    }
  }

  let gapsRecovered = 0;
  for (const range of ranges) {
    const rangeEnd = new Date(range.end.getTime() + 24 * 60 * 60 * 1000); // exclusif, comme periodEnd partout ailleurs
    console.log(`[salesDailyCoverageService] Relance ciblée ${shopId} sur ${range.start.toISOString().slice(0, 10)} -> ${range.end.toISOString().slice(0, 10)}`);
    try {
      await startBackfillFn(posId, shopId, range.start.toISOString(), rangeEnd.toISOString());
      gapsRecovered += 1;
    } catch (err) {
      console.error(`[salesDailyCoverageService] Échec de la relance ciblée sur ${range.start.toISOString().slice(0, 10)} -> ${range.end.toISOString().slice(0, 10)} : ${err.message}`);
    }
  }

  return { checkedDays: results.length, gapsFound: gaps.length, gapsRecovered };
}

/** Liste les jours en écart (PARTIAL/MISSING) pour un magasin, pour affichage côté UI. */
async function listGaps(shopId, { limit = 100 } = {}) {
  return prisma.salesDailyCoverage.findMany({
    where: { rposShopId: shopId, status: { in: [STATUS.PARTIAL, STATUS.MISSING] } },
    orderBy: { day: 'desc' },
    take: limit,
  });
}

module.exports = { STATUS, checkDay, runDailyRecap, listGaps };
