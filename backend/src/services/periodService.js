const rpos = require('./rposClient');
const prisma = require('../utils/prisma');

const MODE_DAYS = {
  YESTERDAY: 1,
  LAST_7_DAYS: 7,
  LAST_30_DAYS: 30,
};

/**
 * Calcule la période d'analyse effective (start/end ISO) pour un magasin, selon le mode configuré.
 * Les périodes relatives (YESTERDAY, LAST_7_DAYS, LAST_30_DAYS) sont calculées à partir de la
 * dernière vente RÉELLE du magasin (pas la date système), pour rester pertinentes même sur un
 * magasin fermé ou dont l'export RPOS a du retard.
 */
async function resolvePeriod(posId, shopId, config) {
  if (config.periodMode === 'CUSTOM') {
    if (!config.customStart || !config.customEnd) {
      throw new Error('Période personnalisée incomplète (customStart/customEnd requis)');
    }
    return {
      start: new Date(config.customStart).toISOString().slice(0, 19),
      end: new Date(config.customEnd).toISOString().slice(0, 19),
      referenceDate: null,
    };
  }

  // Mode "sans réseau Prosuma" (config.ignoreRposStockInCalculation) : rpos.getLastSaleDate ci-
  // dessous échouerait forcément hors réseau, bloquant la génération avant même d'atteindre le
  // calcul par article (là où le reste du mode "sans réseau" est géré, cf. proposalService.js) — on
  // retombe alors sur la dernière vente connue dans la base LOCALE (SalesLine, alimentée par la
  // synchro incrémentale), qui ne nécessite aucun appel réseau.
  let lastSaleDate;
  if (config.ignoreRposStockInCalculation) {
    const latestLocal = await prisma.salesLine.findFirst({ where: { rposShopId: shopId }, orderBy: { date: 'desc' }, select: { date: true } });
    lastSaleDate = latestLocal ? latestLocal.date.toISOString() : null;
  } else {
    lastSaleDate = await rpos.getLastSaleDate(posId, shopId);
  }
  if (!lastSaleDate) {
    throw new Error('Aucune vente trouvée pour ce magasin, impossible de déterminer une période');
  }

  const days = MODE_DAYS[config.periodMode] || MODE_DAYS.LAST_30_DAYS;
  const end = new Date(lastSaleDate);
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);

  return {
    start: start.toISOString().slice(0, 19),
    end: end.toISOString().slice(0, 19),
    referenceDate: lastSaleDate,
  };
}

module.exports = { resolvePeriod, MODE_DAYS };
