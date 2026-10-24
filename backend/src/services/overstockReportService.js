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
// Seuil de persistance pour "toujours en surstock" sur une période — RÉÉCRIT le 23/10/2026 (bug
// signalé : la carte affichait 0 malgré du vrai surstock visible, "Toujours en surstock" restait
// systématiquement vide) — l'ancien seuil ratio ≥90% des PROPOSITIONS générées sur la période se
// basait sur `denom` = nombre de propositions du magasin sur la fenêtre choisie, souvent très
// faible (parfois 1 seule en sandbox, et en pratique dépend de la fréquence réelle de génération,
// pas garantie quotidienne pour tous les magasins) — avec un dénominateur aussi petit, atteindre
// 90% est presque impossible sauf à être en surstock à CHAQUE génération, rarissime. Confirmé
// explicitement par l'utilisateur : persistance mesurée en JOURS CALENDAIRES consécutifs
// (firstOverstockDate -> lastOverstockDate, déjà calculées plus bas), indépendante du nombre de
// propositions générées sur la période.
const ALWAYS_OVERSTOCK_MIN_DAYS = 14;

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
  // ProductCache ne stocke pas de libellé, uniquement l'EAN. Filtré large (rposShopId IN + ean IN,
  // comme la requête principale de cette fonction plus haut) puis réparti en mémoire par couple
  // exact, plutôt qu'un OR avec une clause par article : un `OR` à N entrées génère N × 2 variables
  // liées dans la requête SQL — avec plusieurs milliers d'articles sur 50+ magasins, ça dépassait la
  // limite Postgres de variables liées par requête préparée (bug signalé le 21/10/2026 : "too many
  // bind variables in prepared statement, expected maximum of 32767, received 76447"). Même limite
  // atteinte par un simple `ean IN [...]` avec assez d'éléments (Prisma lie UN paramètre PAR élément
  // du tableau pour Postgres, jamais un seul tableau groupé) — d'où le découpage en lots ci-dessous.
  const overstockedEans = [...new Set(articles.map((a) => a.ean))];
  const EAN_BATCH_SIZE = 5000;
  const labelRows = [];
  for (let i = 0; i < overstockedEans.length; i += EAN_BATCH_SIZE) {
    const batch = overstockedEans.slice(i, i + EAN_BATCH_SIZE);
    const rows = await prisma.salesLine.findMany({
      where: { rposShopId: { in: shopIds }, ean: { in: batch }, label: { not: null } },
      select: { rposShopId: true, ean: true, label: true },
      distinct: ['rposShopId', 'ean'],
    });
    labelRows.push(...rows);
  }
  const labelByKey = new Map(labelRows.map((r) => [`${r.rposShopId}:${r.ean}`, r.label]));
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

  // Jour de la DERNIÈRE proposition générée par magasin sur la période (demande explicite du
  // 21/10/2026 : "je doit voir la periode de surtok... quand es ce que ca pris fin ou ca continue")
  // — sert à déterminer si un article encore en surstock à cette dernière génération est "toujours
  // en cours" (periodEnd approximatif) ou s'il est réellement sorti du surstock avant la fin de la
  // période choisie.
  const lastProposalDayByShop = new Map();
  for (const p of proposals) {
    const day = p.generatedAt.toISOString().slice(0, 10);
    const current = lastProposalDayByShop.get(p.rposShopId);
    if (!current || day > current) lastProposalDayByShop.set(p.rposShopId, day);
  }

  const lines = await prisma.proposalLine.findMany({
    where: { proposalId: { in: proposals.map((p) => p.id) } },
    select: { proposalId: true, ean: true, label: true, department: true, stockAtGeneration: true, avgWeeklySales: true, sellingPrice: true },
  });

  // Agrégation par (magasin, ean) : combien de propositions sur la période avaient cet article EN
  // SURSTOCK, et les dernières valeurs connues (stock/vente/prix) pour l'affichage. En parallèle,
  // agrégation par (JOUR, magasin) : nombre d'articles distincts en surstock ce jour-là, par magasin
  // — demande explicite du 21/10/2026 : "quand je fait le filtre sur un mag ou deux la coube doit
  // mettre ajour" — permet au frontend de recalculer la courbe filtrée sans rappel serveur.
  const byShopEan = new Map(); // `${rposShopId}:${ean}` -> { overstockCount, latest: {...}, firstOverstockDate, lastOverstockDate }
  const overstockEansByDayShop = new Map(); // 'YYYY-MM-DD:rposShopId' -> Set<ean>
  for (const l of lines) {
    const rposShopId = shopIdByProposalId.get(l.proposalId);
    const isOverstocked = (l.avgWeeklySales || 0) > 0 && (l.stockAtGeneration || 0) / l.avgWeeklySales >= minWeeksOfCoverage;
    if (!isOverstocked) continue;
    const key = `${rposShopId}:${l.ean}`;
    const day = dayByProposalId.get(l.proposalId);
    if (!byShopEan.has(key)) {
      byShopEan.set(key, { rposShopId, ean: l.ean, overstockCount: 0, latest: null, firstOverstockDate: day, lastOverstockDate: day });
    }
    const entry = byShopEan.get(key);
    entry.overstockCount += 1;
    // "latest" : la dernière ligne rencontrée l'emporte (lines n'est pas garanti trié par date, mais
    // peu importe ici — juste besoin d'UN jeu de valeurs représentatif pour l'affichage, le ratio de
    // persistance est le chiffre qui compte réellement, pas la valeur exacte affichée à côté).
    entry.latest = l;
    // Période de surstock (demande explicite du 21/10/2026 : "je doit voir la periode de surtok...
    // quand es ce que ca pris fin ou ca continue") — première et dernière date, parmi TOUTES les
    // propositions de la période, où cet article était en surstock dans ce magasin. `lines` n'est
    // pas garanti trié par date (même remarque que `latest` ci-dessus), d'où ces comparaisons plutôt
    // qu'une simple affectation.
    if (day < entry.firstOverstockDate) entry.firstOverstockDate = day;
    if (day > entry.lastOverstockDate) entry.lastOverstockDate = day;

    const dayShopKey = `${day}:${rposShopId}`;
    if (!overstockEansByDayShop.has(dayShopKey)) overstockEansByDayShop.set(dayShopKey, new Set());
    overstockEansByDayShop.get(dayShopKey).add(l.ean);
  }

  const trendPointsByShop = [...overstockEansByDayShop.entries()]
    .map(([dayShopKey, eanSet]) => {
      const sepIdx = dayShopKey.indexOf(':');
      return { date: dayShopKey.slice(0, sepIdx), rposShopId: dayShopKey.slice(sepIdx + 1), count: eanSet.size };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  // Agrégat global tous magasins confondus (demande initiale : "la courbe affichée c'est pour un
  // seul magasin ? ou on peut avoir plusieurs" — confirmé total cumulé par défaut) : un article en
  // surstock dans N magasins le même jour compte une seule fois, d'où un Set par jour plutôt qu'une
  // simple somme de trendPointsByShop (qui compterait l'article N fois).
  const overstockEansByDay = new Map(); // 'YYYY-MM-DD' -> Set<`${rposShopId}:${ean}`>
  for (const [dayShopKey, eanSet] of overstockEansByDayShop) {
    const sepIdx = dayShopKey.indexOf(':');
    const day = dayShopKey.slice(0, sepIdx);
    const rposShopId = dayShopKey.slice(sepIdx + 1);
    if (!overstockEansByDay.has(day)) overstockEansByDay.set(day, new Set());
    for (const ean of eanSet) overstockEansByDay.get(day).add(`${rposShopId}:${ean}`);
  }

  const trendPoints = [...overstockEansByDay.entries()]
    .map(([date, set]) => ({ date, count: set.size }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const shopProposalDenominator = (rposShopId) => proposalCountByShop.get(rposShopId) || 1;

  // Stock LIVE depuis ProductCache (demande explicite du 24/10/2026 : "le Stok est a 110084 or sur
  // le server il est a 22 pourqui ce delacalage ?") — l.stockAtGeneration ci-dessous est une photo
  // au moment de la DERNIÈRE observation en surstock sur la période choisie, qui peut remonter à
  // plusieurs semaines pour une période large (ex: "3 derniers mois") et diverger fortement du
  // stock RPOS actuel. weeksOfCoverage recalculé sur ce stock live aussi (demande explicite :
  // "le surtok ce fait en fonction du stok actuel du magasin... pour voir si je suis en surtok sur
  // un article il doit me dire pourquoi" — la couverture affichée doit expliquer le stock affiché
  // juste à côté, jamais deux grandeurs découplées sur la même ligne). Seul overstockRatio/la
  // persistance sur la période restent basés sur l'historique (stockAtGeneration), qui mesure autre
  // chose : combien de fois l'article a été vu en surstock sur la période, pas son état actuel.
  const liveStockRows = await prisma.productCache.findMany({
    where: { rposShopId: { in: shopIds }, ean: { in: [...new Set(lines.map((l) => l.ean))] } },
    select: { rposShopId: true, ean: true, stock: true },
  });
  const liveStockByKey = new Map(liveStockRows.map((r) => [`${r.rposShopId}:${r.ean}`, r.stock]));

  const articles = [...byShopEan.values()].map((e) => {
    const shop = shopById.get(e.rposShopId);
    const l = e.latest;
    const avgWeeklySales = Math.round((l.avgWeeklySales || 0) * 10) / 10;
    const denom = shopProposalDenominator(e.rposShopId);
    const liveStock = liveStockByKey.get(`${e.rposShopId}:${e.ean}`);
    // "Toujours en cours" (demande explicite du 21/10/2026 : "je doit voir la periode de surtok...
    // quand es ce que ca pris fin ou ca continue") : l'article était en surstock à la DERNIÈRE
    // proposition générée pour ce magasin sur la période — donc rien n'indique qu'il en soit sorti
    // avant la fin de la fenêtre choisie. Sinon, lastOverstockDate est la date réelle de sortie du
    // surstock (dernière fois où on l'a vu en surstock, avant une proposition suivante qui ne
    // l'avait plus).
    const stillOverstocked = e.lastOverstockDate === lastProposalDayByShop.get(e.rposShopId);
    return {
      rposShopId: e.rposShopId,
      shopReference: shop?.reference || null,
      shopName: shop?.name || null,
      ean: e.ean,
      label: l.label,
      department: l.department,
      stock: liveStock !== undefined ? liveStock : (l.stockAtGeneration || 0),
      sellingPrice: l.sellingPrice || null,
      avgDailySales: Math.round((avgWeeklySales / 7) * 100) / 100,
      avgWeeklySales,
      avgMonthlySales: Math.round(avgWeeklySales * (365 / 12 / 7) * 10) / 10,
      weeksOfCoverage: avgWeeklySales > 0 ? Math.round(((liveStock !== undefined ? liveStock : (l.stockAtGeneration || 0)) / avgWeeklySales) * 10) / 10 : null,
      overstockCount: e.overstockCount,
      proposalCount: denom,
      overstockRatio: Math.round((e.overstockCount / denom) * 100) / 100,
      firstOverstockDate: e.firstOverstockDate,
      lastOverstockDate: e.lastOverstockDate,
      // Jours CALENDAIRES entre la première et la dernière observation en surstock (+1 pour compter
      // le jour de début lui-même) — base du critère "Toujours en surstock" ci-dessous, indépendante
      // du nombre de propositions générées sur la période (cf. commentaire ALWAYS_OVERSTOCK_MIN_DAYS).
      overstockDaysSpan: Math.round((new Date(e.lastOverstockDate) - new Date(e.firstOverstockDate)) / (24 * 60 * 60 * 1000)) + 1,
      stillOverstocked,
    };
  })
    // Ne garde que les articles ENCORE en surstock sur le stock live (demande explicite du
    // 24/10/2026 : un article vu en surstock pendant la période mais dont le stock actuel est
    // repassé sous le seuil ne doit plus apparaître dans "Articles en surstock", qui doit refléter
    // l'état PRÉSENT — son historique reste par ailleurs consultable via overstockRatio/la période
    // de surstock sur les lignes qui restent). weeksOfCoverage === null (avgWeeklySales = 0) exclu
    // aussi : pas de vente connue, donc pas de couverture calculable sur le stock live.
    .filter((a) => a.weeksOfCoverage !== null && a.weeksOfCoverage >= minWeeksOfCoverage)
    .sort((a, b) => b.overstockRatio - a.overstockRatio || b.weeksOfCoverage - a.weeksOfCoverage);

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

  // "Toujours en surstock" = encore en surstock à la dernière observation (stillOverstocked) ET
  // depuis au moins ALWAYS_OVERSTOCK_MIN_DAYS jours calendaires consécutifs — un article qui ÉTAIT
  // en surstock il y a longtemps puis en est sorti, ou qui vient d'y entrer il y a 2 jours, n'a pas
  // sa place ici malgré un overstockDaysSpan ou overstockRatio élevé pour d'autres raisons.
  const persistentArticles = articles
    .filter((a) => a.stillOverstocked && a.overstockDaysSpan >= ALWAYS_OVERSTOCK_MIN_DAYS)
    .sort((a, b) => b.overstockDaysSpan - a.overstockDaysSpan);

  return {
    found: true,
    minWeeksOfCoverage,
    alwaysOverstockMinDays: ALWAYS_OVERSTOCK_MIN_DAYS,
    periodStart: start,
    periodEnd: end,
    shopCount: new Set(allArticles.map((a) => a.rposShopId)).size,
    articleCount: allArticles.length,
    articles: allArticles,
    persistentArticleCount: persistentArticles.length,
    persistentArticles,
    trendPoints,
    trendPointsByShop,
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

// Même liste fixe de mots-clés que scrapReportService.js (demande confirmée le 21/10/2026 : "oui tu
// met les 6 types") — réutilisée ici plutôt qu'importée directement pour ne jamais créer de
// dépendance circulaire entre les deux services (overstockReportService require déjà
// scrapReportService ne serait pas un problème en soi, mais ce fichier est déjà volumineux ; la
// liste reste la source de vérité dans scrapReportService.js, copiée ici à l'identique).
//
// Casse affichée sur Surstock = liste FIXE (demande confirmée explicitement : "Surstock garde un
// réglage FIXE... pas de sélecteur sur cette page") — contrairement à la page Casse dédiée, dont le
// filtre par type est interactif, la casse ici alimente le snapshot précalculé toutes les heures
// (overstockReportSnapshotJob.js) : un sélecteur changerait le résultat à la volée, ce qui
// casserait la rapidité obtenue par le précalcul. Remplace le drapeau isScrap (découvert incohérent
// d'un magasin à l'autre pour un même type de mouvement) par ce filtre textuel, plus fiable.
const OVERSTOCK_SCRAP_TYPE_KEYWORDS = ['CASSE', 'AVARI', 'PERIM', 'MANUT', 'EXPER'];
function overstockScrapTypeWhere() {
  return { OR: OVERSTOCK_SCRAP_TYPE_KEYWORDS.map((kw) => ({ typeLabel: { contains: kw, mode: 'insensitive' } })) };
}

/**
 * Casse sur les 3 derniers mois pour un lot d'EAN à travers plusieurs magasins (demande explicite :
 * "si tu les casse sortir la casse de ces articles sur les 3 dernières mois") — lecture locale
 * directe de StockMove (alimentée par stockMoveSyncJob.js, cf. stockMoveAnalysisService.js qui fait
 * de même pour un seul article à la fois) : jamais d'appel RPOS ici, une agrégation groupBy en masse
 * sur 90 jours pour potentiellement des dizaines d'articles × dizaines de magasins serait bien trop
 * coûteuse en aller-retours réseau RPOS un par un.
 */
async function getScrapSummaryForEans(shopEanPairs, { since: sinceOverride, until } = {}) {
  if (!shopEanPairs.length) return new Map();

  // Fenêtre alignée sur la période d'analyse choisie (demande explicite du 24/10/2026 : "les casse
  // sur cette periode d'analyse") quand sinceOverride/until sont fournis par l'appelant (mode
  // période de getOverstockReport) — sinon, comportement d'origine : 90 derniers jours glissants
  // (snapshot "situation actuelle", sans période choisie).
  const since = sinceOverride || new Date(Date.now() - SCRAP_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const dateFilter = until ? { gte: since, lte: until } : { gte: since };
  const shopIds = [...new Set(shopEanPairs.map((p) => p.rposShopId))];
  const eans = [...new Set(shopEanPairs.map((p) => p.ean))];

  // Filtré large (tous les (shop, ean) demandés) puis réparti en mémoire par couple exact : Prisma
  // ne permet pas nativement un "IN d'une liste de paires" propre sans OR explicite, inutile ici vu
  // le nombre de lignes modeste (quelques dizaines d'articles communs au plus).
  const rows = await prisma.stockMove.findMany({
    where: { rposShopId: { in: shopIds }, ean: { in: eans }, date: dateFilter, ...overstockScrapTypeWhere() },
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
 * Quantité actuellement basculée en DLV pour un lot d'(magasin, ean) (demande explicite du
 * 24/10/2026 : "une colonne de combien est en dlv actu pour les surstok") — lecture locale directe
 * de ProductEndOfLife (alimentée par productEndOfLifeSyncJob.js), jamais un appel RPOS ici. TOUJOURS
 * l'état ACTUEL (pas de fenêtre de dates) : contrairement à la casse, qui est un historique de
 * mouvements sur une période, la DLV est un état présent — un article en DLV aujourd'hui peut
 * expliquer pourquoi son stock normal s'écoule plus lentement que prévu (une partie du stock est
 * déjà basculée en vente à prix réduit, hors du circuit normal).
 */
async function getEndOfLifeSummaryForEans(shopEanPairs) {
  if (!shopEanPairs.length) return new Map();

  const shopIds = [...new Set(shopEanPairs.map((p) => p.rposShopId))];
  const eans = [...new Set(shopEanPairs.map((p) => p.ean))];

  const rows = await prisma.productEndOfLife.findMany({
    where: { rposShopId: { in: shopIds }, originEan: { in: eans } },
    select: { rposShopId: true, originEan: true, dlvStock: true },
  });

  // Une fiche DLV à dlvStock NÉGATIF n'est PAS un stock physique encore présent (confirmé
  // explicitement le 24/10/2026, capture à l'appui : 7 fiches DLV historiques pour un même article,
  // négatives pour la plupart — du bruit comptable (retours, ajustements, corrections), pas une
  // vraie quantité restante) — clampée à 0 avant somme, sinon une fiche négative annulerait à tort
  // une fiche positive réelle d'un autre lot du même article.
  const byKey = new Map(); // `${rposShopId}:${ean}` -> { dlvStock, dlvLineCount }
  for (const r of rows) {
    const key = `${r.rposShopId}:${r.originEan}`;
    if (!byKey.has(key)) byKey.set(key, { dlvStock: 0, dlvLineCount: 0 });
    const entry = byKey.get(key);
    entry.dlvStock += Math.max(0, r.dlvStock || 0);
    entry.dlvLineCount += 1;
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
// onglets "commun"/"persistant"). dlvByKey optionnel (demande explicite du 24/10/2026 : "une colonne
// de combien est en dlv actu pour les surstok") — ajoute dlvStock/dlvLineCount sans dépendre de
// attachScrap/les onglets "commun"/"persistant", pas demandé pour eux.
function attachScrapFlat(articles, scrapByKey, dlvByKey) {
  return articles.map((a) => {
    const scrap = scrapByKey.get(`${a.rposShopId}:${a.ean}`) || { scrapQuantity: 0, scrapCount: 0, lastScrapDate: null };
    const dlv = dlvByKey ? (dlvByKey.get(`${a.rposShopId}:${a.ean}`) || { dlvStock: 0, dlvLineCount: 0 }) : null;
    return {
      ...a,
      scrapQuantity90d: scrap.scrapQuantity,
      scrapMoveCount90d: scrap.scrapCount,
      lastScrapDate: scrap.lastScrapDate ? scrap.lastScrapDate.toISOString() : null,
      ...(dlv ? { dlvStock: dlv.dlvStock, dlvLineCount: dlv.dlvLineCount } : {}),
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
 * encore en surstock à la dernière observation ET depuis ≥ ALWAYS_OVERSTOCK_MIN_DAYS jours).
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
  // Casse alignée sur la période d'analyse choisie (demande explicite du 24/10/2026 : "les casse sur
  // cette periode d'analyse") en mode période ; sinon comportement d'origine (90 derniers jours
  // glissants, snapshot "situation actuelle" sans période choisie).
  const scrapByKey = periodMode
    ? await getScrapSummaryForEans(allPairs, { since: new Date(start), until: new Date(end) })
    : await getScrapSummaryForEans(allPairs);
  // DLV actuelle (demande explicite du 24/10/2026 : "une colonne de combien est en dlv actu pour les
  // surstok") — toujours l'état PRÉSENT, jamais borné par la période choisie (cf. commentaire sur
  // getEndOfLifeSummaryForEans).
  const dlvByKey = await getEndOfLifeSummaryForEans(allPairs);

  const articlesByShopWithScrap = attachScrapFlat(byShop.articles, scrapByKey, dlvByKey);
  const commonWithScrap = common.map((e) => ({ ...e, shops: attachScrap(e.shops, scrapByKey, e.ean) }));
  const persistentWithScrap = persistent.map((e) => ({ ...e, shops: attachScrap(e.shops, scrapByKey, e.ean) }));

  return {
    found: true,
    periodMode,
    periodStart: periodMode ? byShop.periodStart : null,
    periodEnd: periodMode ? byShop.periodEnd : null,
    minWeeksOfCoverage,
    alwaysOverstockMinDays: periodMode ? byShop.alwaysOverstockMinDays : null,
    // Casse alignée sur la période choisie en mode période (demande explicite du 24/10/2026) : le
    // frontend affiche ce nombre dans le libellé de la colonne Casse, qui doit donc refléter la
    // vraie fenêtre utilisée (ex: "Casse (7j)" plutôt que le fixe "Casse (90j)" d'origine).
    scrapLookbackDays: periodMode ? Math.round((new Date(end) - new Date(start)) / (24 * 60 * 60 * 1000)) : SCRAP_LOOKBACK_DAYS,
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
    trendPointsByShop: periodMode ? byShop.trendPointsByShop : null,
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
async function getScrapDetailForArticle(allowedShopIds, ean, { lookbackDays = SCRAP_LOOKBACK_DAYS, typeLabels, startDate, endDate } = {}) {
  const shops = await prisma.shop.findMany({
    where: allowedShopIds !== null ? { rposShopId: { in: allowedShopIds } } : {},
    select: { rposShopId: true, reference: true, name: true },
  });
  if (!shops.length) return { found: false, message: 'Aucun magasin accessible pour ce compte.' };

  const shopIds = shops.map((s) => s.rposShopId);
  const shopById = new Map(shops.map((s) => [s.rposShopId, s]));

  // Période personnalisée (demande explicite du 21/10/2026 : "donne la possibilité de personalisé
  // cette période") — startDate/endDate exacts priment sur lookbackDays quand fournis. endDate est
  // inclusif jusqu'à la fin de la journée (23:59:59.999), pas minuit pile.
  const since = startDate ? new Date(startDate) : new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const until = endDate ? new Date(new Date(endDate).setHours(23, 59, 59, 999)) : undefined;

  // Même filtre par type exact que scrapReportService.getScrapOverview (demande explicite du
  // 21/10/2026 : "je veux qui tu affiche les type de mouvement pour les casse... si je mets perimé
  // il doit affiché") — sans sélection explicite, retombe sur la liste de mots-clés par défaut.
  const typeFilter = Array.isArray(typeLabels) && typeLabels.length
    ? { typeLabel: { in: typeLabels } }
    : overstockScrapTypeWhere();

  const moves = await prisma.stockMove.findMany({
    where: { rposShopId: { in: shopIds }, ean, date: { gte: since, ...(until ? { lte: until } : {}) }, ...typeFilter },
    select: { rposShopId: true, ean: true, label: true, date: true, quantity: true, previousQuantity: true, recording: true, typeLabel: true },
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
    typeLabel: m.typeLabel,
  }));

  const totalQuantity = moveRows.reduce((s, m) => s + m.quantity, 0);
  const byShop = new Map();
  for (const m of moveRows) {
    if (!byShop.has(m.rposShopId)) byShop.set(m.rposShopId, { rposShopId: m.rposShopId, shopReference: m.shopReference, shopName: m.shopName, totalQuantity: 0, moveCount: 0 });
    const entry = byShop.get(m.rposShopId);
    entry.totalQuantity += m.quantity;
    entry.moveCount += 1;
  }

  // Récap par jour (demande explicite du 21/10/2026 : "il peux affiche aussi par detail c'est a
  // dir me donner la possiblité de voir par jour") — en plus de la liste détaillée par mouvement,
  // jamais à la place.
  const byDay = new Map();
  for (const m of moveRows) {
    const day = m.date.slice(0, 10); // YYYY-MM-DD
    if (!byDay.has(day)) byDay.set(day, { date: day, quantity: 0, moveCount: 0 });
    const entry = byDay.get(day);
    entry.quantity += m.quantity;
    entry.moveCount += 1;
  }

  return {
    found: true,
    ean,
    label,
    lookbackDays,
    since: since.toISOString(),
    until: until ? until.toISOString() : undefined,
    totalQuantity,
    totalMoveCount: moveRows.length,
    byShop: [...byShop.values()].sort((a, b) => b.totalQuantity - a.totalQuantity),
    byDay: [...byDay.values()].sort((a, b) => b.date.localeCompare(a.date)),
    moves: moveRows,
  };
}

// Colonnes autorisées pour le tri côté serveur — jamais une chaîne arbitraire passée par le
// frontend directement en clé d'accès (cf. getSortValue ci-dessous), pour éviter qu'une requête
// mal formée ne plante sur un champ inexistant plutôt que de retomber proprement sur le tri par
// défaut.
const BY_SHOP_SORTABLE_FIELDS = new Set([
  'label', 'shopName', 'department', 'stock', 'sellingPrice', 'avgDailySales',
  'avgWeeklySales', 'avgMonthlySales', 'weeksOfCoverage', 'overstockRatio', 'scrapQuantity90d',
  'firstOverstockDate', 'dlvStock',
]);

function getSortValue(row, field) {
  const v = row[field];
  return v === null || v === undefined ? -Infinity : v;
}

/**
 * Page filtrée/triée du tableau "Par magasin" — demande explicite du 21/10/2026 : "ca prend au
 * moins 10s pour affiché c'est normal ?" (38922 lignes observées en prod, transférées et rendues
 * en entier côté client à chaque chargement, peu importe la pagination visuelle qui n'agissait
 * qu'APRÈS réception du JSON complet). Lit le même snapshot précalculé que getOverstockReport
 * (jamais de second calcul), applique filtres/tri/pagination EN MÉMOIRE côté serveur, et ne
 * renvoie au frontend QUE la page demandée — le payload réseau passe de ~40-50 Mo (estimé sur 38922
 * lignes, cf. 2.5 Mo mesurés pour 2591 lignes en sandbox) à quelques Ko.
 *
 * N'existe que pour l'onglet "Par magasin" (pas Surstock commun / Toujours en surstock, qui restent
 * sur l'ancien chemin pour l'instant — portée volontairement limitée à la demande initiale).
 */
async function getOverstockByShopPage(allowedShopIds, {
  minWeeksOfCoverage = DEFAULT_MIN_WEEKS_OF_COVERAGE,
  start,
  end,
  cachedFullReport, // si fourni (lu par l'appelant depuis un snapshot), jamais recalculé ici
  page = 1,
  pageSize = 10,
  search,
  shopIds, // sous-ensemble choisi par l'utilisateur dans le sélecteur magasin, distinct de allowedShopIds (périmètre du compte)
  sortField,
  sortDir = 'desc',
  rangeFilters, // { stock: {min,max}, avgDailySales: {min,max}, ... } — mêmes clés que BY_SHOP_SORTABLE_FIELDS
  scrapOnly,
} = {}) {
  const full = cachedFullReport || await getOverstockReport(allowedShopIds, { minWeeksOfCoverage, start, end });
  if (!full.found) return full;

  let rows = full.articlesByShop;

  if (shopIds && shopIds.length) {
    const set = new Set(shopIds);
    rows = rows.filter((r) => set.has(r.rposShopId));
  }
  if (search) {
    const q = search.trim().toLowerCase();
    if (q) rows = rows.filter((r) => r.label.toLowerCase().includes(q) || r.ean.includes(q));
  }
  if (scrapOnly) {
    rows = rows.filter((r) => r.scrapQuantity90d > 0);
  }
  if (rangeFilters) {
    for (const [field, range] of Object.entries(rangeFilters)) {
      if (!range) continue;
      const min = range.min !== undefined && range.min !== '' ? Number(range.min) : null;
      const max = range.max !== undefined && range.max !== '' ? Number(range.max) : null;
      if (min === null && max === null) continue;
      rows = rows.filter((r) => {
        const v = r[field];
        if (v === null || v === undefined) return false;
        if (min !== null && v < min) return false;
        if (max !== null && v > max) return false;
        return true;
      });
    }
  }

  // Comptage des magasins distincts AVANT tri/pagination, sur l'ensemble filtré complet (sert au
  // KPI "Magasins concernés" affiché au-dessus du tableau) — jamais calculé sur la seule page
  // visible, qui ne refléterait que les magasins de ces 10 lignes.
  const filteredShopCount = new Set(rows.map((r) => r.rposShopId)).size;
  const filteredCount = rows.length;

  if (sortField && BY_SHOP_SORTABLE_FIELDS.has(sortField)) {
    const dir = sortDir === 'asc' ? 1 : -1;
    rows = rows.slice().sort((a, b) => {
      const av = getSortValue(a, sortField);
      const bv = getSortValue(b, sortField);
      if (typeof av === 'string' || typeof bv === 'string') {
        return dir * String(av).localeCompare(String(bv), 'fr-FR');
      }
      return dir * (av - bv);
    });
  }

  const totalPages = Math.max(1, Math.ceil(filteredCount / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const pageRows = rows.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  return {
    found: true,
    page: currentPage,
    pageSize,
    totalPages,
    totalCount: filteredCount,
    filteredShopCount,
    rows: pageRows,
    periodMode: full.periodMode,
    minWeeksOfCoverage: full.minWeeksOfCoverage,
    // Libellé dynamique de la colonne Casse côté frontend (demande explicite du 24/10/2026 : "les
    // casse sur cette periode d'analyse") — même valeur que getOverstockReport, transmise ici car ce
    // tableau paginé a son propre appel réseau distinct, ne reçoit pas le rapport complet.
    scrapLookbackDays: full.scrapLookbackDays,
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
  getOverstockByShopPage,
  DEFAULT_MIN_WEEKS_OF_COVERAGE,
  SCRAP_LOOKBACK_DAYS,
  ALWAYS_OVERSTOCK_MIN_DAYS,
};
