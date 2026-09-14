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
async function getRevenue(rposShopId, { date, days, department } = {}) {
  let dateStart;
  let dateEnd;
  if (date) {
    dateStart = new Date(date + 'T00:00:00.000Z');
    dateEnd = new Date(date + 'T23:59:59.999Z');
  } else {
    dateEnd = new Date();
    dateStart = new Date(Date.now() - (days || 1) * 24 * 60 * 60 * 1000);
  }

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
    select: { revenueExclTax: true, revenueInclTax: true },
  });

  if (!lines.length) return { found: false, message: `Aucune vente enregistrée sur la période ${date || `des ${days || 1} derniers jours`}${department ? ` pour le rayon ${department}` : ''}.` };

  return {
    found: true,
    date: date || null,
    days: date ? null : (days || 1),
    department: department || null,
    revenueExclTaxCfa: Math.round(lines.reduce((s, l) => s + l.revenueExclTax, 0)),
    revenueInclTaxCfa: lines.every((l) => l.revenueInclTax !== null) ? Math.round(lines.reduce((s, l) => s + (l.revenueInclTax || 0), 0)) : null,
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

  const lines = await prisma.salesLine.findMany({
    where: { rposShopId, ...(eanFilter ? { ean: { in: eanFilter } } : {}), date: { gte: dateStart } },
    select: { date: true, quantity: true, ean: true, label: true },
    orderBy: { date: 'asc' },
  });

  const byDay = new Map();
  for (const line of lines) {
    const day = line.date.toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) || 0) + line.quantity);
  }

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
    dailyHistory: Array.from(byDay.entries()).map(([date, quantity]) => ({ date, quantity })),
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

module.exports = {
  getStoreStock,
  getArticleStock,
  getRevenue,
  getSalesHistory,
  getCurrentProposal,
  getStockoutRisks,
  getOverstockArticles,
  getParetoArticles,
  getPredictionAccuracy,
  getOrders,
};
