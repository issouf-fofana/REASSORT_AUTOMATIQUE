require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const prisma = require('./utils/prisma');
const { startOrRestartNightlyJob, startOrRestartReceptionSyncJob, startOrRestartSalesSyncJob, startOrRestartShopsSyncJob, startOrRestartDailyReviewJob, startOrRestartPredictionOutcomeJob, startOrRestartImprovementWatchdogJob } = require('./jobs/cronManager');
const { seedServersFromJson } = require('./services/rposServersService');

// Import routes
const reassortRoutes = require('./routes/reassort');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');

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

// Serve static files (dashboard)
app.use(express.static('public'));

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
  console.error(err.stack);
  res.locals.errorStack = err.stack || null; // relu par le hook debug global (ErrorReport)
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Erreur serveur interne'
  });
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
