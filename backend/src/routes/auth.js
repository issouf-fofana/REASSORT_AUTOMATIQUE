const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const prisma = require('../utils/prisma');
const { requireAuth } = require('../middleware/auth');
const { getJwtConfig } = require('../services/jwtConfigService');
const { verifyLdapCredentials, LDAP_DOMAIN_FQDN } = require('../services/ldapService');
const crypto = require('crypto');


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
    let { email } = req.body;
    const { password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email et mot de passe requis' });
    }

    // Accepte aussi le simple identifiant réseau Prosuma (ex: "jdupont") sans "@..." — complété en
    // email @LDAP_DOMAIN_FQDN pour rejoindre le même flux ci-dessous (recherche du compte local
    // existant, puis LDAP si absent). Un compte local se crée forcément avec un email complet
    // (contrainte @unique en base), donc cette normalisation ne risque jamais de collision avec un
    // identifiant local qui contiendrait un "@" par ailleurs.
    if (!email.includes('@')) {
      email = `${email}@${LDAP_DOMAIN_FQDN}`;
    }

    let user = await prisma.user.findUnique({ where: { email } });

    const PENDING_ACCESS_MESSAGE = 'Votre compte existe mais n\'a pas encore été configuré. Contactez le service informatique (SOS) pour demander l\'accès.';

    // Un compte ldapManaged (créé via le premier login LDAP, ou préconfiguré depuis Utilisateurs >
    // recherche annuaire) n'a JAMAIS de mot de passe local exploitable — bcrypt.compare échouerait
    // toujours contre son hash aléatoire. Sa vérification passe systématiquement par LDAP, qu'il
    // soit actif (déjà configuré par un ADMIN, cf. Utilisateurs) ou inactif (en attente).
    if (user && user.ldapManaged) {
      const ldapUsername = email.slice(0, email.indexOf('@'));
      const ldapOk = await verifyLdapCredentials(ldapUsername, password);
      if (!ldapOk) {
        return res.status(401).json({ success: false, message: 'Identifiants incorrects' });
      }
      if (!user.isActive) {
        // Mot de passe AD valide, mais compte pas encore configuré par un ADMIN (pas de
        // rôle/magasin réel attribué) : message explicite plutôt que la même erreur générique
        // qu'un mauvais mot de passe, pour que l'utilisateur sache quoi faire (contacter SOS) au
        // lieu de retenter indéfiniment sa saisie en pensant s'être trompé.
        return res.status(403).json({ success: false, message: PENDING_ACCESS_MESSAGE });
      }
    // Priorité au compte local (STEP 10, plan de rôles §39-40) : si un compte existe déjà avec un
    // mot de passe local, on l'authentifie normalement, LDAP n'intervient jamais pour lui — évite
    // qu'une panne ou une politique de mot de passe AD ne bloque un compte de service/admin local
    // qui n'a jamais eu besoin d'un compte réseau Prosuma (ex: admin@reassort.local).
    } else if (user && user.isActive) {
      const valid = await bcrypt.compare(password, user.password);
      if (!valid) {
        return res.status(401).json({ success: false, message: 'Identifiants incorrects' });
      }
    } else if (!user && email.toLowerCase().endsWith(`@${LDAP_DOMAIN_FQDN}`)) {
      // Pas de compte local pour cet email : si son domaine correspond à Prosuma, on tente LDAP
      // avec l'identifiant réseau (partie avant @) — jamais pour un email d'un autre domaine, qui
      // n'a de toute façon aucune chance d'exister dans cet Active Directory.
      const ldapUsername = email.slice(0, email.indexOf('@'));
      const ldapOk = await verifyLdapCredentials(ldapUsername, password);
      if (!ldapOk) {
        return res.status(401).json({ success: false, message: 'Identifiants incorrects' });
      }
      // Premier succès LDAP pour cet utilisateur : le mot de passe AD est valide, mais le compte est
      // créé INACTIF (pas de rôle/magasin attribué) — un ADMIN doit explicitement le configurer
      // depuis Utilisateurs (recherche annuaire ou activation directe) avant que la connexion
      // n'aboutisse (décision du 17/09/2026 : accès refusé par défaut, jamais un rôle par défaut
      // qui donnerait un accès même limité sans validation humaine).
      user = await prisma.user.create({
        data: {
          email,
          password: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10),
          name: ldapUsername,
          isActive: false,
          ldapManaged: true,
        },
      });
      console.log(`[auth] Compte LDAP créé en attente de validation : ${email}`);
      return res.status(403).json({ success: false, message: PENDING_ACCESS_MESSAGE });
    } else {
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
