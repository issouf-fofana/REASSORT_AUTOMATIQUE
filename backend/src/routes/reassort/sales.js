// Sous-routeur 'sales' — Consultation des lignes de vente synchronisees en local + couverture.
// Monte dans routes/reassort/index.js sous le prefixe /api/reassort (requireAuth +
// requireSupervisedShop appliques la-bas, pas ici). Ne jamais monter ailleurs.
//
// Ouverte aux rôles DIRECTOR/DEPARTMENT_HEAD/SHELF_STOCKER le 28/09/2026 (jusqu'ici réservée
// ADMIN — bug rapporté : "le rayonniste n'a pas accès aux ventes") : resolveShopId/resolvePosId
// (middleware/auth.js) forcent déjà le magasin du compte pour ces rôles, exactement comme sur
// Proposition de commande/Assistant IA — jamais un ?shop= arbitraire. DEPARTMENT_HEAD/SHELF_STOCKER
// sont en plus filtrés par RAYON assigné (cf. filterSalesLinesForUser plus bas), le rayon d'une
// vente n'étant connu qu'après résolution RPOS (SalesLine ne stocke que l'EAN, pas le département).
const express = require('express');
const router = express.Router();
const { requireAdmin, resolveShopId, resolvePosId } = require('../../middleware/auth');
const { DEPARTMENT_SCOPED_ROLES } = require('../../services/aiPermissionsService');
const prisma = require('../../utils/prisma');
const rpos = require('../../services/rposClient');
const { getProductByEanCached } = require('../../services/proposalService');
const { mapWithConcurrency } = require('../../utils/concurrency');

/**
 * Filtre les lignes de vente au périmètre de rayon d'un compte DEPARTMENT_HEAD/SHELF_STOCKER —
 * même principe que filterProposalLinesForUser (aiPermissionsService.js), mais SalesLine ne porte
 * aucun champ department : il faut le résoudre pour chaque EAN distinct via ProductCache/RPOS
 * (getProductByEanCached + getDepartmentHierarchy, déjà utilisés par /sales-lines/departments).
 * Aucune restriction pour ADMIN/SUPERVISOR/DIRECTOR (retournées telles quelles).
 */
async function filterSalesLinesForUser(lines, user, posId) {
  if (!user || !DEPARTMENT_SCOPED_ROLES.has(user.role)) return lines;
  if (!user.assignedDepartment) return [];

  const allowed = new Set(
    user.assignedDepartment.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
  );
  const eans = [...new Set(lines.map((l) => l.ean))];
  const departmentByEan = new Map();
  await mapWithConcurrency(eans, 8, async (ean) => {
    try {
      const product = await getProductByEanCached(posId, user.rposShopId, ean);
      if (!product) return;
      const { rayon } = await rpos.getDepartmentHierarchy(posId, product.department?.id);
      departmentByEan.set(ean, (rayon || '').trim().toLowerCase());
    } catch {
      // Rayon non résolvable pour cet EAN : exclu par prudence plutôt que montré à tort (repli
      // sécurisé, même logique que filterProposalLinesForUser qui exclut au moindre doute).
    }
  });
  return lines.filter((l) => departmentByEan.has(l.ean) && allowed.has(departmentByEan.get(l.ean)));
}

