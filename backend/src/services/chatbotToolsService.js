/**
 * Outils internes du chatbot IA (CAHIER_DES_CHARGES.md §34-38, étape 11 du plan de montée en
 * autonomie IA) : chaque fonction lit des données réelles déjà en base (jamais d'invention), et le
 * LLM ne reçoit QUE le résultat de ces appels — jamais un accès direct à la base (§35 : "Le LLM ne
 * doit pas être directement connecté à toute la base de données").
 *
 * Chaque outil est volontairement scopé à un magasin (rposShopId) reçu en paramètre — la sécurité
 * par permission (§43, quel magasin l'utilisateur a le droit de consulter) est appliquée en amont,
 * dans la route qui appelle ces outils, jamais ici.
 */
const prisma = require('../utils/prisma');
const rpos = require('./rposClient');
const stockMoveAnalysis = require('./stockMoveAnalysisService');
const { mapWithConcurrency } = require('../utils/concurrency');
const { listAnomalies } = require('./orderAnomalyService');

// Seuil "article générique" identique à excludeGenericArticlesBelowPrice (configService.js,
// utilisé par proposalService.js) : un article dont le prix de vente RPOS est en dessous n'est pas
// un vrai produit vendable individuellement (agrégat de rayon type "FRUITS & LEGUMES", "CHARCUTERIE
// PESEE"), sa "quantité vendue" est en réalité une valeur monétaire ou un poids, jamais un nombre
// d'unités réel.
const GENERIC_ARTICLE_PRICE_THRESHOLD = 2;

/**
 * Écarte les lignes de ventes d'articles génériques/poids libre d'une liste de SalesLine — deux
 * signaux combinés (aucun des deux seul n'est fiable, découvert le 18-19/09/2026) :
 * 1. quantity === revenueExclTax (rapide, gratuit, sans dépendance) : couvre le cas où le "prix"
 *    saisi en caisse EST la quantité en valeur — mais ne couvre PAS tous les articles génériques
 *    (ex: "CHARCUTERIE PESEE" a quantity=2 228 922 et revenueExclTax=1 888 915, différents, donc
 *    passait à travers ce seul filtre malgré un prix de vente RPOS à 1 CFA).
 * 2. Prix de vente RPOS < GENERIC_ARTICLE_PRICE_THRESHOLD (via ProductCache, déjà peuplé par la
 *    dernière génération de proposition — AUCUN appel réseau supplémentaire ici) : le signal fiable
 *    déjà utilisé par proposalService.js, mais seulement disponible pour les articles déjà vus par
 *    une génération — un article vendu mais absent du cache n'est alors filtré que par le signal 1.
 * Ne bloque jamais si aucun signal n'est disponible pour un EAN donné : une ligne reste incluse par
 * défaut plutôt que sur-filtrée faute de donnée.
 */
async function filterGenericArticleLines(rposShopId, lines) {
  const survivingLines = lines.filter((l) => Math.abs(l.revenueExclTax - l.quantity) > 0.01);
  if (!survivingLines.length) return survivingLines;

  const eans = [...new Set(survivingLines.map((l) => l.ean))];
  const cached = await prisma.productCache.findMany({
    where: { rposShopId, ean: { in: eans } },
    select: { ean: true, sellingPrice: true },
  });
  const priceByEan = new Map(cached.map((c) => [c.ean, c.sellingPrice]));

  return survivingLines.filter((l) => {
    const price = priceByEan.get(l.ean);
    return price === undefined || price >= GENERIC_ARTICLE_PRICE_THRESHOLD;
  });
}


async function getLatestProposal(rposShopId) {
  return prisma.proposal.findFirst({
    where: { rposShopId },
    orderBy: { generatedAt: 'desc' },
  });
}

/**
 * getShopDepartments(rposShopId) — liste des rayons RÉELS de ce magasin, tels que connus par la
 * dernière proposition générée (spec du 28/09/2026 : "CA de ce rayon liquide" ne trouvait jamais le
 * rayon car `department` n'était jamais extrait du texte de la question, uniquement transmis par le
 * sélecteur d'interface). Utilisée par chatbotService.extractDepartment pour faire correspondre un
 * nom de rayon mentionné en langage libre à un nom RÉEL (ex: "liquide" -> "BOISSONS LIQUIDES"),
 * plutôt que de transmettre le texte brut tel quel à un filtre Prisma qui ne matcherait jamais une
 * égalité exacte.
 */
async function getShopDepartments(rposShopId) {
  const proposal = await getLatestProposal(rposShopId);
  if (!proposal) return [];
  const rows = await prisma.proposalLine.findMany({
    where: { proposalId: proposal.id, department: { not: null } },
    select: { department: true },
    distinct: ['department'],
  });
  return rows.map((r) => r.department).filter(Boolean);
}

/**
 * getDataAvailability(rposShopId) — étendue RÉELLE de l'historique de ventes disponible en base
 * pour ce magasin (spec du 28/09/2026 §7 : "utiliser TOUTES les données disponibles par magasin,
 * pas une fenêtre fixe arbitraire" + "Données disponibles : du DD/MM/AAAA au DD/MM/AAAA"). Distinct
 * de periodStart/periodEnd d'une réponse getRevenue/getParetoArticles (la fenêtre RÉSOLUE pour UNE
 * question précise) : ceci répond à "jusqu'où peut-on remonter pour CE magasin", indépendamment de
 * toute période choisie — utile pour cadrer une comparaison "12 derniers mois" avant de la lancer
 * (si le magasin n'a que 3 mois de recul, le dire plutôt que de renvoyer une comparaison tronquée
 * sans prévenir). Même source que la route ADMIN /sales-lines/coverage (sales.js), extraite ici pour
 * être appelable par le chatbot sans passer par requireAdmin (une question "depuis quand avez-vous
 * mes données ?" est légitime pour tout rôle ayant accès à son propre magasin).
 */
async function getDataAvailability(rposShopId) {
  const [oldest, newest, count] = await Promise.all([
    prisma.salesLine.findFirst({ where: { rposShopId }, orderBy: { date: 'asc' }, select: { date: true } }),
    prisma.salesLine.findFirst({ where: { rposShopId }, orderBy: { date: 'desc' }, select: { date: true } }),
    prisma.salesLine.count({ where: { rposShopId } }),
  ]);

  if (!oldest || !newest) {
    return { found: false, message: 'Aucune vente synchronisée pour ce magasin pour le moment.' };
  }

  const spanDays = Math.round((newest.date.getTime() - oldest.date.getTime()) / (24 * 60 * 60 * 1000));

  return {
    found: true,
    oldestDate: oldest.date.toISOString(),
    newestDate: newest.date.toISOString(),
    spanDays,
    // Signale explicitement quand une comparaison "12 mois glissants" ou "même période l'an dernier"
    // ne peut être que partielle voire impossible, plutôt que de laisser le LLM/l'utilisateur découvrir
    // après coup qu'un chiffre "sur 12 mois" ne portait en fait que sur 3 mois de données réelles.
    coversAtLeastOneYear: spanDays >= 365,
    lineCount: count,
  };
}

/** getStoreStock() — vision d'ensemble du stock du magasin sur sa dernière proposition connue. */
async function getStoreStock(rposShopId, { department } = {}) {
  const proposal = await getLatestProposal(rposShopId);
  if (!proposal) return { found: false, message: 'Aucune proposition générée pour ce magasin.' };

  const lines = await prisma.proposalLine.findMany({
    where: { proposalId: proposal.id, ...(department ? { department } : {}) },
    select: { ean: true, label: true, department: true, stockAtGeneration: true, avgWeeklySales: true, daysUntilStockout: true },
  });

  return {
    found: true,
    generatedAt: proposal.generatedAt,
    articleCount: lines.length,
    totalStockUnits: lines.reduce((s, l) => s + (l.stockAtGeneration || 0), 0),
    lines: lines.slice(0, 200), // borne large mais évite un prompt démesuré sur un très gros magasin
  };
}

/** getArticleStock(ean) — détail d'un article précis. */
async function getArticleStock(rposShopId, ean) {
  const proposal = await getLatestProposal(rposShopId);
  if (!proposal) return { found: false, message: 'Aucune proposition générée pour ce magasin.' };

  const line = await prisma.proposalLine.findFirst({
    where: { proposalId: proposal.id, ean },
  });
  if (!line) return { found: false, message: `Article ${ean} introuvable dans la dernière proposition.` };

  return {
    found: true,
    ean: line.ean,
    label: line.label,
    department: line.department,
    sector: line.sector,
    stock: line.stockAtGeneration,
    avgWeeklySales: line.avgWeeklySales,
    daysUntilStockout: line.daysUntilStockout,
    quantitySuggested: line.quantitySuggested,
    aiAdjusted: line.aiAdjusted,
    aiReasoning: line.aiReasoning,
    trendCategory: line.trendCategory,
    anomalies: line.anomalies ? JSON.parse(line.anomalies) : [],
  };
}

