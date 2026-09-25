const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const prisma = require('../utils/prisma');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const ldapService = require('../services/ldapService');


router.use(requireAuth, requireAdmin);

// Hiérarchie de rôles (plan validé le 15/09/2026) : ADMIN reste l'alias historique de SUPERADMIN
// (testé tel quel à ~27 endroits du code, jamais renommé pour limiter le risque de régression).
// DIRECTOR/DEPARTMENT_HEAD/SHELF_STOCKER remplacent l'ancien STORE unique, avec une granularité
// magasin entier / département / rayon respectivement — cf. schema.prisma pour le détail.
const VALID_ROLES = ['ADMIN', 'SUPERVISOR', 'DIRECTOR', 'DEPARTMENT_HEAD', 'SHELF_STOCKER'];
// Rôles à un seul magasin (rposShopId obligatoire) — remplace l'ancien test "role === 'STORE'".
const SINGLE_SHOP_ROLES = new Set(['DIRECTOR', 'DEPARTMENT_HEAD', 'SHELF_STOCKER']);
// Rôles qui nécessitent en plus un département/rayon assigné.
const DEPARTMENT_SCOPED_ROLES = new Set(['DEPARTMENT_HEAD', 'SHELF_STOCKER']);

function normalizeRole(role) {
  return VALID_ROLES.includes(role) ? role : 'DIRECTOR';
}

function toPublicUser(user) {
  // `password` est volontairement omis de la réponse (jamais exposé côté API).
  // eslint-disable-next-line no-unused-vars
  const { password, ...rest } = user;
  return rest;
}