router.get('/sales-lines', async (req, res) => {
  try {
    // resolveShopId (middleware/auth.js) lit req.query.shop pour un ADMIN/SUPERVISOR, mais TOUT le
    // reste de ce fichier (/sales-lines/departments, /sales-lines/coverage) ainsi que le frontend
    // (SalesHistory.tsx) utilisent le paramètre "shopId" — incohérence trouvée le 28/09/2026 (bug
    // rapporté : "Erreur: Aucun magasin assigné à ce compte" alors qu'un magasin était bien
    // sélectionné). Pour un rôle mono-magasin, resolveShopId ignore déjà toute query et renvoie
    // rposShopId — ne JAMAIS laisser req.query.shopId le court-circuiter, sous peine de permettre à
    // un compte cloisonné de lire les ventes d'un autre magasin en changeant juste l'URL. On ne
    // retombe sur req.query.shopId QUE quand resolveShopId lui-même n'a rien trouvé (ADMIN/SUPERVISOR
    // qui a utilisé l'ancien nom de paramètre "shop"), jamais pour l'écraser.
    const shopId = resolveShopId(req) || req.query.shopId;
    const posId = resolvePosId(req) || req.query.posId;
    if (!shopId) return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });

    const { dateStart, dateEnd, ean, page, pageSize } = req.query;

    const where = { rposShopId: shopId };
    if (dateStart || dateEnd) {
      where.date = {};
      if (dateStart) where.date.gte = new Date(dateStart);
      if (dateEnd) where.date.lte = new Date(dateEnd);
    }
    if (ean) where.ean = ean;

    const currentUser = await prisma.user.findUnique({ where: { id: req.user.id } });
    const isDepartmentScoped = currentUser && DEPARTMENT_SCOPED_ROLES.has(currentUser.role);

    const take = Math.min(parseInt(pageSize, 10) || 100, 500);
    const skip = ((parseInt(page, 10) || 1) - 1) * take;

    if (!isDepartmentScoped) {
      // Chemin normal (ADMIN/SUPERVISOR/DIRECTOR) : pagination/agrégats faits en base, comme avant.
      const [total, lines, aggregate] = await Promise.all([
        prisma.salesLine.count({ where }),
        prisma.salesLine.findMany({ where, orderBy: { date: 'desc' }, take, skip }),
        prisma.salesLine.aggregate({ where, _sum: { quantity: true, revenueExclTax: true, revenueInclTax: true } }),
      ]);
      return res.json({
        success: true,
        data: {
          total, page: parseInt(page, 10) || 1, pageSize: take,
          totalQuantity: aggregate._sum.quantity || 0,
          totalRevenue: aggregate._sum.revenueExclTax || 0,
          totalRevenueInclTax: aggregate._sum.revenueInclTax,
          lines,
        },
      });
    }

    // DEPARTMENT_HEAD/SHELF_STOCKER : le filtrage par rayon ne peut se faire qu'APRÈS résolution
    // RPOS de chaque EAN, donc pas de pagination SQL directe possible — plafonné à un volume
    // raisonnable (cohérent avec les autres pages déjà bornées par rôle restreint) plutôt que de
    // charger tout l'historique d'un magasin en mémoire pour le filtrer ensuite.
    const SCOPED_ROLE_MAX_ROWS = 5000;
    const allMatching = await prisma.salesLine.findMany({ where, orderBy: { date: 'desc' }, take: SCOPED_ROLE_MAX_ROWS });
    const scoped = await filterSalesLinesForUser(allMatching, currentUser, posId);
    const total = scoped.length;
    const totalQuantity = scoped.reduce((sum, l) => sum + (l.quantity || 0), 0);
    const totalRevenue = scoped.reduce((sum, l) => sum + (l.revenueExclTax || 0), 0);
    const anyInclTax = scoped.some((l) => l.revenueInclTax !== null && l.revenueInclTax !== undefined);
    const totalRevenueInclTax = anyInclTax ? scoped.reduce((sum, l) => sum + (l.revenueInclTax || 0), 0) : null;
    const lines = scoped.slice(skip, skip + take);

    res.json({
      success: true,
      data: { total, page: parseInt(page, 10) || 1, pageSize: take, totalQuantity, totalRevenue, totalRevenueInclTax, lines },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE /api/reassort/sales-lines - purge les ventes synchronisées localement pour un magasin sur
// une période donnée (ADMIN). Action irréversible : n'efface que la copie locale (SalesLine), pas
// les ventes réelles côté RPOS — une resynchronisation (Paramètres → Synchronisation des ventes)
// permet de les récupérer à nouveau si besoin. Query: shopId (requis), dateStart, dateEnd (requis
// tous les deux pour éviter une purge accidentelle de tout l'historique du magasin).
router.delete('/sales-lines', requireAdmin, async (req, res) => {
  try {
    const { shopId, dateStart, dateEnd } = req.query;
    if (!shopId) return res.status(400).json({ success: false, message: 'shopId requis' });
    if (!dateStart || !dateEnd) {
      return res.status(400).json({ success: false, message: 'dateStart et dateEnd requis (purge totale non autorisée par sécurité)' });
    }

    const result = await prisma.salesLine.deleteMany({
      where: { rposShopId: shopId, date: { gte: new Date(dateStart), lte: new Date(dateEnd) } },
    });

    res.json({ success: true, message: `${result.count} ligne(s) supprimée(s)`, data: { count: result.count } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/sales-lines/departments - résout le rayon (department) de chaque EAN fourni,
// pour regrouper l'affichage de "Ventes synchronisées" par rayon (ADMIN) comme sur les pages
// Historique des commandes et IA & Prédictions. SalesLine ne stocke que l'EAN (une ligne de vente
// individuelle, pas un article catalogué) : le rayon n'existe qu'au niveau du produit RPOS, donc on
// le résout via ProductCache (déjà alimenté par toute génération de proposition passée sur ce
// magasin, cache-aside persistant) + un appel RPOS de repli pour les EAN encore inconnus.
// Query: shopId, posId, eans (CSV). Réponse: { [ean]: { sector, department } }.
router.get('/sales-lines/departments', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    const posId = resolvePosId(req);
    const { eans } = req.query;
    if (!shopId || !posId || !eans) return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte, ou eans manquant' });

    const eanList = [...new Set(eans.split(',').map((e) => e.trim()).filter(Boolean))];
    const byEan = {};
    const EAN_CONCURRENCY = 8;

    await mapWithConcurrency(eanList, EAN_CONCURRENCY, async (ean) => {
      try {
        const product = await getProductByEanCached(posId, shopId, ean);
        if (!product) {
          // Article générique (vente au poids/valeur libre, ex: "GENERIQUE EPICERIE 1576") : pas de
          // fiche produit RPOS (product: null sur sa ligne de vente), mais sa ligne de vente porte
          // quand même un vrai rayon générique — trouvé le 21/09/2026, "il faut faire la différence
          // entre Code article saisi et Code article" (distinction confirmée par l'utilisateur :
          // certains génériques ont un vrai article catalogué, d'autres non, ce qui explique le
          // fourre-tout "Article introuvable" jusqu'ici). Repli sur ce rayon générique réel plutôt
          // qu'un message qui sonne comme une erreur pour un cas parfaitement normal.
          const generic = await rpos.getGenericArticleDepartment(posId, shopId, ean).catch(() => null);
          byEan[ean] = generic
            ? { sector: 'Articles génériques (poids/valeur libre)', department: generic.name }
            : { sector: 'Article générique', department: 'Sans rayon identifié côté RPOS' };
          return;
        }
        const { sector, rayon } = await rpos.getDepartmentHierarchy(posId, product.department?.id);
        byEan[ean] = { sector, department: rayon };
      } catch (err) {
        byEan[ean] = { sector: 'Erreur', department: 'Erreur' };
      }
    });

    res.json({ success: true, data: byEan });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/sales-lines/coverage - pour un magasin, la plus ancienne et la plus récente
// date de vente synchronisée localement (ADMIN), pour visualiser d'un coup d'œil quelle période
// est déjà couverte avant de lancer un nouveau backfill sur une autre période.
router.get('/sales-lines/coverage', requireAdmin, async (req, res) => {
  try {
    const { shopId } = req.query;
    if (!shopId) return res.status(400).json({ success: false, message: 'shopId requis' });

    const [oldest, newest, count] = await Promise.all([
      prisma.salesLine.findFirst({ where: { rposShopId: shopId }, orderBy: { date: 'asc' }, select: { date: true } }),
      prisma.salesLine.findFirst({ where: { rposShopId: shopId }, orderBy: { date: 'desc' }, select: { date: true } }),
      prisma.salesLine.count({ where: { rposShopId: shopId } }),
    ]);

    res.json({ success: true, data: { oldestDate: oldest?.date || null, newestDate: newest?.date || null, count } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/sales-lines/rpos-earliest-available - interroge RPOS pour savoir jusqu'à
// quelle date le magasin a réellement un historique de ventes disponible (ADMIN). RPOS n'expose
// aucune limite de rétention connue à l'avance ("l'API ne dit pas jusqu'où on peut remonter") :
// c'est la seule façon de le savoir, en demandant directement la toute première vente enregistrée.
// Distinct de /sales-lines/coverage (ce qui est déjà en BASE LOCALE) : ici on répond à "combien de
// jours puis-je encore récupérer en plus ?" en comparant à la limite réelle côté serveur.
router.get('/sales-lines/rpos-earliest-available', requireAdmin, async (req, res) => {
  try {
    const { shopId, posId } = req.query;
    if (!shopId || !posId) return res.status(400).json({ success: false, message: 'shopId et posId requis' });

    const earliestDate = await rpos.getEarliestSaleDate(posId, shopId);
    res.json({ success: true, data: { earliestDate } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/servers - liste tous les serveurs RPOS connus, avec leurs magasins et statut
// (ADMIN uniquement).
//
// Par défaut (sans ?refresh=true), les magasins de chaque serveur sont lus depuis la table locale
// Shop (synchronisée automatiquement toutes les heures par shopsSyncJob.js) plutôt qu'interrogés
// en direct sur RPOS : cette route touchait auparavant les 18 serveurs à CHAQUE ouverture de page,
// ce qui la rendait très lente (et bloquante) dès que le réseau/VPN vers RPOS est instable — alors
// que la liste des magasins change très rarement (cf. shopsSyncJob.js). Passez ?refresh=true pour
// forcer un appel RPOS direct (ex: bouton "Actualiser depuis RPOS" côté UI), utile juste après
// l'ajout d'un nouveau magasin qui n'a pas encore été synchronisé.
module.exports = router;
