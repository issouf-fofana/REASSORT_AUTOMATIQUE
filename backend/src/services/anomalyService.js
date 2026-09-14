/**
 * Détection d'anomalies par article (CAHIER_DES_CHARGES.md §30-31, étape 7 du plan de montée en
 * autonomie IA) : signaux calculés uniquement à partir des données déjà disponibles à la génération
 * (dailyHistory, stock, ventes moyennes) — aucun appel réseau supplémentaire.
 *
 * Objectif du §30 : préférer VERIFY_STOCK / prudence plutôt qu'une commande automatique en cas de
 * signal anormal. Ce module ne décide rien lui-même : il calcule des signaux (anomalies détectées +
 * trendScore) que confidenceService.js et l'IA utilisent ensuite pour ajuster leur confiance.
 */

// Nombre de jours récents comparés au reste de l'historique pour juger d'une explosion/chute des
// ventes : trop court (ex: 2 jours) réagirait à du bruit normal, trop long masquerait un vrai
// décrochage récent.
const RECENT_WINDOW_DAYS = 3;
const MIN_DAYS_FOR_TREND = 7;

// Seuils de variation (%) entre la moyenne récente et la moyenne de référence, au-delà desquels le
// signal est jugé assez fort pour être remonté comme anomalie plutôt qu'une simple fluctuation.
const SALES_SPIKE_THRESHOLD_PCT = 80; // +80% ou plus : explosion
const SALES_DROP_THRESHOLD_PCT = -60; // -60% ou moins : chute brutale
const TREND_GROWING_THRESHOLD_PCT = 15;
const TREND_DECLINING_THRESHOLD_PCT = -15;
const VOLATILE_CV_THRESHOLD = 1.2; // coefficient de variation au-delà duquel la tendance est jugée trop erratique pour être classée

