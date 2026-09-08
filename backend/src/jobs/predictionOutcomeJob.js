/**
 * Job planifié : résultat réel vs prédiction (CAHIER_DES_CHARGES.md §22, étape 5 du plan de montée
 * en autonomie IA).
 *
 * Pour chaque AIPrediction (étape 4) dont la période cible (targetPeriodEnd) est terminée et qui
 * n'a pas encore d'AIPredictionOutcome, calcule ce qui s'est réellement passé sur cette période :
 * ventes réelles (SalesLine, déjà synchronisées localement par salesSyncJob — aucun appel RPOS),
 * stock actuel en cache (ProductCache), et commande effectivement passée si la proposition a été
 * validée. N'écrit qu'un résultat de mesure : ne modifie ni la proposition, ni le plan, ni aucun
 * comportement de calcul existant.
 */
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// Nombre de prédictions évaluées par lot : une table pouvant grossir vite (une ligne par article
// et par génération), on évite de tout charger en mémoire d'un coup.
const BATCH_SIZE = 500;

function computeErrors(predictedQuantity, actualSales) {
  const forecastError = actualSales - predictedQuantity;
  const absoluteError = Math.abs(forecastError);
  // §22 : "gérer correctement les cas où actual = 0" — pourcentage non défini plutôt que division
  // par zéro ou infini silencieux.
  const percentageError = actualSales > 0 ? absoluteError / actualSales : null;
  return { forecastError, absoluteError, percentageError };
}

async function evaluatePrediction(prediction) {
  const [salesAgg, productCache, proposalLine] = await Promise.all([
    prisma.salesLine.aggregate({
      where: {
        rposShopId: prediction.rposShopId,
        ean: prediction.ean,
        date: { gte: prediction.targetPeriodStart, lte: prediction.targetPeriodEnd },
      },
      _sum: { quantity: true },
    }),
    prisma.productCache.findUnique({
      where: { rposShopId_ean: { rposShopId: prediction.rposShopId, ean: prediction.ean } },
    }),
    prisma.proposalLine.findFirst({
      where: { proposalId: prediction.proposalId, ean: prediction.ean },
      select: { quantitySuggested: true, proposal: { select: { status: true } } },
    }),
  ]);

  const actualSales = salesAgg._sum.quantity || 0;
  const actualStock = productCache ? productCache.stock : null;
  const actualOrders = proposalLine && proposalLine.proposal.status === 'VALIDATED'
    ? proposalLine.quantitySuggested
    : null;

  const { forecastError, absoluteError, percentageError } = computeErrors(prediction.predictedQuantity, actualSales);

  return prisma.aIPredictionOutcome.create({
    data: {
      predictionId: prediction.id,
      predictedQuantity: prediction.predictedQuantity,
      actualSales,
      actualStock,
      actualOrders,
      forecastError,
      absoluteError,
      percentageError,
    },
  });
}

async function runPredictionOutcomeEvaluation() {
  const now = new Date();

  const pending = await prisma.aIPrediction.findMany({
    where: {
      targetPeriodEnd: { not: null, lt: now },
      outcome: null,
    },
    take: BATCH_SIZE,
  });

  console.log(`[predictionOutcomeJob] Évaluation de ${pending.length} prédiction(s) dont la période cible est terminée...`);

  const results = { evaluated: 0, failed: 0 };
  for (const prediction of pending) {
    try {
      await evaluatePrediction(prediction);
      results.evaluated += 1;
    } catch (error) {
      results.failed += 1;
      console.error(`[predictionOutcomeJob] Échec pour prédiction ${prediction.id} (${prediction.ean}):`, error.message);
    }
  }

  console.log(`[predictionOutcomeJob] Terminé : ${results.evaluated} évaluée(s), ${results.failed} échec(s).`);
  return results;
}

module.exports = { runPredictionOutcomeEvaluation };