/**
 * getArticleStockAllShops(ean) — stock d'un article précis dans TOUS les magasins accessibles au
 * compte (demande du 25/09/2026 : "dans tout les magasin le systeme meme si ya pas token ia il
 * peux chercher"), même principe que getRevenueAllShops : réservé ADMIN/SUPERVISOR côté
 * chatbotService.js, purement déterministe (aucun appel LLM), lit ProposalLine déjà en base.
 * Chaque magasin a sa propre dernière proposition (pas de table partagée à filtrer en un seul
 * groupBy comme pour le CA) : une requête par magasin, en parallèle borné.
 */
async function getArticleStockAllShops(allowedShopIds, ean) {
  if (!allowedShopIds || !allowedShopIds.length) return { found: false, message: 'Aucun magasin accessible pour ce compte.' };

  const shops = await prisma.shop.findMany({ where: { rposShopId: { in: allowedShopIds } }, select: { rposShopId: true, reference: true, name: true } });
  if (!shops.length) return { found: false, message: 'Aucun magasin trouvé pour ce compte.' };

  const results = await mapWithConcurrency(shops, 5, async (shop) => {
    const proposal = await getLatestProposal(shop.rposShopId);
    if (!proposal) return { rposShopId: shop.rposShopId, shopReference: shop.reference, shopName: shop.name, found: false };

    const line = await prisma.proposalLine.findFirst({ where: { proposalId: proposal.id, ean } });
    if (!line) return { rposShopId: shop.rposShopId, shopReference: shop.reference, shopName: shop.name, found: false };

    return {
      rposShopId: shop.rposShopId,
      shopReference: shop.reference,
      shopName: shop.name,
      found: true,
      label: line.label,
      stock: line.stockAtGeneration,
      avgWeeklySales: line.avgWeeklySales,
      daysUntilStockout: line.daysUntilStockout,
    };
  });

  const withData = results.filter((r) => r.found);
  if (!withData.length) {
    return { found: false, message: `Article ${ean} introuvable dans la dernière proposition d'aucun magasin accessible.` };
  }

  return {
    found: true,
    ean,
    label: withData[0].label,
    shopCount: results.length,
    totalStockUnits: withData.reduce((s, r) => s + (r.stock || 0), 0),
    shops: results.sort((a, b) => (b.stock || 0) - (a.stock || 0)),
  };
}

/**
 * getRevenue() — chiffre d'affaires réel (HT) du magasin sur une période ou une date précise,
 * calculé depuis SalesLine.revenueExclTax. Distinct de getSalesHistory (quantités vendues) : une
 * question sur "le CA" porte sur un montant en CFA, jamais une quantité d'unités.
 */
async function getRevenue(rposShopId, { date, days, department, ean, posId } = {}) {
  let dateStart;
  let dateEnd;
  let periodMode = null;
  if (date) {
    dateStart = new Date(date + 'T00:00:00.000Z');
    dateEnd = new Date(date + 'T23:59:59.999Z');
    // Une date extraite d'une question en langage libre peut être syntaxiquement plausible mais
    // calendairement invalide de deux façons différentes, toutes deux trouvées le 16/09/2026 lors
    // d'un test exhaustif de questions :
    //  1) jour/mois hors plage absolue (ex: "32/13/2026") -> new Date() produit un "Invalid Date"
    //     (NaN), que Prisma refusait ensuite avec une exception brute (stack trace complète
    //     renvoyée telle quelle à l'utilisateur) ;
    //  2) jour inexistant pour CE mois précis (ex: "30/02/2026" — février n'a jamais 30 jours,
    //     "31/04/2026" — avril n'a que 30 jours) -> new Date() ne lève PAS de NaN, elle fait un
    //     rollover silencieux vers le mois suivant (30/02 devient le 2 mars) : la requête tourne
    //     sans erreur mais interroge une date DIFFÉRENTE de celle demandée, sans jamais le signaler
    //     — plus trompeur qu'un crash, jamais acceptable pour du CA. Détecté en comparant le
    //     jour/mois reconstruit après parsing à ceux demandés : un rollover les change forcément.
    const [yStr, mStr, dStr] = date.split('-');
    const rolledOver = dateStart.getUTCFullYear() !== Number(yStr)
      || dateStart.getUTCMonth() + 1 !== Number(mStr)
      || dateStart.getUTCDate() !== Number(dStr);
    if (Number.isNaN(dateStart.getTime()) || Number.isNaN(dateEnd.getTime()) || rolledOver) {
      return { found: false, message: `La date "${date}" n'est pas une date valide.` };
    }
  } else if (days) {
    dateEnd = new Date();
    dateStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    periodMode = 'CUSTOM_DAYS';
  } else if (ean && posId) {
    // "Le CA de l'article X" sans période précisée (spec du 28/09/2026 §1 : "si la période n'est
    // pas précisée, utiliser la période d'analyse par défaut du système") : reprend la même
    // résolution que la génération de proposition/Pareto (periodService.resolvePeriod) plutôt qu'un
    // défaut de 1 jour arbitraire et invisible — un CA "d'hier" en réponse à "quel est le CA de cet
    // article" avait déjà été trouvé trompeur (bug similaire à getParetoArticles, même correctif).
    try {
      const configService = require('./configService');
      const periodService = require('./periodService');
      const config = await configService.getConfig(rposShopId);
      const period = await periodService.resolvePeriod(posId, rposShopId, config);
      dateStart = new Date(period.start);
      dateEnd = new Date(period.end);
      periodMode = config.periodMode;
    } catch (err) {
      dateEnd = new Date();
      dateStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
      periodMode = 'FALLBACK_1_DAY';
    }
  } else {
    dateEnd = new Date();
    dateStart = new Date(Date.now() - (days || 1) * 24 * 60 * 60 * 1000);
    periodMode = 'DEFAULT_1_DAY';
  }

  // Un article précis (EAN) prime sur un filtre par département — une question "le CA de cet
  // article" ne doit jamais être diluée dans le CA de tout son rayon (bug trouvé le 16/09/2026 :
  // l'EAN était déjà extrait de la question et utilisé pour choisir la capacité de permission
  // requise — revenueArticle vs revenueShop, cf. aiPermissionsService.resolveRevenueCapability —
  // mais jamais transmis jusqu'ici pour filtrer réellement les données, donc "le CA de l'article X"
  // répondait en fait le CA de tout le magasin).
  let eanFilter = null;
  if (ean) {
    eanFilter = [ean];
  } else if (department) {
    const proposal = await getLatestProposal(rposShopId);
    if (proposal) {
      const departmentLines = await prisma.proposalLine.findMany({ where: { proposalId: proposal.id, department }, select: { ean: true } });
      eanFilter = departmentLines.map((l) => l.ean);
      if (!eanFilter.length) return { found: false, message: `Aucun article du rayon "${department}" trouvé dans la dernière proposition.` };
    }
  }

  const lines = await prisma.salesLine.findMany({
    where: { rposShopId, ...(eanFilter ? { ean: { in: eanFilter } } : {}), date: { gte: dateStart, lte: dateEnd } },
    select: { revenueExclTax: true, revenueInclTax: true, receiptId: true, syncedAt: true },
  });

  if (!lines.length) {
    return {
      found: false,
      message: `Aucune vente enregistrée sur la période${ean ? ` pour l'article ${ean}` : department ? ` pour le rayon ${department}` : ''}.`,
      periodStart: dateStart.toISOString(),
      periodEnd: dateEnd.toISOString(),
      periodMode,
    };
  }

  // Nombre de VENTES au sens tickets de caisse (receipt.id distincts, ajouté le 16/09/2026 —
  // confirmé par test direct que ce comptage retombe exactement sur le "Nb de ventes" de l'écran
  // RMaster). Distinct de articleLineCount (une ligne par article vendu, plusieurs lignes par
  // ticket) : null si aucune ligne de la période n'a de receiptId (données synchronisées avant
  // l'ajout de ce champ), jamais présenté comme "0 vente" qui serait faux.
  const linesWithReceipt = lines.filter((l) => l.receiptId);
  const salesCount = linesWithReceipt.length ? new Set(linesWithReceipt.map((l) => l.receiptId)).size : null;

  return {
    found: true,
    date: date || null,
    // days reflète le nombre de jours réellement transmis par l'appelant, jamais un défaut implicite
    // de 1 reconstruit après coup : quand la période vient d'un mode résolu (periodMode ci-dessous,
    // ex: LAST_365_DAYS), days reste null — periodStart/periodEnd font foi, pas ce champ.
    days: date ? null : (days || null),
    ean: ean || null,
    department: department || null,
    // periodStart/periodEnd (28/09/2026, spec "toujours afficher clairement la période d'analyse" —
    // §1 et §6) : dateStart/dateEnd étaient déjà calculées ci-dessus mais jamais exposées dans le
    // retour, forçant le LLM à reconstruire lui-même les dates depuis date/days — source d'erreur et
    // de confusion entre deux CA calculés sur des fenêtres différentes sans que la réponse ne le
    // dise. Bornes explicites en ISO, la seule source de vérité pour la période réellement utilisée.
    periodStart: dateStart.toISOString(),
    periodEnd: dateEnd.toISOString(),
    periodMode,
    revenueExclTaxCfa: Math.round(lines.reduce((s, l) => s + l.revenueExclTax, 0)),
    revenueInclTaxCfa: lines.every((l) => l.revenueInclTax !== null) ? Math.round(lines.reduce((s, l) => s + (l.revenueInclTax || 0), 0)) : null,
    // Nombre de VENTES (tickets de caisse distincts) — comparable au "Nb de ventes" de RMaster.
    // null si non disponible (période antérieure à la synchro du champ receipt), jamais 0 à tort.
    salesCount,
    // Nommé explicitement "articleLineCount" (pas "salesCount"/"ticketCount") pour que le LLM ne le
    // présente jamais comme "nombre de ventes"/"nombre de tickets" : c'est le nombre de LIGNES
    // vendues (un article vendu = une ligne), une notion différente de salesCount ci-dessus.
    articleLineCount: lines.length,
    // Demande du 27/09/2026 : "il doit me donner en signalant la dernière heure/date où il a pris
    // les données" — les ventes sont synchronisées depuis RPOS toutes les 15 minutes (jamais en
    // temps réel), donc un CA "d'aujourd'hui" peut avoir jusqu'à ~15 minutes de retard sur la
    // réalité RPOS. lastSyncedAt = la synchronisation la plus récente parmi les lignes retournées,
    // pour que la réponse dise explicitement jusqu'à quelle heure les données sont à jour plutôt que
    // de donner un chiffre sans préciser sa fraîcheur.
    lastSyncedAt: lines.reduce((max, l) => (!max || l.syncedAt > max ? l.syncedAt : max), null),
  };
}

