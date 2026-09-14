/**
 * Score de confiance par article (CAHIER_DES_CHARGES.md §20, étape 6 du plan de montée en
 * autonomie IA) : entre 0 et 100, calculé à partir des signaux réellement disponibles aujourd'hui.
 *
 * Le §20 liste 10 critères idéaux (quantité d'historique, stabilité, volatilité, précision
 * historique, qualité des données, anomalies, saisonnalité, erreurs précédentes, comportement
 * magasin, comportement article). Tous n'ont pas encore de calcul dédié dans ce projet :
 * - détection d'anomalies dédiée : étape 7, pas encore faite ;
 * - modèle de "comportement magasin/article" distinct : pas encore modélisé séparément.
 * Version assumée à cette étape (honnête plutôt que complète) : combine les 4 signaux qui ont déjà
 * une source de données fiable ici — quantité d'historique, volatilité, précision historique
 * passée (AIPredictionOutcome, étape 5), qualité des données (rupture de stock détectée OU anomalie
 * détectée par anomalyService.js, étape 7). Un score PRUDENT (pas optimiste) est retourné quand un
 * signal manque, plutôt que de l'ignorer ou de l'inventer — ex: aucun historique d'erreur passée
 * pour cet article => précision historique notée au niveau neutre (50/100), pas au maximum.
 */
const prisma = require('../utils/prisma');


// Pondération de chaque signal dans le score final (somme = 1). La précision historique pèse le
// plus lourd : c'est le seul signal qui mesure directement "l'IA a-t-elle eu raison par le passé
// sur CET article", les autres ne sont que des indices indirects de fiabilité attendue.
const WEIGHTS = {
  historyLength: 0.20,
  volatility: 0.25,
  historicalAccuracy: 0.40,
  dataQuality: 0.15,
};

// En dessous de ce nombre de jours de vente, l'historique est jugé insuffisant pour un score élevé
// (cohérent avec forecastService.MIN_DAYS_FOR_SMOOTHING, en dessous duquel le lissage retombe déjà
// sur une moyenne plate faute de recul).
const FULL_CONFIDENCE_HISTORY_DAYS = 42; // 6 semaines : au-delà, le critère est jugé pleinement satisfait
const MIN_USABLE_HISTORY_DAYS = 7;

/** 0 sous MIN_USABLE_HISTORY_DAYS, 100 à partir de FULL_CONFIDENCE_HISTORY_DAYS, linéaire entre les deux. */
function scoreHistoryLength(daysOfHistory) {
  if (daysOfHistory <= MIN_USABLE_HISTORY_DAYS) return 0;
  if (daysOfHistory >= FULL_CONFIDENCE_HISTORY_DAYS) return 100;
  return ((daysOfHistory - MIN_USABLE_HISTORY_DAYS) / (FULL_CONFIDENCE_HISTORY_DAYS - MIN_USABLE_HISTORY_DAYS)) * 100;
}

/**
 * Volatilité = coefficient de variation (écart-type / moyenne) des quantités vendues par jour.
 * Un article vendu de façon très irrégulière (CV élevé) est plus difficile à prévoir fiablement
 * qu'un article à rythme stable — score inversement proportionnel au CV, plafonné à un CV de 2
 * (au-delà, jugé aussi peu fiable qu'à 2 : évite qu'un pic extrême écrase le score à 0 pour rien).
 */
function scoreVolatility(dailyHistory) {
  if (!dailyHistory || dailyHistory.length < MIN_USABLE_HISTORY_DAYS) return 0;
  const quantities = dailyHistory.map((d) => d.quantity || 0);
  const mean = quantities.reduce((s, q) => s + q, 0) / quantities.length;
  if (mean <= 0) return 0; // aucune vente sur la période : rien à prévoir de fiable
  const variance = quantities.reduce((s, q) => s + (q - mean) ** 2, 0) / quantities.length;
  const stdDev = Math.sqrt(variance);
  const coefficientOfVariation = stdDev / mean;
  const MAX_CV = 2;
  const clamped = Math.min(coefficientOfVariation, MAX_CV);
  return (1 - clamped / MAX_CV) * 100;
}

/**
 * Précision historique = moyenne des erreurs de prévision passées (AIPredictionOutcome, étape 5)
 * pour cet article sur ce magasin. Sans historique d'évaluation (cas normal au démarrage du
 * système, ou nouvel article), retourne un score NEUTRE (50) plutôt que 0 (punirait injustement un
 * article jamais encore évalué) ou 100 (fausse confiance non méritée).
 */
async function scoreHistoricalAccuracy(rposShopId, ean) {
  const outcomes = await prisma.aIPredictionOutcome.findMany({
    where: { prediction: { rposShopId, ean } },
    orderBy: { evaluatedAt: 'desc' },
    take: 8, // les évaluations les plus récentes seulement : une IA qui s'améliore ne doit pas être
    // pénalisée indéfiniment par ses erreurs d'il y a plusieurs mois.
    select: { percentageError: true },
  });

  const withPct = outcomes.filter((o) => o.percentageError !== null);
  if (withPct.length === 0) return { score: 50, sampleSize: 0 };

  const avgError = withPct.reduce((s, o) => s + o.percentageError, 0) / withPct.length;
  // 0% d'erreur => 100 ; 100% d'erreur ou plus => 0, linéaire entre les deux.
  const score = Math.max(0, (1 - avgError)) * 100;
  return { score, sampleSize: withPct.length };
}

/**
 * Qualité des données = pénalité si une rupture de stock a faussé la période d'analyse récente,
 * ou si anomalyService.js a détecté un signal anormal (explosion/chute de ventes, stock incohérent)
 * qui rend l'historique récent moins représentatif d'une demande normale.
 */
function scoreDataQuality(hadNegativeStock, hasAnomaly) {
  if (hadNegativeStock && hasAnomaly) return 20;
  if (hadNegativeStock || hasAnomaly) return 40;
  return 100;
}

/**
 * Calcule le score de confiance (0-100) d'une ligne de proposition donnée, avec le détail par
 * signal (pour affichage/débogage). Ne modifie rien : lecture seule sur les données déjà connues
 * de cette ligne + historique d'évaluations passées.
 */
async function computeConfidenceScore({ rposShopId, ean, dailyHistory, hadNegativeStock, hasAnomaly }) {
  const daysOfHistory = dailyHistory ? dailyHistory.length : 0;
  const historyLengthScore = scoreHistoryLength(daysOfHistory);
  const volatilityScore = scoreVolatility(dailyHistory);
  const { score: accuracyScore, sampleSize: accuracySampleSize } = await scoreHistoricalAccuracy(rposShopId, ean);
  const dataQualityScore = scoreDataQuality(hadNegativeStock, !!hasAnomaly);

  const confidenceScore = Math.round(
    historyLengthScore * WEIGHTS.historyLength +
    volatilityScore * WEIGHTS.volatility +
    accuracyScore * WEIGHTS.historicalAccuracy +
    dataQualityScore * WEIGHTS.dataQuality
  );

  return {
    confidenceScore,
    breakdown: {
      historyLength: Math.round(historyLengthScore),
      volatility: Math.round(volatilityScore),
      historicalAccuracy: Math.round(accuracyScore),
      historicalAccuracySampleSize: accuracySampleSize,
      dataQuality: Math.round(dataQualityScore),
    },
  };
}

module.exports = { computeConfidenceScore };
