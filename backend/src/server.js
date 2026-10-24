require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const prisma = require('./utils/prisma');
const logger = require('./utils/logger');
const { startOrRestartNightlyJob, startOrRestartReceptionSyncJob, startOrRestartSalesSyncJob, startOrRestartSalesDailyRecapJob, startOrRestartProductEolSyncJob, startOrRestartStockMoveSyncJob, startOrRestartStockSnapshotJob, startOrRestartStockoutLossRecalcJob, startOrRestartStockoutDailyLossSnapshotJob, startOrRestartSupplierOrdersSyncJob, startOrRestartStockoutSectorBackfillJob, startOrRestartStockoutCatchUpResolveJob, startOrRestartStockoutProductCacheRefreshJob, startOrRestartOverstockProductCacheRefreshJob, startOrRestartStockoutStatusRecalcJob, startOrRestartStockoutAlertJob, startOrRestartStockoutPeriodSummarySnapshotJob, startOrRestartOverstockReportSnapshotJob, startOrRestartOrderIdentitySyncJob, startOrRestartShopsSyncJob, startOrRestartDailyReviewJob, startOrRestartPredictionOutcomeJob, startOrRestartImprovementWatchdogJob, startOrRestartProposalReminderJob, startOrRestartEndOfDayValidationRecapJob, startOrRestartTokenUsageWatchdogJob } = require('./jobs/cronManager');
const { seedServersFromJson } = require('./services/rposServersService');
const salesBackfillService = require('./services/salesBackfillService');

// Import routes
const reassortRoutes = require('./routes/reassort');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const fallbackRoutes = require('./routes/fallback');
const oauthOutlookRoutes = require('./routes/oauthOutlook');
const publicAssetsRoutes = require('./routes/publicAssets');

// Initialize Express
const app = express();

// =============================================
// MIDDLEWARE
// =============================================
app.use(helmet());
// Compression gzip des réponses (demande explicite du 19/10/2026 : "pourquoi ca prend temps pour
// etre affiché souvent ?" — diagnostiqué via l'onglet Network : la route /proposal/pending
// transférait jusqu'à 5.5 Mo de JSON non compressé pour une proposition de 619 articles, ~30
// champs chacun avec des textes de raisonnement IA assez longs. Aucune compression n'était activée
// sur le serveur Express — gzip réduit typiquement ce type de JSON répétitif à 10-20% de sa taille
// d'origine, sans aucun changement côté frontend (le navigateur décompresse automatiquement via
// l'en-tête Accept-Encoding déjà envoyé par défaut).
app.use(compression());
// localhost et 127.0.0.1 sont deux origines distinctes pour le navigateur (CORS les compare
// strictement) même si elles pointent sur la même machine : on autorise les deux variantes du
// port configuré pour ne pas dépendre de la façon dont l'utilisateur tape l'URL dans son navigateur.
const corsOriginConfig = process.env.CORS_ORIGIN || 'http://localhost:8080';
const corsOrigins = new Set();
corsOriginConfig.split(',').forEach((raw) => {
  const origin = raw.trim();
  corsOrigins.add(origin);
  corsOrigins.add(origin.replace('://localhost', '://127.0.0.1'));
  corsOrigins.add(origin.replace('://127.0.0.1', '://localhost'));
});