/**
 * getRevenueAllShops(allowedShopIds, { date, days }) — classement du CA de TOUS les magasins
 * accessibles à l'utilisateur (demande du 19/09/2026 : "il peut poser une question quelle est le CA
 * des magasins, le système doit lui donner les infos sur le CA de chaque magasin... classé par
 * défaut par le plus haut niveau"). Réservé ADMIN/SUPERVISOR (résolu et vérifié en amont, jamais
 * dans ce tool — allowedShopIds est la liste déjà autorisée, cf. chatbotService.js) : un DIRECTOR/
 * DEPARTMENT_HEAD/SHELF_STOCKER reste cloisonné à son unique magasin comme partout ailleurs, cette
 * fonction n'est même pas exposée dans son catalogue de tools.
 * Classé par CA décroissant par défaut (le magasin au CA le plus élevé en tête) — cohérent avec le
 * principe déjà appliqué dans getParetoArticles/getTopGisements (toujours trié par ordre d'intérêt
 * décroissant, jamais un ordre arbitraire comme l'ordre d'insertion en base).
 */
async function getRevenueAllShops(allowedShopIds, { date, days = 1 } = {}) {
  if (!allowedShopIds || !allowedShopIds.length) return { found: false, message: 'Aucun magasin accessible pour ce compte.' };

  let dateStart;
  let dateEnd;
  if (date) {
    dateStart = new Date(date + 'T00:00:00.000Z');
    dateEnd = new Date(date + 'T23:59:59.999Z');
    if (Number.isNaN(dateStart.getTime())) return { found: false, message: `La date "${date}" n'est pas une date valide.` };
  } else {
    dateEnd = new Date();
    dateStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  }

  const grouped = await prisma.salesLine.groupBy({
    by: ['rposShopId'],
    where: { rposShopId: { in: allowedShopIds }, date: { gte: dateStart, lte: dateEnd } },
    _sum: { revenueExclTax: true, revenueInclTax: true },
  });
  const revenueByShop = new Map(grouped.map((g) => [g.rposShopId, g._sum]));

  const shops = await prisma.shop.findMany({ where: { rposShopId: { in: allowedShopIds } }, select: { rposShopId: true, reference: true, name: true } });

  const results = shops.map((shop) => ({
    rposShopId: shop.rposShopId,
    shopReference: shop.reference,
    shopName: shop.name,
    revenueExclTaxCfa: Math.round(revenueByShop.get(shop.rposShopId)?.revenueExclTax || 0),
    revenueInclTaxCfa: Math.round(revenueByShop.get(shop.rposShopId)?.revenueInclTax || 0),
  })).sort((a, b) => b.revenueExclTaxCfa - a.revenueExclTaxCfa);

  if (!results.length) return { found: false, message: 'Aucun magasin trouvé pour ce compte.' };

  return {
    found: true,
    date: date || null,
    days: date ? null : days,
    shopCount: results.length,
    totalRevenueExclTaxCfa: results.reduce((s, r) => s + r.revenueExclTaxCfa, 0),
    shops: results,
  };
}

/**
 * getSales() / getSalesHistory(ean, days, department) — historique de ventes réel depuis SalesLine.
 *
 * SalesLine ne connaît pas le rayon d'un article (seulement son EAN) : un filtre par département
 * passe donc d'abord par la dernière proposition (ProposalLine.department), la seule source locale
 * qui associe un EAN à son rayon, avant de restreindre SalesLine à ces EAN. Sans cette étape, une
 * question posée dans le contexte d'un rayon précis (ex: "BAZAR AGENCEMENT DECO" sélectionné dans
 * l'UI) sommait silencieusement les ventes de TOUT le magasin, produisant un total incohérent avec
 * le rayon affiché à l'utilisateur.
 */
async function getSalesHistory(rposShopId, { ean, days = 30, department } = {}) {
  const dateStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  let eanFilter = ean ? [ean] : null;
  if (!ean && department) {
    const proposal = await getLatestProposal(rposShopId);
    if (proposal) {
      const departmentLines = await prisma.proposalLine.findMany({
        where: { proposalId: proposal.id, department },
        select: { ean: true },
      });
      eanFilter = departmentLines.map((l) => l.ean);
      if (!eanFilter.length) return { found: false, message: `Aucun article du rayon "${department}" trouvé dans la dernière proposition.` };
    }
  }

  const rawLines = await prisma.salesLine.findMany({
    where: { rposShopId, ...(eanFilter ? { ean: { in: eanFilter } } : {}), date: { gte: dateStart } },
    select: { date: true, quantity: true, revenueExclTax: true, ean: true, label: true, receiptId: true },
    orderBy: { date: 'asc' },
  });

  // Écarte les articles génériques/poids libre (ex: "FRUITS & LEGUMES", "CHARCUTERIE PESEE") du
  // calcul de QUANTITÉ (cf. filterGenericArticleLines) — leur "quantité vendue" est en réalité une
  // valeur monétaire ou un poids, jamais un nombre d'unités réel. Le CA (getRevenue) n'est PAS
  // concerné : ces articles ont un vrai chiffre d'affaires réel, seule leur "quantité" n'a pas de sens.
  const lines = await filterGenericArticleLines(rposShopId, rawLines);

  const byDay = new Map();
  // Tickets distincts par jour (ajouté le 16/09/2026, même donnée que getRevenue.salesCount — ici
  // demandée typiquement par article, ex: "combien de ventes sur cet article le 14"), en plus de la
  // quantité déjà suivie ci-dessous : deux notions différentes (une vente peut porter plusieurs
  // unités du même article), toutes deux utiles selon la question posée.
  const receiptsByDay = new Map();
  for (const line of lines) {
    const day = line.date.toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) || 0) + line.quantity);
    if (line.receiptId) {
      if (!receiptsByDay.has(day)) receiptsByDay.set(day, new Set());
      receiptsByDay.get(day).add(line.receiptId);
    }
  }
  const linesWithReceipt = lines.filter((l) => l.receiptId);
  const totalSalesCount = linesWithReceipt.length ? new Set(linesWithReceipt.map((l) => l.receiptId)).size : null;

  // Détail par article seulement quand la question porte sur un rayon (plusieurs articles) plutôt
  // qu'un seul EAN précis : évite un doublon inutile de la même info pour une question ciblée.
  const byArticle = !ean
    ? Array.from(
        lines.reduce((map, l) => {
          const key = l.ean;
          if (!map.has(key)) map.set(key, { ean: l.ean, label: l.label, quantity: 0 });
          map.get(key).quantity += l.quantity;
          return map;
        }, new Map()).values()
      ).sort((a, b) => b.quantity - a.quantity).slice(0, 30)
    : null;

  return {
    found: lines.length > 0,
    days,
    ean: ean || null,
    department: department || null,
    totalQuantity: lines.reduce((s, l) => s + l.quantity, 0),
    // Nombre de VENTES (tickets de caisse distincts) sur toute la période demandée — null si aucune
    // ligne n'a de receiptId (données synchronisées avant l'ajout de ce champ), jamais 0 à tort.
    // Distinct de totalQuantity (une vente peut porter plusieurs unités du même article).
    totalSalesCount,
    dailyHistory: Array.from(byDay.entries()).map(([date, quantity]) => ({
      date,
      quantity,
      salesCount: receiptsByDay.has(date) ? receiptsByDay.get(date).size : null,
    })),
    topArticles: byArticle,
  };
}

/** getCurrentProposal() — la proposition en attente de validation pour ce magasin. */
async function getCurrentProposal(rposShopId, { department } = {}) {
  const proposal = await prisma.proposal.findFirst({
    where: { rposShopId, status: 'GENERATED' },
    orderBy: { generatedAt: 'desc' },
    include: { lines: { select: { ean: true, label: true, quantitySuggested: true, department: true } } },
  });
  if (!proposal) return { found: false, message: 'Aucune proposition en attente de validation pour ce magasin.' };

  const lines = department ? proposal.lines.filter((l) => l.department === department) : proposal.lines;
  if (department && !lines.length) return { found: false, message: `Aucun article du rayon "${department}" dans la proposition en attente.` };

  return {
    found: true,
    generatedAt: proposal.generatedAt,
    status: proposal.status,
    department: department || null,
    articleCount: lines.length,
    lines: lines.slice(0, 200),
  };
}

