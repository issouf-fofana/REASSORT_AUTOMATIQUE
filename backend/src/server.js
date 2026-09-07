require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { PrismaClient } = require('@prisma/client');
const { startOrRestartNightlyJob, startOrRestartReceptionSyncJob, startOrRestartSalesSyncJob, startOrRestartShopsSyncJob } = require('./jobs/cronManager');
const { seedServersFromJson } = require('./services/rposServersService');

// Import routes
const reassortRoutes = require('./routes/reassort');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');

// Initialize Express
const app = express();
const prisma = new PrismaClient();

// =============================================
// MIDDLEWARE
// =============================================
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  credentials: true
}));
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
