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
// Seuil de persistance pour "toujours en surstock" sur une période (demande explicite du
// 21/10/2026 : "je dois avoir les article on son toujour en surstok" + confirmé "seuil souple
// ≥90%" plutôt que 100% strict — tolère une génération manquée/en panne un jour sans faire sortir
// l'article de la liste.
const ALWAYS_OVERSTOCK_THRESHOLD_RATIO = 0.9;

/**
 * Étendue réelle de l'historique de propositions disponible (demande explicite du 21/10/2026 :
 * "quand je veux faire le filtre on doit me dire j'ai des donner de quel periode... si je clique de
 * 10/10/2026 alors que les donner commence de 12 le 10 doit etre grisé") — une proposition est
 * générée chaque nuit par magasin et jamais supprimée (NIGHTLY_PROPOSAL_CRON, cf.
 * cronManager.js/systemConfigService.js), donc cette date correspond à la plus ancienne génération
 * encore en base pour les magasins accessibles à ce compte, pas une fenêtre fixe arbitraire.
 */
async function getOverstockDataAvailability(allowedShopIds) {
  if (Array.isArray(allowedShopIds) && !allowedShopIds.length) {
    return { found: false, message: 'Aucun magasin accessible pour ce compte.' };
  }
  const where = allowedShopIds !== null ? { rposShopId: { in: allowedShopIds } } : {};
  const [oldest, newest] = await Promise.all([
    prisma.proposal.findFirst({ where, orderBy: { generatedAt: 'asc' }, select: { generatedAt: true } }),
    prisma.proposal.findFirst({ where, orderBy: { generatedAt: 'desc' }, select: { generatedAt: true } }),
  ]);
  if (!oldest || !newest) return { found: false, message: 'Aucune proposition générée pour les magasins accessibles.' };
  return { found: true, oldestDate: oldest.generatedAt.toISOString(), newestDate: newest.generatedAt.toISOString() };
}

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

// Fenêtre de calcul de la vente moyenne directement depuis les ventes brutes (SalesLine), pour les
// magasins SANS proposition générée (demande explicite du 21/10/2026 : "fait les calcule en
// fonction des vente... il faut faire dans la base et il soit affiché faut pas au chargement il
// fait les calcule" — l'utilisateur a confirmé avoir lui-même désactivé la génération nocturne sur
// la plupart des magasins, ce n'est donc pas un bug à corriger côté génération, mais Surstock doit
// quand même pouvoir les couvrir). Même fenêtre que le reste du calcul existant (dérivation
// jour/semaine/mois depuis UNE SEULE moyenne de base, confirmé "il faut faire comme tu fait
// actuellement") : 30 jours glissants.
const SALES_FALLBACK_LOOKBACK_DAYS = 30;

/**
 * Articles en surstock calculés DIRECTEMENT depuis le stock (ProductCache) et les ventes
 * (SalesLine) synchronisés — pour les magasins qui n'ont AUCUNE proposition générée (fallback de
 * getOverstockByShop ci-dessous). Même règle de surstock et même forme de retour que la version
 * basée sur les propositions, pour que l'appelant puisse fusionner les deux sans distinction.
 * department toujours null ici (demande confirmée : "rayon vide... évite les appels RPOS en
 * masse" — le nom de rayon n'existe en local que via ProposalLine, qui n'existe pas pour ces
 * magasins par définition).
 */
