/**
 * Analyse et prédiction du comportement d'un article sur une période choisie par l'utilisateur
 * ("évolution demandée") : courbe de ventes, points de commande historiques, et projection de la
 * prochaine commande (période/quantité prévue), avec une granularité d'agrégation adaptée à la
 * durée de la période (minute/heure sur une période courte, jour/semaine/mois sur une période
 * longue) — pour que le graphique reste lisible aussi bien sur une journée que sur une année.
 */
const { PrismaClient } = require('@prisma/client');
const rpos = require('./rposClient');

const prisma = new PrismaClient();

/**
 * Historique de vente d'un article, en lisant d'abord la base locale SalesLine (alimentée par
 * salesSyncJob.js) plutôt que RPOS en direct — évite d'attendre la pagination RPOS à chaque
 * ouverture du graphique d'évolution. Retombe sur RPOS uniquement si la base locale n'a aucune
 * ligne pour cette période (magasin pas encore synchronisé, ou période trop ancienne).
 */
async function getSalesHistoryLocalFirst(posId, shopId, ean, dateStart, dateEnd) {
  const dbLines = await prisma.salesLine.findMany({
    where: { rposShopId: shopId, ean, date: { gte: new Date(dateStart), lt: new Date(dateEnd) } },
  });
  if (dbLines.length > 0) {
    return dbLines.map((l) => ({ date: l.date.toISOString(), quantity: l.quantity, revenue: l.revenueExclTax }));
  }
  // Aucune ligne locale pour cette période précise (magasin pas encore synchronisé sur cette
  // fenêtre) : tente RPOS en dernier recours, mais un échec réseau ne doit pas faire échouer tout
  // le graphique — retourne un historique vide plutôt qu'une erreur bloquante.
  try {
    return await rpos.getSalesHistoryForProduct(posId, shopId, ean, dateStart, dateEnd);
  } catch (err) {
    console.error('[productAnalyticsService] Historique de ventes RPOS indisponible et base locale vide pour cette période:', err.message);
    return [];
  }
}

// L'historique de commandes n'a pas d'équivalent en base locale (contrairement aux ventes) : la
// fenêtre d'analyse pouvant être rouverte plusieurs fois de suite sur le même article (changement
// de préréglage de période, etc.), un cache court en mémoire process évite de rappeler RPOS à
// chaque fois pour la même requête pendant que l'utilisateur explore le graphique.
const PURCHASE_HISTORY_CACHE_TTL_MS = 5 * 60 * 1000;
const purchaseHistoryCache = new Map(); // `${posId}:${shopId}:${productId}:${dateStart}:${dateEnd}` -> { data, cachedAt }

async function getPurchaseHistoryCached(posId, shopId, productId, dateStart, dateEnd) {
  if (!productId) return [];
  const key = `${posId}:${shopId}:${productId}:${dateStart}:${dateEnd}`;
  const cached = purchaseHistoryCache.get(key);
  if (cached && Date.now() - cached.cachedAt < PURCHASE_HISTORY_CACHE_TTL_MS) {
    return cached.data;
  }
  // Pas d'équivalent local pour l'historique de commandes (contrairement aux ventes) : un échec
  // réseau RPOS (hors du réseau Prosuma, VPN coupé...) ne doit pas faire échouer tout le graphique
  // d'évolution — le reste (ventes, tendance) reste utile même sans les points de commande.
  try {
    const data = await rpos.getPurchaseHistoryForProduct(posId, shopId, productId, dateStart, dateEnd);
    purchaseHistoryCache.set(key, { data, cachedAt: Date.now() });
    return data;
  } catch (err) {
    console.error('[productAnalyticsService] Historique de commandes RPOS indisponible:', err.message);
    return [];
  }
}

/**
 * Choisit la granularité d'agrégation en fonction de la durée de la période demandée, pour éviter
 * d'envoyer des milliers de points bruts au frontend sur une longue période, ou au contraire
 * d'aplatir toute la variation sur une période courte.
 */
function chooseGranularity(periodDays) {
  if (periodDays <= 2) return 'hour';
  if (periodDays <= 62) return 'day';
  if (periodDays <= 365) return 'week';
  return 'month';
}

/** Clé d'agrégation d'une date selon la granularité choisie (tronque la date à ce niveau). */
function bucketKey(date, granularity) {
  const d = new Date(date);
  if (granularity === 'hour') {
    return d.toISOString().slice(0, 13) + ':00'; // YYYY-MM-DDTHH:00
  }
  if (granularity === 'day') {
    return d.toISOString().slice(0, 10); // YYYY-MM-DD
  }
  if (granularity === 'week') {
    // Lundi de la semaine de la date, pour des buckets alignés sur la semaine calendaire.
    const day = (d.getUTCDay() + 6) % 7; // 0 = lundi
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - day);
    return monday.toISOString().slice(0, 10);
  }
  // month
  return d.toISOString().slice(0, 7); // YYYY-MM
}

/** Agrège une liste de { date, quantity, revenue } en points de série temporelle. */
function aggregateSeries(lines, granularity) {
  const buckets = new Map();
  for (const line of lines) {
    const key = bucketKey(line.date, granularity);
    if (!buckets.has(key)) buckets.set(key, { date: key, quantity: 0, revenue: 0 });
    const bucket = buckets.get(key);
    bucket.quantity += line.quantity;
    bucket.revenue += line.revenue || 0;
  }
  return Array.from(buckets.values()).sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Reconstitue une estimation du niveau de stock à la fin de chaque bucket de la série, faute
 * d'historique de stock réel côté RPOS (qui n'expose que le stock courant). On part du stock
 * actuel connu et on remonte le temps bucket par bucket, en défaisant les ventes (stock plus
 * élevé avant qu'elles n'aient eu lieu) et les réceptions de commande (stock plus bas avant
 * qu'elles n'arrivent) : stockAvant = stockAprès + ventes − quantité reçue sur ce bucket.
 * Approximation : suppose que chaque commande passée est reçue à sa date de commande (RPOS ne
 * fournit pas de date de réception fiable, cf. receptionSyncJob.js) et ignore les ajustements
 * d'inventaire manuels, donc peut dériver sur une longue période — à afficher comme une
 * tendance indicative, pas une valeur exacte.
 */
