/**
 * Chien de garde quotidien du Conseiller d'amélioration IA (première brique AI Center, §44).
 *
 * Lance le cycle complet sans intervention humaine : détection des anomalies silencieuses,
 * persistance dédupliquée, enrichissement IA des priorités (max 5, avec repli déterministe),
 * puis évaluation d'effet des recommandations marquées APPLIED (IMPROVED vs NO_EFFECT).
 * Planifié après l'évaluation des prédictions (7h) pour bénéficier des mesures les plus
 * fraîches. Le run est lui-même suivi via trackJobRun (santé visible dans Paramètres).
 */
const improvementService = require('../services/improvementService');

async function runImprovementWatchdog() {
  const result = await improvementService.generateImprovements();
  console.log(
    `[improvementWatchdog] ${result.findings} constat(s), ${result.created} nouvelle(s) reco(s), ` +
    `${result.duplicates} déjà ouverte(s), ${result.enriched} enrichie(s) par IA, ` +
    `${result.evaluation.improved} amélioration(s) constatée(s), ${result.evaluation.noEffect} sans effet.`
  );
  return result;
}

module.exports = { runImprovementWatchdog };