async function computeOverstockFromSales(shopIds, shopById, { minWeeksOfCoverage = DEFAULT_MIN_WEEKS_OF_COVERAGE, lookbackDays = SALES_FALLBACK_LOOKBACK_DAYS } = {}) {
  if (!shopIds.length) return [];

  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

  const [productRows, salesByEan] = await Promise.all([
    prisma.productCache.findMany({
      where: { rposShopId: { in: shopIds }, orderable: true },
      select: { rposShopId: true, ean: true, stock: true, sellingPrice: true },
    }),
    prisma.salesLine.groupBy({
      by: ['rposShopId', 'ean'],
      where: { rposShopId: { in: shopIds }, date: { gte: since } },
      _sum: { quantity: true },
    }),
  ]);

  // Même seuil "article générique" que proposalService.js/chatbotToolsService.js
  // (excludeGenericArticlesBelowPrice, défaut 2 CFA) : un prix très bas signale un agrégat de
  // rayon (ex: "FRUITS & LEGUMES" vendu au poids), pas un article réel — sa "quantité vendue" en
  // base est en réalité un poids ou une valeur monétaire, jamais un nombre d'unités exploitable.
  const GENERIC_ARTICLE_PRICE_THRESHOLD = 2;

  const salesByKey = new Map(salesByEan.map((s) => [`${s.rposShopId}:${s.ean}`, s._sum.quantity || 0]));

  const articles = [];
  for (const p of productRows) {
    if ((p.sellingPrice || 0) < GENERIC_ARTICLE_PRICE_THRESHOLD) continue;
    const totalQty = salesByKey.get(`${p.rposShopId}:${p.ean}`) || 0;
    const avgWeeklySales = Math.round(((totalQty / lookbackDays) * 7) * 10) / 10;
    if (avgWeeklySales <= 0) continue;
    const weeksOfCoverage = (p.stock || 0) / avgWeeklySales;
    if (weeksOfCoverage < minWeeksOfCoverage) continue;

    const shop = shopById.get(p.rposShopId);
    articles.push({
      rposShopId: p.rposShopId,
      shopReference: shop?.reference || null,
      shopName: shop?.name || null,
      ean: p.ean,
      label: null, // résolu séparément via SalesLine.label (voir ci-dessous) ou laissé vide
      department: null,
      stock: p.stock || 0,
      sellingPrice: p.sellingPrice || null,
      avgDailySales: Math.round((avgWeeklySales / 7) * 100) / 100,
      avgWeeklySales,
      avgMonthlySales: Math.round(avgWeeklySales * (365 / 12 / 7) * 10) / 10,
      weeksOfCoverage: Math.round(weeksOfCoverage * 10) / 10,
    });
  }

  if (!articles.length) return articles;

  // Nom de l'article : SalesLine.label (dernière vente connue pour cet EAN dans ce magasin) —
  // ProductCache ne stocke pas de libellé, uniquement l'EAN. Un seul aller-retour groupé plutôt
  // qu'une requête par article.
  const eansNeedingLabel = articles.map((a) => ({ rposShopId: a.rposShopId, ean: a.ean }));
  const labelRows = await prisma.salesLine.findMany({
    where: { OR: eansNeedingLabel.map((e) => ({ rposShopId: e.rposShopId, ean: e.ean })) },
    select: { rposShopId: true, ean: true, label: true },
    distinct: ['rposShopId', 'ean'],
  });
  const labelByKey = new Map(labelRows.filter((r) => r.label).map((r) => [`${r.rposShopId}:${r.ean}`, r.label]));
  for (const a of articles) {
    a.label = labelByKey.get(`${a.rposShopId}:${a.ean}`) || a.ean;
  }

  return articles.sort((a, b) => b.weeksOfCoverage - a.weeksOfCoverage);
}

/**
 * Articles en surstock par magasin (périmètre accessible au compte), avec vente moyenne
 * jour/semaine/mois dérivée de la même valeur avgWeeklySales déjà stockée (aucune nouvelle mesure,
 * juste /7 et *(365/12/7) — demande explicite "vente moyen par jour semaine et mois"). Un magasin
 * SANS proposition générée (génération nocturne désactivée, demande explicite du 21/10/2026) passe
 * par computeOverstockFromSales ci-dessus à la place — jamais absent du rapport simplement parce
 * qu'aucune proposition n'a jamais tourné pour lui.
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

  // id -> rposShopId, pour ré-attribuer chaque ligne à son magasin après la requête groupée.
  const shopIdByProposalId = new Map([...latestProposalIdByShop.entries()].map(([shopId, proposalId]) => [proposalId, shopId]));

  const lines = proposalIds.length
    ? await prisma.proposalLine.findMany({
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
      })
    : [];

  const articlesFromProposals = lines
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
    });

  // Magasins accessibles SANS aucune proposition (jamais générée, ou génération désactivée) :
  // calculés depuis les ventes/stock directement plutôt qu'absents du rapport.
  const shopIdsWithoutProposal = shopIds.filter((id) => !latestProposalIdByShop.has(id));
  const articlesFromSales = await computeOverstockFromSales(shopIdsWithoutProposal, shopById, { minWeeksOfCoverage });

  const articles = [...articlesFromProposals, ...articlesFromSales].sort((a, b) => b.weeksOfCoverage - a.weeksOfCoverage);

  return {
    found: true,
    minWeeksOfCoverage,
    shopCount: new Set(articles.map((a) => a.rposShopId)).size,
    articleCount: articles.length,
    articles,
  };
}

/**
 * Articles en surstock sur une PÉRIODE choisie (demande explicite du 21/10/2026 : "si moi meme je
 * veux le surstok sur une periode comment je peux faire le filtre", confirmé "historique : quels
 * articles étaient en surstock à un moment donné") — contrairement à getOverstockByShop (snapshot
 * de la toute dernière proposition), parcourt TOUTES les propositions générées dans [start, end]
 * pour chaque magasin et calcule, par article, combien de fois il était en surstock sur combien de
 * propositions générées — base du calcul "toujours en surstock" ci-dessous.
 */