function reconstructStockSeries(series, purchaseHistory, granularity, currentStock) {
  if (currentStock === null || currentStock === undefined || !series.length) return series.map(() => null);

  const receivedByBucket = new Map();
  for (const order of purchaseHistory) {
    const key = bucketKey(order.date, granularity);
    receivedByBucket.set(key, (receivedByBucket.get(key) || 0) + order.quantity);
  }

  const stockAtBucketEnd = new Array(series.length);
  let runningStock = currentStock;
  for (let i = series.length - 1; i >= 0; i--) {
    stockAtBucketEnd[i] = runningStock;
    const received = receivedByBucket.get(series[i].date) || 0;
    runningStock = runningStock + series[i].quantity - received;
  }
  return stockAtBucketEnd;
}

/**
 * Analyse complète d'un article sur une période : série de ventes agrégée, historique de
 * commandes, indicateurs de comportement, et prédiction de la prochaine commande.
 */
async function analyzeProduct(posId, shopId, { ean, productId, dateStart, dateEnd, safetyStockRatio, currentStock, currentOrderedQuantity }) {
  const periodDays = Math.max(1, (new Date(dateEnd) - new Date(dateStart)) / (24 * 60 * 60 * 1000));
  const granularity = chooseGranularity(periodDays);

  const [salesLines, purchaseHistory] = await Promise.all([
    getSalesHistoryLocalFirst(posId, shopId, ean, dateStart, dateEnd),
    getPurchaseHistoryCached(posId, shopId, productId, dateStart, dateEnd),
  ]);

  const series = aggregateSeries(salesLines, granularity);
  const stockSeries = reconstructStockSeries(series, purchaseHistory, granularity, currentStock);

  const totalQuantity = salesLines.reduce((sum, l) => sum + l.quantity, 0);
  const totalRevenue = salesLines.reduce((sum, l) => sum + (l.revenue || 0), 0);
  const avgWeeklySales = (totalQuantity / periodDays) * 7;

  // Min/max sur les buckets agrégés (pas sur les ventes individuelles) : plus parlant pour
  // répondre à "quelle est la plus forte/faible période de vente ?" à la granularité affichée.
  const bucketQuantities = series.map((b) => b.quantity);
  const minBucketQuantity = bucketQuantities.length ? Math.min(...bucketQuantities) : 0;
  const maxBucketQuantity = bucketQuantities.length ? Math.max(...bucketQuantities) : 0;

  // Tendance simple : compare la 2e moitié de la période à la 1ère, en quantité totale.
  const midIndex = Math.floor(series.length / 2);
  const firstHalfQty = series.slice(0, midIndex).reduce((s, b) => s + b.quantity, 0);
  const secondHalfQty = series.slice(midIndex).reduce((s, b) => s + b.quantity, 0);
  let trend = 'stable';
  if (firstHalfQty > 0) {
    const change = (secondHalfQty - firstHalfQty) / firstHalfQty;
    if (change > 0.15) trend = 'hausse';
    else if (change < -0.15) trend = 'baisse';
  }

  // Fréquence de commande : nombre de commandes distinctes et quantité moyenne commandée, pour
  // répondre à "à quelle fréquence est-il commandé ? quelle quantité est généralement commandée ?"
  const orderCount = purchaseHistory.length;
  const avgOrderedQuantity = orderCount > 0
    ? purchaseHistory.reduce((s, p) => s + p.quantity, 0) / orderCount
    : null;
  let avgDaysBetweenOrders = null;
  if (orderCount >= 2) {
    const sortedDates = purchaseHistory.map((p) => new Date(p.date).getTime()).sort((a, b) => a - b);
    const span = sortedDates[sortedDates.length - 1] - sortedDates[0];
    avgDaysBetweenOrders = (span / (orderCount - 1)) / (24 * 60 * 60 * 1000);
  }

  // Prédiction de la prochaine commande : même logique que le calcul de réassort standard, pour
  // rester cohérent avec ce que la proposition afficherait pour cet article.
  const ratio = safetyStockRatio ?? 0.5;
  const stock = currentStock ?? 0;
  const orderedQty = currentOrderedQuantity ?? 0;
  const safetyStock = avgWeeklySales * ratio;
  const predictedQuantity = Math.max(0, Math.ceil(avgWeeklySales + safetyStock - stock - orderedQty));
  const nextOrderInDays = avgDaysBetweenOrders
    ? Math.max(0, Math.round(avgDaysBetweenOrders - (orderCount ? (Date.now() - new Date(purchaseHistory[0].date).getTime()) / (24 * 60 * 60 * 1000) : 0)))
    : null;

  return {
    periodStart: dateStart,
    periodEnd: dateEnd,
    granularity,
    series,
    stockSeries,
    purchaseHistory,
    stats: {
      totalQuantity,
      totalRevenue,
      avgWeeklySales,
      minBucketQuantity,
      maxBucketQuantity,
      trend,
      orderCount,
      avgOrderedQuantity,
      avgDaysBetweenOrders,
    },
    prediction: {
      predictedQuantity,
      nextOrderInDays,
      avgWeeklySales,
      currentStock: stock,
      currentOrderedQuantity: orderedQty,
      safetyStock,
    },
  };
}

module.exports = { analyzeProduct, chooseGranularity };
