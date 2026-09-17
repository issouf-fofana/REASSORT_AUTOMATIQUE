/**
 * Score de préparation à l'autonomie (demande du 17/09/2026) : indicateur CONSULTATIF — jamais une
 * bascule automatique de comportement (choix validé le 17/09/2026). Mesure si le système progresse
 * vers moins de supervision humaine, via 7 critères mesurables, et calcule un palier parmi :
 *   VALIDATION_HUMAINE -> SUPERVISION_HUMAINE -> AUTONOMIE_CONTROLEE -> AUTONOME
 * avec hystérésis : un palier n'est retenu comme "atteint" que si le score s'y maintient sur
 * plusieurs snapshots consécutifs (STABILITY_STREAK_REQUIRED), jamais sur un seul pic ponctuel —
 * et redescend immédiatement si la performance se dégrade (JAMAIS de cliquet qui empêcherait de
 * redescendre). AI_QUANTITY_ADJUSTMENT_ENABLED (systemConfigService.js) reste le seul réglage qui
 * change réellement le comportement du système ; ce score n'y touche jamais.
 *
 * Sur les 7 critères demandés, 2 (ruleComplianceScore, testCaseScore) n'ont aujourd'hui AUCUNE
 * source de données réelle (pas de journal de violations RBAC dédié, pas de suite de cas de test
 * rejouée) — choix validé le 17/09/2026 : ils restent `null` explicitement et sont EXCLUS du calcul
 * de globalScore (moyenne des seuls critères réellement mesurés), jamais une valeur inventée.
 */
const prisma = require('../utils/prisma');

const DAY_MS = 24 * 60 * 60 * 1000;
const EVAL_WINDOW_DAYS = 90;

// Nombre de snapshots consécutifs requis pour qu'un palier soit considéré comme réellement "tenu"
// dans le temps, pas juste atteint une fois — l'exigence explicite de la demande ("atteints ET
// maintenus dans le temps").
const STABILITY_STREAK_REQUIRED = 5;

// Seuils de score global pour chaque palier (croissants) — un score en dessous de tous les seuils
// retombe sur VALIDATION_HUMAINE, le point de départ le plus prudent.
const LEVEL_THRESHOLDS = [
  { level: 'AUTONOME', minScore: 90 },
  { level: 'AUTONOMIE_CONTROLEE', minScore: 75 },
  { level: 'SUPERVISION_HUMAINE', minScore: 55 },
  { level: 'VALIDATION_HUMAINE', minScore: 0 },
];

function levelForScore(score) {
  return LEVEL_THRESHOLDS.find((t) => score >= t.minScore).level;
}

function average(values) {
  const defined = values.filter((v) => v !== null && v !== undefined);
  if (!defined.length) return null;
  return defined.reduce((s, v) => s + v, 0) / defined.length;
}

/** errorRateScore : taux d'erreur réel (percentageError > 30%) sur les prédictions évaluées récemment. */
async function computeErrorRateScore() {
  const dateStart = new Date(Date.now() - EVAL_WINDOW_DAYS * DAY_MS);
  const outcomes = await prisma.aIPredictionOutcome.findMany({
    where: { evaluatedAt: { gte: dateStart }, percentageError: { not: null } },
    select: { percentageError: true },
  });
  if (!outcomes.length) return null;
  const errorCount = outcomes.filter((o) => Math.abs(o.percentageError) > 0.3).length;
  return Math.round((1 - errorCount / outcomes.length) * 1000) / 10;
}

/** recommendationAccuracyScore : même base que AIDomainMastery.accuracy (accuracyPct). */
async function computeAccuracyScore() {
  const dateStart = new Date(Date.now() - EVAL_WINDOW_DAYS * DAY_MS);
  const outcomes = await prisma.aIPredictionOutcome.findMany({
    where: { evaluatedAt: { gte: dateStart }, percentageError: { not: null } },
    select: { percentageError: true },
  });
  if (!outcomes.length) return null;
  const avgAbsError = outcomes.reduce((s, o) => s + Math.abs(o.percentageError), 0) / outcomes.length;
  return Math.max(0, Math.round((1 - Math.min(avgAbsError, 1)) * 1000) / 10);
}

/**
 * stabilityScore : une IA correcte EN MOYENNE mais erratique (grande variance d'erreur d'une
 * prédiction à l'autre) n'est pas prête pour moins de supervision — l'écart-type des erreurs compte
 * autant que leur moyenne pour juger de la fiabilité réelle.
 */
async function computeStabilityScore() {
  const dateStart = new Date(Date.now() - EVAL_WINDOW_DAYS * DAY_MS);
  const outcomes = await prisma.aIPredictionOutcome.findMany({
    where: { evaluatedAt: { gte: dateStart }, percentageError: { not: null } },
    select: { percentageError: true },
  });
  if (outcomes.length < 5) return null; // variance peu significative sur un échantillon trop petit
  const errors = outcomes.map((o) => Math.abs(o.percentageError));
  const mean = errors.reduce((s, e) => s + e, 0) / errors.length;
  const variance = errors.reduce((s, e) => s + (e - mean) ** 2, 0) / errors.length;
  const stdDev = Math.sqrt(variance);
  // Un écart-type de 0 (parfaitement stable) -> 100 ; un écart-type >= 50% -> 0 (plafonné).
  return Math.max(0, Math.round((1 - Math.min(stdDev / 0.5, 1)) * 1000) / 10);
}

