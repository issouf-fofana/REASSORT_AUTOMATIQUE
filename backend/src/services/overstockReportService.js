/**
 * Rapport de surstock multi-magasins (demande explicite du 21/10/2026) : "sortir pour les magasins
 * chaque magasin les articles en surstock", "identifier les articles que les magasins ont en commun
 * en surstock", "si ils les cassent sortir la casse de ces articles sur les 3 dernières mois",
 * exportable en CSV avec vente moyenne jour/semaine/mois, prix de vente, nom, code EAN.
 *
 * Définition du surstock : IDENTIQUE à getOverstockArticles (chatbotToolsService.js) — un article
 * dont le stock couvre plus de `minWeeksOfCoverage` semaines de vente moyenne, calculé à partir de
 * la DERNIÈRE proposition générée pour chaque magasin (ProposalLine.stockAtGeneration /
 * ProposalLine.avgWeeklySales), pas d'un nouveau calcul distinct. Seuil par défaut choisi à 2
 * semaines (pas 6, le seuil du chatbot jugé trop élevé le 21/10/2026 : "6 semaine est trop") —
 * réglable par appelant, jamais codé en dur ailleurs qu'ici.
 */
const prisma = require('../utils/prisma');

const DEFAULT_MIN_WEEKS_OF_COVERAGE = 2;
const SCRAP_LOOKBACK_DAYS = 90; // "3 dernières mois", demande explicite

async function getLatestProposalIdsByShop(shopIds) {
  // Un seul aller-retour DB pour tous les magasins plutôt qu'une requête par magasin (findFirst en
  // boucle) : groupBy + max(generatedAt), puis on résout l'id réel de chaque proposition la plus
  // récente. Même esprit que la parallélisation déjà appliquée à getDashboardSummaryAllShops
  // (demande du 20/10/2026 sur une page voisine) — éviter de réintroduire un N+1/série ici.
  const latestDates = await prisma.proposal.groupBy({
    by: ['rposShopId'],
    where: { rposShopId: { in: shopIds } },
    _max: { generatedAt: true },
  });
  const pairs = latestDates.filter((d) => d._max.generatedAt).map((d) => ({ rposShopId: d.rposShopId, generatedAt: d._max.generatedAt }));
  if (!pairs.length) return new Map();

  const proposals = await prisma.proposal.findMany({
    where: { OR: pairs.map((p) => ({ rposShopId: p.rposShopId, generatedAt: p.generatedAt })) },
    select: { id: true, rposShopId: true },
  });
  return new Map(proposals.map((p) => [p.rposShopId, p.id]));
}

/**
 * Articles en surstock par magasin (périmètre accessible au compte), avec vente moyenne
 * jour/semaine/mois dérivée de la même valeur avgWeeklySales déjà stockée (aucune nouvelle mesure,
 * juste /7 et *(365/12/7) — demande explicite "vente moyen par jour semaine et mois").
 */
