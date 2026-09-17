/**
 * Mémoire de maîtrise par domaine métier (demande du 17/09/2026) : calcule et persiste, pour chaque
 * domaine (les capacités RBAC IA déjà utilisées ailleurs — cf. aiPermissionsService.CAPABILITIES —
 * plus "code"), un score de maîtrise/confiance consultable dans l'UI (ai-mastery.html).
 *
 * Deux méthodes de calcul cohabitent (choix assumé le 17/09/2026, cf. schema.prisma AIDomainMastery) :
 *  - "accuracy" a une vraie vérité-terrain (AIPredictionOutcome compare prédiction et vente réelle) :
 *    masteryScore dérivé de l'erreur moyenne réelle.
 *  - tous les autres domaines n'ont AUCUNE vérité-terrain aujourd'hui (juste des lectures instantanées
 *    sans vérification a posteriori) : masteryScore dérivé du volume et de l'ancienneté des
 *    CorrectionRecord sur ce domaine — une correction récente pèse plus qu'une correction ancienne
 *    (le système "oublie" progressivement une erreur corrigée depuis longtemps sans récidive).
 * Ne JAMAIS mélanger les deux calculs pour un même domaine : le champ `method` sur chaque ligne dit
 * explicitement laquelle a produit ce score, pour que l'UI puisse toujours indiquer sa fiabilité
 * réelle plutôt que de laisser croire à une précision qui n'existe pas.
 */
const prisma = require('../utils/prisma');
const { CAPABILITIES } = require('./aiPermissionsService');

const DOMAINS = [...CAPABILITIES, 'code'];

const DAY_MS = 24 * 60 * 60 * 1000;
const ACCURACY_WINDOW_DAYS = 90;

// Poids de pénalité par ancienneté d'une correction (cf. commentaire de tête) : une correction très
// récente compte pour beaucoup (le domaine vient de montrer une faiblesse), une correction ancienne
// sans récidive compte pour peu (le système a eu le temps de prouver que ça ne s'est pas reproduit).
function correctionWeight(createdAt) {
  const ageDays = (Date.now() - new Date(createdAt).getTime()) / DAY_MS;
  if (ageDays <= 7) return 10;
  if (ageDays <= 30) return 5;
  return 2;
}

/**
 * Confiance du score (0-100) : reflète la TAILLE de l'échantillon ayant servi au calcul, pas sa
 * valeur — un domaine avec masteryScore=95 mais seulement 2 observations doit afficher une
 * confiance basse (score potentiellement flatteur par manque de données), jamais la même confiance
 * qu'un domaine avec 200 observations. Plafonne à 100 après un seuil raisonnable d'observations
 * (au-delà, plus de données n'apporte plus grand-chose à la certitude).
 */
function confidenceFromSampleSize(n) {
  const CONFIDENCE_SATURATION_SAMPLE_SIZE = 30;
  return Math.round(Math.min(100, (n / CONFIDENCE_SATURATION_SAMPLE_SIZE) * 100));
}

async function computeAccuracyMastery() {
  const dateStart = new Date(Date.now() - ACCURACY_WINDOW_DAYS * DAY_MS);
  const outcomes = await prisma.aIPredictionOutcome.findMany({
    where: { evaluatedAt: { gte: dateStart }, percentageError: { not: null } },
    select: { percentageError: true },
  });
  const correctionCount = await prisma.correctionRecord.count({ where: { domain: 'accuracy' } });

  if (!outcomes.length) {
    return {
      masteryScore: 100, confidenceScore: 0, totalObservations: 0, errorCount: 0, correctionCount,
      knownIssuesJson: null,
    };
  }
  const avgAbsError = outcomes.reduce((s, o) => s + Math.abs(o.percentageError), 0) / outcomes.length;
  // Un écart moyen de 0% -> maîtrise 100 ; un écart de 100%+ -> maîtrise 0 (plafonné) : cohérent avec
  // accuracyPct déjà affiché par getPredictionAccuracy (chatbotToolsService.js), même échelle.
  const masteryScore = Math.max(0, Math.round((1 - Math.min(avgAbsError, 1)) * 1000) / 10);
  // "Erreur" comptée ici = prédiction dont l'écart dépasse 30% (seuil arbitraire mais cohérent avec
  // une tolérance métier raisonnable pour une quantité à commander, pas 0% qui compterait la moindre
  // prédiction imparfaite comme une erreur).
  const errorCount = outcomes.filter((o) => Math.abs(o.percentageError) > 0.3).length;

  return {
    masteryScore,
    confidenceScore: confidenceFromSampleSize(outcomes.length),
    totalObservations: outcomes.length,
    errorCount,
    correctionCount,
    knownIssuesJson: null,
  };
}