function average(values) {
  if (!values.length) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function coefficientOfVariation(values) {
  const mean = average(values);
  if (mean <= 0) return 0;
  const variance = average(values.map((v) => (v - mean) ** 2));
  return Math.sqrt(variance) / mean;
}

/**
 * Explosion ou chute brutale des ventes : compare la moyenne des derniers RECENT_WINDOW_DAYS jours
 * à la moyenne du reste de la période. Ignore les périodes trop courtes (pas assez de recul pour
 * distinguer un vrai signal d'une fluctuation normale).
 */
function detectSalesSpikeOrDrop(dailyHistory) {
  if (!dailyHistory || dailyHistory.length < MIN_DAYS_FOR_TREND) return null;

  const quantities = dailyHistory.map((d) => d.quantity || 0);
  const recent = quantities.slice(-RECENT_WINDOW_DAYS);
  const baseline = quantities.slice(0, -RECENT_WINDOW_DAYS);
  if (!baseline.length) return null;

  const recentAvg = average(recent);
  const baselineAvg = average(baseline);

  // Baseline nulle mais ventes récentes non nulles : démarrage d'une demande auparavant absente,
  // signal fort à remonter même si un pourcentage de variation n'est pas mathématiquement définissable.
  if (baselineAvg <= 0) {
    return recentAvg > 0
      ? { type: 'SALES_SPIKE', changePct: null, message: 'Ventes apparues récemment alors qu\'il n\'y en avait aucune sur le reste de la période.' }
      : null;
  }

  const changePct = ((recentAvg - baselineAvg) / baselineAvg) * 100;
  if (changePct >= SALES_SPIKE_THRESHOLD_PCT) {
    return { type: 'SALES_SPIKE', changePct: Math.round(changePct), message: `Ventes en hausse de ${Math.round(changePct)}% sur les ${RECENT_WINDOW_DAYS} derniers jours vs le reste de la période.` };
  }
  if (changePct <= SALES_DROP_THRESHOLD_PCT) {
    return { type: 'SALES_DROP', changePct: Math.round(changePct), message: `Ventes en chute de ${Math.round(Math.abs(changePct))}% sur les ${RECENT_WINDOW_DAYS} derniers jours vs le reste de la période.` };
  }
  return null;
}

/**
 * Stock incohérent : l'article a un stock RPOS positif significatif mais n'a enregistré aucune
 * vente récente alors qu'il vend habituellement — signale une rupture invisible (article mal
 * rangé, erreur de caisse, code-barre non scanné) plutôt qu'une vraie absence de demande.
 * minAvgDailySales (unité/jour, configurable via ANOMALY_MIN_DAILY_SALES) : en dessous de ce
 * rythme habituel, le silence des ventes n'est pas jugé incohérent (article lent ou intermittent).
 */
function detectStockInconsistency(stock, avgWeeklySales, dailyHistory, minAvgDailySales = 1) {
  if (!dailyHistory || dailyHistory.length < MIN_DAYS_FOR_TREND) return null;
  if (!(stock > 0) || !(avgWeeklySales > 0)) return null;

  const recentDays = dailyHistory.slice(-RECENT_WINDOW_DAYS);
  const recentTotal = recentDays.reduce((s, d) => s + (d.quantity || 0), 0);
  const avgDailySales = avgWeeklySales / 7;
  // L'article vend normalement plusieurs unités par jour en moyenne, mais rien sur les derniers
  // jours malgré un stock disponible : incohérent, à vérifier plutôt qu'à prendre pour argent
  // comptant (§30 "rupture invisible").
  if (recentTotal === 0 && avgDailySales >= minAvgDailySales) {
    return { type: 'STOCK_INCONSISTENCY', message: `Stock disponible (${stock}) mais aucune vente sur les ${RECENT_WINDOW_DAYS} derniers jours, alors que l'article vend habituellement ~${avgDailySales.toFixed(1)}/jour — rupture invisible possible (article mal positionné, EAN non scanné).` };
  }
  return null;
}

/**
 * Catégorise la tendance générale de l'article (§31) : GROWING / DECLINING / STABLE / VOLATILE /
 * UNKNOWN. Indépendant de detectSalesSpikeOrDrop (qui ne regarde que les tout derniers jours) :
 * la tendance ici pondère l'ensemble de l'historique disponible.
 */
function computeTrendScore(dailyHistory) {
  if (!dailyHistory || dailyHistory.length < MIN_DAYS_FOR_TREND) return { category: 'UNKNOWN', changePct: null };

  const quantities = dailyHistory.map((d) => d.quantity || 0);
  const cv = coefficientOfVariation(quantities);
  if (cv >= VOLATILE_CV_THRESHOLD) return { category: 'VOLATILE', changePct: null };

  const mid = Math.floor(quantities.length / 2);
  const firstHalfAvg = average(quantities.slice(0, mid));
  const secondHalfAvg = average(quantities.slice(mid));
  if (firstHalfAvg <= 0) return { category: secondHalfAvg > 0 ? 'GROWING' : 'UNKNOWN', changePct: null };

  const changePct = ((secondHalfAvg - firstHalfAvg) / firstHalfAvg) * 100;
  if (changePct >= TREND_GROWING_THRESHOLD_PCT) return { category: 'GROWING', changePct: Math.round(changePct) };
  if (changePct <= TREND_DECLINING_THRESHOLD_PCT) return { category: 'DECLINING', changePct: Math.round(changePct) };
  return { category: 'STABLE', changePct: Math.round(changePct) };
}

/**
 * Point d'entrée : calcule tous les signaux d'anomalie + la tendance pour un article. Ne fait
 * aucun appel réseau/base — synchrone, appelable en masse sur toutes les lignes d'une génération.
 * minAvgDailySales : seuil "rupture invisible" (voir detectStockInconsistency), transmis par
 * l'appelant (proposalService le lit en config une fois par génération).
 */
function detectAnomalies({ stock, avgWeeklySales, dailyHistory, minAvgDailySales = 1 }) {
  const anomalies = [];
  const spikeOrDrop = detectSalesSpikeOrDrop(dailyHistory);
  if (spikeOrDrop) anomalies.push(spikeOrDrop);
  const stockInconsistency = detectStockInconsistency(stock, avgWeeklySales, dailyHistory, minAvgDailySales);
  if (stockInconsistency) anomalies.push(stockInconsistency);

  const trend = computeTrendScore(dailyHistory);

  return { anomalies, trend };
}

module.exports = { detectAnomalies };