async function getOverstockByShop(allowedShopIds, { minWeeksOfCoverage = DEFAULT_MIN_WEEKS_OF_COVERAGE } = {}) {
  if (Array.isArray(allowedShopIds) && !allowedShopIds.length) {
    return { found: false, message: 'Aucun magasin accessible pour ce compte.' };
  }

  const shops = await prisma.shop.findMany({
    where: allowedShopIds !== null ? { rposShopId: { in: allowedShopIds } } : {},
    select: { rposShopId: true, reference: true, name: true },
  });
  if (!shops.length) return { found: true, minWeeksOfCoverage, shopCount: 0, articleCount: 0, articles: [] };

  const shopIds = shops.map((s) => s.rposShopId);
  const shopById = new Map(shops.map((s) => [s.rposShopId, s]));
  const latestProposalIdByShop = await getLatestProposalIdsByShop(shopIds);
  const proposalIds = [...latestProposalIdByShop.values()];
  if (!proposalIds.length) {
    return { found: true, minWeeksOfCoverage, shopCount: 0, articleCount: 0, articles: [], message: 'Aucune proposition générée pour les magasins accessibles.' };
  }

  // id -> rposShopId, pour ré-attribuer chaque ligne à son magasin après la requête groupée.
  const shopIdByProposalId = new Map([...latestProposalIdByShop.entries()].map(([shopId, proposalId]) => [proposalId, shopId]));

  const lines = await prisma.proposalLine.findMany({
    where: { proposalId: { in: proposalIds } },
    select: {
      proposalId: true,
      ean: true,
      label: true,
      department: true,
      stockAtGeneration: true,
      avgWeeklySales: true,
      sellingPrice: true,
    },
  });

  const articles = lines
    .filter((l) => (l.avgWeeklySales || 0) > 0 && (l.stockAtGeneration || 0) / l.avgWeeklySales >= minWeeksOfCoverage)
    .map((l) => {
      const rposShopId = shopIdByProposalId.get(l.proposalId);
      const shop = shopById.get(rposShopId);
      const avgWeeklySales = Math.round(l.avgWeeklySales * 10) / 10;
      return {
        rposShopId,
        shopReference: shop?.reference || null,
        shopName: shop?.name || null,
        ean: l.ean,
        label: l.label,
        department: l.department,
        stock: l.stockAtGeneration || 0,
        sellingPrice: l.sellingPrice || null,
        avgDailySales: Math.round((avgWeeklySales / 7) * 100) / 100,
        avgWeeklySales,
        avgMonthlySales: Math.round(avgWeeklySales * (365 / 12 / 7) * 10) / 10,
        weeksOfCoverage: Math.round((l.stockAtGeneration / l.avgWeeklySales) * 10) / 10,
      };
    })
    .sort((a, b) => b.weeksOfCoverage - a.weeksOfCoverage);

  return {
    found: true,
    minWeeksOfCoverage,
    shopCount: new Set(articles.map((a) => a.rposShopId)).size,
    articleCount: articles.length,
    articles,
  };
}

/**
 * Articles en surstock dans PLUSIEURS magasins à la fois (demande explicite : "identifier les
 * articles que les magasins ont en commun en surstock") — regroupe la sortie de getOverstockByShop
 * par EAN, ne garde que les EAN présents dans >= 2 magasins distincts.
 */
function groupCommonOverstock(articles) {
  const byEan = new Map();
  for (const a of articles) {
    if (!byEan.has(a.ean)) byEan.set(a.ean, { ean: a.ean, label: a.label, department: a.department, sellingPrice: a.sellingPrice, shops: [] });
    const entry = byEan.get(a.ean);
    // label/sellingPrice peuvent légèrement varier d'un magasin à l'autre (prix régional, libellé
    // RPOS modifié) : on garde la première valeur rencontrée pour l'affichage groupé, chaque ligne
    // par magasin ci-dessous conserve ses propres valeurs exactes.
    entry.shops.push({
      rposShopId: a.rposShopId,
      shopReference: a.shopReference,
      shopName: a.shopName,
      stock: a.stock,
      sellingPrice: a.sellingPrice,
      avgDailySales: a.avgDailySales,
      avgWeeklySales: a.avgWeeklySales,
      avgMonthlySales: a.avgMonthlySales,
      weeksOfCoverage: a.weeksOfCoverage,
    });
  }
  return [...byEan.values()]
    .filter((e) => e.shops.length >= 2)
    .sort((a, b) => b.shops.length - a.shops.length);
}

/**
 * Casse sur les 3 derniers mois pour un lot d'EAN à travers plusieurs magasins (demande explicite :
 * "si tu les casse sortir la casse de ces articles sur les 3 dernières mois") — lecture locale
 * directe de StockMove (alimentée par stockMoveSyncJob.js, cf. stockMoveAnalysisService.js qui fait
 * de même pour un seul article à la fois) : jamais d'appel RPOS ici, une agrégation groupBy en masse
 * sur 90 jours pour potentiellement des dizaines d'articles × dizaines de magasins serait bien trop
 * coûteuse en aller-retours réseau RPOS un par un.
 */
