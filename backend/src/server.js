require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const prisma = require('./utils/prisma');
const logger = require('./utils/logger');
const { startOrRestartNightlyJob, startOrRestartReceptionSyncJob, startOrRestartSalesSyncJob, startOrRestartShopsSyncJob, startOrRestartDailyReviewJob, startOrRestartPredictionOutcomeJob, startOrRestartImprovementWatchdogJob } = require('./jobs/cronManager');
const { seedServersFromJson } = require('./services/rposServersService');
const salesBackfillService = require('./services/salesBackfillService');

// Import routes
const reassortRoutes = require('./routes/reassort');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const fallbackRoutes = require('./routes/fallback');

// Initialize Express
const app = express();

// =============================================
// MIDDLEWARE
// =============================================
app.use(helmet());
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
    try {
      const body = res.locals.responseBody;
      require('./services/errorReportService').reportError({
        source: 'backend',
        url: `${req.method} ${req.originalUrl}`.slice(0, 500),
        method: req.method,
        statusCode: res.statusCode,
        message: (body && body.message) || (res.locals.errorStack || '').split('\n')[0] || `HTTP ${res.statusCode}`,
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
app.use('/api/reassort', reassortRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);

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
    // Synchronisation locale de la liste des magasins RPOS (horaire configurable).
    await startOrRestartShopsSyncJob();
    // Réajustement quotidien continu des plans hebdomadaires non encore validés (horaire configurable).
    await startOrRestartDailyReviewJob();
    // Évaluation des prédictions dont la période cible est terminée (horaire configurable).
    await startOrRestartPredictionOutcomeJob();
    // Chien de garde quotidien du Conseiller d'amélioration IA (horaire configurable).
    await startOrRestartImprovementWatchdogJob();
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