async function getOverstockOverPeriod(allowedShopIds, { minWeeksOfCoverage = DEFAULT_MIN_WEEKS_OF_COVERAGE, start, end } = {}) {
  if (Array.isArray(allowedShopIds) && !allowedShopIds.length) {
    return { found: false, message: 'Aucun magasin accessible pour ce compte.' };
  }
  if (!start || !end) {
    return { found: false, message: 'Paramètres start et end (dates) requis pour une analyse sur période.' };
  }

  const shops = await prisma.shop.findMany({
    where: allowedShopIds !== null ? { rposShopId: { in: allowedShopIds } } : {},
    select: { rposShopId: true, reference: true, name: true },
  });
  if (!shops.length) return { found: true, minWeeksOfCoverage, shopCount: 0, articleCount: 0, articles: [], persistentArticles: [] };

  const shopIds = shops.map((s) => s.rposShopId);
  const shopById = new Map(shops.map((s) => [s.rposShopId, s]));

  const proposals = await prisma.proposal.findMany({
    where: { rposShopId: { in: shopIds }, generatedAt: { gte: new Date(start), lte: new Date(end) } },
    select: { id: true, rposShopId: true, generatedAt: true },
  });
  if (!proposals.length) {
    return { found: true, minWeeksOfCoverage, shopCount: 0, articleCount: 0, articles: [], persistentArticles: [], trendPoints: [], message: 'Aucune proposition générée sur cette période pour les magasins accessibles.' };
  }

  const shopIdByProposalId = new Map(proposals.map((p) => [p.id, p.rposShopId]));
  // Jour (YYYY-MM-DD) de génération de chaque proposition — base du graphique d'évolution ci-dessous
  // (demande explicite du 21/10/2026 : "je veux le style... graphique en haut" inspiré d'un tableau
  // de bord avec courbe de tendance). Une proposition est générée une fois par nuit par magasin,
  // donc ce jour identifie naturellement un point de la courbe.
  const dayByProposalId = new Map(proposals.map((p) => [p.id, p.generatedAt.toISOString().slice(0, 10)]));
  // Nombre de propositions générées par magasin sur la période : dénominateur du ratio de
  // persistance ci-dessous (un magasin ouvert depuis peu ou avec des générations manquées a moins
  // de propositions que la pleine fenêtre, le ratio reste correct relativement à SES propositions).
  const proposalCountByShop = new Map();
  for (const p of proposals) proposalCountByShop.set(p.rposShopId, (proposalCountByShop.get(p.rposShopId) || 0) + 1);

  const lines = await prisma.proposalLine.findMany({
    where: { proposalId: { in: proposals.map((p) => p.id) } },
    select: { proposalId: true, ean: true, label: true, department: true, stockAtGeneration: true, avgWeeklySales: true, sellingPrice: true },
  });

  // Agrégation par (magasin, ean) : combien de propositions sur la période avaient cet article EN
  // SURSTOCK, et les dernières valeurs connues (stock/vente/prix) pour l'affichage. En parallèle,
  // agrégation par JOUR : nombre d'articles distincts (magasin+ean confondus) en surstock ce
  // jour-là, pour la courbe de tendance.
  const byShopEan = new Map(); // `${rposShopId}:${ean}` -> { overstockCount, latest: {...} }
  const overstockEansByDay = new Map(); // 'YYYY-MM-DD' -> Set<`${rposShopId}:${ean}`>
  for (const l of lines) {
    const rposShopId = shopIdByProposalId.get(l.proposalId);
    const isOverstocked = (l.avgWeeklySales || 0) > 0 && (l.stockAtGeneration || 0) / l.avgWeeklySales >= minWeeksOfCoverage;
    if (!isOverstocked) continue;
    const key = `${rposShopId}:${l.ean}`;
    if (!byShopEan.has(key)) byShopEan.set(key, { rposShopId, ean: l.ean, overstockCount: 0, latest: null });
    const entry = byShopEan.get(key);
    entry.overstockCount += 1;
    // "latest" : la dernière ligne rencontrée l'emporte (lines n'est pas garanti trié par date, mais
    // peu importe ici — juste besoin d'UN jeu de valeurs représentatif pour l'affichage, le ratio de
    // persistance est le chiffre qui compte réellement, pas la valeur exacte affichée à côté).
    entry.latest = l;

    const day = dayByProposalId.get(l.proposalId);
    if (!overstockEansByDay.has(day)) overstockEansByDay.set(day, new Set());
    overstockEansByDay.get(day).add(key);
  }

  const trendPoints = [...overstockEansByDay.entries()]
    .map(([date, set]) => ({ date, count: set.size }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const shopProposalDenominator = (rposShopId) => proposalCountByShop.get(rposShopId) || 1;

  const articles = [...byShopEan.values()].map((e) => {
    const shop = shopById.get(e.rposShopId);
    const l = e.latest;
    const avgWeeklySales = Math.round((l.avgWeeklySales || 0) * 10) / 10;
    const denom = shopProposalDenominator(e.rposShopId);
    return {
      rposShopId: e.rposShopId,
      shopReference: shop?.reference || null,
      shopName: shop?.name || null,
      ean: e.ean,
      label: l.label,
      department: l.department,
      stock: l.stockAtGeneration || 0,
      sellingPrice: l.sellingPrice || null,
      avgDailySales: Math.round((avgWeeklySales / 7) * 100) / 100,
      avgWeeklySales,
      avgMonthlySales: Math.round(avgWeeklySales * (365 / 12 / 7) * 10) / 10,
      weeksOfCoverage: avgWeeklySales > 0 ? Math.round(((l.stockAtGeneration || 0) / avgWeeklySales) * 10) / 10 : null,
      overstockCount: e.overstockCount,
      proposalCount: denom,
      overstockRatio: Math.round((e.overstockCount / denom) * 100) / 100,
    };
  }).sort((a, b) => b.overstockRatio - a.overstockRatio || b.weeksOfCoverage - a.weeksOfCoverage);

  // Magasins accessibles SANS AUCUNE proposition sur la période (génération désactivée, confirmé
  // par l'utilisateur le 21/10/2026) : une analyse "toujours en surstock" n'a pas de sens pour eux
  // (pas de propositions successives à comparer), mais ils ont quand même du stock/des ventes
  // connus — mieux vaut les montrer sur "Par magasin"/"Surstock commun" avec une photo du moment
  // (comme la vue "situation actuelle") que de les faire disparaître entièrement du mode période
  // (confirmé explicitement : "Oui, les inclure quand même"). overstockRatio/overstockCount restent
  // undefined pour ces lignes — le frontend sait déjà traiter overstockRatio optionnel (fmtPct
  // affiche '—' si absent), jamais une persistance inventée à partir d'une seule photo.
  const shopIdsWithProposalInPeriod = new Set(proposals.map((p) => p.rposShopId));
  const shopIdsWithoutProposalInPeriod = shopIds.filter((id) => !shopIdsWithProposalInPeriod.has(id));
  const salesFallbackArticles = await computeOverstockFromSales(shopIdsWithoutProposalInPeriod, shopById, { minWeeksOfCoverage });

  const allArticles = [...articles, ...salesFallbackArticles].sort((a, b) => {
    const ar = a.overstockRatio ?? -1;
    const br = b.overstockRatio ?? -1;
    return br - ar || (b.weeksOfCoverage ?? 0) - (a.weeksOfCoverage ?? 0);
  });

  const persistentArticles = articles
    .filter((a) => a.overstockRatio >= ALWAYS_OVERSTOCK_THRESHOLD_RATIO)
    .sort((a, b) => b.overstockRatio - a.overstockRatio);

  return {
    found: true,
    minWeeksOfCoverage,
    alwaysOverstockThresholdRatio: ALWAYS_OVERSTOCK_THRESHOLD_RATIO,
    periodStart: start,
    periodEnd: end,
    shopCount: new Set(allArticles.map((a) => a.rposShopId)).size,
    articleCount: allArticles.length,
    articles: allArticles,
    persistentArticleCount: persistentArticles.length,
    persistentArticles,
    trendPoints,
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
 * Regroupe les articles "toujours en surstock" (sortie de getOverstockOverPeriod.persistentArticles)
 * par EAN pour un affichage par article façon groupCommonOverstock — DISTINCT de
 * groupCommonOverstock lui-même : celui-ci exige >= 2 magasins (la question "en commun entre
 * magasins") alors qu'un article persistant dans un seul magasin reste pertinent ici (la question
 * "toujours en surstock" ne porte pas sur le nombre de magasins), et doit conserver
 * overstockCount/proposalCount/overstockRatio que groupCommonOverstock ignore.
 */
function groupPersistentOverstock(persistentArticles) {
  const byEan = new Map();
  for (const a of persistentArticles) {
    if (!byEan.has(a.ean)) byEan.set(a.ean, { ean: a.ean, label: a.label, department: a.department, sellingPrice: a.sellingPrice, shops: [] });
    byEan.get(a.ean).shops.push({
      rposShopId: a.rposShopId,
      shopReference: a.shopReference,
      shopName: a.shopName,
      stock: a.stock,
      sellingPrice: a.sellingPrice,
      avgDailySales: a.avgDailySales,
      avgWeeklySales: a.avgWeeklySales,
      avgMonthlySales: a.avgMonthlySales,
      weeksOfCoverage: a.weeksOfCoverage,
      overstockCount: a.overstockCount,
      proposalCount: a.proposalCount,
      overstockRatio: a.overstockRatio,
    });
  }
  return [...byEan.values()].sort((a, b) => b.shops.length - a.shops.length);
}

function attachScrap(shopEntries, scrapByKey, ean) {
  return shopEntries.map((s) => {
    const scrap = scrapByKey.get(`${s.rposShopId}:${ean}`) || { scrapQuantity: 0, scrapCount: 0, lastScrapDate: null };
    return {
      ...s,
      scrapQuantity90d: scrap.scrapQuantity,
      scrapMoveCount90d: scrap.scrapCount,
      lastScrapDate: scrap.lastScrapDate ? scrap.lastScrapDate.toISOString() : null,
    };
  });
}

// Même principe qu'attachScrap, pour une liste PLATE d'articles (chacun porte son propre ean, pas
// un article avec un sous-tableau shops) — demande explicite du 21/10/2026 : "je veux aussi fair en
// sorte que les article qui son en sur-stok voir sil on des casse... aussi je peux avoir ca sur la
// ligne des tableau" (onglet "Par magasin", qui jusque-là n'avait la casse que via les deux autres
// onglets "commun"/"persistant").
function attachScrapFlat(articles, scrapByKey) {
  return articles.map((a) => {
    const scrap = scrapByKey.get(`${a.rposShopId}:${a.ean}`) || { scrapQuantity: 0, scrapCount: 0, lastScrapDate: null };
    return {
      ...a,
      scrapQuantity90d: scrap.scrapQuantity,
      scrapMoveCount90d: scrap.scrapCount,
      lastScrapDate: scrap.lastScrapDate ? scrap.lastScrapDate.toISOString() : null,
    };
  });
}

/**
 * Rapport complet prêt pour affichage/export (demande explicite du 21/10/2026) : combine
 * getOverstockByShop/getOverstockOverPeriod + groupCommonOverstock + la casse 3 mois des seuls
 * articles communs/persistants (pas tous, pour ne pas payer le coût d'agrégation sur des articles
 * non pertinents pour cette question).
 *
 * Sans start/end : comportement d'origine (snapshot de la toute dernière proposition par magasin).
 * Avec start/end : analyse sur la période choisie (demande explicite "si moi meme je veux le
 * surstok sur une periode comment je peux faire le filtre"), articles communs calculés sur les
 * mêmes articles mais ajoute en plus persistentArticles ("toujours en surstock" sur la période,
 * ratio ≥ ALWAYS_OVERSTOCK_THRESHOLD_RATIO).
 */
async function getOverstockReport(allowedShopIds, { minWeeksOfCoverage = DEFAULT_MIN_WEEKS_OF_COVERAGE, start, end } = {}) {
  const periodMode = !!(start && end);
  const byShop = periodMode
    ? await getOverstockOverPeriod(allowedShopIds, { minWeeksOfCoverage, start, end })
    : await getOverstockByShop(allowedShopIds, { minWeeksOfCoverage });
  if (!byShop.found) return byShop;

  const common = groupCommonOverstock(byShop.articles);

  const persistent = periodMode ? groupPersistentOverstock(byShop.persistentArticles) : [];

  const allPairs = [
    ...byShop.articles.map((a) => ({ rposShopId: a.rposShopId, ean: a.ean })),
    ...common.flatMap((e) => e.shops.map((s) => ({ rposShopId: s.rposShopId, ean: e.ean }))),
    ...persistent.flatMap((e) => e.shops.map((s) => ({ rposShopId: s.rposShopId, ean: e.ean }))),
  ];
  const scrapByKey = await getScrapSummaryForEans(allPairs);

  const articlesByShopWithScrap = attachScrapFlat(byShop.articles, scrapByKey);
  const commonWithScrap = common.map((e) => ({ ...e, shops: attachScrap(e.shops, scrapByKey, e.ean) }));
  const persistentWithScrap = persistent.map((e) => ({ ...e, shops: attachScrap(e.shops, scrapByKey, e.ean) }));

  return {
    found: true,
    periodMode,
    periodStart: periodMode ? byShop.periodStart : null,
    periodEnd: periodMode ? byShop.periodEnd : null,
    minWeeksOfCoverage,
    alwaysOverstockThresholdRatio: periodMode ? byShop.alwaysOverstockThresholdRatio : null,
    scrapLookbackDays: SCRAP_LOOKBACK_DAYS,
    shopCount: byShop.shopCount,
    articleCount: byShop.articleCount,
    articlesByShop: articlesByShopWithScrap,
    commonArticleCount: commonWithScrap.length,
    commonArticles: commonWithScrap,
    // "Articles communs à plusieurs magasins" ET "toujours en surstock" sont deux tris orthogonaux
    // de la même liste d'articles — un article peut être dans l'un, l'autre, les deux, ou aucun
    // (ex: en surstock dans un seul magasin mais en permanence). persistentArticles n'existe qu'en
    // mode période (la notion de persistance n'a pas de sens sur un simple snapshot).
    persistentArticleCount: periodMode ? persistentWithScrap.length : null,
    persistentArticles: periodMode ? persistentWithScrap : null,
    // Courbe "nombre d'articles distincts en surstock par jour" (demande explicite du 21/10/2026,
    // style inspiré d'un tableau de bord avec graphique de tendance en haut de page) — n'existe
    // qu'en mode période, dérivée des mêmes propositions déjà parcourues ci-dessus, aucun calcul
    // supplémentaire ni job de synchro.
    trendPoints: periodMode ? byShop.trendPoints : null,
  };
}

/**
 * Lit le snapshot précalculé par overstockReportSnapshotJob.js (vue par défaut uniquement — aucune
 * période, seuil par défaut) et le filtre selon allowedShopIds pour ce compte, sans jamais recalculer
 * (demande explicite du 21/10/2026 : "il charge trop pourqhoi ? il fait les calcule quand
 * j'actualise ?"). Retourne null si aucun snapshot n'existe encore (job jamais exécuté) — l'appelant
 * retombe alors sur getOverstockReport() en direct.
 */
async function getCachedDefaultOverstockReport(allowedShopIds, cacheKey) {
  const snapshot = await prisma.overstockReportSnapshot.findUnique({ where: { cacheKey } });
  if (!snapshot) return null;

  const full = JSON.parse(snapshot.reportJson);
  if (allowedShopIds === null) return full; // ADMIN : snapshot déjà calculé pour tous les magasins

  const allowedSet = new Set(allowedShopIds);
  const articlesByShop = full.articlesByShop.filter((a) => allowedSet.has(a.rposShopId));
  // Un article "commun"/"persistant" dans le snapshot complet peut ne plus l'être une fois réduit au
  // périmètre SUPERVISOR (ex: commun à 3 magasins dont 1 seul accessible) — on ne filtre donc jamais
  // juste les lignes à l'intérieur de chaque article, on RECALCULE le regroupement sur les lignes
  // déjà filtrées (coût négligeable, en mémoire, pas de nouvelle requête DB).
  const filterShopsIn = (groups) =>
    groups
      .map((g) => ({ ...g, shops: g.shops.filter((s) => allowedSet.has(s.rposShopId)) }))
      .filter((g) => g.shops.length >= 2);

  return {
    ...full,
    shopCount: new Set(articlesByShop.map((a) => a.rposShopId)).size,
    articleCount: articlesByShop.length,
    articlesByShop,
    commonArticles: filterShopsIn(full.commonArticles),
    commonArticleCount: filterShopsIn(full.commonArticles).length,
    persistentArticles: full.persistentArticles ? filterShopsIn(full.persistentArticles) : null,
    persistentArticleCount: full.persistentArticles ? filterShopsIn(full.persistentArticles).length : null,
  };
}

/**
 * Détail complet de la casse d'un article (demande explicite du 21/10/2026 : "quand je clique sur
 * l'article je peux avoir... tout les casse les quantité, la date et autre") — contrairement à
 * getScrapSummaryForEans (agrégat), renvoie CHAQUE mouvement de casse individuel sur la fenêtre
 * demandée, pour un ou plusieurs magasins. Lecture locale directe de StockMove (alimentée par
 * stockMoveSyncJob.js), jamais d'appel RPOS — même source que stockMoveAnalysisService.js mais en
 * lot (plusieurs magasins à la fois) plutôt qu'un seul posId/shopId.
 */
async function getScrapDetailForArticle(allowedShopIds, ean, { lookbackDays = SCRAP_LOOKBACK_DAYS } = {}) {
  const shops = await prisma.shop.findMany({
    where: allowedShopIds !== null ? { rposShopId: { in: allowedShopIds } } : {},
    select: { rposShopId: true, reference: true, name: true },
  });
  if (!shops.length) return { found: false, message: 'Aucun magasin accessible pour ce compte.' };

  const shopIds = shops.map((s) => s.rposShopId);
  const shopById = new Map(shops.map((s) => [s.rposShopId, s]));
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

  const moves = await prisma.stockMove.findMany({
    where: { rposShopId: { in: shopIds }, ean, isScrap: true, date: { gte: since } },
    select: { rposShopId: true, ean: true, label: true, date: true, quantity: true, previousQuantity: true, recording: true },
    orderBy: { date: 'desc' },
  });

  const label = moves.find((m) => m.label)?.label || null;
  const moveRows = moves.map((m) => ({
    rposShopId: m.rposShopId,
    shopReference: shopById.get(m.rposShopId)?.reference || null,
    shopName: shopById.get(m.rposShopId)?.name || null,
    date: m.date.toISOString(),
    // quantity est négatif pour une sortie de stock (StockMove.quantity = delta signé) : affiché en
    // positif ici, cohérent avec le reste de ce fichier (getScrapSummaryForEans).
    quantity: Math.abs(m.quantity),
    recording: m.recording || null,
  }));

  const totalQuantity = moveRows.reduce((s, m) => s + m.quantity, 0);
  const byShop = new Map();
  for (const m of moveRows) {
    if (!byShop.has(m.rposShopId)) byShop.set(m.rposShopId, { rposShopId: m.rposShopId, shopReference: m.shopReference, shopName: m.shopName, totalQuantity: 0, moveCount: 0 });
    const entry = byShop.get(m.rposShopId);
    entry.totalQuantity += m.quantity;
    entry.moveCount += 1;
  }

  return {
    found: true,
    ean,
    label,
    lookbackDays,
    since: since.toISOString(),
    totalQuantity,
    totalMoveCount: moveRows.length,
    byShop: [...byShop.values()].sort((a, b) => b.totalQuantity - a.totalQuantity),
    moves: moveRows,
  };
}

module.exports = {
  getOverstockByShop,
  getOverstockOverPeriod,
  getOverstockDataAvailability,
  getCachedDefaultOverstockReport,
  groupCommonOverstock,
  groupPersistentOverstock,
  getScrapSummaryForEans,
  getScrapDetailForArticle,
  getOverstockReport,
  DEFAULT_MIN_WEEKS_OF_COVERAGE,
  SCRAP_LOOKBACK_DAYS,
  ALWAYS_OVERSTOCK_THRESHOLD_RATIO,
};