/** getStockoutRisks() — articles dont la rupture est proche (daysUntilStockout bas), triés par urgence. */
async function getStockoutRisks(rposShopId, { maxDays = 3, department } = {}) {
  const proposal = await getLatestProposal(rposShopId);
  if (!proposal) return { found: false, message: 'Aucune proposition générée pour ce magasin.' };

  const lines = await prisma.proposalLine.findMany({
    where: {
      proposalId: proposal.id,
      daysUntilStockout: { not: null, lte: maxDays },
      ...(department ? { department } : {}),
    },
    orderBy: { daysUntilStockout: 'asc' },
    select: { ean: true, label: true, department: true, stockAtGeneration: true, daysUntilStockout: true, quantitySuggested: true },
    take: 50,
  });

  return { found: true, maxDays, count: lines.length, lines };
}

/** getOverstockArticles() — articles dont le stock couvre largement plus que la vente moyenne (surstock probable). */
async function getOverstockArticles(rposShopId, { minWeeksOfCoverage = 6, department } = {}) {
  const proposal = await getLatestProposal(rposShopId);
  if (!proposal) return { found: false, message: 'Aucune proposition générée pour ce magasin.' };

  const lines = await prisma.proposalLine.findMany({
    where: { proposalId: proposal.id, ...(department ? { department } : {}) },
    select: { ean: true, label: true, department: true, stockAtGeneration: true, avgWeeklySales: true },
  });

  const overstocked = lines
    .filter((l) => l.avgWeeklySales > 0 && (l.stockAtGeneration || 0) / l.avgWeeklySales >= minWeeksOfCoverage)
    .map((l) => ({ ...l, weeksOfCoverage: Math.round(((l.stockAtGeneration || 0) / l.avgWeeklySales) * 10) / 10 }))
    .sort((a, b) => b.weeksOfCoverage - a.weeksOfCoverage)
    .slice(0, 50);

  return { found: true, minWeeksOfCoverage, count: overstocked.length, lines: overstocked };
}

/**
 * getParetoArticles() — articles représentant la part de CA demandée (§7 du cahier des charges,
 * "les articles représentant les 80% du CA"), recalculé directement depuis TOUTES les ventes
 * réelles du magasin sur la période (SalesLine), PAS depuis ProposalLine : celle-ci ne contient que
 * les articles retenus dans la proposition finale après exclusions (stock non fiable, déjà
 * commandé...), donc son cumul ne repart jamais de 0% et ne représente plus le vrai classement
 * Pareto de l'ensemble des articles vendus par le magasin.
 */
// posId ajouté le 28/09/2026 (spec "une seule source de vérité pour les périodes") : quand `days`
// n'est pas précisé par l'utilisateur, la période résolue est désormais EXACTEMENT la même que
// celle utilisée pour générer la proposition de ce magasin (resolvePeriod + config.periodMode),
// plutôt qu'un défaut de 30 jours glissants sur l'horloge système indépendant de tout réglage —
// jusqu'ici le Pareto du chatbot pouvait porter sur une fenêtre totalement différente de celle
// affichée dans la proposition, sans que ni l'un ni l'autre ne le signale (bug trouvé à l'audit du
// 28/09/2026). `days` explicite (utilisateur : "Pareto sur 3 mois") reste toujours prioritaire.
// thresholdPct par défaut = null : résolu plus bas sur config.paretoThreshold du magasin (même
// valeur que la génération), jamais 80 arbitraire si le magasin a un seuil personnalisé différent.
async function getParetoArticles(posId, rposShopId, { thresholdPct, department, days } = {}) {
  const configService = require('./configService');
  const periodService = require('./periodService');
  const config = await configService.getConfig(rposShopId);
  const effectiveThresholdPct = thresholdPct || Math.round((config.paretoThreshold || 0.8) * 100);

  let dateStart;
  let dateEnd = new Date();
  let periodLabel;
  if (days) {
    dateStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    periodLabel = { mode: 'CUSTOM_DAYS', days };
  } else if (posId) {
    try {
      const period = await periodService.resolvePeriod(posId, rposShopId, config);
      dateStart = new Date(period.start);
      dateEnd = new Date(period.end);
      periodLabel = { mode: config.periodMode };
    } catch (err) {
      // Période non résolvable (aucune vente RPOS connue...) : repli sur 30 jours glissants plutôt
      // que de faire échouer toute la question — le champ "days" dans la réponse signale alors ce
      // repli au LLM, jamais présenté comme la vraie période configurée du magasin.
      dateStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      periodLabel = { mode: 'FALLBACK_30_DAYS', days: 30, fallbackReason: err.message };
    }
  } else {
    dateStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    periodLabel = { mode: 'FALLBACK_30_DAYS', days: 30 };
  }
  const thresholdPctResolved = effectiveThresholdPct;

  let eanFilter = null;
  if (department) {
    const proposal = await getLatestProposal(rposShopId);
    if (proposal) {
      const departmentLines = await prisma.proposalLine.findMany({ where: { proposalId: proposal.id, department }, select: { ean: true } });
      eanFilter = departmentLines.map((l) => l.ean);
      if (!eanFilter.length) return { found: false, message: `Aucun article du rayon "${department}" trouvé dans la dernière proposition.` };
    }
  }

  const lines = await prisma.salesLine.findMany({
    where: { rposShopId, ...(eanFilter ? { ean: { in: eanFilter } } : {}), date: { gte: dateStart, lte: dateEnd } },
    select: { ean: true, label: true, revenueExclTax: true },
  });
  if (!lines.length) return { found: false, message: `Aucune vente enregistrée sur la période résolue${department ? ` pour le rayon ${department}` : ''}.` };

  const byEan = new Map();
  for (const line of lines) {
    if (!byEan.has(line.ean)) byEan.set(line.ean, { ean: line.ean, label: line.label, revenue: 0 });
    const entry = byEan.get(line.ean);
    entry.revenue += line.revenueExclTax;
    if (line.label) entry.label = line.label;
  }

  const articles = Array.from(byEan.values()).filter((a) => a.revenue > 0).sort((a, b) => b.revenue - a.revenue);
  const totalRevenue = articles.reduce((s, a) => s + a.revenue, 0);

  let cumulative = 0;
  const withinThreshold = [];
  for (const art of articles) {
    cumulative += art.revenue;
    const cumulativePct = (cumulative / totalRevenue) * 100;
    withinThreshold.push({
      ean: art.ean,
      label: art.label,
      revenue: art.revenue,
      revenueSharePct: Math.round((art.revenue / totalRevenue) * 10000) / 100,
      cumulativePct: Math.round(cumulativePct * 100) / 100,
    });
    if (cumulativePct >= thresholdPctResolved) break;
  }

  // Regroupement par rayon réel (demande du 19/09/2026 : "quand on demande les articles qui font
  // 80% du CA, qu'il découpe par rayon" — jusqu'ici la réponse listait des libellés d'articles bruts
  // sans hiérarchie, certains étant eux-mêmes des noms de rayon agrégés type "FRUITS & LEGUMES",
  // prêtant à confusion avec un vrai classement par rayon). Le rayon (ProposalLine.department) n'est
  // connu QUE pour les EAN déjà présents dans la dernière proposition — un article jamais proposé
  // (ex: hors Pareto habituel, nouveau) reste sous "Rayon non renseigné" plutôt que d'être exclu.
  const latestProposal = !department ? await getLatestProposal(rposShopId) : null;
  let departmentByEan = new Map();
  if (latestProposal) {
    const proposalLines = await prisma.proposalLine.findMany({
      where: { proposalId: latestProposal.id, ean: { in: withinThreshold.map((a) => a.ean) } },
      select: { ean: true, department: true, sector: true },
    });
    departmentByEan = new Map(proposalLines.map((l) => [l.ean, { department: l.department, sector: l.sector }]));
  }

  const byDepartment = new Map();
  for (const art of withinThreshold) {
    const info = departmentByEan.get(art.ean);
    const key = info?.department || 'Rayon non renseigné';
    const entry = byDepartment.get(key) || { department: key, sector: info?.sector || null, revenue: 0, articleCount: 0 };
    entry.revenue += art.revenue;
    entry.articleCount += 1;
    byDepartment.set(key, entry);
  }
  const departments = Array.from(byDepartment.values())
    .map((d) => ({ ...d, revenueSharePct: Math.round((d.revenue / totalRevenue) * 10000) / 100 }))
    .sort((a, b) => b.revenue - a.revenue);

  // Seuil au-delà duquel "Rayon non renseigné" domine trop le classement pour rester présenté comme
  // un résultat normal (demande du 19/09/2026) : la dernière proposition ne couvre alors visiblement
  // pas assez d'articles (proposition ancienne, limitée, ou magasin jamais généré) — le LLM doit le
  // dire explicitement plutôt que de laisser croire à un vrai rayon "non renseigné" comme les autres.
  const unassignedShare = byDepartment.get('Rayon non renseigné')?.revenueSharePct
    ?? (byDepartment.has('Rayon non renseigné') ? Math.round((byDepartment.get('Rayon non renseigné').revenue / totalRevenue) * 10000) / 100 : 0);
  const UNASSIGNED_WARNING_THRESHOLD_PCT = 20;

  return {
    found: true,
    thresholdPct: thresholdPctResolved,
    // periodStart/periodEnd (28/09/2026) : bornes réellement utilisées, jamais seulement "days" en
    // interne — periodMode indique explicitement si c'est LA MÊME période que la proposition
    // (config.periodMode du magasin) ou un repli/une demande explicite de l'utilisateur.
    periodStart: dateStart.toISOString(),
    periodEnd: dateEnd.toISOString(),
    periodMode: periodLabel.mode,
    days: periodLabel.days || null,
    department: department || null,
    totalArticlesWithSales: articles.length,
    articleCount: withinThreshold.length,
    // "departments" est le classement PRINCIPAL à présenter (demande explicite de regroupement par
    // rayon) ; "lines" (détail par article individuel) reste disponible pour une question de suivi
    // qui demanderait le détail d'un rayon précis.
    departments,
    departmentDataIncomplete: unassignedShare > UNASSIGNED_WARNING_THRESHOLD_PCT,
    unassignedRevenueSharePct: unassignedShare,
    lines: withinThreshold.slice(0, 100),
  };
}