// Derrière un reverse proxy (Dokploy, nginx) l'IP client réelle arrive via X-Forwarded-For :
// trust proxy la rend visible dans req.ip (journal d'audit ErrorReport, traçabilité Qui/Où).
// En accès direct Docker (ports publiés), le NAT masque l'IP du poste (passerelle 172.x vue
// côté backend) — limite connue, documentée dans le README (section debug global).
app.set('trust proxy', 1);
app.use(cors({
  origin: [...corsOrigins],
  credentials: true
}));
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Debug global (Conseiller d'amélioration IA) : journalise TOUTES les réponses API 5xx avec
// leur contexte (URL, message exact, utilisateur) dans ErrorReport — quel que soit le chemin
// de code (routes en try/catch direct ou error handler central), car on observe la réponse
// finale plutôt qu'un point d'appel. Fire-and-forget : n'allonge ni ne casse jamais la requête.
app.use((req, res, next) => {
  const origJson = res.json.bind(res);
  res.json = (body) => { res.locals.responseBody = body; return origJson(body); };
  res.on('finish', () => {
    if (res.statusCode < 500 || !req.originalUrl.startsWith('/api/')) return;
    const body = res.locals.responseBody;
    const message = (body && body.message) || (res.locals.errorStack || '').split('\n')[0] || `HTTP ${res.statusCode}`;
    // Écrit AUSSI dans stderr (demande du 21/09/2026 : "il faut loger les erreurs dans les logs de
    // mon dokploy aussi il est vide or j'ai des erreurs") — jusqu'ici, une route qui gérait son
    // propre catch et répondait res.status(500).json(...) directement (la majorité des routes de ce
    // projet) ne passait jamais par le error handler central d'Express (celui-là logue déjà
    // correctement via logger.error, cf. plus bas dans ce fichier), donc n'apparaissait JAMAIS dans
    // les logs du conteneur — seulement dans la réponse HTTP renvoyée au navigateur. Dokploy (et
    // `docker logs`) ne lit que stdout/stderr, jamais la table ErrorReport ci-dessous : sans cette
    // ligne, une vraie erreur 500 pouvait rester invisible côté logs alors qu'elle cassait déjà
    // l'écran d'un utilisateur (ex: REVISION_CHANGE_THRESHOLD, type Float au lieu de String).
    console.error(`[5xx] ${req.method} ${req.originalUrl} -> ${res.statusCode} : ${message}`);
    try {
      require('./services/errorReportService').reportError({
        source: 'backend',
        url: `${req.method} ${req.originalUrl}`.slice(0, 500),
        method: req.method,
        statusCode: res.statusCode,
        message,
        stack: res.locals.errorStack || null,
        userEmail: (req.user && req.user.email) || null,
        shopRef: (req.user && req.user.rposShopReference) || null,
        ip: req.ip || null,
        userAgent: req.get('User-Agent') || null,
      });
    } catch { /* le debug ne doit jamais casser la réponse */ }
  });
  next();
});

// Pages de secours (fallback minimal : / et /login + leurs assets, dossier
// backend/public-fallback/ synchronisé via `npm run sync-fallback`). Monté AVANT
// les routes /api : il ne répond qu'à sa whitelist + aux assets existants, et
// passe la main (next) dans tous les autres cas — l'API n'est jamais masquée.
// Remplace l'ancien `express.static('public')` (snapshot anglais du template,
// 36 Mo, pages divergentes) supprimé lors du ménage P1 : plus aucun doublon.
app.use(fallbackRoutes);

// =============================================
// API ROUTES
// =============================================
// Hors /api/reassort volontairement (comme oauthOutlookRoutes plus bas) : requireAuth y est
// appliqué globalement, mais le logo/favicon du site doit rester lisible SANS connexion (page de
// login incluse) — ce routeur applique requireAuth lui-même, uniquement sur ses routes protégées.
app.use('/api', publicAssetsRoutes);
app.use('/api/reassort', reassortRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
// Hors /api/reassort volontairement : reçoit la redirection du NAVIGATEUR d'Azure AD (jamais un
// appel fetch authentifié par notre JWT), protégé par son propre state signé — cf. oauthOutlook.js.
app.use('/api/oauth/outlook', oauthOutlookRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// =============================================
// ERROR HANDLING
// =============================================
app.use((err, req, res, next) => {
  logger.error('Erreur serveur', {
    method: req.method,
    url: req.originalUrl,
    message: err.message,
    stack: err.stack,
  });
  res.locals.errorStack = err.stack || null; // relu par le hook debug global (ErrorReport)
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Erreur serveur interne'
  });
});

// Filet de sécurité process : sans handler, une exception non catchée QUELQUE PART (même hors
// d'une route Express, ex: dans un job planifié ou une Promise oubliée) fait tomber TOUT le process
// Node immédiatement — Docker le relance ensuite (restart: unless-stopped), mais toute connexion en
// cours (notamment un flux SSE de l'Assistant IA) se ferme sans jamais avoir pu écrire d'event
// "error"/"done", ce qui apparaît côté client comme "Flux terminé sans réponse exploitable." sans
// aucune trace exploitable une fois le conteneur recréé (les logs du process mort ne survivent pas
// à `docker compose up --build`, seulement à un `restart` simple) — bug observé le 16/09/2026 sans
// pouvoir en identifier la cause exacte faute de ce filet. Journalise ici AVANT de laisser Node
// terminer le process normalement (ne PAS avaler l'exception : au-delà de ce point, l'état du
// process peut être corrompu de façon imprévisible, mieux vaut un redémarrage propre par Docker
// qu'un process qui continue à tourner dans un état indéterminé).
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException — le process va se terminer', { message: err.message, stack: err.stack });
  require('./services/errorReportService').reportError({
    source: 'backend',
    message: `uncaughtException: ${err.message}`,
    stack: err.stack || null,
  }).finally(() => process.exit(1));
});
process.on('unhandledRejection', (reason) => {
  const message = (reason && reason.message) || String(reason);
  const stack = (reason && reason.stack) || null;
  logger.error('unhandledRejection', { message, stack });
  require('./services/errorReportService').reportError({
    source: 'backend',
    message: `unhandledRejection: ${message}`,
    stack,
  });
  // Pas de process.exit ici : contrairement à uncaughtException, une Promise rejetée sans handler
  // ne laisse pas le process dans un état forcément corrompu (le code qui l'a émise a déjà géré son
  // propre échec de façon incomplète, pas le process entier) — journaliser suffit, un exit ici
  // serait une régression (transformerait une erreur locale isolée en interruption totale du
  // service pour tous les magasins, bien plus grave que l'erreur d'origine).
});

