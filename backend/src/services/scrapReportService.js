/**
 * Rapport de casse multi-magasins (demande explicite du 21/10/2026) : "les casse des article on
 * doit voir un bouton sur la sidebare" — contrairement à overstockReportService.js (casse limitée
 * aux articles déjà en surstock), ce rapport couvre TOUS les articles ayant eu de la casse sur la
 * période, qu'ils soient en surstock ou non. Lecture locale directe de StockMove (alimentée par
 * stockMoveSyncJob.js), jamais d'appel RPOS.
 *
 * Filtre par TYPE de mouvement ajouté le 21/10/2026 (demande explicite : "tu prend que type de
 * mouvement car il ya plusieur type de mouvement... je veux qui tu affiche les type de mouvement
 * pour les casse") — découvert en creusant les vraies données : le drapeau StockMove.isScrap posé
 * par RPOS est INCOHÉRENT d'un magasin à l'autre pour un même libellé de type (ex: "DEMAR : AVARI -
 * CASSE AVARIE" marqué is_scrap=true dans un magasin, false dans un autre). Plus fiable de filtrer
 * directement par typeLabel (texte RPOS, stable) que par ce drapeau mal réglé côté RPOS.
 */
const prisma = require('../utils/prisma');

const DEFAULT_LOOKBACK_DAYS = 90;

// Liste FIXE des types de mouvement considérés comme de la casse par défaut (demande confirmée le
// 21/10/2026, après revue des vraies données : "oui tu met les 6 types") — mots-clés recherchés
// dans StockMove.typeLabel (contains, insensible à la casse), pas une correspondance exacte : les
// libellés RPOS varient légèrement en ponctuation/espaces d'un magasin à l'autre pour un même type
// logique (ex: "DEMAR : AVARI - CASSE AVARIE  -   -1"). Exclut volontairement "client" seul (aurait
// aussi attrapé "Cadeau client"/"CADEAUX CLIENTS", qui ne sont pas des pertes) — "CASSE CLIENTELE"
// matche déjà via le mot "CASSE".
const DEFAULT_SCRAP_TYPE_KEYWORDS = ['CASSE', 'AVARI', 'PERIM', 'MANUT', 'EXPER'];

function isDefaultScrapType(typeLabel) {
  if (!typeLabel) return false;
  const upper = typeLabel.toUpperCase();
  return DEFAULT_SCRAP_TYPE_KEYWORDS.some((kw) => upper.includes(kw));
}

/**
 * Tous les types de mouvement distincts vus sur la période pour le périmètre magasins accessible —
 * sert à peupler le sélecteur de types sur la page Casse (demande explicite : "met un litre pour
 * affiche ses donner du filtre"). Inclut TOUS les types (pas seulement ceux is_scrap=true ou
 * correspondant aux mots-clés par défaut), pour que l'utilisateur garde la main complète plutôt que
 * de dépendre d'une présélection qui pourrait rater un type mal nommé.
 */
async function getMovementTypes(allowedShopIds, { lookbackDays = DEFAULT_LOOKBACK_DAYS } = {}) {
  if (Array.isArray(allowedShopIds) && !allowedShopIds.length) {
    return { found: false, message: 'Aucun magasin accessible pour ce compte.' };
  }
  const shops = await prisma.shop.findMany({
    where: allowedShopIds !== null ? { rposShopId: { in: allowedShopIds } } : {},
    select: { rposShopId: true },
  });
  if (!shops.length) return { found: true, types: [] };

  const shopIds = shops.map((s) => s.rposShopId);
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

  const rows = await prisma.stockMove.groupBy({
    by: ['typeLabel'],
    where: { rposShopId: { in: shopIds }, date: { gte: since } },
    _count: { _all: true },
  });

  const types = rows
    .map((r) => ({ typeLabel: r.typeLabel, moveCount: r._count._all, isDefaultScrapType: isDefaultScrapType(r.typeLabel) }))
    .sort((a, b) => (b.isDefaultScrapType ? 1 : 0) - (a.isDefaultScrapType ? 1 : 0) || b.moveCount - a.moveCount);

  return { found: true, lookbackDays, types };
}

/**
 * Casse agrégée par (magasin, article) sur la période demandée, pour le périmètre magasins
 * accessible au compte (ADMIN : tous ; SUPERVISOR : son périmètre ; mono-magasin : son seul
 * magasin — résolu par l'appelant, cf. resolveOverstockShopFilter réutilisé par la route).
 */