async function getScrapSummaryForEans(shopEanPairs) {
  if (!shopEanPairs.length) return new Map();

  const since = new Date(Date.now() - SCRAP_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const shopIds = [...new Set(shopEanPairs.map((p) => p.rposShopId))];
  const eans = [...new Set(shopEanPairs.map((p) => p.ean))];

  // Filtré large (tous les (shop, ean) demandés) puis réparti en mémoire par couple exact : Prisma
  // ne permet pas nativement un "IN d'une liste de paires" propre sans OR explicite, inutile ici vu
  // le nombre de lignes modeste (quelques dizaines d'articles communs au plus).
  const rows = await prisma.stockMove.findMany({
    where: { rposShopId: { in: shopIds }, ean: { in: eans }, isScrap: true, date: { gte: since } },
    select: { rposShopId: true, ean: true, quantity: true, date: true },
  });

  const byKey = new Map(); // `${rposShopId}:${ean}` -> { scrapQuantity, scrapCount, lastScrapDate }
  for (const r of rows) {
    const key = `${r.rposShopId}:${r.ean}`;
    if (!byKey.has(key)) byKey.set(key, { scrapQuantity: 0, scrapCount: 0, lastScrapDate: null });
    const entry = byKey.get(key);
    // quantity est négatif pour une sortie de stock (cohérent avec StockMove.quantity = delta signé,
    // cf. le bug corrigé le 20/10/2026 sur les arrivages) : on affiche une quantité perdue positive.
    entry.scrapQuantity += Math.abs(r.quantity);
    entry.scrapCount += 1;
    if (!entry.lastScrapDate || r.date > entry.lastScrapDate) entry.lastScrapDate = r.date;
  }
  return byKey;
}

/**
 * Rapport complet prêt pour affichage/export (demande explicite du 21/10/2026) : combine
 * getOverstockByShop + groupCommonOverstock + la casse 3 mois des seuls articles communs (pas tous,
 * pour ne pas payer le coût d'agrégation sur des articles non pertinents pour cette question).
 */
async function getOverstockReport(allowedShopIds, { minWeeksOfCoverage = DEFAULT_MIN_WEEKS_OF_COVERAGE } = {}) {
  const byShop = await getOverstockByShop(allowedShopIds, { minWeeksOfCoverage });
  if (!byShop.found) return byShop;

  const common = groupCommonOverstock(byShop.articles);

  const pairs = common.flatMap((e) => e.shops.map((s) => ({ rposShopId: s.rposShopId, ean: e.ean })));
  const scrapByKey = await getScrapSummaryForEans(pairs);

  const commonWithScrap = common.map((e) => ({
    ...e,
    shops: e.shops.map((s) => {
      const scrap = scrapByKey.get(`${s.rposShopId}:${e.ean}`) || { scrapQuantity: 0, scrapCount: 0, lastScrapDate: null };
      return {
        ...s,
        scrapQuantity90d: scrap.scrapQuantity,
        scrapMoveCount90d: scrap.scrapCount,
        lastScrapDate: scrap.lastScrapDate ? scrap.lastScrapDate.toISOString() : null,
      };
    }),
  }));

  return {
    found: true,
    minWeeksOfCoverage,
    scrapLookbackDays: SCRAP_LOOKBACK_DAYS,
    shopCount: byShop.shopCount,
    articleCount: byShop.articleCount,
    articlesByShop: byShop.articles,
    commonArticleCount: commonWithScrap.length,
    commonArticles: commonWithScrap,
  };
}

module.exports = { getOverstockByShop, groupCommonOverstock, getScrapSummaryForEans, getOverstockReport, DEFAULT_MIN_WEEKS_OF_COVERAGE, SCRAP_LOOKBACK_DAYS };
