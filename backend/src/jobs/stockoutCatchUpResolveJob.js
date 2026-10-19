/**
 * Job planifié : filet de rattrapage pour résoudre les ruptures EN_COURS dont un arrivage réel est
 * déjà présent en base locale (StockMove) mais que resolveEpisodesFromArrivalMoves.js (déclenché par
 * stockMoveSyncJob.js) n'a pas pu traiter — soit parce que l'arrivage a été synchronisé AVANT le
 * déploiement du correctif, soit tout autre cas résiduel.
 *
 * Bug signalé avec capture le 19/10/2026 : "j'ai fait le commit il est toujour en pareil tu vois ?"
 * — resolveEpisodesFromArrivalMoves ne traite que les lignes StockMove NOUVELLEMENT insérées à
 * chaque passage de stockMoveSyncJob (toutes les 20 min), jamais une relecture de l'historique déjà
 * en base. Un arrivage déjà synchronisé avant le déploiement du correctif n'est donc jamais revu —
 * ce job (catchUpResolveStockoutEpisodes, stockoutEpisodeService.js) comble ce trou en relisant
 * StockMove pour CHAQUE épisode EN_COURS à chaque passage, sans appel RPOS (tout en local).
 *
 * Fréquence volontairement modérée (toutes les heures par défaut, aligné sur stockoutLossRecalcJob)
 * : une fois le rattrapage initial fait après un déploiement, le nombre de cas résiduels devient
 * faible — ce job reste surtout un filet de sécurité continu, pas une opération lourde répétée.
 */
const { catchUpResolveStockoutEpisodes } = require('../services/stockoutEpisodeService');

async function runStockoutCatchUpResolveJob() {
  console.log('[stockoutCatchUpResolveJob] Rattrapage démarré...');
  const { checked, resolved } = await catchUpResolveStockoutEpisodes();
  console.log(`[stockoutCatchUpResolveJob] Terminé : ${resolved}/${checked} épisode(s) EN_COURS résolu(s) grâce à un arrivage déjà en base.`);
}

module.exports = { runStockoutCatchUpResolveJob };
