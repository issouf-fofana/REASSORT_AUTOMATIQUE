/**
 * Détection d'anomalie de commande (demande du 18/09/2026, backend/amelioration.md) : compare la
 * quantité proposée pour un article à l'historique des quantités RÉELLEMENT VALIDÉES par un humain
 * pour ce même article/magasin (ProposalLine.quantityValidated), et signale un écart statistique
 * important — trop haut (risque de surstock) ou trop bas (risque de rupture malgré la commande).
 *
 * Détecté à la GÉNÉRATION de la proposition (pas à la validation) : l'alerte doit être visible
 * AVANT que l'utilisateur ne décide, jamais après coup — choix explicite de l'utilisateur.
 *
 * Ne conclut JAMAIS "commande incorrecte" : une anomalie signifie seulement "différent de
 * l'habitude", jamais "erreur" — le contexte (promotion, reprise d'activité...) peut justifier un
 * écart, seul un humain statue (ACKNOWLEDGED = écart accepté, DISMISSED = fausse alerte confirmée).
 */
const prisma = require('../utils/prisma');

// Nombre minimum de commandes passées validées nécessaires pour juger un écart significatif — sous
// ce seuil, la moyenne/l'écart-type ne représentent pas encore un vrai "comportement habituel"
// (un historique de 1-2 commandes peut n'importe quoi représenter, jamais une base fiable).
const MIN_SAMPLE_SIZE = 3;
// Nombre de commandes passées les plus récentes prises en compte — au-delà, un comportement très
// ancien (magasin qui a changé de rythme depuis) pèserait à tort sur le jugement d'aujourd'hui.
const HISTORY_SAMPLE_SIZE = 10;
// Seuil de déviation (en écarts-types, ou en ratio à la moyenne si écart-type nul) au-delà duquel
// un écart est jugé anormal — 2 écarts-types est un seuil statistique courant (au-delà, l'écart a
// moins de 5% de chances d'être une simple variation normale sous hypothèse gaussienne).
const ANOMALY_THRESHOLD = 2;

function average(values) {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function standardDeviation(values, mean) {
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Historique des quantités réellement validées pour un article/magasin, les plus récentes d'abord.
 * Exclut la proposition en cours (excludeProposalId) : une génération ne doit jamais se comparer à
 * elle-même si elle a par erreur déjà une ligne persistée au moment de l'appel.
 */
async function getValidatedQuantityHistory(rposShopId, ean, { excludeProposalId } = {}) {
  const lines = await prisma.proposalLine.findMany({
    where: {
      ean,
      quantityValidated: { not: null },
      proposal: { rposShopId, ...(excludeProposalId ? { id: { not: excludeProposalId } } : {}) },
    },
    select: { quantityValidated: true },
    orderBy: { proposal: { generatedAt: 'desc' } },
    take: HISTORY_SAMPLE_SIZE,
  });
  return lines.map((l) => l.quantityValidated);
}

/**
 * Compare une quantité (proposée ou en cours de saisie) à l'historique validé pour cet article.
 * Retourne { anomaly: false } si l'historique est trop court ou si l'écart reste dans la norme —
 * jamais une fausse alerte faute de données suffisantes.
 */
async function detectOrderAnomaly(rposShopId, ean, newQuantity, { excludeProposalId } = {}) {
  if (!(newQuantity > 0)) return { anomaly: false }; // 0 n'est jamais une anomalie de SUR ou SOUS-commande
  const history = await getValidatedQuantityHistory(rposShopId, ean, { excludeProposalId });
  if (history.length < MIN_SAMPLE_SIZE) return { anomaly: false, reason: 'historique insuffisant' };

  const mean = average(history);
  const stdDev = standardDeviation(history, mean);
  // Écart-type nul (l'historique commande toujours exactement la même quantité) : tout écart
  // devient statistiquement "infini" avec la formule standard — on retombe sur un ratio à la
  // moyenne (>50% d'écart) pour rester un seuil raisonnable plutôt qu'une alerte sur le moindre
  // écart d'une seule unité.
  const deviation = stdDev > 0 ? Math.abs(newQuantity - mean) / stdDev : Math.abs(newQuantity - mean) / mean;
  const effectiveThreshold = stdDev > 0 ? ANOMALY_THRESHOLD : 0.5;

  if (deviation <= effectiveThreshold) return { anomaly: false };

  return {
    anomaly: true,
    direction: newQuantity > mean ? 'HIGH' : 'LOW',
    newQuantity,
    historicalMean: mean,
    historicalMin: Math.min(...history),
    historicalMax: Math.max(...history),
    sampleSize: history.length,
  };
}

/** Persiste une anomalie détectée (une ligne par détection — pas de déduplication ici, l'appelant décide). */
async function recordAnomaly(rposShopId, ean, label, proposalId, result) {
  return prisma.orderAnomaly.create({
    data: {
      rposShopId, ean, label, proposalId,
      newQuantity: result.newQuantity,
      historicalMean: result.historicalMean,
      historicalMin: result.historicalMin,
      historicalMax: result.historicalMax,
      sampleSize: result.sampleSize,
      direction: result.direction,
    },
  });
}

async function listAnomalies({ status, rposShopId, limit = 100 } = {}) {
  const rows = await prisma.orderAnomaly.findMany({
    where: { ...(status ? { status } : {}), ...(rposShopId ? { rposShopId } : {}) },
    orderBy: { detectedAt: 'desc' },
    take: limit,
    // Référence/nom du magasin lisible (via la Proposal d'origine) plutôt que le seul UUID
    // rposShopId — le champ direct existe mais un UUID brut n'est pas exploitable côté UI.
    include: { proposal: { select: { rposShopReference: true, rposShopName: true } } },
  });
  return rows.map((r) => ({
    ...r,
    shopReference: r.proposal?.rposShopReference || null,
    shopName: r.proposal?.rposShopName || null,
    proposal: undefined,
  }));
}

async function setAnomalyStatus(id, status, contextNote) {
  if (!['PENDING', 'ACKNOWLEDGED', 'DISMISSED'].includes(status)) {
    throw new Error(`Statut invalide : "${status}"`);
  }
  return prisma.orderAnomaly.update({ where: { id }, data: { status, ...(contextNote !== undefined ? { contextNote } : {}) } });
}

module.exports = {
  MIN_SAMPLE_SIZE, HISTORY_SAMPLE_SIZE, ANOMALY_THRESHOLD,
  getValidatedQuantityHistory, detectOrderAnomaly, recordAnomaly, listAnomalies, setAnomalyStatus,
};