/** getPredictionAccuracy() — précision réelle des prédictions passées pour ce magasin (KPI §23). */
async function getPredictionAccuracy(rposShopId, { days = 90 } = {}) {
  const dateStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const outcomes = await prisma.aIPredictionOutcome.findMany({
    where: { prediction: { rposShopId }, evaluatedAt: { gte: dateStart } },
    select: { percentageError: true, forecastError: true, actualSales: true, predictedQuantity: true },
  });

  const withPct = outcomes.filter((o) => o.percentageError !== null);
  if (!withPct.length) return { found: false, message: `Aucune prédiction évaluée sur les ${days} derniers jours pour ce magasin.` };

  const avgAbsError = withPct.reduce((s, o) => s + Math.abs(o.percentageError), 0) / withPct.length;
  return {
    found: true,
    days,
    evaluatedPredictions: withPct.length,
    averageAbsolutePercentageError: Math.round(avgAbsError * 1000) / 10, // en %
    accuracyPct: Math.round((1 - avgAbsError) * 1000) / 10,
  };
}

/** getOrders() — commandes fournisseur créées récemment par cette plateforme pour ce magasin. */
async function getOrders(rposShopId, { days = 14 } = {}) {
  const dateStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const orders = await prisma.proposalOrder.findMany({
    where: { proposal: { rposShopId }, createdAt: { gte: dateStart } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, department: true, rposOrderReference: true, createdAt: true, receptionStatus: true },
    take: 50,
  });
  return { found: orders.length > 0, days, count: orders.length, orders };
}

/**
 * getArticleDetails(posId, shopId, ean) — fiche complète d'un article en direct depuis RPOS
 * (demande du 15/09/2026 : un admin doit pouvoir demander "où se trouve cet article", "quel est
 * son prix actuel", "a-t-il une promo" et toute autre info produit). Distinct de getArticleStock
 * (qui ne lit que la dernière proposition, donc jamais l'emplacement/prix/promo) — ici l'appel RPOS
 * direct donne la fiche produit réelle et à jour, quel que soit l'état de la dernière génération.
 */
function toNum(v) {
  return v !== undefined && v !== null && v !== '' ? Number(v) : null;
}

async function getArticleDetails(posId, shopId, ean) {
  const product = await rpos.getProductByEan(posId, shopId, ean);
  if (!product) return { found: false, message: `Article ${ean} introuvable côté RPOS pour ce magasin.` };

  const hasPromo = !!(product.promo_price || (product.promotions && Object.keys(product.promotions).length));
  const address = (product.addresses && product.addresses[0]) || null;

  // Fiche complète calquée sur l'écran produit RPOS (demande du 15/09/2026 : "tout les champ
  // disponible... il doit avoir tout") — chaque section de cet écran (identification, prix, stock,
  // conditionnement, options caisse, fidélité, fournisseur) mappée en un champ exploitable par l'IA,
  // plutôt que le sous-ensemble prix/emplacement/promo initial.
  return {
    found: true,
    // Identification
    ean: product.ean,
    shortCode: product.short_code || null,
    label1: product.label_1 || null,
    label2: product.label_2 || null,
    label3: product.label_3 || null,
    department: product.department ? { name: product.department.name, code: product.department.code } : null,
    productType: product.product_type || null,
    linkedCodes: (product.linked_codes || []).map((c) => c.ean).filter(Boolean),
    // Emplacement rayon physique (adresse RPOS) : ce que le magasin appelle "où se trouve l'article".
    location: address ? { name: address.name, code: address.code } : null,
    // Prix
    sellingPrice: toNum(product.selling_price),
    shopPrice: toNum(product.shop_price),
    promoPrice: toNum(product.promo_price),
    hasPromo,
    priceExclTax: toNum(product.price_excl_tax),
    buyingPrice: toNum(product.buying_price),
    pamp: toNum(product.pamp),
    marginRate: toNum(product.margin_rate),
    shippingCost: toNum(product.shipping_cost),
    vat: product.vat ? { name: product.vat.name, ratePct: toNum(product.vat.value) } : null,
    lastSellingDate: product.last_selling_date || null,
    // Stock
    stock: toNum(product.stock),
    endOfLifeStock: toNum(product.end_of_life_stock),
    lowStockAlert: toNum(product.low_stock_alert),
    handleStock: !!product.handle_stock,
    blocked: !!product.blocked,
    orderable: !!product.orderable,
    currentOrderedQuantity: toNum(product.current_ordered_quantity),
    nextDeliveryQuantity: toNum(product.next_delivery_quantity),
    // Conditionnement / unités
    inputMethod: product.input_method ? product.input_method.display_name : null,
    sellingUnit: product.selling_unit ? product.selling_unit.display_name : null,
    orderingUnit: toNum(product.ordering_unit),
    packagingUnit: product.packaging_unit ? product.packaging_unit.display_name : null,
    packagedQuantity: toNum(product.packaged_quantity),
    maxOrderQuantity: toNum(product.max_quantity),
    internalPackaging: product.internal_packaging || null,
    // Options caisse
    autoPosButton: !!product.auto_pos_button,
    gridSearchFlag: !!product.grid_search_flag,
    discountAllowed: !!product.discount_allowed,
    manualDiscountAllowed: !!product.manual_discount_allowed,
    forcedPriceAllowed: !!product.forced_price_allowed,
    isComponent: !!product.is_component,
    qualifiesForTicketResto: !!product.qualifies_for_ticket_resto,
    // Fidélité / origine
    countryOrigin: product.country_origin || null,
    supplierReference: product.supplier_reference || null,
    // Magasin / fournisseurs
    shop: product.shop ? { reference: product.shop.reference, name: product.shop.name } : null,
    defaultSupplier: product.default_supplier || null,
    suppliers: (product.suppliers || []).map((s) => ({ name: s.name, code: s.code, deliveryTimeDays: s.delivery_time_days })),
  };
}

/**
 * getArticlesByGisement(posId, shopId, gisementQuery, { days }) — liste des articles d'un gisement
 * (position physique de stockage en magasin, ex: "PETITS ELECTRO-MENAGERS"), en direct depuis RPOS
 * (demande du 18/09/2026 : "je veux voir mes tops ventes de chaque gisement" — le chatbot ne
 * connaissait jusqu'ici que la fiche complète d'UN article via getArticleDetails, jamais "tous les
 * articles D'UN gisement"). Distinct de department/rayon (getDepartmentHierarchy, classification
 * produit) : le gisement est une notion RPOS différente, la position physique réelle en magasin —
 * malgré la ressemblance de vocabulaire, ne jamais confondre les deux dans une réponse.
 * Recherche par nom approximatif (insensible à la casse, sous-chaîne) — l'utilisateur ne connaît
 * jamais l'id technique du gisement, seulement son nom affiché en magasin.
 *
 * Croisé avec SalesLine (ajouté le 18/09/2026, même magasin/jours que les autres outils de ventes) :
 * la liste RPOS seule ne donne que stock/prix, jamais un "top ventes" — sans ce croisement, le LLM
 * ne pouvait que dire "je n'ai pas cette donnée" à une question pourtant légitime. articleCount peut
 * dépasser 250 sur un gros gisement ; on ne trie/n'agrège les ventes que sur les EAN réellement
 * présents dans ce gisement, jamais sur tout le magasin (ce serait le rôle de getParetoArticles).
 */