async function computeCorrectionVolumeMastery(domain) {
  const corrections = await prisma.correctionRecord.findMany({
    where: { domain },
    select: { createdAt: true, errorObserved: true },
    orderBy: { createdAt: 'desc' },
  });

  const penalty = corrections.reduce((sum, c) => sum + correctionWeight(c.createdAt), 0);
  const masteryScore = Math.max(0, Math.min(100, 100 - penalty));

  // Regroupe les libellés d'erreur pour repérer une récidive (même erreur corrigée plusieurs fois =
  // signal plus préoccupant qu'une correction isolée, à faire ressortir dans l'UI).
  const byLabel = {};
  for (const c of corrections) {
    byLabel[c.errorObserved] = (byLabel[c.errorObserved] || 0) + 1;
  }
  const recurring = Object.entries(byLabel).filter(([, count]) => count > 1).map(([label, count]) => ({ label, count }));

  return {
    masteryScore,
    // Confiance basée sur le nombre total de corrections connues pour ce domaine : peu de
    // corrections ne veut pas forcément dire "domaine maîtrisé", ça peut aussi vouloir dire "domaine
    // jamais vraiment mis à l'épreuve" — la confiance reste basse tant que l'échantillon est petit.
    confidenceScore: confidenceFromSampleSize(corrections.length),
    totalObservations: corrections.length,
    errorCount: corrections.length,
    correctionCount: corrections.length,
    knownIssuesJson: recurring.length ? JSON.stringify(recurring) : null,
  };
}

/** Recalcule et persiste la maîtrise de TOUS les domaines connus. Appelé par un cron dédié. */
async function recomputeAllDomains() {
  const results = [];
  for (const domain of DOMAINS) {
    const method = domain === 'accuracy' ? 'ACCURACY_OUTCOME' : 'CORRECTION_VOLUME';
    const computed = domain === 'accuracy' ? await computeAccuracyMastery() : await computeCorrectionVolumeMastery(domain);
    const saved = await prisma.aIDomainMastery.upsert({
      where: { domain },
      create: { domain, method, ...computed, lastEvaluatedAt: new Date() },
      update: { method, ...computed, lastEvaluatedAt: new Date() },
    });
    results.push(saved);
  }
  return results;
}

async function listMastery() {
  const rows = await prisma.aIDomainMastery.findMany({ orderBy: { domain: 'asc' } });
  const byDomain = Object.fromEntries(rows.map((r) => [r.domain, r]));
  // Domaine jamais encore calculé (première utilisation avant tout cron) : renvoyer un état par
  // défaut explicite plutôt qu'un trou dans la liste — jamais un domaine RBAC connu absent de l'UI.
  return DOMAINS.map((domain) => {
    const row = byDomain[domain];
    if (row) return { ...row, knownIssues: row.knownIssuesJson ? JSON.parse(row.knownIssuesJson) : [] };
    return {
      id: null, domain, masteryScore: 100, confidenceScore: 0,
      method: domain === 'accuracy' ? 'ACCURACY_OUTCOME' : 'CORRECTION_VOLUME',
      totalObservations: 0, errorCount: 0, correctionCount: 0, knownIssues: [],
      lastEvaluatedAt: null, updatedAt: null,
    };
  });
}

module.exports = { DOMAINS, recomputeAllDomains, listMastery };
