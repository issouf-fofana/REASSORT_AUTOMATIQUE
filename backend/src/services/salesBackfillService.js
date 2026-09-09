/**
 * Récupération historique volumineuse des ventes RPOS, avec découpage en tranches, persistance de
 * la progression et reprise automatique après interruption (crash, redéploiement, coupure réseau).
 *
 * Différent de salesSyncJob.js (synchronisation incrémentale courante, quelques heures/jours à la
 * fois, une seule marque d'avancement par magasin) : ce service sert au premier chargement massif
 * de l'historique d'un magasin (plusieurs mois, potentiellement des millions de lignes), qui doit
 * pouvoir être interrompu et repris sans perdre le travail déjà fait ni dupliquer des données.
 *
 * Principe :
 * 1. Compter le volume total sur la période demandée (un appel RPOS léger, page_size=1).
 * 2. Découper le temps en tranches dont la durée vise TARGET_LINES_PER_CHUNK lignes chacune,
 *    en extrapolant depuis le volume/jour moyen mesuré à l'étape 1.
 * 3. Persister un SalesBackfillRun + ses SalesBackfillChunk (statut PENDING) avant de commencer.
 * 4. Traiter les tranches dans l'ordre, en ignorant celles déjà DONE : pour chaque tranche,
 *    paginer RPOS et insérer les lignes AU FUR ET À MESURE (page par page), en mettant à jour
 *    lastPageCompleted et fetchedLines après chaque page — si interrompu à la page 15/35, la
 *    reprise redemande la page 16, pas la tranche entière.
 * 5. Déduplication : chaque ligne a une dedupKey unique (shopId+ean+date+quantity+revenue) et
 *    l'insertion utilise skipDuplicates, donc relancer un run déjà partiellement fait ne crée
 *    jamais de doublons, même si une tranche est retraitée depuis le début.
 */
const { PrismaClient } = require('@prisma/client');
const rpos = require('./rposClient');

const prisma = new PrismaClient();

const TARGET_LINES_PER_CHUNK = 400_000;
const PAGE_SIZE = 250;
const MIN_CHUNK_DAYS = 1;

/** Signale une pause demandée par l'utilisateur, distincte d'une vraie erreur : le run est
 * reprenable normalement, pas dans un état "ERROR" qui suggérerait un problème à corriger. */
class PauseRequestedError extends Error {
  constructor() {
    super('Pause demandée par l\'utilisateur');
    this.name = 'PauseRequestedError';
  }
}

function buildDedupKey(shopId, ean, date, quantity, revenue) {
  return `${shopId}|${ean}|${date}|${quantity}|${revenue}`;
}

function toSalesLineRow(line, posId, shopId) {
  const ean = String(line.ean || '').trim();
  const date = new Date(line.date).toISOString();
  const quantity = parseFloat(String(line.quantity || 0).replace(',', '.')) || 0;
  const revenueExclTax = parseFloat(String(line.total_excl_tax || 0).replace(',', '.')) || 0;
  const revenueInclTax = line.total_incl_tax !== undefined && line.total_incl_tax !== null
    ? parseFloat(String(line.total_incl_tax).replace(',', '.')) || 0
    : null;
  return {
    rposPosId: posId,
    rposShopId: shopId,
    ean,
    label: line.label_1 || null,
    date: new Date(date),
    quantity,
    revenueExclTax,
    revenueInclTax,
    // dedupKey inchangée (basée sur le HT uniquement, cf. salesSyncJob.js) : ne pas y inclure le
    // TTC pour ne pas casser la déduplication des lignes déjà synchronisées avant cet ajout.
    dedupKey: buildDedupKey(shopId, ean, date, quantity, revenueExclTax),
  };
}

/** Compte le volume de lignes RPOS sur une période, sans en télécharger le contenu (page_size=1). */
async function countLinesInPeriod(posId, shopId, dateStart, dateEnd) {
  const page = await rpos.fetchProductLinesPage(posId, shopId, dateStart, dateEnd, 1, 1);
  return page.count;
}

/**
 * Découpe [periodStart, periodEnd] en tranches temporelles visant TARGET_LINES_PER_CHUNK lignes
 * chacune, à partir du volume total mesuré sur la période complète. Approximatif par nature (le
 * volume réel peut varier d'un jour à l'autre) mais suffisant pour rester loin de la limite RPOS
 * par appel dans l'immense majorité des cas.
 */
