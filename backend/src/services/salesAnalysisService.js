const prisma = require('../utils/prisma');

// Sauvegarde/relit l'analyse de ventes déjà calculée par proposalService.analyzeSales, pour
// permettre de générer plusieurs propositions à partir de la même analyse sans refaire le calcul
// de ventes à chaque fois (demande du 30/09/2026). Une seule ligne par magasin (upsert par
// rposShopId), jamais d'historique, jamais d'expiration automatique.

async function saveSalesAnalysis(posId, shopId, shopReference, analysis) {
  const data = {
    rposShopId: shopId,
    rposShopReference: shopReference || '',
    rposPosId: posId,
    payload: analysis,
    periodStart: new Date(analysis.period.start),
    periodEnd: new Date(analysis.period.end),
    periodMode: analysis.config.periodMode,
    actualDataStart: analysis.actualDataStart ? new Date(analysis.actualDataStart) : null,
    actualDataEnd: analysis.actualDataEnd ? new Date(analysis.actualDataEnd) : null,
    totalArticlesWithSales: analysis.totalArticlesWithSales,
    salesSource: analysis.salesSource,
  };
  return prisma.salesAnalysis.upsert({
    where: { rposShopId: shopId },
    create: data,
    update: data,
  });
}

// Métadonnées légères pour affichage (bandeau "Analyse du DD/MM disponible"), sans le payload
// complet — évite de désérialiser potentiellement des milliers d'articles pour un simple check.
async function getSalesAnalysis(shopId) {
  const row = await prisma.salesAnalysis.findUnique({
    where: { rposShopId: shopId },
    select: {
      analyzedAt: true,
      periodStart: true,
      periodEnd: true,
      periodMode: true,
      actualDataStart: true,
      actualDataEnd: true,
      totalArticlesWithSales: true,
      salesSource: true,
    },
  });
  return row || null;
}

// Recharge l'analyse complète (payload inclus), utilisable directement par
// proposalService.generateFromAnalysis. Le payload traverse un aller-retour JSON (colonne jsonb) :
// les Date deviennent des strings ISO à la lecture, à reconvertir explicitement pour les champs que
// generateFromAnalysis traite comme de vraies Date (ex: actualDataStart.toISOString()).
async function loadSalesAnalysisForGeneration(shopId) {
  const row = await prisma.salesAnalysis.findUnique({ where: { rposShopId: shopId } });
  if (!row) return null;
  const payload = row.payload;
  return {
    ...payload,
    actualDataStart: payload.actualDataStart ? new Date(payload.actualDataStart) : null,
    actualDataEnd: payload.actualDataEnd ? new Date(payload.actualDataEnd) : null,
  };
}

module.exports = { saveSalesAnalysis, getSalesAnalysis, loadSalesAnalysisForGeneration };