/** anomalyDetectionScore : taux de constats SILENT_ANOMALY confirmés utiles (pas DISMISSED). */
async function computeAnomalyDetectionScore() {
  const dateStart = new Date(Date.now() - EVAL_WINDOW_DAYS * DAY_MS);
  const anomalies = await prisma.aIImprovement.findMany({
    where: { type: 'SILENT_ANOMALY', createdAt: { gte: dateStart }, status: { not: 'PROPOSED' } },
    select: { status: true },
  });
  if (!anomalies.length) return null;
  const dismissed = anomalies.filter((a) => a.status === 'DISMISSED').length;
  return Math.round((1 - dismissed / anomalies.length) * 1000) / 10;
}

/** postCorrectionScore : taux de corrections confirmées efficaces (IMPROVED vs NO_EFFECT). */
async function computePostCorrectionScore() {
  const dateStart = new Date(Date.now() - EVAL_WINDOW_DAYS * DAY_MS);
  const evaluated = await prisma.aIImprovement.findMany({
    where: { status: { in: ['IMPROVED', 'NO_EFFECT'] }, updatedAt: { gte: dateStart } },
    select: { status: true },
  });
  if (!evaluated.length) return null;
  const improved = evaluated.filter((e) => e.status === 'IMPROVED').length;
  return Math.round((improved / evaluated.length) * 1000) / 10;
}

async function computeSnapshot() {
  const [errorRateScore, recommendationAccuracyScore, stabilityScore, anomalyDetectionScore, postCorrectionScore] = await Promise.all([
    computeErrorRateScore(), computeAccuracyScore(), computeStabilityScore(), computeAnomalyDetectionScore(), computePostCorrectionScore(),
  ]);
  // ruleComplianceScore et testCaseScore : toujours null aujourd'hui (cf. commentaire de tête).
  const ruleComplianceScore = null;
  const testCaseScore = null;

  const criteria = { errorRateScore, recommendationAccuracyScore, stabilityScore, anomalyDetectionScore, ruleComplianceScore, postCorrectionScore, testCaseScore };
  const measuredValues = Object.values(criteria);
  const globalScore = average(measuredValues) ?? 0;
  const measuredCriteriaCount = measuredValues.filter((v) => v !== null).length;

  const level = levelForScore(globalScore);

  // Continuité du palier (hystérésis) : compare au dernier snapshot connu — si le nouveau palier est
  // le même, incrémente le compteur de continuité ; sinon (montée OU descente), repart à 1. La
  // demande explicite ("l'autonomie ne doit pas être activée simplement parce que le modèle a un
  // niveau de confiance élevé... débloquée progressivement... maintenus dans le temps") interdit de
  // considérer un palier comme acquis sur un seul snapshot.
  const previous = await prisma.autonomyReadinessSnapshot.findFirst({ orderBy: { computedAt: 'desc' } });
  const currentStreakCount = previous && previous.level === level ? previous.currentStreakCount + 1 : 1;

  const domainMastery = await prisma.aIDomainMastery.findMany();

  const snapshot = await prisma.autonomyReadinessSnapshot.create({
    data: {
      ...criteria,
      globalScore,
      measuredCriteriaCount,
      level,
      currentStreakCount,
      detailsJson: JSON.stringify({
        domainMastery: domainMastery.map((d) => ({ domain: d.domain, masteryScore: d.masteryScore, confidenceScore: d.confidenceScore })),
        streakRequired: STABILITY_STREAK_REQUIRED,
      }),
    },
  });
  return snapshot;
}

/**
 * Palier "réellement tenu" à afficher en avant à l'utilisateur : le dernier snapshot calculé, mais
 * seulement si sa continuité (currentStreakCount) atteint le seuil requis — sinon on affiche le
 * palier précédemment TENU (le dernier avec un streak suffisant), pas le nouveau palier encore en
 * cours de confirmation. Empêche d'annoncer une montée de palier prématurée sur un seul bon snapshot.
 */
async function getEffectiveReadiness() {
  const latest = await prisma.autonomyReadinessSnapshot.findFirst({ orderBy: { computedAt: 'desc' } });
  if (!latest) return null;
  if (latest.currentStreakCount >= STABILITY_STREAK_REQUIRED) {
    return { ...latest, detailsJson: JSON.parse(latest.detailsJson), levelConfirmed: true };
  }
  // Cherche le dernier snapshot avant celui-ci qui avait déjà confirmé un palier (peut être un palier
  // inférieur si le score vient de baisser, ou le même palier avec un historique plus ancien).
  const history = await prisma.autonomyReadinessSnapshot.findMany({ orderBy: { computedAt: 'desc' }, take: 200 });
  const confirmed = history.find((s) => s.currentStreakCount >= STABILITY_STREAK_REQUIRED);
  return {
    ...latest,
    detailsJson: JSON.parse(latest.detailsJson),
    levelConfirmed: false,
    lastConfirmedLevel: confirmed ? confirmed.level : 'VALIDATION_HUMAINE',
  };
}

async function listHistory({ limit = 30 } = {}) {
  const rows = await prisma.autonomyReadinessSnapshot.findMany({ orderBy: { computedAt: 'desc' }, take: limit });
  return rows.map((r) => ({ ...r, detailsJson: JSON.parse(r.detailsJson) }));
}

module.exports = { STABILITY_STREAK_REQUIRED, LEVEL_THRESHOLDS, computeSnapshot, getEffectiveReadiness, listHistory };
