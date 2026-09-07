const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { PrismaClient } = require('@prisma/client');
const { requireAuth } = require('../middleware/auth');
const { getJwtConfig } = require('../services/jwtConfigService');

const prisma = new PrismaClient();

// Limite les tentatives de connexion par IP (brute-force sur mot de passe) : sans ce garde-fou,
// rien n'empêchait un script d'essayer des milliers de mots de passe par minute sur /login.
// 10 tentatives / 15 min par IP est large pour un usage légitime (quelques essais avec faute de
// frappe) tout en rendant un brute-force impraticable.
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Trop de tentatives de connexion, réessayez dans quelques minutes.' },
});

// POST /api/auth/login - body: { email, password }
router.post('/login', loginRateLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email et mot de passe requis' });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.isActive) {
      return res.status(401).json({ success: false, message: 'Identifiants incorrects' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ success: false, message: 'Identifiants incorrects' });
    }

    const payload = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      rposShopId: user.rposShopId,
      rposShopReference: user.rposShopReference,
      rposShopName: user.rposShopName,
      rposPosId: user.rposPosId,
    };

    const { secret, expiresIn } = await getJwtConfig();
    const token = jwt.sign(payload, secret, { expiresIn });

    // Liste des magasins supervisés renvoyée à part (pas dans le JWT signé) : elle peut changer
    // sans attendre l'expiration du token, le frontend la rafraîchit via /auth/me si besoin.
    let supervisedShops = [];
    if (user.role === 'SUPERVISOR') {
      supervisedShops = await prisma.supervisedShop.findMany({ where: { userId: user.id } });
    }

    res.json({ success: true, data: { token, user: { ...payload, supervisedShops } } });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/auth/me - renvoie l'utilisateur courant à partir du token, avec sa liste de magasins
// supervisés à jour (jamais figée dans le JWT, cf. /login)
router.get('/me', requireAuth, async (req, res) => {
  let supervisedShops = [];
  if (req.user.role === 'SUPERVISOR') {
    supervisedShops = await prisma.supervisedShop.findMany({ where: { userId: req.user.id } });
  }
  res.json({ success: true, data: { ...req.user, supervisedShops } });
});

module.exports = router;
