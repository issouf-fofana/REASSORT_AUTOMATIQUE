// Sous-routeur 'sales' — Consultation des lignes de vente synchronisees en local + couverture.
// Monte dans routes/reassort/index.js sous le prefixe /api/reassort (requireAuth +
// requireSupervisedShop appliques la-bas, pas ici). Ne jamais monter ailleurs.
const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin, resolveShopId, resolvePosId, requireSupervisedShop } = require('../../middleware/auth');
const prisma = require('../../utils/prisma');
const rpos = require('../../services/rposClient');
const { getProductByEanCached } = require('../../services/proposalService');
const { mapWithConcurrency } = require('../../utils/concurrency');

router.get('/sales-lines', requireAdmin, async (req, res) => {
  try {
    const { shopId, dateStart, dateEnd, ean, page, pageSize } = req.query;
    if (!shopId) return res.status(400).json({ success: false, message: 'shopId requis' });

    const where = { rposShopId: shopId };
    if (dateStart || dateEnd) {
      where.date = {};
      if (dateStart) where.date.gte = new Date(dateStart);
      if (dateEnd) where.date.lte = new Date(dateEnd);
    }
    if (ean) where.ean = ean;

    const take = Math.min(parseInt(pageSize, 10) || 100, 500);
    const skip = ((parseInt(page, 10) || 1) - 1) * take;

    const [total, lines, aggregate] = await Promise.all([
      prisma.salesLine.count({ where }),
      prisma.salesLine.findMany({ where, orderBy: { date: 'desc' }, take, skip }),
      prisma.salesLine.aggregate({ where, _sum: { quantity: true, revenueExclTax: true, revenueInclTax: true } }),
    ]);

    res.json({
      success: true,
      data: {
        total,
        page: parseInt(page, 10) || 1,
        pageSize: take,
        totalQuantity: aggregate._sum.quantity || 0,
        totalRevenue: aggregate._sum.revenueExclTax || 0,
        // null si aucune ligne de la sélection n'a de TTC connu (lignes synchronisées avant
        // l'ajout de ce champ) — distingué de 0 pour ne pas afficher un total TTC faux.
        totalRevenueInclTax: aggregate._sum.revenueInclTax,
        lines,
      },
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
router.get('/sales-lines/departments', requireAdmin, async (req, res) => {
  try {
    const { shopId, posId, eans } = req.query;
    if (!shopId || !posId || !eans) return res.status(400).json({ success: false, message: 'shopId, posId et eans sont requis' });

    const eanList = [...new Set(eans.split(',').map((e) => e.trim()).filter(Boolean))];
    const byEan = {};
    const EAN_CONCURRENCY = 8;

    await mapWithConcurrency(eanList, EAN_CONCURRENCY, async (ean) => {
      try {
        const product = await getProductByEanCached(posId, shopId, ean);
        if (!product) { byEan[ean] = { sector: 'Article introuvable', department: 'Article introuvable' }; return; }
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
