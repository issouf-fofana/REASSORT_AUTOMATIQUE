/**
 * Analyse des mouvements de stock d'un article (CAHIER_DES_CHARGES.md, ajout du 16/09/2026 : demande
 * d'exploiter /api/stock_move/ RPOS pour expliquer les variations de stock au-delà des seules ventes
 * — casse, cession entre rayons, retour fournisseur, inventaire... Utilisé par :
 *   - chatbotToolsService.js (outil "pourquoi le stock a bougé")
 *   - insights.js /product/:productId/analytics (indicateur UI sur la fiche article)
 *   - proposalService.js (détection de casse/perte récurrente pour fiabiliser une proposition)
 *
 * Ne réinterprète jamais les mouvements comme des ventes ou l'inverse : une baisse de stock par
 * casse ne doit jamais être comptée comme de la demande client dans le calcul d'une quantité
 * proposée (c'est justement le problème que cette donnée permet de corriger).
 *
 * Local-first depuis le 15/10/2026 (même principe que getSalesHistoryLocalFirst,
 * productAnalyticsService.js) : lit d'abord la table locale StockMove (alimentée par
 * stockMoveSyncJob.js) plutôt que RPOS en direct — 4-5s mesurées par appel RPOS contre <100ms en
 * local. Repli sur RPOS uniquement si la fenêtre demandée dépasse ce qui est synchronisé pour ce
 * magasin (StockMoveSyncState.lastSyncedUntil), pour ne jamais répondre avec une période incomplète
 * sans le signaler — un magasin pas encore synchronisé, ou une période antérieure au premier
 * backfill, retombe alors sur l'ancien comportement RPOS direct.
 */
const rpos = require('./rposClient');
const prisma = require('../utils/prisma');

// Tolérance de fraîcheur : une question posée "maintenant" (dateEnd = new Date()) ne peut quasiment
// JAMAIS être strictement <= lastSyncedUntil, le job tournant par intervalles (toutes les 20 min par
// défaut, cf. STOCK_MOVE_SYNC_CRON) — un écart de quelques minutes entre "maintenant" et la dernière
// synchro est normal, pas un signe de données manquantes. Bug trouvé en test réel le 15/10/2026 :
// sans cette tolérance, isLocallyCovered retournait systématiquement false sur une question "live",
// retombant à chaque fois sur RPOS en direct malgré une synchro locale réussie quelques minutes plus
// tôt — annulant tout le bénéfice de la table locale pour l'usage le plus courant du chatbot.
const FRESHNESS_TOLERANCE_MS = 25 * 60 * 1000; // un peu plus que l'intervalle de synchro par défaut

/** true si la table locale couvre [dateEnd] pour ce magasin, à la tolérance de fraîcheur près —
 * c'est-à-dire que la synchro incrémentale est passée assez récemment par rapport à cette date. On
 * ne vérifie que la borne de FIN (pas le début) : StockMove peut légitimement n'avoir aucune ligne
 * ancienne si le backfill initial n'a couvert qu'une fenêtre récente, ce qui n'est pas un signe
 * d'incomplétude mais simplement une absence de données pour une période trop ancienne. */
async function isLocallyCovered(shopId, dateEnd) {
  const state = await prisma.stockMoveSyncState.findUnique({ where: { rposShopId: shopId } });
  if (!state?.lastSyncedUntil || state.lastSyncStatus !== 'ok') return false;
  return state.lastSyncedUntil.getTime() + FRESHNESS_TOLERANCE_MS >= new Date(dateEnd).getTime();
}

async function getMovesFromLocal(shopId, ean, dateStart, dateEnd) {
  const rows = await prisma.stockMove.findMany({
    where: { rposShopId: shopId, ean, date: { gte: new Date(dateStart), lte: new Date(dateEnd) } },
    orderBy: { date: 'desc' },
    take: 250,
  });
  return rows.map((r) => ({
    date: r.date.toISOString(),
    typeLabel: r.typeLabel,
    recording: r.recording,
    isScrap: r.isScrap,
    quantity: r.quantity,
    previousQuantity: r.previousQuantity,
  }));
}

/**
 * Résumé agrégé des mouvements d'un article sur une période, groupés par type de mouvement (pas par
 * jour : le volume de types réellement rencontrés par article est faible en pratique, cf. test direct
 * du 16/09/2026 — Vente/Arrivage dominent très largement, les autres types sont rares et significatifs
 * quand ils apparaissent, donc plus lisibles agrégés par type que noyés dans une série temporelle).
 */
async function getStockMoveSummary(posId, shopId, ean, dateStart, dateEnd) {
  const covered = await isLocallyCovered(shopId, dateEnd);
  const moves = covered
    ? await getMovesFromLocal(shopId, ean, dateStart, dateEnd)
    : await rpos.getStockMovesForProduct(posId, shopId, ean, dateStart, dateEnd, { limit: 250 });

  const byType = new Map();
  let scrapQuantity = 0; // perte physique cumulée (is_scrap=true), toujours positive pour lecture directe
  let saleQuantity = 0;
  let receiptQuantity = 0;

  for (const move of moves) {
    const key = move.typeLabel;
    if (!byType.has(key)) {
      byType.set(key, { typeLabel: key, recording: move.recording, isScrap: move.isScrap, count: 0, totalQuantity: 0, lastDate: move.date });
    }
    const entry = byType.get(key);
    entry.count += 1;
    entry.totalQuantity += move.quantity;
    if (move.date > entry.lastDate) entry.lastDate = move.date;

    if (move.isScrap) scrapQuantity += Math.abs(move.quantity);
    if (move.typeLabel === 'Vente') saleQuantity += Math.abs(move.quantity);
    if (move.typeLabel === 'Arrivage' || move.typeLabel === 'Arrivage manuel') receiptQuantity += move.quantity;
  }

  return {
    ean,
    dateStart,
    dateEnd,
    totalMoves: moves.length,
    // Tronqué si totalMoves atteint la limite de page (250) : signalé pour ne jamais laisser croire
    // à une période entièrement couverte quand ce n'est pas le cas (même précaution que
    // /predictions/history pour la couverture réelle des données).
    truncated: moves.length >= 250,
    saleQuantity: Math.round(saleQuantity * 100) / 100,
    receiptQuantity: Math.round(receiptQuantity * 100) / 100,
    scrapQuantity: Math.round(scrapQuantity * 100) / 100,
    byType: [...byType.values()]
      .map((t) => ({ ...t, totalQuantity: Math.round(t.totalQuantity * 100) / 100 }))
      .sort((a, b) => b.count - a.count),
    recentMoves: moves.slice(0, 20), // détail brut le plus récent, pour un "pourquoi" précis (le LLM peut citer une date/quantité exacte)
  };
}

module.exports = { getStockMoveSummary, getMovesFromLocal };