async function getArticlesByGisement(posId, shopId, gisementQuery, { days = 30 } = {}) {
  const result = await rpos.getArticlesByGisement(posId, shopId, gisementQuery);
  if (!result) return { found: false, message: `Aucun gisement trouvé correspondant à "${gisementQuery}" pour ce magasin.` };

  const eans = result.articles.map((a) => a.ean).filter(Boolean);
  const dateStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const salesByEan = new Map();
  if (eans.length) {
    const lines = await prisma.salesLine.findMany({
      where: { rposShopId: shopId, ean: { in: eans }, date: { gte: dateStart } },
      select: { ean: true, quantity: true, revenueExclTax: true },
    });
    for (const line of lines) {
      const entry = salesByEan.get(line.ean) || { quantitySold: 0, revenue: 0 };
      entry.quantitySold += line.quantity;
      entry.revenue += line.revenueExclTax;
      salesByEan.set(line.ean, entry);
    }
  }

  const articles = result.articles.map((a) => ({
    ...a,
    quantitySold: salesByEan.get(a.ean)?.quantitySold || 0,
    revenue: salesByEan.get(a.ean)?.revenue || 0,
  })).sort((a, b) => b.revenue - a.revenue);

  return {
    found: true,
    gisementName: result.gisementName,
    gisementCode: result.gisementCode,
    articleCount: result.articleCount,
    days,
    salesDataAvailable: salesByEan.size > 0,
    articles,
  };
}

// Nombre de meilleurs articles (par CA) dont on résout le gisement pour construire getTopGisements
// — jamais tous les articles vendus (potentiellement des milliers), un appel RPOS par article
// résolu serait bien trop lourd. 30 (réduit de 60 le 18/09/2026, ~30s -> ~15s en pratique) : le
// Pareto 80/20 capture déjà l'essentiel du signal bien avant ce nombre pour un magasin type — un
// classement de gisements n'a pas besoin de la même exhaustivité qu'un calcul de proposition.
const TOP_GISEMENTS_ARTICLE_SAMPLE = 30;
const TOP_GISEMENTS_CONCURRENCY = 8;

/**
 * getTopGisements(posId, shopId, { days }) — classement des gisements (positions physiques de
 * stockage) par chiffre d'affaires généré, quand aucun gisement précis n'est nommé dans la question
 * (demande du 18/09/2026 : "tops ventes de chaque gisement" sans nom — répondre par un vrai
 * classement plutôt que de bloquer sur "précisez lequel"). Approche : identifie les meilleurs
 * articles vendus (déjà en base, SalesLine — aucun coût RPOS), résout leur gisement UN PAR UN via
 * RPOS (getProductGisement, TOP_GISEMENTS_ARTICLE_SAMPLE articles maximum, en parallèle contrôlé),
 * puis agrège par gisement. Ne parcourt JAMAIS tous les gisements du magasin (391 vus le 18/09/2026)
 * ni tous les articles vendus — seulement l'échantillon des meilleures ventes, en confiance que le
 * Pareto 80/20 y capture l'essentiel du signal utile pour un classement de gisements.
 */
async function getTopGisements(posId, shopId, { days = 30 } = {}) {
  const dateStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const lines = await prisma.salesLine.findMany({
    where: { rposShopId: shopId, date: { gte: dateStart } },
    select: { ean: true, revenueExclTax: true, quantity: true },
  });
  if (!lines.length) return { found: false, message: `Aucune vente enregistrée sur les ${days} derniers jours.` };

  // Écarte les articles génériques/poids libre agrégés au niveau d'un rayon entier (ex: "FRUITS &
  // LEGUMES", "CHARCUTERIE PESEE") avant l'agrégation par EAN — cf. filterGenericArticleLines
  // (deux signaux combinés, un seul suffisait pas : trouvé le 18-19/09/2026, un classement de
  // gisements ET un "tops ventes" faussés par ces pseudo-articles malgré un premier filtre).
  const genuineLines = await filterGenericArticleLines(shopId, lines);

  const byEan = new Map();
  for (const line of genuineLines) {
    const entry = byEan.get(line.ean) || { ean: line.ean, revenue: 0, quantitySold: 0 };
    entry.revenue += line.revenueExclTax;
    entry.quantitySold += line.quantity;
    byEan.set(line.ean, entry);
  }
  const topArticles = Array.from(byEan.values())
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, TOP_GISEMENTS_ARTICLE_SAMPLE);

  const resolved = await mapWithConcurrency(topArticles, TOP_GISEMENTS_CONCURRENCY, async (art) => {
    try {
      const gisement = await rpos.getProductGisement(posId, shopId, art.ean);
      return gisement ? { ...art, gisementName: gisement.name, gisementCode: gisement.code } : null;
    } catch (err) {
      return null; // un article dont le gisement échoue à résoudre est simplement ignoré, jamais fatal
    }
  });

  const byGisement = new Map();
  for (const art of resolved) {
    if (!art) continue;
    const key = art.gisementCode || art.gisementName;
    const entry = byGisement.get(key) || { gisementName: art.gisementName, gisementCode: art.gisementCode, revenue: 0, quantitySold: 0, articleCount: 0 };
    entry.revenue += art.revenue;
    entry.quantitySold += art.quantitySold;
    entry.articleCount += 1;
    byGisement.set(key, entry);
  }

  const gisements = Array.from(byGisement.values()).sort((a, b) => b.revenue - a.revenue);
  if (!gisements.length) return { found: false, message: 'Impossible de rattacher les meilleures ventes à un gisement (données RPOS indisponibles).' };

  return {
    found: true,
    days,
    sampleSize: topArticles.length,
    note: `Classement basé sur les ${topArticles.length} meilleures ventes du magasin, pas la totalité des articles.`,
    gisements,
  };
}

/**
 * getPriceChangeHistory(posId, shopId, ean) — historique des changements de prix (vente, promo,
 * achat) d'un article, en direct depuis RPOS (demande du 15/09/2026 : "quand est-ce que l'article a
 * changé de prix de vente ou prix promo, je veux les détails"). Miroir de l'écran admin RPOS "Log
 * changements de prix".
 */
async function getPriceChangeHistory(posId, shopId, ean) {
  const history = await rpos.getPriceChangeHistory(posId, shopId, ean, { limit: 30 });
  if (!history.length) return { found: false, message: `Aucun changement de prix enregistré pour l'article ${ean}.` };
  return { found: true, ean, label: history[0].label, changeCount: history.length, history };
}

/**
 * getStockMoveHistory(posId, shopId, ean, { days }) — pourquoi le stock d'un article a bougé, au-delà
 * des seules ventes : casse, cession entre rayons, retour fournisseur, inventaire, consommation
 * interne... (demande du 16/09/2026, à partir de /api/stock_move/ RPOS, écran admin "Mouvements de
 * stock"). Une baisse de stock n'est pas toujours une vente — cet outil permet au chatbot de répondre
 * avec la vraie cause plutôt que de supposer que tout écart vient de la demande client.
 */
async function getStockMoveHistory(posId, shopId, ean, { days = 14 } = {}) {
  const dateEnd = new Date();
  const dateStart = new Date(dateEnd.getTime() - days * 24 * 60 * 60 * 1000);
  const summary = await stockMoveAnalysis.getStockMoveSummary(
    posId, shopId, ean, dateStart.toISOString(), dateEnd.toISOString(),
  );
  if (!summary.totalMoves) {
    // Rien sur la fenêtre récente (souvent 14j par défaut) : chercher le tout dernier mouvement
    // connu, sans limite de temps, pour donner une vraie date plutôt qu'un silence qui laisse croire
    // à tort qu'aucune donnée n'existe DU TOUT pour cet article (bug réel signalé le 29/09/2026 : un
    // article dont le dernier mouvement remontait à plus d'un mois répondait "en développement",
    // trompeur — la donnée existe, elle est juste antérieure à la fenêtre par défaut).
    const veryOldStart = new Date('2000-01-01').toISOString();
    let lastKnownMove = null;
    try {
      const allMoves = await rpos.getStockMovesForProduct(posId, shopId, ean, veryOldStart, dateEnd.toISOString(), { limit: 1 });
      lastKnownMove = allMoves[0] || null;
    } catch {
      // Repli best-effort : un échec ici ne doit jamais empêcher de répondre au moins la formule
      // honnête "aucun mouvement récent", jamais planter toute la conversation pour ce seul détail.
    }
    return {
      found: false,
      message: lastKnownMove
        ? `Aucun mouvement de stock enregistré pour l'article ${ean} sur les ${days} derniers jours. Le dernier mouvement connu remonte au ${lastKnownMove.date.slice(0, 10)} (${lastKnownMove.typeLabel}).`
        : `Aucun mouvement de stock enregistré pour l'article ${ean} sur les ${days} derniers jours, ni dans l'historique disponible.`,
      lastKnownMoveDate: lastKnownMove ? lastKnownMove.date : null,
      lastKnownMoveType: lastKnownMove ? lastKnownMove.typeLabel : null,
    };
  }
  return { found: true, days, ...summary };
}

/**
 * getDlvArticles() — articles ayant actuellement du stock en DLV (Date Limite de Vente courte,
 * demande du 22/09/2026). PAS une date de péremption automatique : un geste manuel du personnel
 * qui bascule une partie du stock d'un article sur un EAN "DLV" distinct, vendu à prix réduit
 * jusqu'à écoulement (cf. schema.prisma#ProductEndOfLife, synchronisé depuis RPOS toutes les
 * heures). Un article avec beaucoup de stock en DLV signale un problème de rotation. Trié par
 * stock DLV décroissant (les plus gros volumes à écouler en premier).
 */