function planChunks(periodStart, periodEnd, totalLines) {
  const totalDays = Math.max(1, (periodEnd.getTime() - periodStart.getTime()) / (24 * 60 * 60 * 1000));
  const linesPerDay = totalLines / totalDays;
  const chunkDays = linesPerDay > 0
    ? Math.max(MIN_CHUNK_DAYS, Math.floor(TARGET_LINES_PER_CHUNK / linesPerDay))
    : totalDays; // pas de ventes détectées : une seule tranche couvrant toute la période

  const chunks = [];
  let cursor = periodEnd;
  while (cursor > periodStart) {
    const chunkStart = new Date(Math.max(periodStart.getTime(), cursor.getTime() - chunkDays * 24 * 60 * 60 * 1000));
    chunks.unshift({ periodStart: chunkStart, periodEnd: cursor });
    cursor = chunkStart;
  }
  return chunks;
}

/**
 * Démarre un nouveau run de backfill, ou reprend le run IN_PROGRESS existant pour ce magasin sur
 * exactement la même période (évite de recompter/redécouper si un run est déjà en cours ou a été
 * interrompu). Retourne le run (avec ses chunks) prêt à être traité par processRun.
 */
async function startOrResumeRun(posId, shopId, periodStart, periodEnd) {
  const existing = await prisma.salesBackfillRun.findFirst({
    where: {
      rposShopId: shopId,
      status: { in: ['IN_PROGRESS', 'PAUSED'] },
      periodStart: new Date(periodStart),
      periodEnd: new Date(periodEnd),
    },
    include: { chunks: { orderBy: { chunkIndex: 'asc' } } },
  });
  if (existing) {
    console.log(`[salesBackfillService] Reprise du run existant ${existing.id} pour ${shopId} (${existing.chunks.filter((c) => c.status === 'DONE').length}/${existing.chunks.length} tranche(s) déjà terminée(s))`);
    if (existing.status === 'PAUSED') {
      await prisma.salesBackfillRun.update({ where: { id: existing.id }, data: { status: 'IN_PROGRESS', pauseRequested: false } });
    }
    return existing;
  }

  const start = new Date(periodStart);
  const end = new Date(periodEnd);
  console.log(`[salesBackfillService] Comptage du volume total pour ${shopId} sur ${start.toISOString()} -> ${end.toISOString()}...`);
  const totalLines = await countLinesInPeriod(posId, shopId, start.toISOString().slice(0, 19), end.toISOString().slice(0, 19));
  const chunkPlans = planChunks(start, end, totalLines);

  console.log(`[salesBackfillService] ${totalLines} ligne(s) estimée(s) -> ${chunkPlans.length} tranche(s) planifiée(s)`);

  const run = await prisma.salesBackfillRun.create({
    data: {
      rposPosId: posId,
      rposShopId: shopId,
      periodStart: start,
      periodEnd: end,
      estimatedTotalLines: totalLines,
      totalChunks: chunkPlans.length,
      chunks: {
        create: chunkPlans.map((c, i) => ({
          chunkIndex: i + 1,
          periodStart: c.periodStart,
          periodEnd: c.periodEnd,
        })),
      },
    },
    include: { chunks: { orderBy: { chunkIndex: 'asc' } } },
  });

  return run;
}

