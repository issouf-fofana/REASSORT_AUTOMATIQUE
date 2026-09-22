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
const prisma = require('../utils/prisma');
const rpos = require('./rposClient');


const TARGET_LINES_PER_CHUNK = 400_000;
const PAGE_SIZE = 250;
const MIN_CHUNK_DAYS = 1;

// Retry automatique par tranche (demande du 21/09/2026 : "le système ne doit pas recommencer toute
// la récupération... il doit identifier précisément l'intervalle concerné et relancer
// automatiquement la récupération uniquement sur la partie qui a échoué") — jusqu'à
// MAX_CHUNK_RETRIES tentatives sur LA MÊME tranche avant de l'abandonner et de continuer avec les
// tranches suivantes, plutôt que d'arrêter tout le run au premier incident réseau/RPOS transitoire.
const MAX_CHUNK_RETRIES = 3;
const RETRY_DELAY_MS = 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

// Corrigé le 22/09/2026 (même bug et même correctif que salesSyncJob.js#toSalesLineRows : deux
// ventes réelles distinctes, même EAN/quantité/montant à la même seconde, produisaient la même
// dedupKey et la seconde était silencieusement perdue par skipDuplicates — écarts constatés en
// prod, ex. "17619 ventes réelles, 17617 synchronisées"). toSalesLineRow (singulier) devient
// toSalesLineRows (pluriel) pour indexer les collisions sur tout un LOT de lignes (une page RPOS
// ici, plutôt que la fenêtre entière comme dans salesSyncJob.js — ce fichier traite déjà page par
// page en streaming) avant de calculer chaque dedupKey ; la 1ère occurrence garde l'ancienne clé
// (compatible avec les lignes déjà en base), les suivantes reçoivent un suffixe `#n` distinct.
function toSalesLineRows(lines, posId, shopId) {
  const collisionCount = new Map();
  return lines.map((line) => {
    const ean = String(line.ean || '').trim();
    const date = new Date(line.date).toISOString();
    const quantity = parseFloat(String(line.quantity || 0).replace(',', '.')) || 0;
    const revenueExclTax = parseFloat(String(line.total_excl_tax || 0).replace(',', '.')) || 0;
    const revenueInclTax = line.total_incl_tax !== undefined && line.total_incl_tax !== null
      ? parseFloat(String(line.total_incl_tax).replace(',', '.')) || 0
      : null;
    const baseKey = buildDedupKey(shopId, ean, date, quantity, revenueExclTax);
    const occurrence = collisionCount.get(baseKey) || 0;
    collisionCount.set(baseKey, occurrence + 1);
    return {
      rposPosId: posId,
      rposShopId: shopId,
      ean,
      label: line.label_1 || null,
      date: new Date(date),
      quantity,
      revenueExclTax,
      revenueInclTax,
      dedupKey: occurrence === 0 ? baseKey : `${baseKey}|#${occurrence}`,
    };
  });
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

/**
 * Traite UNE tentative d'une tranche : pagine RPOS et insère les lignes au fur et à mesure, en
 * persistant la progression après chaque page. Logs détaillés à chaque page (demande du
 * 21/09/2026 : "où l'erreur s'est produite", "combien de données ont été récupérées") — le nom du
 * magasin/tranche/page apparaît systématiquement pour pouvoir suivre précisément le déroulement
 * même sur un run avec des dizaines de tranches en parallèle (plusieurs magasins dans un batch).
 */
async function attemptChunk(posId, shopId, chunk) {
  const label = `${shopId} tranche ${chunk.chunkIndex} (${chunk.periodStart.toISOString().slice(0, 10)} -> ${chunk.periodEnd.toISOString().slice(0, 10)})`;
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
  const t0 = Date.now();
  console.log(`[salesBackfillService] DÉBUT ${label} — reprise à la page ${page} (${fetchedLines} ligne(s) déjà récupérée(s) précédemment)`);

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let pageResult;
      try {
        pageResult = await rpos.fetchProductLinesPage(posId, shopId, dateStart, dateEnd, page, PAGE_SIZE);
      } catch (err) {
        // Où l'erreur s'est produite (demande explicite) : page précise, pas seulement la tranche.
        console.error(`[salesBackfillService] ERREUR ${label} page ${page} — appel RPOS échoué : ${err.message}`);
        throw err;
      }
      expectedLines = pageResult.count;

      // Ne filtre plus les EAN non-numériques (ex: "D10130999999" - articles génériques RPOS) : ces
      // ventes sont réelles et doivent être stockées pour que le CA total du magasin reste exact
      // (écart de 51 lignes/2,5% trouvé le 15/09/2026 en comparant avec RPOS). Le filtre EAN
      // numérique reste appliqué plus loin, au moment du calcul Pareto/réassort (proposalService.js)
      // — un article générique n'est jamais commandable individuellement, mais sa vente compte bien
      // dans le CA magasin.
      const rows = toSalesLineRows(pageResult.results.filter((l) => l.ean), posId, shopId);

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

      // Une ligne de log toutes les 10 pages (pas à chaque page, trop verbeux sur une tranche de
      // 400 000 lignes/1600 pages) pour suivre l'avancement sans noyer les logs — la page 1 et
      // toute page en erreur restent systématiquement loguées, quelle que soit cette fréquence.
      if (page === 1 || page % 10 === 0) {
        console.log(`[salesBackfillService] PROGRESSION ${label} — page ${page}, ${fetchedLines}/${expectedLines} ligne(s) (${Math.round((fetchedLines / Math.max(expectedLines, 1)) * 100)}%)`);
      }

      if (!pageResult.nextPage) break;
      page = pageResult.nextPage;

      // Vérifié entre deux pages (jamais au milieu d'une page en cours) : la page qu'on vient de
      // traiter est déjà persistée ci-dessus, donc s'arrêter ici ne perd rien — une reprise
      // repartira à la page suivante via lastPageCompleted.
      const current = await prisma.salesBackfillRun.findUnique({ where: { id: chunk.runId }, select: { pauseRequested: true } });
      if (current?.pauseRequested) throw new PauseRequestedError();
    }

    // Vérification de complétude explicite (demande du 21/09/2026 : "aucune donnée ne doit être
    // considérée comme correctement récupérée tant que le système n'a pas vérifié que l'intervalle
    // attendu est complet") — expectedLines vient du dernier count() RPOS vu (peut légèrement
    // différer du count() initial si des ventes sont entrées entre-temps), donc un écart n'est pas
    // forcément une vraie perte de données, mais doit être signalé plutôt que silencieusement
    // marqué DONE comme si tout concordait.
    if (fetchedLines < expectedLines) {
      console.warn(`[salesBackfillService] INCOMPLET ${label} — ${fetchedLines}/${expectedLines} ligne(s) récupérée(s) après la dernière page RPOS (pas de page suivante signalée). Écart possible : ventes ajoutées côté RPOS pendant la récupération, ou lignes sans EAN filtrées.`);
    }

    const durationSec = Math.round((Date.now() - t0) / 1000);
    console.log(`[salesBackfillService] FIN ${label} — ${fetchedLines}/${expectedLines} ligne(s) récupérée(s) en ${durationSec}s`);
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

/**
 * Traite une tranche avec retry automatique (demande du 21/09/2026) : jusqu'à MAX_CHUNK_RETRIES
 * tentatives sur CETTE tranche précise avant de l'abandonner. Chaque tentative reprend exactement
 * où la précédente s'est arrêtée (lastPageCompleted persisté par attemptChunk même en cas d'échec
 * en cours de route), jamais depuis le début de la tranche. Une pause utilisateur n'est jamais
 * retentée (propagée telle quelle) — ce n'est pas un échec, retenter n'aurait aucun sens.
 */
async function processChunk(posId, shopId, chunk) {
  const label = `${shopId} tranche ${chunk.chunkIndex}`;
  let lastError;
  for (let attempt = chunk.retryCount + 1; attempt <= MAX_CHUNK_RETRIES; attempt++) {
    try {
      if (attempt > 1) {
        console.log(`[salesBackfillService] TENTATIVE ${attempt}/${MAX_CHUNK_RETRIES} pour ${label} (après échec précédent : ${lastError?.message})`);
      }
      await attemptChunk(posId, shopId, { ...chunk, retryCount: attempt - 1 });
      if (attempt > 1) console.log(`[salesBackfillService] TENTATIVE ${attempt}/${MAX_CHUNK_RETRIES} pour ${label} — RÉUSSIE après ${attempt - 1} échec(s) précédent(s).`);
      return;
    } catch (err) {
      if (err instanceof PauseRequestedError) throw err;
      lastError = err;
      await prisma.salesBackfillChunk.update({ where: { id: chunk.id }, data: { retryCount: attempt } });
      if (attempt < MAX_CHUNK_RETRIES) {
        console.warn(`[salesBackfillService] ÉCHEC tentative ${attempt}/${MAX_CHUNK_RETRIES} pour ${label} : ${err.message} — nouvelle tentative dans ${RETRY_DELAY_MS / 1000}s.`);
        await sleep(RETRY_DELAY_MS);
        // Relit la tranche pour repartir du VRAI dernier état persisté (lastPageCompleted,
        // fetchedLines mis à jour par la tentative qui vient d'échouer), pas l'état capturé au
        // tout début de processChunk (qui serait périmé dès la 2e tentative).
        chunk = await prisma.salesBackfillChunk.findUnique({ where: { id: chunk.id } });
      }
    }
  }
  console.error(`[salesBackfillService] ABANDON ${label} après ${MAX_CHUNK_RETRIES} tentative(s) — dernière erreur : ${lastError.message}`);
  throw lastError;
}

/**
 * Traite toutes les tranches non terminées d'un run, dans l'ordre. Contrairement au comportement
 * précédent (arrêt immédiat du run entier à la première tranche en échec), CONTINUE avec les
 * tranches suivantes même si une tranche épuise ses tentatives (demande du 21/09/2026 : maximiser
 * les données récupérées en une seule exécution) — le run passe en ERROR seulement à LA FIN, si au
 * moins une tranche reste en échec après retry, pour rester compatible avec l'UI existante (déjà
 * capable de proposer une reprise sur un run ERROR).
 */
async function processRun(runId) {
  const run = await prisma.salesBackfillRun.findUnique({
    where: { id: runId },
    include: { chunks: { orderBy: { chunkIndex: 'asc' } } },
  });
  if (!run) throw new Error(`Run ${runId} introuvable`);

  const pendingChunks = run.chunks.filter((c) => c.status !== 'DONE');
  console.log(`[salesBackfillService] DÉBUT run ${runId} (magasin ${run.rposShopId}, période ${run.periodStart.toISOString().slice(0, 10)} -> ${run.periodEnd.toISOString().slice(0, 10)}) : ${pendingChunks.length}/${run.chunks.length} tranche(s) à traiter, ${run.estimatedTotalLines} ligne(s) estimée(s) au total`);

  await prisma.salesBackfillRun.update({ where: { id: runId }, data: { status: 'IN_PROGRESS', pauseRequested: false } });

  // Tranches qui ont épuisé leurs tentatives (demande du 21/09/2026 : "identifier précisément
  // l'intervalle concerné") — accumulées ici pour un résumé final clair, jamais mélangées avec les
  // tranches réussies dans les logs de progression courante.
  const failedChunks = [];

  for (const chunk of pendingChunks) {
    console.log(`[salesBackfillService] Tranche ${chunk.chunkIndex}/${run.totalChunks} (${chunk.periodStart.toISOString().slice(0, 10)} -> ${chunk.periodEnd.toISOString().slice(0, 10)})...`);
    try {
      await processChunk(run.rposPosId, run.rposShopId, chunk);
    } catch (err) {
      if (err instanceof PauseRequestedError) {
        console.log(`[salesBackfillService] PAUSE run ${runId} (progression conservée, reprise possible à l'identique).`);
        await prisma.salesBackfillRun.update({ where: { id: runId }, data: { status: 'PAUSED', pauseRequested: false } });
        return;
      }
      // Ne bloque plus tout le run : continue avec les tranches suivantes (demande explicite du
      // 21/09/2026) — cette tranche reste ERROR en base (visible et reprenable individuellement,
      // cf. getRunStatus), mais le reste de la période est quand même récupéré dans cette exécution
      // plutôt que d'attendre une reprise manuelle pour avancer ne serait-ce que d'une tranche.
      console.error(`[salesBackfillService] ABANDON DÉFINITIF tranche ${chunk.chunkIndex}/${run.totalChunks} du run ${runId} après ${MAX_CHUNK_RETRIES} tentative(s) — passage à la tranche suivante. Erreur : ${err.message}`);
      failedChunks.push(chunk.chunkIndex);
    }
  }

  if (failedChunks.length) {
    console.error(`[salesBackfillService] FIN run ${runId} avec ${failedChunks.length} tranche(s) en échec définitif (index : ${failedChunks.join(', ')}) — reprise possible sur ces tranches précises.`);
    await prisma.salesBackfillRun.update({ where: { id: runId }, data: { status: 'ERROR' } });
    return;
  }

  await prisma.salesBackfillRun.update({ where: { id: runId }, data: { status: 'DONE', completedAt: new Date() } });
  console.log(`[salesBackfillService] FIN run ${runId} — toutes les tranches terminées avec succès.`);

  // Récap automatique de couverture jour par jour (demande du 21/09/2026 : "il doit faire un récap
  // de la journée... si y'a des écarts il doit chercher à récupérer les données restantes") —
  // require() en local (pas en tête de fichier) pour éviter une dépendance circulaire, ce service
  // relançant lui-même startBackfill en cas d'écart détecté. N'interrompt jamais le run déjà marqué
  // DONE ci-dessus si le récap échoue : un problème de récap est un signal à corriger séparément,
  // jamais une raison de remettre en cause un backfill qui vient de réussir.
  try {
    const coverageService = require('./salesDailyCoverageService');
    await coverageService.runDailyRecap(run.rposPosId, run.rposShopId, run.periodStart.toISOString(), run.periodEnd.toISOString(), { startBackfillFn: startBackfill });
  } catch (err) {
    console.error(`[salesBackfillService] Échec du récap de couverture post-run ${runId} : ${err.message}`);
  }
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

// Un run IN_PROGRESS sans la moindre écriture depuis ce délai est considéré mort (le process qui le
// traitait a crashé ou a été redémarré — ex: redéploiement backend en plein milieu — sans jamais
// marquer le run en erreur, cf. bug trouvé le 22/09/2026 : "il fait ca depuis plus de 2h... quand je
// clique il reste grisé"). Chaque page RPOS traitée met à jour le chunk (updatedAt du run suit via
// la relation) : un run vivant ne peut donc jamais rester silencieux aussi longtemps, même sur une
// page RPOS lente (timeout HTTP à 15s, cf. rposClient.RPOS_REQUEST_TIMEOUT_MS). Généreux (2 minutes,
// pas 15s) pour ne jamais marquer à tort un run juste temporairement ralenti par un pic RPOS.
const STALE_RUN_THRESHOLD_MS = 2 * 60 * 1000;

async function getRunStatus(runId) {
  let run = await prisma.salesBackfillRun.findUnique({
    where: { id: runId },
    include: { chunks: { orderBy: { chunkIndex: 'asc' } } },
  });
  if (!run) return null;

  // SalesBackfillRun.updatedAt ne bouge QU'au démarrage/à la fin du run (jamais pendant le
  // traitement des pages) — c'est SalesBackfillChunk.updatedAt qui est rafraîchi à chaque page RPOS
  // traitée (cf. la mise à jour fetchedLines/lastPageCompleted plus haut dans ce fichier). La bonne
  // horloge d'activité est donc la plus récente des deux, jamais le run seul (qui donnerait
  // systématiquement un faux positif "mort" dès que STALE_RUN_THRESHOLD_MS s'écoule après le
  // démarrage, même sur un run parfaitement sain en train d'avancer).
  const lastActivity = run.chunks.reduce(
    (latest, c) => (c.updatedAt > latest ? c.updatedAt : latest),
    run.updatedAt,
  );
  if (run.status === 'IN_PROGRESS' && Date.now() - lastActivity.getTime() > STALE_RUN_THRESHOLD_MS) {
    console.warn(`[salesBackfillService] Run ${runId} détecté mort (aucune activité depuis ${Math.round((Date.now() - lastActivity.getTime()) / 1000)}s) — marqué ERROR pour permettre son annulation/reprise.`);
    run = await prisma.salesBackfillRun.update({
      where: { id: runId },
      data: { status: 'ERROR' },
      include: { chunks: { orderBy: { chunkIndex: 'asc' } } },
    });
  }

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

/**
 * Lance un lot de récupération sur plusieurs magasins (bouton "Tout cocher" côté UI), un magasin
 * après l'autre, piloté entièrement côté serveur — persiste la liste des cibles et l'avancement en
 * base (SalesBackfillBatch) pour que fermer l'onglet ou recharger la page n'arrête jamais les
 * magasins restants (contrairement à l'ancienne file d'attente en JS navigateur qu'elle remplace).
 * targets : [{ posId, shopId, shopLabel }]
 */
async function startBatch(targets, periodStart, periodEnd) {
  if (!targets || !targets.length) throw new Error('Aucun magasin sélectionné');

  const existingActive = await prisma.salesBackfillBatch.findFirst({ where: { status: 'IN_PROGRESS' } });
  if (existingActive) throw new Error('Une récupération groupée est déjà en cours');

  const batch = await prisma.salesBackfillBatch.create({
    data: {
      targetsJson: JSON.stringify(targets),
      periodStart: new Date(periodStart),
      periodEnd: new Date(periodEnd),
    },
  });

  processBatch(batch.id).catch((err) => console.error(`[salesBackfillService] Erreur non gérée pour le batch ${batch.id}:`, err.message));
  return batch.id;
}

/**
 * Traite un batch : reprend à currentIndex (utile après un redémarrage du serveur en plein milieu
 * d'un lot — le run du magasin interrompu est lui-même repris via startOrResumeRun) et avance un
 * magasin à la fois, jamais en parallèle, jusqu'à la fin de la liste ou une annulation demandée.
 */
async function processBatch(batchId) {
  const batch = await prisma.salesBackfillBatch.findUnique({ where: { id: batchId } });
  if (!batch) throw new Error(`Batch ${batchId} introuvable`);
  if (batch.status !== 'IN_PROGRESS') return;

  const targets = JSON.parse(batch.targetsJson);
  const periodStart = batch.periodStart.toISOString();
  const periodEnd = batch.periodEnd.toISOString();

  for (let i = batch.currentIndex; i < targets.length; i++) {
    const fresh = await prisma.salesBackfillBatch.findUnique({ where: { id: batchId } });
    if (!fresh || fresh.cancelRequested) {
      await prisma.salesBackfillBatch.update({ where: { id: batchId }, data: { status: 'CANCELLED', completedAt: new Date() } });
      console.log(`[salesBackfillService] Batch ${batchId} annulé à l'index ${i}.`);
      return;
    }

    const target = targets[i];
    await prisma.salesBackfillBatch.update({ where: { id: batchId }, data: { currentIndex: i } });
    console.log(`[salesBackfillService] Batch ${batchId} : magasin ${i + 1}/${targets.length} (${target.shopLabel || target.shopId})...`);
    try {
      const run = await startOrResumeRun(target.posId, target.shopId, periodStart, periodEnd);
      await prisma.salesBackfillRun.update({ where: { id: run.id }, data: { batchId } });
      await processRun(run.id);
    } catch (err) {
      console.error(`[salesBackfillService] Batch ${batchId} : échec sur ${target.shopId} :`, err.message);
      // Une erreur AVANT même la création du run (ex: comptage du volume initial impossible car le
      // serveur RPOS était injoignable) ne laisse aucune trace en base côté SalesBackfillRun — sans
      // ce champ, seul le log serveur (perdu après coup) indiquait quel magasin/période a échoué,
      // empêchant une relance ciblée depuis l'UI plutôt que de devoir tout relancer.
      const current = await prisma.salesBackfillBatch.findUnique({ where: { id: batchId }, select: { failuresJson: true } });
      const failures = JSON.parse(current?.failuresJson || '[]');
      failures.push({
        posId: target.posId,
        shopId: target.shopId,
        shopLabel: target.shopLabel || target.shopId,
        periodStart,
        periodEnd,
        message: err.message,
        failedAt: new Date().toISOString(),
      });
      await prisma.salesBackfillBatch.update({ where: { id: batchId }, data: { failuresJson: JSON.stringify(failures) } });
    }
  }

  await prisma.salesBackfillBatch.update({
    where: { id: batchId },
    data: { status: 'DONE', currentIndex: targets.length, completedAt: new Date() },
  });
  console.log(`[salesBackfillService] Batch ${batchId} terminé.`);
}

/** Batch actif (IN_PROGRESS) le plus récent, pour que l'UI retrouve sa progression au chargement. */
async function findActiveBatch() {
  return prisma.salesBackfillBatch.findFirst({ where: { status: 'IN_PROGRESS' }, orderBy: { createdAt: 'desc' } });
}

/** Détail d'un batch avec son run en cours (pour afficher la progression du magasin actif). */
async function getBatchStatus(batchId) {
  const batch = await prisma.salesBackfillBatch.findUnique({
    where: { id: batchId },
    include: { runs: { orderBy: { createdAt: 'desc' }, take: 1 } },
  });
  if (!batch) return null;

  const targets = JSON.parse(batch.targetsJson);
  const currentTarget = targets[batch.currentIndex] || null;
  const currentRun = batch.runs[0] || null;

  return {
    batchId: batch.id,
    status: batch.status,
    total: targets.length,
    currentIndex: batch.currentIndex,
    currentTarget,
    currentRunId: currentRun ? currentRun.id : null,
    failures: JSON.parse(batch.failuresJson || '[]'),
  };
}

/**
 * Relance un magasin précis en échec dans un batch (bouton "Relancer" par ligne d'échec côté UI),
 * sur la même période que la tentative initiale — indépendant du batch lui-même (pas besoin qu'il
 * soit encore IN_PROGRESS), en utilisant startBackfill (le chemin single-magasin déjà existant) et
 * en retirant cette entrée de failuresJson dès que la relance démarre avec succès.
 */
async function retryBatchFailure(batchId, shopId) {
  const batch = await prisma.salesBackfillBatch.findUnique({ where: { id: batchId } });
  if (!batch) throw new Error(`Batch ${batchId} introuvable`);

  const failures = JSON.parse(batch.failuresJson || '[]');
  const failure = failures.find((f) => f.shopId === shopId);
  if (!failure) throw new Error('Aucun échec enregistré pour ce magasin dans ce lot');

  const runId = await startBackfill(failure.posId, failure.shopId, failure.periodStart, failure.periodEnd);

  const remaining = failures.filter((f) => f.shopId !== shopId);
  await prisma.salesBackfillBatch.update({ where: { id: batchId }, data: { failuresJson: JSON.stringify(remaining) } });

  return runId;
}

/** Demande l'arrêt propre d'un batch : le magasin en cours va jusqu'au bout de sa tranche courante, puis le lot s'arrête sans lancer les magasins restants. */
async function requestCancelBatch(batchId) {
  const batch = await prisma.salesBackfillBatch.findUnique({ where: { id: batchId } });
  if (!batch) throw new Error(`Batch ${batchId} introuvable`);
  if (batch.status !== 'IN_PROGRESS') throw new Error('Ce lot n\'est pas en cours');
  await prisma.salesBackfillBatch.update({ where: { id: batchId }, data: { cancelRequested: true } });
}

module.exports = {
  startBackfill,
  getRunStatus,
  findResumableRun,
  processRun,
  requestPause,
  cancelRun,
  startBatch,
  processBatch,
  findActiveBatch,
  getBatchStatus,
  requestCancelBatch,
  retryBatchFailure,
};