async function getDlvArticles(rposShopId, { limit = 50 } = {}) {
  const rows = await prisma.productEndOfLife.findMany({
    where: { rposShopId, dlvStock: { gt: 0 } },
    orderBy: { dlvStock: 'desc' },
    take: limit,
  });
  if (!rows.length) return { found: false, message: 'Aucun article en DLV pour ce magasin actuellement.' };

  return {
    found: true,
    count: rows.length,
    articles: rows.map((r) => ({
      originEan: r.originEan,
      label: r.label,
      dlvStock: r.dlvStock,
      sellingPrice: r.sellingPrice,
      syncedAt: r.syncedAt,
    })),
  };
}

/** getArticleDlvStatus() — un article précis a-t-il du stock en DLV actuellement ? */
async function getArticleDlvStatus(rposShopId, ean) {
  const rows = await prisma.productEndOfLife.findMany({
    where: { rposShopId, originEan: ean, dlvStock: { gt: 0 } },
  });
  if (!rows.length) {
    return { found: true, hasDlv: false, message: `Aucune DLV active pour l'article ${ean} dans ce magasin.` };
  }
  const totalDlvStock = rows.reduce((sum, r) => sum + r.dlvStock, 0);
  return {
    found: true,
    hasDlv: true,
    ean,
    label: rows[0].label,
    totalDlvStock,
    entries: rows.map((r) => ({ dlvEan: r.dlvEan, dlvStock: r.dlvStock, sellingPrice: r.sellingPrice })),
  };
}

/**
 * getOrderAnomalies() — commandes récentes dont la quantité validée s'écarte nettement de
 * l'historique du magasin (page Anomalies de commande, orderAnomalyService.js déjà existant) —
 * demande du 26/09/2026 : "y a-t-il des anomalies sur mes commandes récentes ?". Ne traite JAMAIS
 * une anomalie comme "commande incorrecte" par elle-même (règle §9 du document d'origine) : direction
 * HIGH/LOW et statut (PENDING encore à traiter, ACKNOWLEDGED déjà vu, DISMISSED fausse alerte
 * confirmée) sont renvoyés tels quels, jamais reformulés en jugement.
 */
async function getOrderAnomalies(rposShopId, { status, limit = 20 } = {}) {
  const rows = await listAnomalies({ rposShopId, status: status || 'PENDING', limit });
  if (!rows.length) {
    return { found: true, count: 0, message: 'Aucune anomalie de commande actuellement pour ce magasin.' };
  }
  return {
    found: true,
    count: rows.length,
    anomalies: rows.map((r) => ({
      ean: r.ean,
      label: r.label,
      direction: r.direction, // HIGH (quantité inhabituellement élevée) | LOW (inhabituellement basse)
      newQuantity: r.newQuantity,
      historicalMean: r.historicalMean,
      historicalMin: r.historicalMin,
      historicalMax: r.historicalMax,
      sampleSize: r.sampleSize,
      status: r.status,
      detectedAt: r.detectedAt,
    })),
  };
}

// =============================================
// OUTILS "TOUS MAGASINS" (demande du 26/09/2026 : pilotage réseau pour un compte multi-magasins,
// ADMIN/SUPERVISOR) — même principe que getRevenueAllShops/getArticleStockAllShops déjà existants :
// `allowedShopIds` est résolu par l'appelant (chatbotService.js) selon le périmètre réel du compte
// (tous les magasins pour ADMIN, seulement les magasins supervisés pour SUPERVISOR), jamais recalculé
// ici. Zéro appel RPOS : uniquement des données déjà synchronisées en base, pour rester rapide même
// sur un grand nombre de magasins.
// =============================================

/**
 * getStockoutRisksAllShops() — pour chaque magasin du périmètre, les articles en risque de rupture
 * imminente (repris de getStockoutRisks, mais un compte par magasin plutôt que le détail complet —
 * une vue réseau doit rester lisible, pas une liste de centaines d'articles empilés).
 */
async function getStockoutRisksAllShops(allowedShopIds, { maxDays = 3 } = {}) {
  if (!allowedShopIds || !allowedShopIds.length) return { found: false, message: 'Aucun magasin accessible pour ce compte.' };

  const shops = await prisma.shop.findMany({ where: { rposShopId: { in: allowedShopIds } }, select: { rposShopId: true, reference: true, name: true } });
  const results = [];
  for (const shop of shops) {
    const proposal = await getLatestProposal(shop.rposShopId);
    if (!proposal) continue;
    const count = await prisma.proposalLine.count({
      where: { proposalId: proposal.id, daysUntilStockout: { not: null, lte: maxDays } },
    });
    if (count > 0) results.push({ rposShopId: shop.rposShopId, shopReference: shop.reference, shopName: shop.name, articlesAtRisk: count });
  }
  results.sort((a, b) => b.articlesAtRisk - a.articlesAtRisk);

  if (!results.length) return { found: true, maxDays, shopCount: 0, message: `Aucun magasin n'a d'article en risque de rupture (moins de ${maxDays} jour(s) de stock) actuellement.` };
  return { found: true, maxDays, shopCount: results.length, totalArticlesAtRisk: results.reduce((s, r) => s + r.articlesAtRisk, 0), shops: results };
}

/** getOverstockArticlesAllShops() — même principe que getStockoutRisksAllShops, pour le surstock. */
async function getOverstockArticlesAllShops(allowedShopIds, { minWeeksOfCoverage = 6 } = {}) {
  if (!allowedShopIds || !allowedShopIds.length) return { found: false, message: 'Aucun magasin accessible pour ce compte.' };

  const shops = await prisma.shop.findMany({ where: { rposShopId: { in: allowedShopIds } }, select: { rposShopId: true, reference: true, name: true } });
  const results = [];
  for (const shop of shops) {
    const proposal = await getLatestProposal(shop.rposShopId);
    if (!proposal) continue;
    const lines = await prisma.proposalLine.findMany({
      where: { proposalId: proposal.id },
      select: { stockAtGeneration: true, avgWeeklySales: true },
    });
    const count = lines.filter((l) => l.avgWeeklySales > 0 && (l.stockAtGeneration || 0) / l.avgWeeklySales >= minWeeksOfCoverage).length;
    if (count > 0) results.push({ rposShopId: shop.rposShopId, shopReference: shop.reference, shopName: shop.name, articlesOverstocked: count });
  }
  results.sort((a, b) => b.articlesOverstocked - a.articlesOverstocked);

  if (!results.length) return { found: true, minWeeksOfCoverage, shopCount: 0, message: 'Aucun magasin en surstock notable actuellement.' };
  return { found: true, minWeeksOfCoverage, shopCount: results.length, totalArticlesOverstocked: results.reduce((s, r) => s + r.articlesOverstocked, 0), shops: results };
}

/**
 * getPendingProposalsAllShops() — quels magasins du périmètre ont encore une proposition GENERATED
 * (pas encore validée) — même donnée que proposalReminderJob.js/endOfDayValidationRecapJob.js,
 * exposée ici en lecture pour une question directe au chat ("quelles propositions sont encore en
 * attente ?").
 */
async function getPendingProposalsAllShops(allowedShopIds) {
  if (!allowedShopIds || !allowedShopIds.length) return { found: false, message: 'Aucun magasin accessible pour ce compte.' };

  const pending = await prisma.proposal.findMany({
    where: { rposShopId: { in: allowedShopIds }, status: 'GENERATED' },
    select: { rposShopId: true, rposShopReference: true, rposShopName: true, lines: { select: { id: true } } },
  });
  if (!pending.length) return { found: true, shopCount: 0, message: 'Aucune proposition en attente de validation sur votre périmètre actuellement.' };

  const shops = pending
    .map((p) => ({ rposShopId: p.rposShopId, shopReference: p.rposShopReference, shopName: p.rposShopName, articlesPending: p.lines.length }))
    .sort((a, b) => b.articlesPending - a.articlesPending);

  return { found: true, shopCount: shops.length, totalArticlesPending: shops.reduce((s, r) => s + r.articlesPending, 0), shops };
}

/** getOrderAnomaliesAllShops() — anomalies de commande PENDING sur tout le périmètre (même donnée
 * que getOrderAnomalies, agrégée par magasin plutôt que le détail complet). */
async function getOrderAnomaliesAllShops(allowedShopIds) {
  if (!allowedShopIds || !allowedShopIds.length) return { found: false, message: 'Aucun magasin accessible pour ce compte.' };

  const rows = await listAnomalies({ status: 'PENDING', limit: 500 });
  const filtered = rows.filter((r) => allowedShopIds.includes(r.rposShopId));
  if (!filtered.length) return { found: true, shopCount: 0, message: 'Aucune anomalie de commande sur votre périmètre actuellement.' };

  const byShop = new Map();
  for (const r of filtered) {
    const key = r.rposShopId;
    if (!byShop.has(key)) byShop.set(key, { rposShopId: key, shopReference: r.shopReference, shopName: r.shopName, anomalyCount: 0 });
    byShop.get(key).anomalyCount += 1;
  }
  const shops = [...byShop.values()].sort((a, b) => b.anomalyCount - a.anomalyCount);

  return { found: true, shopCount: shops.length, totalAnomalies: filtered.length, shops };
}

