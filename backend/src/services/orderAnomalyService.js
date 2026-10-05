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
async function getValidatedQuantityHistory(rposShopId, ean, { excludeProposalId, historySampleSize = HISTORY_SAMPLE_SIZE } = {}) {
  const lines = await prisma.proposalLine.findMany({
    where: {
      ean,
      quantityValidated: { not: null },
      proposal: { rposShopId, ...(excludeProposalId ? { id: { not: excludeProposalId } } : {}) },
    },
    // detectedAt/generatedAt + proposalId + rposOrderReference remontés avec la quantité (demande
    // du 05/10/2026 : afficher le détail des commandes validées ayant servi au calcul, y compris le
    // numéro de commande RPOS, pas seulement la moyenne/les bornes) — sert à listResult ci-dessous
    // et à l'affichage détaillé côté UI (OrderAnomalies.tsx).
    select: { quantityValidated: true, proposalId: true, proposal: { select: { generatedAt: true, rposOrderReference: true } } },
    orderBy: { proposal: { generatedAt: 'desc' } },
    take: historySampleSize,
  });
  return lines.map((l) => ({
    quantity: l.quantityValidated,
    proposalId: l.proposalId,
    generatedAt: l.proposal.generatedAt,
    // null si la proposition n'a jamais été transmise à RPOS (rare pour une ligne validée, mais
    // possible en cas d'échec de validation) — affiché comme "—" côté UI plutôt que planter dessus.
    orderReference: l.proposal.rposOrderReference,
  }));
}

/**
 * Compare une quantité (proposée ou en cours de saisie) à l'historique validé pour cet article.
 * Retourne { anomaly: false } si l'historique est trop court ou si l'écart reste dans la norme —
 * jamais une fausse alerte faute de données suffisantes.
 *
 * @param {object} [thresholds] - seuils configurables (Paramètres, demande du 05/10/2026 — en dur
 *   auparavant) : minSampleSize, historySampleSize, anomalyThreshold. Valeurs par défaut = anciennes
 *   constantes, pour ne jamais changer le comportement d'un appelant qui ne les fournit pas encore.
 */
async function detectOrderAnomaly(rposShopId, ean, newQuantity, { excludeProposalId, minSampleSize = MIN_SAMPLE_SIZE, historySampleSize = HISTORY_SAMPLE_SIZE, anomalyThreshold = ANOMALY_THRESHOLD } = {}) {
  if (!(newQuantity > 0)) return { anomaly: false }; // 0 n'est jamais une anomalie de SUR ou SOUS-commande
  const historyEntries = await getValidatedQuantityHistory(rposShopId, ean, { excludeProposalId, historySampleSize });
  if (historyEntries.length < minSampleSize) return { anomaly: false, reason: 'historique insuffisant' };

  const history = historyEntries.map((e) => e.quantity);
  const mean = average(history);
  const stdDev = standardDeviation(history, mean);
  // Écart-type nul (l'historique commande toujours exactement la même quantité) : tout écart
  // devient statistiquement "infini" avec la formule standard — on retombe sur un ratio à la
  // moyenne (>50% d'écart) pour rester un seuil raisonnable plutôt qu'une alerte sur le moindre
  // écart d'une seule unité.
  const deviation = stdDev > 0 ? Math.abs(newQuantity - mean) / stdDev : Math.abs(newQuantity - mean) / mean;
  const effectiveThreshold = stdDev > 0 ? anomalyThreshold : 0.5;

  if (deviation <= effectiveThreshold) return { anomaly: false };

  return {
    anomaly: true,
    direction: newQuantity > mean ? 'HIGH' : 'LOW',
    newQuantity,
    historicalMean: mean,
    historicalMin: Math.min(...history),
    historicalMax: Math.max(...history),
    sampleSize: history.length,
    // Détail des commandes validées ayant servi au calcul (demande du 05/10/2026) — persisté en
    // JSON sur OrderAnomaly.historyDetail, affiché en dépliable côté UI.
    historyDetail: historyEntries.map((e) => ({ quantity: e.quantity, generatedAt: e.generatedAt, orderReference: e.orderReference })),
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
      trendContext: result.trendContext || null,
      historyDetail: result.historyDetail ? JSON.stringify(result.historyDetail) : null,
    },
  });
}

