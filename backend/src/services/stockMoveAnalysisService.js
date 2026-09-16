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
 */
const rpos = require('./rposClient');

/**
 * Résumé agrégé des mouvements d'un article sur une période, groupés par type de mouvement (pas par
 * jour : le volume de types réellement rencontrés par article est faible en pratique, cf. test direct
 * du 16/09/2026 — Vente/Arrivage dominent très largement, les autres types sont rares et significatifs
 * quand ils apparaissent, donc plus lisibles agrégés par type que noyés dans une série temporelle).
 */
async function getStockMoveSummary(posId, shopId, ean, dateStart, dateEnd) {
  const moves = await rpos.getStockMovesForProduct(posId, shopId, ean, dateStart, dateEnd, { limit: 250 });

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

module.exports = { getStockMoveSummary };