/** Traite une tranche : pagine RPOS et insère les lignes au fur et à mesure, en persistant la progression après chaque page. */
async function processChunk(posId, shopId, chunk) {
  await prisma.salesBackfillChunk.update({
    where: { id: chunk.id },
    data: { status: 'IN_PROGRESS', startedAt: chunk.startedAt || new Date(), errorMessage: null },
  });

  const dateStart = chunk.periodStart.toISOString().slice(0, 19);
  const dateEnd = chunk.periodEnd.toISOString().slice(0, 19);

  // Reprise intra-tranche : si une page a déjà été complétée pour cette tranche (interruption
  // précédente), on reprend à la page suivante plutôt que de retélécharger depuis le début. Les
  // lignes déjà insérées ne seront de toute façon pas dupliquées grâce à dedupKey+skipDuplicates,
  // mais repartir de la bonne page évite du travail redondant et des appels RPOS inutiles.
  let page = (chunk.lastPageCompleted || 0) + 1;
  let fetchedLines = chunk.fetchedLines || 0;
  let expectedLines = chunk.expectedLines || 0;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const pageResult = await rpos.fetchProductLinesPage(posId, shopId, dateStart, dateEnd, page, PAGE_SIZE);
      expectedLines = pageResult.count;

      const rows = pageResult.results
        .filter((l) => l.ean && /^\d+$/.test(String(l.ean).trim()))
        .map((l) => toSalesLineRow(l, posId, shopId));

      if (rows.length > 0) {
        // fetchedLines compte les lignes RPOS effectivement VUES (traitées), pas seulement celles
        // insérées : sinon une reprise sur une tranche déjà (ré)couverte par ailleurs (ex: chevauchement
        // avec la synchro incrémentale) verrait skipDuplicates ignorer la quasi-totalité des lignes
        // et le compteur resterait figé près de sa valeur d'avant l'interruption, alors que la
        // tranche est en réalité bien complète. La déduplication reste garantie côté stockage
        // (contrainte unique dedupKey + skipDuplicates), seul l'affichage de progression change ici.
        await prisma.salesLine.createMany({ data: rows, skipDuplicates: true });
        fetchedLines += rows.length;
      }

      await prisma.salesBackfillChunk.update({
        where: { id: chunk.id },
        data: { expectedLines, fetchedLines, lastPageCompleted: page },
      });

      if (!pageResult.nextPage) break;
      page = pageResult.nextPage;

      // Vérifié entre deux pages (jamais au milieu d'une page en cours) : la page qu'on vient de
      // traiter est déjà persistée ci-dessus, donc s'arrêter ici ne perd rien — une reprise
      // repartira à la page suivante via lastPageCompleted.
      const current = await prisma.salesBackfillRun.findUnique({ where: { id: chunk.runId }, select: { pauseRequested: true } });
      if (current?.pauseRequested) throw new PauseRequestedError();
    }

    await prisma.salesBackfillChunk.update({
      where: { id: chunk.id },
      data: { status: 'DONE', completedAt: new Date() },
    });
  } catch (err) {
    if (err instanceof PauseRequestedError) {
      // La tranche reste IN_PROGRESS (pas ERROR) : sa progression (lastPageCompleted, fetchedLines)
      // est déjà à jour, une reprise continuera normalement à la page suivante.
      throw err;
    }
    await prisma.salesBackfillChunk.update({
      where: { id: chunk.id },
      data: { status: 'ERROR', errorMessage: err.message },
    });
    throw err;
  }
}

/** Traite toutes les tranches non terminées d'un run, dans l'ordre, en s'arrêtant à la première erreur (le run reste reprenable). */
async function processRun(runId) {
  const run = await prisma.salesBackfillRun.findUnique({
    where: { id: runId },
    include: { chunks: { orderBy: { chunkIndex: 'asc' } } },
  });
  if (!run) throw new Error(`Run ${runId} introuvable`);

  const pendingChunks = run.chunks.filter((c) => c.status !== 'DONE');
  console.log(`[salesBackfillService] Run ${runId} : ${pendingChunks.length}/${run.chunks.length} tranche(s) à traiter`);

  await prisma.salesBackfillRun.update({ where: { id: runId }, data: { status: 'IN_PROGRESS', pauseRequested: false } });

  for (const chunk of pendingChunks) {
    console.log(`[salesBackfillService] Tranche ${chunk.chunkIndex}/${run.totalChunks} (${chunk.periodStart.toISOString()} -> ${chunk.periodEnd.toISOString()})...`);
    try {
      await processChunk(run.rposPosId, run.rposShopId, chunk);
    } catch (err) {
      if (err instanceof PauseRequestedError) {
        console.log(`[salesBackfillService] Run ${runId} mis en pause (progression conservée).`);
        await prisma.salesBackfillRun.update({ where: { id: runId }, data: { status: 'PAUSED', pauseRequested: false } });
        return;
      }
      console.error(`[salesBackfillService] Échec tranche ${chunk.chunkIndex} du run ${runId}:`, err.message);
      await prisma.salesBackfillRun.update({ where: { id: runId }, data: { status: 'ERROR' } });
      return;
    }
  }

  await prisma.salesBackfillRun.update({ where: { id: runId }, data: { status: 'DONE', completedAt: new Date() } });
  console.log(`[salesBackfillService] Run ${runId} terminé.`);
}

/**
 * Point d'entrée principal : démarre ou reprend un backfill pour un magasin/période, et lance le
 * traitement en tâche de fond (ne bloque pas l'appelant — utile pour une route API qui doit
 * répondre immédiatement avec le runId pendant que le travail continue).
 */