/**
 * getPredictionAccuracyAllShops() — classement des magasins par fiabilité des prévisions IA
 * (PredictionOutcome déjà évalué par predictionOutcomeJob.js), pour répondre à "quel magasin a la
 * meilleure/pire précision ?".
 */
async function getPredictionAccuracyAllShops(allowedShopIds, { days = 90 } = {}) {
  if (!allowedShopIds || !allowedShopIds.length) return { found: false, message: 'Aucun magasin accessible pour ce compte.' };

  const dateStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const shops = await prisma.shop.findMany({ where: { rposShopId: { in: allowedShopIds } }, select: { rposShopId: true, reference: true, name: true } });
  const results = [];
  for (const shop of shops) {
    const outcomes = await prisma.aIPredictionOutcome.findMany({
      where: { prediction: { rposShopId: shop.rposShopId }, evaluatedAt: { gte: dateStart } },
      select: { percentageError: true },
    });
    const withPct = outcomes.filter((o) => o.percentageError !== null);
    if (!withPct.length) continue;
    const avgAbsError = withPct.reduce((s, o) => s + Math.abs(o.percentageError), 0) / withPct.length;
    results.push({
      rposShopId: shop.rposShopId, shopReference: shop.reference, shopName: shop.name,
      accuracyPct: Math.round((1 - avgAbsError) * 1000) / 10,
      sampleSize: withPct.length,
    });
  }
  if (!results.length) return { found: true, days, shopCount: 0, message: `Aucune prédiction évaluée sur les ${days} derniers jours pour votre périmètre.` };
  results.sort((a, b) => b.accuracyPct - a.accuracyPct);

  return { found: true, days, shopCount: results.length, shops: results };
}

/**
 * getRevenueTrendAllShops() — compare le CA de chaque magasin entre deux périodes consécutives de
 * même durée ("le réseau fait-il mieux que le mois dernier ?", "classe les magasins par évolution
 * des ventes"). currentDays définit la période récente ; la période précédente de même durée est
 * comparée automatiquement.
 */
async function getRevenueTrendAllShops(allowedShopIds, { currentDays = 30 } = {}) {
  if (!allowedShopIds || !allowedShopIds.length) return { found: false, message: 'Aucun magasin accessible pour ce compte.' };

  const now = new Date();
  const currentStart = new Date(now.getTime() - currentDays * 24 * 60 * 60 * 1000);
  const previousStart = new Date(now.getTime() - 2 * currentDays * 24 * 60 * 60 * 1000);

  const [currentGrouped, previousGrouped] = await Promise.all([
    prisma.salesLine.groupBy({ by: ['rposShopId'], where: { rposShopId: { in: allowedShopIds }, date: { gte: currentStart, lte: now } }, _sum: { revenueExclTax: true } }),
    prisma.salesLine.groupBy({ by: ['rposShopId'], where: { rposShopId: { in: allowedShopIds }, date: { gte: previousStart, lt: currentStart } }, _sum: { revenueExclTax: true } }),
  ]);
  const currentByShop = new Map(currentGrouped.map((g) => [g.rposShopId, g._sum.revenueExclTax || 0]));
  const previousByShop = new Map(previousGrouped.map((g) => [g.rposShopId, g._sum.revenueExclTax || 0]));

  const shops = await prisma.shop.findMany({ where: { rposShopId: { in: allowedShopIds } }, select: { rposShopId: true, reference: true, name: true } });
  const results = shops
    .map((shop) => {
      const current = Math.round(currentByShop.get(shop.rposShopId) || 0);
      const previous = Math.round(previousByShop.get(shop.rposShopId) || 0);
      const evolutionPct = previous > 0 ? Math.round(((current - previous) / previous) * 1000) / 10 : null;
      return { rposShopId: shop.rposShopId, shopReference: shop.reference, shopName: shop.name, currentRevenueCfa: current, previousRevenueCfa: previous, evolutionPct };
    })
    .filter((r) => r.currentRevenueCfa > 0 || r.previousRevenueCfa > 0)
    .sort((a, b) => (b.evolutionPct ?? -Infinity) - (a.evolutionPct ?? -Infinity));

  if (!results.length) return { found: true, shopCount: 0, message: 'Aucune vente trouvée sur votre périmètre pour cette comparaison.' };
  return {
    found: true, currentDays, shopCount: results.length,
    totalCurrentRevenueCfa: results.reduce((s, r) => s + r.currentRevenueCfa, 0),
    totalPreviousRevenueCfa: results.reduce((s, r) => s + r.previousRevenueCfa, 0),
    shops: results,
  };
}

/**
 * getSilentShops() — magasins du périmètre dont AUCUNE vente n'a été synchronisée depuis plus de
 * `staleDays` jours (cas réel trouvé en session : magasin 050, dernière vente datant d'août 2024) —
 * un vrai signal d'alerte pour un dirigeant, jamais visible autrement qu'en creusant magasin par
 * magasin. Zéro dépendance RPOS (pure lecture base).
 */
async function getSilentShops(allowedShopIds, { staleDays = 7 } = {}) {
  if (!allowedShopIds || !allowedShopIds.length) return { found: false, message: 'Aucun magasin accessible pour ce compte.' };

  const staleThreshold = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000);
  const shops = await prisma.shop.findMany({ where: { rposShopId: { in: allowedShopIds } }, select: { rposShopId: true, reference: true, name: true } });

  const results = [];
  for (const shop of shops) {
    const lastSale = await prisma.salesLine.findFirst({ where: { rposShopId: shop.rposShopId }, orderBy: { date: 'desc' }, select: { date: true } });
    if (!lastSale || lastSale.date < staleThreshold) {
      const daysSinceLastSale = lastSale ? Math.floor((Date.now() - lastSale.date.getTime()) / (24 * 60 * 60 * 1000)) : null;
      results.push({ rposShopId: shop.rposShopId, shopReference: shop.reference, shopName: shop.name, lastSaleDate: lastSale?.date || null, daysSinceLastSale });
    }
  }
  results.sort((a, b) => (b.daysSinceLastSale ?? Infinity) - (a.daysSinceLastSale ?? Infinity));

  if (!results.length) return { found: true, staleDays, shopCount: 0, message: `Tous les magasins de votre périmètre ont des ventes synchronisées récemment (moins de ${staleDays} jour(s)).` };
  return { found: true, staleDays, shopCount: results.length, shops: results };
}

/**
 * Compte les comptes utilisateurs actifs rattachés à un magasin — demande du 27/09/2026 : "est-ce
 * que le système peut répondre combien d'utilisateurs sont dans ce magasin ?". Deux façons distinctes
 * d'être rattaché à un magasin (cf. schema.prisma, User) : rposShopId direct (DIRECTOR/
 * DEPARTMENT_HEAD/SHELF_STOCKER, un seul magasin fixe) OU via SupervisedShop (SUPERVISOR, plusieurs
 * magasins choisis) — un SUPERVISOR de ce magasin compte donc lui aussi, listé séparément pour ne
 * jamais laisser croire qu'il y travaille au même titre qu'un compte mono-magasin. isActive
 * uniquement : un compte désactivé n'est plus vraiment "dans" ce magasin au sens où l'utilisateur
 * pose la question (qui y travaille réellement aujourd'hui), mais compté à part pour rester complet
 * plutôt que silencieusement absent des chiffres.
 */
async function getShopUsers(rposShopId) {
  const shop = await prisma.shop.findUnique({ where: { rposShopId }, select: { reference: true, name: true } });
  const directUsers = await prisma.user.findMany({
    where: { rposShopId },
    select: { name: true, role: true, isActive: true, assignedDepartment: true },
  });
  const supervisors = await prisma.supervisedShop.findMany({
    where: { rposShopId },
    select: { user: { select: { name: true, isActive: true } } },
  });

  const activeDirect = directUsers.filter((u) => u.isActive);
  const inactiveDirect = directUsers.filter((u) => !u.isActive);
  const activeSupervisors = supervisors.filter((s) => s.user.isActive).map((s) => s.user.name);

  return {
    found: true,
    shopReference: shop?.reference || null,
    shopName: shop?.name || null,
    directUserCount: activeDirect.length,
    directUsers: activeDirect.map((u) => ({ name: u.name, role: u.role, assignedDepartment: u.assignedDepartment || null })),
    inactiveDirectUserCount: inactiveDirect.length,
    supervisorCount: activeSupervisors.length,
    supervisorNames: activeSupervisors,
  };
}

module.exports = {
  getStoreStock,
  getShopUsers,
  getArticleStock,
  getArticleStockAllShops,
  getOrderAnomalies,
  getStockoutRisksAllShops,
  getOverstockArticlesAllShops,
  getPendingProposalsAllShops,
  getOrderAnomaliesAllShops,
  getPredictionAccuracyAllShops,
  getRevenueTrendAllShops,
  getSilentShops,
  getArticleDetails,
  getArticlesByGisement,
  getTopGisements,
  getPriceChangeHistory,
  getRevenue,
  getRevenueAllShops,
  getSalesHistory,
  getCurrentProposal,
  getStockoutRisks,
  getOverstockArticles,
  getParetoArticles,
  getPredictionAccuracy,
  getOrders,
  getStockMoveHistory,
  getDlvArticles,
  getArticleDlvStatus,
  getDataAvailability,
  getShopDepartments,
};