// GET /api/users/ldap/search?q=... - recherche des comptes dans l'annuaire AD Prosuma par nom ou
// identifiant (admin uniquement), pour préconfigurer le rôle/magasin d'un employé AVANT son
// premier login plutôt que d'attendre qu'il se connecte une fois et reste bloqué en attente de
// validation (cf. décision du 17/09/2026, STEP 10).
router.get('/ldap/search', async (req, res) => {
  try {
    const results = await ldapService.searchLdapUsers(req.query.q);
    res.json({ success: true, data: results });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

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
//         assignedDepartment (DEPARTMENT_HEAD/SHELF_STOCKER, nom(s) de département séparés par
//         virgule pour un rayonniste multi-rayons), aiPermissionsJson (réglage fin optionnel),
//         supervisedShops: [{ rposShopId, rposShopReference, rposShopName, rposPosId }, ...],
//         ldapManaged (optionnel, compte préconfiguré depuis l'annuaire AD avant son premier
//         login — cf. GET /ldap/search — dans ce cas password n'est pas requis : l'authentification
//         de ce compte se fera toujours via LDAP, jamais avec un mot de passe local) }
router.post('/', async (req, res) => {
  try {
    const {
      email, password, name, role,
      rposShopId, rposShopReference, rposShopName, rposPosId,
      assignedDepartment, aiPermissionsJson,
      supervisedShops, ldapManaged,
    } = req.body;

    if (!email || !name || (!password && !ldapManaged)) {
      return res.status(400).json({ success: false, message: 'email, name et password (sauf compte LDAP) sont requis' });
    }
    const normalizedRole = normalizeRole(role);
    if (SINGLE_SHOP_ROLES.has(normalizedRole) && (!rposShopId || !rposPosId)) {
      return res.status(400).json({ success: false, message: 'Ce rôle doit être rattaché à un magasin et son serveur (rposShopId, rposPosId)' });
    }
    if (DEPARTMENT_SCOPED_ROLES.has(normalizedRole) && !assignedDepartment) {
      return res.status(400).json({ success: false, message: 'Ce rôle doit avoir un département/rayon assigné (assignedDepartment)' });
    }
    if (normalizedRole === 'SUPERVISOR' && (!Array.isArray(supervisedShops) || supervisedShops.length === 0)) {
      return res.status(400).json({ success: false, message: 'Un compte SUPERVISOR doit superviser au moins un magasin' });
    }

    // Un compte LDAP n'a jamais de mot de passe local exploitable : hash aléatoire jamais destiné
    // à être utilisé (cf. logique de /api/auth/login, qui redirige toujours ce compte vers LDAP dès
    // que son email correspond au domaine Prosuma), plutôt qu'exiger un mot de passe fictif côté UI.
    const hashed = await bcrypt.hash(ldapManaged ? crypto.randomBytes(32).toString('hex') : password, 10);

    const user = await prisma.user.create({
      data: {
        email,
        password: hashed,
        name,
        ldapManaged: !!ldapManaged,
        role: normalizedRole,
        rposShopId: SINGLE_SHOP_ROLES.has(normalizedRole) ? rposShopId : null,
        rposShopReference: SINGLE_SHOP_ROLES.has(normalizedRole) ? rposShopReference : null,
        rposShopName: SINGLE_SHOP_ROLES.has(normalizedRole) ? rposShopName : null,
        rposPosId: SINGLE_SHOP_ROLES.has(normalizedRole) ? rposPosId : null,
        assignedDepartment: DEPARTMENT_SCOPED_ROLES.has(normalizedRole) ? assignedDepartment : null,
        aiPermissionsJson: aiPermissionsJson ? JSON.stringify(aiPermissionsJson) : null,
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
// liste des magasins supervisés pour un SUPERVISOR, département/rayon assigné et permissions IA
// personnalisées pour DEPARTMENT_HEAD/SHELF_STOCKER/DIRECTOR)
router.put('/:id', async (req, res) => {
  try {
    const {
      email, name, role,
      rposShopId, rposShopReference, rposShopName, rposPosId,
      assignedDepartment, aiPermissionsJson,
      supervisedShops, isActive, password,
    } = req.body;

    const data = {};
    if (email !== undefined) data.email = email;
    if (name !== undefined) data.name = name;
    if (role !== undefined) data.role = normalizeRole(role);
    if (isActive !== undefined) data.isActive = isActive;
    if (password) {
      // Un compte Active Directory (ldapManaged) a son mot de passe géré par l'annuaire, jamais par
      // cette plateforme — filet de sécurité derrière le masquage de l'action côté frontend (demande
      // du 25/09/2026), au cas où l'appel serait déclenché autrement qu'via l'UI.
      const target = await prisma.user.findUnique({ where: { id: req.params.id }, select: { ldapManaged: true } });
      if (target?.ldapManaged) {
        return res.status(400).json({ success: false, message: 'Ce compte est géré par Active Directory : le mot de passe ne peut pas être modifié ici.' });
      }
      data.password = await bcrypt.hash(password, 10);
    }
    // aiPermissionsJson : réglage fin optionnel, jamais recalculé automatiquement — un champ omis
    // du body (undefined) laisse la valeur existante intacte ; null l'efface explicitement pour
    // revenir au défaut du rôle (cf. aiPermissionsService.getEffectivePermissions).
    if (aiPermissionsJson !== undefined) data.aiPermissionsJson = aiPermissionsJson ? JSON.stringify(aiPermissionsJson) : null;

    if (data.role === 'ADMIN' || data.role === 'SUPERVISOR') {
      data.rposShopId = null;
      data.rposShopReference = null;
      data.rposShopName = null;
      data.rposPosId = null;
      data.assignedDepartment = null;
    } else if (SINGLE_SHOP_ROLES.has(data.role)) {
      if (rposShopId !== undefined) data.rposShopId = rposShopId;
      if (rposShopReference !== undefined) data.rposShopReference = rposShopReference;
      if (rposShopName !== undefined) data.rposShopName = rposShopName;
      if (rposPosId !== undefined) data.rposPosId = rposPosId;
      data.assignedDepartment = DEPARTMENT_SCOPED_ROLES.has(data.role) ? (assignedDepartment ?? null) : null;
    } else if (assignedDepartment !== undefined) {
      // role non fourni dans cette requête (édition d'un autre champ) : on n'écrase
      // assignedDepartment que si explicitement transmis, jamais par déduction du rôle actuel non
      // reçu ici.
      data.assignedDepartment = assignedDepartment;
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
