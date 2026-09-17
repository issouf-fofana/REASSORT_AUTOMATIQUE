const fs = require('fs');
const path = require('path');
const prisma = require('../utils/prisma');
const crypto = require('./cryptoService');


const MAGASINS_JSON_PATH = path.join(__dirname, '..', '..', 'magasins.json');

/**
 * Amorce la table RposServer depuis magasins.json au premier démarrage (idempotent : ne touche
 * pas aux serveurs déjà en base, pour ne jamais écraser des identifiants déjà configurés).
 * Pour l'instant seul le serveur pos1 dispose d'identifiants réels (RPOS_USER/RPOS_PASSWORD) ;
 * les autres sont créés inactifs, en attente que l'admin renseigne leurs identifiants.
 */
async function seedServersFromJson() {
  if (!fs.existsSync(MAGASINS_JSON_PATH)) return;

  const servers = JSON.parse(fs.readFileSync(MAGASINS_JSON_PATH, 'utf-8'));
  const existing = await prisma.rposServer.findMany({ select: { posId: true } });
  const existingIds = new Set(existing.map((s) => s.posId));

  for (const server of servers) {
    if (existingIds.has(server.pos_id)) continue;

    const isPos1 = server.pos_id === 'pos1';
    await prisma.rposServer.create({
      data: {
        posId: server.pos_id,
        label: server.prod_label,
        baseUrl: server.base_url,
        rposUser: isPos1 ? (process.env.RPOS_USER || null) : null,
        rposPassword: isPos1 && process.env.RPOS_PASSWORD ? crypto.encrypt(process.env.RPOS_PASSWORD) : null,
        isActive: isPos1,
      },
    });
  }
}

async function listServers() {
  return prisma.rposServer.findMany({ orderBy: { posId: 'asc' } });
}

async function getServer(posId) {
  return prisma.rposServer.findUnique({ where: { posId } });
}

async function upsertServerCredentials(posId, { baseUrl, rposUser, rposPassword }) {
  const data = {};
  if (baseUrl !== undefined) data.baseUrl = baseUrl;
  if (rposUser !== undefined) data.rposUser = rposUser;
  if (rposPassword) data.rposPassword = crypto.encrypt(rposPassword);
  if (rposUser || rposPassword) data.isActive = true;

  return prisma.rposServer.update({ where: { posId }, data });
}

/**
 * Applique le même identifiant/mot de passe RPOS à TOUS les serveurs connus (cas Prosuma où un
 * seul compte RPOS est valide sur toutes les plateformes) — ne touche jamais baseUrl, chaque
 * serveur garde sa propre adresse physique.
 */
async function applyCredentialsToAllServers({ rposUser, rposPassword }) {
  const data = {};
  if (rposUser !== undefined) data.rposUser = rposUser;
  if (rposPassword) data.rposPassword = crypto.encrypt(rposPassword);
  if (rposUser || rposPassword) data.isActive = true;

  return prisma.rposServer.updateMany({ data });
}

module.exports = {
  seedServersFromJson,
  listServers,
  getServer,
  upsertServerCredentials,
  applyCredentialsToAllServers,
};