async function getScrapOverview(allowedShopIds, { lookbackDays = DEFAULT_LOOKBACK_DAYS, typeLabels } = {}) {
  if (Array.isArray(allowedShopIds) && !allowedShopIds.length) {
    return { found: false, message: 'Aucun magasin accessible pour ce compte.' };
  }

  const shops = await prisma.shop.findMany({
    where: allowedShopIds !== null ? { rposShopId: { in: allowedShopIds } } : {},
    select: { rposShopId: true, reference: true, name: true },
  });
  if (!shops.length) return { found: true, lookbackDays, shopCount: 0, articleCount: 0, totalQuantity: 0, articles: [] };

  const shopIds = shops.map((s) => s.rposShopId);
  const shopById = new Map(shops.map((s) => [s.rposShopId, s]));
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

  // Filtre par type exact choisi par l'utilisateur (demande explicite du 21/10/2026 : "si je mets
  // perimé il doit affiché, si je met casse il me donne") — remplace le drapeau isScrap (découvert
  // incohérent d'un magasin à l'autre pour un même type) par une correspondance exacte sur les
  // libellés réellement présents, cochés dans le sélecteur de la page. Sans sélection explicite,
  // retombe sur la liste de mots-clés par défaut ci-dessus (comportement proche de l'ancien isScrap,
  // en plus fiable).
  const typeFilter = Array.isArray(typeLabels) && typeLabels.length
    ? { typeLabel: { in: typeLabels } }
    : { OR: DEFAULT_SCRAP_TYPE_KEYWORDS.map((kw) => ({ typeLabel: { contains: kw, mode: 'insensitive' } })) };

  const moves = await prisma.stockMove.findMany({
    where: { rposShopId: { in: shopIds }, date: { gte: since }, ...typeFilter },
    select: { rposShopId: true, ean: true, label: true, quantity: true, date: true },
  });

  // Prix de vente pour l'affichage (valeur perdue estimée) : lu depuis ProductCache, déjà
  // synchronisé par ailleurs — jamais un appel RPOS supplémentaire ici.
  const eans = [...new Set(moves.map((m) => m.ean))];
  const priceRows = eans.length
    ? await prisma.productCache.findMany({ where: { rposShopId: { in: shopIds }, ean: { in: eans } }, select: { rposShopId: true, ean: true, sellingPrice: true } })
    : [];
  const priceByKey = new Map(priceRows.map((p) => [`${p.rposShopId}:${p.ean}`, p.sellingPrice]));

  const byKey = new Map(); // `${rposShopId}:${ean}` -> { ... }
  for (const m of moves) {
    const key = `${m.rposShopId}:${m.ean}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        rposShopId: m.rposShopId,
        ean: m.ean,
        label: m.label,
        quantity: 0,
        moveCount: 0,
        lastDate: m.date,
      });
    }
    const entry = byKey.get(key);
    // quantity est négatif pour une sortie de stock (StockMove.quantity = delta signé) : affiché en
    // positif ici, cohérent avec overstockReportService.js.
    entry.quantity += Math.abs(m.quantity);
    entry.moveCount += 1;
    if (m.date > entry.lastDate) entry.lastDate = m.date;
    if (!entry.label && m.label) entry.label = m.label;
  }

  const articles = [...byKey.values()]
    .map((e) => {
      const shop = shopById.get(e.rposShopId);
      const sellingPrice = priceByKey.get(`${e.rposShopId}:${e.ean}`) ?? null;
      return {
        rposShopId: e.rposShopId,
        shopReference: shop?.reference || null,
        shopName: shop?.name || null,
        ean: e.ean,
        label: e.label,
        sellingPrice,
        quantity: e.quantity,
        moveCount: e.moveCount,
        estimatedLoss: sellingPrice !== null ? Math.round(sellingPrice * e.quantity) : null,
        lastDate: e.lastDate.toISOString(),
      };
    })
    .sort((a, b) => b.quantity - a.quantity);

  return {
    found: true,
    lookbackDays,
    since: since.toISOString(),
    shopCount: new Set(articles.map((a) => a.rposShopId)).size,
    articleCount: articles.length,
    totalQuantity: articles.reduce((s, a) => s + a.quantity, 0),
    totalEstimatedLoss: articles.reduce((s, a) => s + (a.estimatedLoss || 0), 0),
    articles,
  };
}

module.exports = { getScrapOverview, getMovementTypes, isDefaultScrapType, DEFAULT_SCRAP_TYPE_KEYWORDS, DEFAULT_LOOKBACK_DAYS };