/**
 * Contextualise une anomalie déjà détectée avec la tendance de vente de l'article (amelioration.md
 * §7, 05/10/2026) : "une différence n'est pas forcément une erreur" — si une commande HIGH coïncide
 * avec des ventes en forte hausse (ou une commande LOW avec des ventes en forte baisse), l'écart a
 * une explication plausible déjà visible dans les données, pas besoin d'attendre qu'un humain la
 * devine. N'annule JAMAIS l'anomalie (§9 : seul un humain statue via ACKNOWLEDGED/DISMISSED) —
 * ajoute seulement un message explicatif à côté.
 *
 * @param {{direction: 'HIGH'|'LOW'}} anomalyResult - résultat de detectOrderAnomaly (anomaly: true)
 * @param {{category: string, changePct: number|null}} trend - anomalyService.computeTrendScore
 * @returns {string|null} message de contexte, ou null si la tendance ne va pas dans le même sens
 */
function buildTrendContext(anomalyResult, trend) {
  if (!trend || !anomalyResult) return null;
  const { category, changePct } = trend;

  if (anomalyResult.direction === 'HIGH' && category === 'GROWING') {
    return changePct != null
      ? `Les ventes de cet article sont en hausse de ${changePct}% récemment, ce qui peut partiellement expliquer cette quantité plus élevée que d'habitude.`
      : `Les ventes de cet article sont en hausse récemment, ce qui peut partiellement expliquer cette quantité plus élevée que d'habitude.`;
  }
  if (anomalyResult.direction === 'LOW' && category === 'DECLINING') {
    return changePct != null
      ? `Les ventes de cet article sont en baisse de ${Math.abs(changePct)}% récemment, ce qui peut partiellement expliquer cette quantité plus faible que d'habitude.`
      : `Les ventes de cet article sont en baisse récemment, ce qui peut partiellement expliquer cette quantité plus faible que d'habitude.`;
  }
  // Tendance erratique (VOLATILE) : l'écart peut juste refléter cette instabilité plutôt qu'une
  // vraie décision inhabituelle — vaut la peine de le signaler même sans correspondre à HIGH/LOW.
  if (category === 'VOLATILE') {
    return 'Les ventes de cet article sont volatiles récemment (forte variation d\'un jour à l\'autre), ce qui peut aussi expliquer un écart par rapport aux commandes habituelles.';
  }
  return null;
}

async function listAnomalies({ status, rposShopId, limit = 100 } = {}) {
  const rows = await prisma.orderAnomaly.findMany({
    where: { ...(status ? { status } : {}), ...(rposShopId ? { rposShopId } : {}) },
    orderBy: { detectedAt: 'desc' },
    take: limit,
    // Référence/nom du magasin lisible — le champ direct (rposShopId) est un UUID brut, pas
    // exploitable tel quel côté UI (demande du 05/10/2026 : "affiche aussi le nom du magasin").
    include: { proposal: { select: { rposShopReference: true, rposShopName: true } } },
  });

  // Résolution via Shop (source indépendante de la Proposal) pour les anomalies dont proposalId est
  // null (ex: détectées hors génération) ou dont la Proposal liée a depuis été supprimée — sinon
  // ces lignes retombaient sur l'UUID brut faute de résultat, ce qui a motivé ce correctif (bug
  // constaté sur une anomalie de test créée sans proposalId). Un seul findMany groupé plutôt qu'une
  // requête par ligne, pour rester performant même avec `limit` élevé.
  const missingShopIds = [...new Set(rows.filter((r) => !r.proposal?.rposShopReference).map((r) => r.rposShopId))];
  const shopsById = missingShopIds.length
    ? new Map((await prisma.shop.findMany({ where: { rposShopId: { in: missingShopIds } }, select: { rposShopId: true, reference: true, name: true } })).map((s) => [s.rposShopId, s]))
    : new Map();

  return rows.map((r) => ({
    ...r,
    shopReference: r.proposal?.rposShopReference || shopsById.get(r.rposShopId)?.reference || null,
    shopName: r.proposal?.rposShopName || shopsById.get(r.rposShopId)?.name || null,
    proposal: undefined,
    // Désérialisé ici (stocké en JSON string côté base, cf. recordAnomaly) pour que l'UI reçoive
    // directement un tableau exploitable — jamais bloquant : une valeur corrompue/ancienne (avant
    // l'ajout du champ) retombe sur null plutôt que de faire échouer tout le listing.
    historyDetail: (() => { try { return r.historyDetail ? JSON.parse(r.historyDetail) : null; } catch { return null; } })(),
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
  buildTrendContext,
};