async function startBackfill(posId, shopId, periodStart, periodEnd) {
  const run = await startOrResumeRun(posId, shopId, periodStart, periodEnd);
  processRun(run.id).catch((err) => console.error(`[salesBackfillService] Erreur non gérée pour le run ${run.id}:`, err.message));
  return run.id;
}

async function getRunStatus(runId) {
  const run = await prisma.salesBackfillRun.findUnique({
    where: { id: runId },
    include: { chunks: { orderBy: { chunkIndex: 'asc' } } },
  });
  if (!run) return null;

  const totalFetched = run.chunks.reduce((sum, c) => sum + c.fetchedLines, 0);
  const totalExpected = run.chunks.reduce((sum, c) => sum + (c.expectedLines || 0), 0) || run.estimatedTotalLines;
  const doneChunks = run.chunks.filter((c) => c.status === 'DONE').length;

  return {
    runId: run.id,
    status: run.status,
    periodStart: run.periodStart,
    periodEnd: run.periodEnd,
    estimatedTotalLines: run.estimatedTotalLines,
    totalChunks: run.totalChunks,
    doneChunks,
    totalFetchedLines: totalFetched,
    totalExpectedLines: totalExpected,
    progressPct: totalExpected > 0 ? Math.round((totalFetched / totalExpected) * 10000) / 100 : 0,
    chunks: run.chunks.map((c) => ({
      chunkIndex: c.chunkIndex,
      periodStart: c.periodStart,
      periodEnd: c.periodEnd,
      expectedLines: c.expectedLines,
      fetchedLines: c.fetchedLines,
      status: c.status,
      errorMessage: c.errorMessage,
    })),
  };
}

/** Trouve un run actif (IN_PROGRESS), en pause ou en erreur (tous reprenables) pour un magasin, pour proposer une reprise dès l'ouverture de l'UI. */
async function findResumableRun(shopId) {
  return prisma.salesBackfillRun.findFirst({
    where: { rposShopId: shopId, status: { in: ['IN_PROGRESS', 'PAUSED', 'ERROR'] } },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Demande l'arrêt propre d'un run en cours : pose pauseRequested, lu par la boucle de pagination
 * entre deux pages RPOS (jamais au milieu d'une page). Ne bloque pas — le run passera à PAUSED
 * dès que le traitement en cours atteint son prochain point de contrôle, généralement en quelques
 * secondes (le temps d'une page RPOS).
 */
async function requestPause(runId) {
  const run = await prisma.salesBackfillRun.findUnique({ where: { id: runId } });
  if (!run) throw new Error(`Run ${runId} introuvable`);
  if (run.status !== 'IN_PROGRESS') throw new Error(`Ce run n'est pas en cours (statut actuel : ${run.status})`);
  await prisma.salesBackfillRun.update({ where: { id: runId }, data: { pauseRequested: true } });
}

/**
 * Annule définitivement un run bloqué (PAUSED ou ERROR, ex: coupure réseau pendant la
 * récupération) : contrairement à requestPause (arrêt propre d'un run encore actif), cancelRun
 * s'applique à un run déjà arrêté que l'utilisateur ne veut plus reprendre. Marque CANCELLED, un
 * statut distinct de PAUSED/ERROR, pour que findResumableRun ne le propose plus jamais en reprise —
 * la progression déjà récupérée (lignes déjà en base) n'est pas supprimée, seul le run est clos.
 * Refuse d'annuler un run IN_PROGRESS : il faut d'abord le mettre en pause (requestPause) pour
 * éviter d'annuler pendant qu'une page RPOS est en cours de traitement.
 */
async function cancelRun(runId) {
  const run = await prisma.salesBackfillRun.findUnique({ where: { id: runId } });
  if (!run) throw new Error(`Run ${runId} introuvable`);
  if (run.status === 'IN_PROGRESS') {
    throw new Error('Ce run est en cours — mettez-le en pause avant de l\'annuler.');
  }
  if (run.status === 'CANCELLED' || run.status === 'DONE') {
    throw new Error(`Ce run est déjà ${run.status === 'DONE' ? 'terminé' : 'annulé'}.`);
  }
  await prisma.salesBackfillRun.update({ where: { id: runId }, data: { status: 'CANCELLED', completedAt: new Date() } });
}

module.exports = { startBackfill, getRunStatus, findResumableRun, processRun, requestPause, cancelRun };
