/**
 * Récap quotidien de couverture des ventes (demande du 22/09/2026 : "au moins à 23h59:59 on est
 * sûr que il a tout pris") — la synchro incrémentale (salesSyncJob.js, toutes les 15 min) ne
 * compare jamais RPOS vs local sur une journée COMPLÈTE, seulement sur une fenêtre glissante de
 * 48h ; un écart plus ancien que cette fenêtre n'était donc jamais rattrapé automatiquement.
 *
 * Ce job tourne une fois par jour (par défaut 23:59, configurable) et appelle, pour CHAQUE magasin
 * actif, la vérification jour-par-jour déjà existante (salesDailyCoverageService.checkDay /
 * runDailyRecap — logique de comparaison et de relance ciblée écrite le 21/09/2026, mais jusqu'ici
 * jamais invoquée automatiquement, seulement en fin d'un backfill manuel).
 *
 * ÉLARGI le 25/10/2026 (bug réel constaté en production : écart résiduel de quelques dizaines à
 * centaines de lignes persistant sur PRESQUE CHAQUE jour, même après ce récap) — ce job ne
 * vérifiait QUE "la journée qui vient de se terminer" (hier), jamais plus tard. Une vente RPOS
 * ajoutée ou corrigée en retard côté caisse APRÈS le passage du récap sur ce jour précis (synchro
 * différée d'une caisse, panne ponctuelle résolue ensuite) restait donc définitivement manquante,
 * aucun mécanisme ne revérifiant jamais un jour déjà passé. Vérifie désormais une fenêtre glissante
 * des SALES_DAILY_RECAP_LOOKBACK_DAYS derniers jours (défaut 7) à chaque passage — coût minime
 * (checkDay ne fait qu'un comptage léger par jour ; une vraie récupération ciblée n'est déclenchée
 * que pour les jours réellement en écart), mais rattrape maintenant les écarts tardifs qu'un simple
 * "hier" ne pouvait jamais voir.
 */
const rpos = require('../services/rposClient');
const rposServers = require('../services/rposServersService');
const systemConfig = require('../services/systemConfigService');
const coverageService = require('../services/salesDailyCoverageService');
const { startBackfill } = require('../services/salesBackfillService');
const { mapWithConcurrency } = require('../utils/concurrency');

const SHOP_CONCURRENCY_PER_SERVER = 4;

function startOfDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

async function runSalesDailyRecap() {
  // periodEnd = la journée qui vient de se terminer au moment de l'exécution (hier si le job
  // tourne à 23:59, "aujourd'hui" au sens calendaire s'il tourne juste après minuit) — jamais le
  // jour courant encore en cours, dont la couverture est nécessairement partielle par définition.
  // periodStart recule désormais de SALES_DAILY_RECAP_LOOKBACK_DAYS jours (défaut 7, cf.
  // commentaire en tête de fichier) au lieu de se limiter à cette seule journée.
  const now = new Date();
  const periodEnd = startOfDay(now);
  const lookbackDays = parseInt(await systemConfig.getValue(systemConfig.KEYS.SALES_DAILY_RECAP_LOOKBACK_DAYS), 10) || 7;
  const periodStart = new Date(periodEnd.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

  const servers = await rposServers.listServers();
  const activeServers = servers.filter((s) => s.isActive && s.rposUser && s.rposPassword);

  const shopIdsConfig = await systemConfig.getValue(systemConfig.KEYS.SALES_SYNC_SHOP_IDS);
  const restrictedShopIds = shopIdsConfig ? shopIdsConfig.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const restrictToShops = restrictedShopIds.length > 0;

  console.log(`[salesDailyRecapJob] Récap quotidien démarré sur ${activeServers.length} serveur(s) pour ${periodStart.toISOString().slice(0, 10)} -> ${periodEnd.toISOString().slice(0, 10)}` +
    (restrictToShops ? ` (restreint à ${restrictedShopIds.length} magasin(s))` : '') + '...');

  let totalGapsFound = 0;
  let totalGapsRecovered = 0;

  await Promise.all(activeServers.map(async (server) => {
    let shops;
    try {
      shops = await rpos.getShops(server.posId);
    } catch (err) {
      console.error(`[salesDailyRecapJob] Impossible de lister les magasins de ${server.posId}:`, err.message);
      return;
    }
    if (restrictToShops) shops = shops.filter((shop) => restrictedShopIds.includes(shop.id));

    await mapWithConcurrency(shops, SHOP_CONCURRENCY_PER_SERVER, async (shop) => {
      try {
        const result = await coverageService.runDailyRecap(
          server.posId,
          shop.id,
          periodStart.toISOString(),
          periodEnd.toISOString(),
          { startBackfillFn: startBackfill },
        );
        totalGapsFound += result.gapsFound;
        totalGapsRecovered += result.gapsRecovered;
      } catch (err) {
        console.error(`[salesDailyRecapJob] Échec pour ${shop.reference || shop.id} (${server.posId}):`, err.message);
      }
    });
  }));

  console.log(`[salesDailyRecapJob] Récap quotidien terminé : ${totalGapsFound} écart(s) détecté(s), ${totalGapsRecovered} relance(s) de récupération.`);
}

module.exports = { runSalesDailyRecap };
