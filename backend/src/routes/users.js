const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const prisma = require('../utils/prisma');
const { requireAuth, requireAdmin } = require('../middleware/auth');


router.use(requireAuth, requireAdmin);

const VALID_ROLES = ['ADMIN', 'SUPERVISOR', 'STORE'];

function normalizeRole(role) {
  return VALID_ROLES.includes(role) ? role : 'STORE';
}

function toPublicUser(user) {
  const { password, ...rest } = user;
  return rest;
}

// GET /api/users - liste tous les comptes (admin uniquement)
router.get('/', async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      include: { supervisedShops: true },
    });
    res.json({ success: true, data: users.map(toPublicUser) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/users - crée un compte
// body: { email, password, name, role, rposShopId, rposShopReference, rposShopName, rposPosId,
//         supervisedShops: [{ rposShopId, rposShopReference, rposShopName, rposPosId }, ...] }
router.post('/', async (req, res) => {
  try {
    const {
      email, password, name, role,
      rposShopId, rposShopReference, rposShopName, rposPosId,
      supervisedShops,
    } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ success: false, message: 'email, password et name sont requis' });
    }
    const normalizedRole = normalizeRole(role);
    if (normalizedRole === 'STORE' && (!rposShopId || !rposPosId)) {
      return res.status(400).json({ success: false, message: 'Un compte STORE doit être rattaché à un magasin et son serveur (rposShopId, rposPosId)' });
    }
    if (normalizedRole === 'SUPERVISOR' && (!Array.isArray(supervisedShops) || supervisedShops.length === 0)) {
      return res.status(400).json({ success: false, message: 'Un compte SUPERVISOR doit superviser au moins un magasin' });
    }

    const hashed = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        email,
        password: hashed,
        name,
        role: normalizedRole,
        rposShopId: normalizedRole === 'STORE' ? rposShopId : null,
        rposShopReference: normalizedRole === 'STORE' ? rposShopReference : null,
        rposShopName: normalizedRole === 'STORE' ? rposShopName : null,
        rposPosId: normalizedRole === 'STORE' ? rposPosId : null,
        supervisedShops: normalizedRole === 'SUPERVISOR'
          ? { create: supervisedShops.map((s) => ({
              rposShopId: s.rposShopId, rposShopReference: s.rposShopReference,
              rposShopName: s.rposShopName, rposPosId: s.rposPosId,
            })) }
          : undefined,
      },
      include: { supervisedShops: true },
    });

    res.status(201).json({ success: true, data: toPublicUser(user) });
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(400).json({ success: false, message: 'Cet email existe déjà' });
    }
    console.error('Create user error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT /api/users/:id - met à jour un compte (magasin, rôle, actif, mot de passe optionnel,
// liste des magasins supervisés pour un SUPERVISOR)
router.put('/:id', async (req, res) => {
  try {
    const {
      email, name, role,
      rposShopId, rposShopReference, rposShopName, rposPosId,
      supervisedShops, isActive, password,
    } = req.body;

    const data = {};
    if (email !== undefined) data.email = email;
    if (name !== undefined) data.name = name;
    if (role !== undefined) data.role = normalizeRole(role);
    if (isActive !== undefined) data.isActive = isActive;
    if (password) data.password = await bcrypt.hash(password, 10);

    if (data.role === 'ADMIN' || data.role === 'SUPERVISOR') {
      data.rposShopId = null;
      data.rposShopReference = null;
      data.rposShopName = null;
      data.rposPosId = null;
    } else if (data.role === 'STORE') {
      if (rposShopId !== undefined) data.rposShopId = rposShopId;
      if (rposShopReference !== undefined) data.rposShopReference = rposShopReference;
      if (rposShopName !== undefined) data.rposShopName = rposShopName;
      if (rposPosId !== undefined) data.rposPosId = rposPosId;
    }

    // Remplace entièrement la liste des magasins supervisés si fournie (édition explicite),
    // uniquement pertinent pour un compte SUPERVISOR.
    if (Array.isArray(supervisedShops)) {
      await prisma.supervisedShop.deleteMany({ where: { userId: req.params.id } });
      data.supervisedShops = {
        create: supervisedShops.map((s) => ({
          rposShopId: s.rposShopId, rposShopReference: s.rposShopReference,
          rposShopName: s.rposShopName, rposPosId: s.rposPosId,
        })),
      };
    }

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data,
      include: { supervisedShops: true },
    });
    res.json({ success: true, data: toPublicUser(user) });
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE /api/users/:id
router.delete('/:id', async (req, res) => {
  try {
    await prisma.user.delete({ where: { id: req.params.id } });
    res.json({ success: true, message: 'Compte supprimé' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
