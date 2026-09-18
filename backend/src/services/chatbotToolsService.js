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


async function getLatestProposal(rposShopId) {
  return prisma.proposal.findFirst({
    where: { rposShopId },
    orderBy: { generatedAt: 'desc' },
  });
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
 * getRevenue() — chiffre d'affaires réel (HT) du magasin sur une période ou une date précise,
 * calculé depuis SalesLine.revenueExclTax. Distinct de getSalesHistory (quantités vendues) : une
 * question sur "le CA" porte sur un montant en CFA, jamais une quantité d'unités.
 */
async function getRevenue(rposShopId, { date, days, department, ean } = {}) {
  let dateStart;
  let dateEnd;
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
  } else {
    dateEnd = new Date();
    dateStart = new Date(Date.now() - (days || 1) * 24 * 60 * 60 * 1000);
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
    select: { revenueExclTax: true, revenueInclTax: true, receiptId: true },
  });

  if (!lines.length) return { found: false, message: `Aucune vente enregistrée sur la période ${date || `des ${days || 1} derniers jours`}${ean ? ` pour l'article ${ean}` : department ? ` pour le rayon ${department}` : ''}.` };

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
    days: date ? null : (days || 1),
    ean: ean || null,
    department: department || null,
    revenueExclTaxCfa: Math.round(lines.reduce((s, l) => s + l.revenueExclTax, 0)),
    revenueInclTaxCfa: lines.every((l) => l.revenueInclTax !== null) ? Math.round(lines.reduce((s, l) => s + (l.revenueInclTax || 0), 0)) : null,
    // Nombre de VENTES (tickets de caisse distincts) — comparable au "Nb de ventes" de RMaster.
    // null si non disponible (période antérieure à la synchro du champ receipt), jamais 0 à tort.
    salesCount,
    // Nommé explicitement "articleLineCount" (pas "salesCount"/"ticketCount") pour que le LLM ne le
    // présente jamais comme "nombre de ventes"/"nombre de tickets" : c'est le nombre de LIGNES
    // vendues (un article vendu = une ligne), une notion différente de salesCount ci-dessus.
    articleLineCount: lines.length,
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

  // Écarte les articles génériques/poids libre (ex: "FRUITS & LEGUMES", "POISSONNERIE PESEE") du
  // calcul de QUANTITÉ : ces lignes ont systématiquement quantity === revenueExclTax (le "prix"
  // saisi en caisse EST la quantité, en valeur, pas un nombre d'unités réel — cf. getTopGisements,
  // même signal, trouvé le 18/09/2026 lors d'une campagne de fuzz testing où une question anodine
  // affichait "32 672 873 unités vendues"). Le CA (getRevenue) n'est PAS concerné : ces articles ont
  // un vrai chiffre d'affaires réel, seule leur "quantité" en unités n'a aucun sens.
  const lines = rawLines.filter((l) => Math.abs(l.revenueExclTax - l.quantity) > 0.01);

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
async function getParetoArticles(rposShopId, { thresholdPct = 80, department, days = 30 } = {}) {
  const dateStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

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
    where: { rposShopId, ...(eanFilter ? { ean: { in: eanFilter } } : {}), date: { gte: dateStart } },
    select: { ean: true, label: true, revenueExclTax: true },
  });
  if (!lines.length) return { found: false, message: `Aucune vente enregistrée sur les ${days} derniers jours${department ? ` pour le rayon ${department}` : ''}.` };

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
      revenueSharePct: Math.round((art.revenue / totalRevenue) * 10000) / 100,
      cumulativePct: Math.round(cumulativePct * 100) / 100,
    });
    if (cumulativePct >= thresholdPct) break;
  }

  return {
    found: true,
    thresholdPct,
    days,
    department: department || null,
    totalArticlesWithSales: articles.length,
    articleCount: withinThreshold.length,
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

  const byEan = new Map();
  for (const line of lines) {
    const entry = byEan.get(line.ean) || { ean: line.ean, revenue: 0, quantitySold: 0 };
    entry.revenue += line.revenueExclTax;
    entry.quantitySold += line.quantity;
    byEan.set(line.ean, entry);
  }
  // Écarte les articles génériques/poids libre agrégés au niveau d'un rayon entier (ex: "FRUITS &
  // LEGUMES", "POISSONNERIE PESEE") — même filtre en principe que excludeGenericArticlesBelowPrice
  // (proposalService.js, prix de vente < seuil), mais détecté ici sans appel RPOS supplémentaire :
  // ces articles génériques ont systématiquement quantity === revenue (le "prix" saisi en caisse
  // EST la quantité, en valeur, pas un nombre d'unités réel) — signal trouvé le 18/09/2026 en
  // creusant un classement de gisements faussé par ces pseudo-articles.
  const topArticles = Array.from(byEan.values())
    .filter((a) => Math.abs(a.revenue - a.quantitySold) > 0.01)
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
    return { found: false, message: `Aucun mouvement de stock enregistré pour l'article ${ean} sur les ${days} derniers jours.` };
  }
  return { found: true, days, ...summary };
}

module.exports = {
  getStoreStock,
  getArticleStock,
  getArticleDetails,
  getArticlesByGisement,
  getTopGisements,
  getPriceChangeHistory,
  getRevenue,
  getSalesHistory,
  getCurrentProposal,
  getStockoutRisks,
  getOverstockArticles,
  getParetoArticles,
  getPredictionAccuracy,
  getOrders,
  getStockMoveHistory,
};
