/**
 * Journal unifié des corrections (demande du 17/09/2026) : chaque correction — qu'elle vienne du
 * chien de garde IA (AIImprovement confirmé IMPROVED) ou d'une correction de code faite en
 * développement — laisse une trace complète et structurée : erreur exacte constatée, contexte,
 * cause identifiée, correction apportée, fichiers/fonctions concernés, tests avant/après, et liens
 * vers l'historique des corrections similaires.
 *
 * UN SEUL journal pour les deux sources (choix validé le 17/09/2026, plutôt que deux journaux
 * séparés) : "l'historique des corrections similaires" n'a de sens que si une correction de code
 * peut être rapprochée d'une auto-correction IA sur le même domaine, et inversement.
 */
const prisma = require('../utils/prisma');

const SOURCES = ['AI_AUTO', 'DEV_FIX'];

// Domaines valides : les capacités déjà utilisées pour le RBAC IA (aiPermissionsService.CAPABILITIES),
// jamais une taxonomie parallèle qui divergerait — "code" en repli pour un correctif transverse qui
// ne se rattache à aucune capacité précise (ex: bug d'infrastructure, de proxy, de routage Express).
const DOMAINS = ['revenueShop', 'revenueArticle', 'articleDetails', 'stock', 'sales', 'orders', 'accuracy', 'code'];

// Mapping AIImprovement.type -> domaine le plus proche, utilisé quand une correction AI_AUTO est
// créée automatiquement à partir d'un constat du chien de garde (improvementService.js). Un type
// inconnu (nouveau type ajouté plus tard sans mise à jour de cette table) retombe sur "code" plutôt
// que de faire planter la création — jamais un blocage pour une simple taxonomie non à jour.
const IMPROVEMENT_TYPE_TO_DOMAIN = {
  ACCURACY: 'accuracy',
  SILENT_ANOMALY: 'stock',
  CHATBOT_GAP: 'sales',
  JOB_HEALTH: 'code',
  DATA_QUALITY: 'code',
  WORKFLOW: 'code',
};

function toJsonArray(value) {
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify([value]);
  return JSON.stringify([]);
}

function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function serialize(record) {
  return {
    ...record,
    filesChanged: parseJsonArray(record.filesChanged),
    functionsChanged: parseJsonArray(record.functionsChanged),
    similarPastCorrectionIds: parseJsonArray(record.similarPastCorrectionIds),
  };
}

/**
 * Recherche les corrections passées les plus proches d'un nouveau correctif, pour alimenter
 * similarPastCorrectionIds à la création — jamais recalculé après coup (une correction future qui
 * cite celle-ci ne modifie pas rétroactivement cette liste, cf. schema.prisma). Se limite au MÊME
 * domaine : une correction sur "stock" n'a pas grand intérêt à être comparée à une correction
 * "orders", même avec des mots proches dans la description.
 */
async function findSimilar(domain, { excludeId, limit = 5 } = {}) {
  const candidates = await prisma.correctionRecord.findMany({
    where: { domain, ...(excludeId ? { id: { not: excludeId } } : {}) },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { id: true },
  });
  return candidates.map((c) => c.id);
}

/**
 * Crée une entrée du journal. domain doit être une capacité connue (cf. DOMAINS) ou "code" — un
 * domaine inconnu est refusé plutôt que silencieusement toléré : ce journal sert de base à la
 * mesure de maîtrise par domaine (AIDomainMastery, à venir), une valeur qui ne matche aucune
 * capacité réelle fausserait ce calcul sans que personne ne le remarque.
 */
async function recordCorrection({
  source, improvementId, domain, errorObserved, context, rootCause, fixApplied,
  filesChanged, functionsChanged, testsBefore, testsAfter, createdBy,
}) {
  if (!SOURCES.includes(source)) {
    throw new Error(`source invalide : "${source}" (attendu : ${SOURCES.join(', ')})`);
  }
  if (!DOMAINS.includes(domain)) {
    throw new Error(`domain invalide : "${domain}" (attendu : ${DOMAINS.join(', ')})`);
  }
  const similarIds = await findSimilar(domain);
  const created = await prisma.correctionRecord.create({
    data: {
      source,
      improvementId: improvementId || null,
      domain,
      errorObserved,
      context,
      rootCause,
      fixApplied,
      filesChanged: toJsonArray(filesChanged),
      functionsChanged: toJsonArray(functionsChanged),
      testsBefore: typeof testsBefore === 'string' ? testsBefore : JSON.stringify(testsBefore || ''),
      testsAfter: typeof testsAfter === 'string' ? testsAfter : JSON.stringify(testsAfter || ''),
      similarPastCorrectionIds: toJsonArray(similarIds),
      createdBy: createdBy || 'system',
    },
  });
  return serialize(created);
}

/**
 * Crée automatiquement une entrée AI_AUTO à partir d'un AIImprovement confirmé IMPROVED (correction
 * appliquée ET dont l'effet a été mesuré comme réel) — appelé depuis improvementService.js au moment
 * de cette transition, jamais à APPLIED seul (une correction "appliquée" mais pas encore vérifiée
 * n'est pas encore une correction confirmée pour ce journal).
 */
async function recordFromImprovement(improvement, { metricBefore, metricAfter } = {}) {
  const domain = IMPROVEMENT_TYPE_TO_DOMAIN[improvement.type] || 'code';
  const evidence = improvement.evidence ? (() => { try { return JSON.parse(improvement.evidence); } catch (e) { return improvement.evidence; } })() : null;
  return recordCorrection({
    source: 'AI_AUTO',
    improvementId: improvement.id,
    domain,
    errorObserved: improvement.errorMessage || improvement.title,
    context: `${improvement.scope === 'global' ? 'Portée globale' : `Magasin ${improvement.scope}`} — ${improvement.title}`,
    rootCause: improvement.detail,
    fixApplied: improvement.appliedNote || improvement.devRecommendation || 'Correction appliquée automatiquement par le chien de garde IA.',
    filesChanged: [],
    functionsChanged: [],
    testsBefore: JSON.stringify({ metric: improvement.metricName, value: metricBefore ?? improvement.metricBefore, evidence }),
    testsAfter: JSON.stringify({ metric: improvement.metricName, value: metricAfter ?? improvement.metricAfter }),
    createdBy: 'system',
  });
}

async function listCorrections({ domain, source, limit = 50, cursor } = {}) {
  const records = await prisma.correctionRecord.findMany({
    where: { ...(domain ? { domain } : {}), ...(source ? { source } : {}) },
    orderBy: { createdAt: 'desc' },
    take: limit,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
  });
  return records.map(serialize);
}

async function getCorrection(id) {
  const record = await prisma.correctionRecord.findUnique({ where: { id } });
  return record ? serialize(record) : null;
}

module.exports = { SOURCES, DOMAINS, recordCorrection, recordFromImprovement, findSimilar, listCorrections, getCorrection };
