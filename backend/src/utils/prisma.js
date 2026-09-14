/**
 * Client Prisma PARTAGÉ par tout le backend (jobs, services, routes, middleware).
 *
 * Avant, chaque fichier créait son propre `new PrismaClient()` (25 instances) : chaque instance
 * ouvre son propre pool de connexions vers Postgres, ce qui expose à l'épuisement du pool
 * (max_connections) quand plusieurs jobs tournent en concurrence (génération nocturne ×3
 * magasins + score de confiance ×10 en parallèle). Une seule instance = un seul pool.
 * Le cache sur globalThis évite de recréer le client à chaque rechargement en dev (nodemon).
 */
const { PrismaClient } = require('@prisma/client');

const prisma = globalThis.__reassortPrisma ?? (globalThis.__reassortPrisma = new PrismaClient());

module.exports = prisma;