// =============================================
// START SERVER
// =============================================
const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await prisma.$connect();
    console.log('✅ Database connected');

    await seedServersFromJson();
    console.log('🗺️  Serveurs RPOS synchronisés depuis magasins.json');

    // Un redémarrage du process (rebuild, crash, redéploiement) abandonne toute génération de
    // proposition en tâche de fond sans jamais la marquer en erreur — le run restait à RUNNING pour
    // toujours en base, avec sa bannière de progression figée indéfiniment côté frontend, laissant
    // croire à tort qu'une génération est encore active. Marqués en erreur au redémarrage : plus
    // fiable que d'espérer reprendre une tâche dont l'état intermédiaire (connexions RPOS, etc.)
    // n'a de toute façon pas survécu au redémarrage.
    const staleRuns = await prisma.proposalGenerationRun.updateMany({
      where: { status: 'RUNNING' },
      data: { status: 'ERROR', errorMessage: 'Génération interrompue par un redémarrage du serveur — relancez-la si besoin.', completedAt: new Date() },
    });
    if (staleRuns.count > 0) {
      console.log(`⚠️  ${staleRuns.count} génération(s) de proposition interrompue(s) par le redémarrage, marquée(s) en erreur.`);
    }

    // Contrairement aux propositions ci-dessus, un batch de récupération d'historique (bouton
    // "Tout cocher" du backfill) sait reprendre proprement là où il s'est arrêté (chunks/pages déjà
    // persistés, cf. salesBackfillService) : un redémarrage du serveur ne doit donc jamais
    // l'abandonner, juste relancer sa boucle de traitement pour le magasin en cours et les suivants.
    const activeBatch = await salesBackfillService.findActiveBatch();
    if (activeBatch) {
      console.log(`📥 Reprise du lot de récupération de ventes ${activeBatch.id} (magasin ${activeBatch.currentIndex + 1}/${JSON.parse(activeBatch.targetsJson).length})...`);
      salesBackfillService.processBatch(activeBatch.id).catch((err) => console.error('Erreur reprise batch backfill:', err.message));
    }

    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📊 Dashboard: http://localhost:${PORT}`);
      console.log(`🔌 API: http://localhost:${PORT}/api`);
    });

    // Génération nocturne des propositions de réassort (horaire configurable via Paramètres).
    await startOrRestartNightlyJob();
    // Synchronisation périodique des statuts de réception RPOS (horaire configurable).
    await startOrRestartReceptionSyncJob();
    // Synchronisation locale incrémentale des ventes RPOS (horaire configurable).
    await startOrRestartSalesSyncJob();
    // Récap quotidien de couverture des ventes, jour par jour (horaire configurable, 23:59 par défaut).
    await startOrRestartSalesDailyRecapJob();
    // Synchronisation locale des DLV actives (horaire configurable, toutes les heures par défaut).
    await startOrRestartProductEolSyncJob();
    // Synchronisation locale des mouvements de stock RPOS (horaire configurable, toutes les 20 min par défaut).
    await startOrRestartStockMoveSyncJob();
    // Capture périodique du stock pour la détection des épisodes de rupture (horaire configurable, toutes les 6h par défaut).
    await startOrRestartStockSnapshotJob();
    // Recalcul de la perte (qtyPerdueEstimee/caPerdueEstime) des épisodes EN_COURS, stocké en base
    // pour que les pages du module Ruptures restent rapides (horaire configurable, toutes les heures par défaut).
    await startOrRestartStockoutLossRecalcJob();
    // Précalcule le CA perdu par (magasin, rayon, jour) — demande explicite du 21/10/2026 :
    // "Analyse par rayon"/"Priorisation par rayon" doit refléter la période choisie, pas un total
    // global (toutes les 2h par défaut, backfill 95 jours au premier passage).
    await startOrRestartStockoutDailyLossSnapshotJob();
    // Tableau de bord lent (10-30s, demande explicite du 22/10/2026) : GET /reassort/orders
    // appelait RPOS en direct à chaque chargement — synchro en tâche de fond toutes les 10 min.
    await startOrRestartSupplierOrdersSyncJob();
    // Résout automatiquement secteur/rayon pour les épisodes EN_COURS encore à null (anciens,
    // ouverts avant le correctif RPOS, ou tout cas résiduel) — filet de sécurité en continu, pas
    // seulement à la création d'un épisode (horaire configurable, toutes les 6h par défaut).
    await startOrRestartStockoutSectorBackfillJob();
    // Filet de rattrapage des ruptures résolvables par un arrivage déjà présent en base locale mais
    // raté par resolveEpisodesFromArrivalMoves (qui ne traite que les mouvements fraîchement
    // synchronisés, pas l'historique) — couvre notamment les arrivages synchronisés AVANT le
    // déploiement de ce correctif (horaire configurable, toutes les heures par défaut).
    await startOrRestartStockoutCatchUpResolveJob();
    // Resynchronise ProductCache.stock (le vrai stock RPOS officiel) pour les articles en rupture
    // EN_COURS — demande explicite : "le stckok afficher doit etre le stok tu pos" après un cas où
    // le stock recalculé depuis l'historique StockMove restait fortement négatif malgré un vrai
    // arrivage (horaire configurable, toutes les 15 min par défaut).
    await startOrRestartStockoutProductCacheRefreshJob();
    // Même resynchronisation ProductCache.stock, mais pour les articles ACTUELLEMENT en surstock
    // (demande explicite du 24/10/2026 : cas constaté en production — ProductCache.stock périmé
    // depuis des semaines pour un article en surstock, faussant la colonne Stock de la page Surstock,
    // horaire configurable, toutes les heures par défaut).
    await startOrRestartOverstockProductCacheRefreshJob();
    // Précalcule hasOrder/reactionStatus/deliveryStatus pour chaque rupture EN_COURS — demande
    // explicite : "il ne calcule ps a meme temps... le but est d'optimisé", même principe que le
    // recalcul de perte ci-dessus (horaire configurable, toutes les 5 min par défaut).
    await startOrRestartStockoutStatusRecalcJob();
    await startOrRestartStockoutAlertJob();
    // Précalcule chaque nuit "Analyse des pertes sur une période" (30 derniers jours) pour que la
    // page l'affiche instantanément au lieu de recalculer à chaque chargement (horaire configurable).
    await startOrRestartStockoutPeriodSummarySnapshotJob();
    // Précalcule le rapport Surstock pour sa vue par défaut (horaire configurable) — demande
    // explicite du 21/10/2026 : "il charge trop pourqhoi ? il fait les calcule quand j'actualise ?".
    await startOrRestartOverstockReportSnapshotJob();
    await startOrRestartOrderIdentitySyncJob();
    // Synchronisation locale de la liste des magasins RPOS (horaire configurable).
    await startOrRestartShopsSyncJob();
    // Réajustement quotidien continu des plans hebdomadaires non encore validés (horaire configurable).
    await startOrRestartDailyReviewJob();
    // Évaluation des prédictions dont la période cible est terminée (horaire configurable).
    await startOrRestartPredictionOutcomeJob();
    // Chien de garde quotidien du Conseiller d'amélioration IA (horaire configurable).
    await startOrRestartImprovementWatchdogJob();
    // Relance des propositions encore en attente (horaire configurable, 10h par défaut).
    await startOrRestartProposalReminderJob();
    // Récap de fin de journée pour les ADMIN (horaire configurable, 16h30 par défaut).
    await startOrRestartEndOfDayValidationRecapJob();
    // Chien de garde consommation de tokens IA, alerte les ADMIN en cas de pic (horaire configurable, 7h10 par défaut).
    await startOrRestartTokenUsageWatchdogJob();

    // Rattrapages ponctuels déclenchés une fois par démarrage (demandes explicites du 18/10/2026 :
    // "fait dans le code et quand je deploi et mais a jour pour tout a meme temps" / "faut pour les
    // sans secteur comme ca") — EN ARRIÈRE-PLAN, jamais attendus (pas de `await`) : le serveur est
    // déjà en écoute depuis app.listen() plus haut, ces rattrapages ne doivent jamais retarder ni
    // bloquer l'exposition du port. CORRIGÉ suite à un incident réel : les avoir mis dans
    // docker-entrypoint.sh, AVANT le démarrage du serveur, a rendu le service injoignable le temps
    // de leur exécution (le job secteur/rayon fait de vrais appels RPOS un par un, potentiellement
    // des dizaines de minutes avec plusieurs milliers d'épisodes sur tout le réseau).
    //
    // ÉCHELONNÉS avec un court délai entre chacun (demande explicite du 24/10/2026 : "quand je fait
    // un deployement le server n'est plus access a causes des jobs") — les lancer tous EN MÊME
    // TEMPS (comme avant ce correctif) crée un pic de charge au démarrage (428% CPU, 4.8 Go RAM
    // mesurés en prod) car plusieurs font de vrais appels RPOS en parallèle sur tous les magasins
    // simultanément. Rien n'est supprimé ni rendu bloquant : chaque job tourne toujours en
    // arrière-plan (pas de `await`), juste décalé de quelques secondes par rapport au précédent
    // pour lisser le pic plutôt que de tout cumuler à la même seconde.
    const STARTUP_JOB_STAGGER_MS = 20_000;
    const startupJobs = [
      ['./jobs/stockoutSectorBackfillJob', 'runStockoutSectorBackfillJob', '[startup] Résolution secteur/rayon en arrière-plan : échec non bloquant —'],
      ['../scripts/fixWeekendReceptionDates', 'runWeekendReceptionDatesFix', '[startup] Correction des dates de livraison en arrière-plan : échec non bloquant —'],
      // Rattrapage immédiat des ruptures résolvables par un arrivage déjà en base (demande
      // implicite du 19/10/2026 : "j'ai fait le commit il est toujour en pareil") — purement local
      // (aucun appel RPOS), donc sûr à lancer dès le démarrage sans attendre le premier passage
      // planifié (jusqu'à 1h par défaut, cf. STOCKOUT_CATCH_UP_RESOLVE_CRON).
      ['./jobs/stockoutCatchUpResolveJob', 'runStockoutCatchUpResolveJob', '[startup] Rattrapage de résolution des ruptures en arrière-plan : échec non bloquant —'],
      // Resynchronisation immédiate du stock RPOS officiel des articles en rupture — fait de vrais
      // appels RPOS (contrairement au rattrapage ci-dessus, purement local).
      ['./jobs/stockoutProductCacheRefreshJob', 'runStockoutProductCacheRefreshJob', '[startup] Resynchronisation du stock RPOS en arrière-plan : échec non bloquant —'],
      // Précalcul immédiat du statut des ruptures déjà ouvertes AVANT ce déploiement (demande
      // explicite du 20/10/2026 : "il ne calcule ps a meme temps... le but est d'optimisé") — sans
      // ce passage immédiat, les épisodes déjà ouverts resteraient avec hasOrder/deliveryStatus à
      // null jusqu'au premier déclenchement planifié (jusqu'à 5 min, cf. STOCKOUT_STATUS_RECALC_CRON).
      ['./jobs/stockoutStatusRecalcJob', 'runStockoutStatusRecalcJob', '[startup] Précalcul du statut des ruptures en arrière-plan : échec non bloquant —'],
      // Précalcul immédiat du rapport Surstock (sans ce passage, la page resterait lente jusqu'au
      // premier déclenchement planifié, jusqu'à 1h, cf. OVERSTOCK_REPORT_SNAPSHOT_CRON).
      ['./jobs/overstockReportSnapshotJob', 'runOverstockReportSnapshotJob', '[startup] Précalcul du rapport Surstock en arrière-plan : échec non bloquant —'],
      // Resynchronisation immédiate du stock RPOS officiel des articles en surstock (demande
      // explicite du 24/10/2026) — placé après le précalcul Surstock ci-dessus pour éviter deux
      // calculs lourds de getOverstockByShop en concurrence au même instant au démarrage.
      ['./jobs/overstockProductCacheRefreshJob', 'runOverstockProductCacheRefreshJob', '[startup] Resynchronisation du stock RPOS des articles en surstock en arrière-plan : échec non bloquant —'],
    ];
    startupJobs.forEach(([modulePath, exportName, errorPrefix], index) => {
      setTimeout(() => {
        const job = require(modulePath)[exportName];
        job().catch((err) => console.error(errorPrefix, err.message));
      }, index * STARTUP_JOB_STAGGER_MS);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

start();

// Graceful shutdown
process.on('SIGTERM', async () => {
  await prisma.$disconnect();
  process.exit(0);
});
