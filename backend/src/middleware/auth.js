const jwt = require('jsonwebtoken');
const prisma = require('../utils/prisma');
const { getJwtConfig } = require('../services/jwtConfigService');


/** Vérifie le token JWT et attache l'utilisateur (id, role, rposShopId) à req.user. */
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ success: false, message: 'Authentification requise' });
  }

  try {
    const { secret } = await getJwtConfig();
    const payload = jwt.verify(token, secret);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Token invalide ou expiré' });
  }
}

/** Autorise uniquement les comptes ADMIN. */
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'ADMIN') {
    return res.status(403).json({ success: false, message: 'Accès réservé aux administrateurs' });
  }
  next();
}

// DIRECTOR/DEPARTMENT_HEAD/SHELF_STOCKER partagent exactement le même cloisonnement magasin que
// l'ancien rôle STORE (toujours rposShopId du compte, jamais un ?shop= arbitraire) — seule la
// granularité département/rayon (assignedDepartment) et les permissions IA par capacité les
// distinguent entre eux, appliquées plus loin (chatbotService.js), pas ici (plan validé le
// 15/09/2026).
const SINGLE_SHOP_ROLES = new Set(['STORE', 'DIRECTOR', 'DEPARTMENT_HEAD', 'SHELF_STOCKER']);

/**
 * Détermine le shopId effectif pour la requête, en appliquant le cloisonnement :
 * - ADMIN : peut consulter n'importe quel magasin via ?shop=<id>, ou aucun (à gérer par l'appelant)
 * - SUPERVISOR : peut consulter uniquement un magasin de sa liste supervisée (vérifiée en base à
 *   chaque requête, jamais depuis le JWT, pour refuser l'accès même après une modification de la
 *   liste par un admin sans attendre l'expiration du token — readme §30)
 * - DIRECTOR/DEPARTMENT_HEAD/SHELF_STOCKER (et l'ancien STORE) : toujours son propre shopId, même
 *   si ?shop=<id> est fourni dans l'URL (ignoré)
 * Retourne null si aucun magasin n'est accessible pour cette requête.
 */
function resolveShopId(req) {
  if (req.user.role === 'ADMIN') {
    return req.query.shop || req.body?.shopId || null;
  }
  if (req.user.role === 'SUPERVISOR') {
    return req.query.shop || req.body?.shopId || null; // vérifié par requireSupervisedShop
  }
  return req.user.rposShopId || null;
}

/**
 * Détermine le posId (serveur RPOS) effectif pour la requête, avec le même cloisonnement que
 * resolveShopId : un compte à un seul magasin (DIRECTOR/DEPARTMENT_HEAD/SHELF_STOCKER, ex-STORE) ne
 * peut jamais cibler un autre serveur que le sien.
 */
function resolvePosId(req) {
  if (req.user.role === 'ADMIN') {
    return req.query.pos || req.body?.posId || null;
  }
  if (req.user.role === 'SUPERVISOR') {
    return req.query.pos || req.body?.posId || null; // vérifié par requireSupervisedShop
  }
  return req.user.rposPosId || null;
}

/**
 * Vérifie qu'un compte SUPERVISOR a bien accès au magasin ciblé par la requête (present dans sa
 * liste SupervisedShop en base, pas dans le JWT). Ne fait rien pour ADMIN/STORE (déjà cloisonnés
 * par resolveShopId), ni quand la requête ne cible aucun shopId précis (routes qui gèrent
 * elles-mêmes ce cas, ex: /shops qui liste tout le périmètre supervisé).
 */
async function requireSupervisedShop(req, res, next) {
  if (req.user.role !== 'SUPERVISOR') return next();

  const shopId = resolveShopId(req);
  if (!shopId) return next();

  const supervised = await prisma.supervisedShop.findFirst({
    where: { userId: req.user.id, rposShopId: shopId },
  });

  if (!supervised) {
    return res.status(403).json({ success: false, message: 'Ce magasin n\'est pas dans votre périmètre de supervision' });
  }

  next();
}

module.exports = { requireAuth, requireAdmin, resolveShopId, resolvePosId, requireSupervisedShop, SINGLE_SHOP_ROLES };
