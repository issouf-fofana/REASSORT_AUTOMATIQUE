/**
 * Script de rattrapage PONCTUEL (23/10/2026) : recalcule hasOrder/reactionStatus/deliveryStatus/
 * orderCreatedAt/actualReceptionDateStatus pour les épisodes déjà RESOLUE AVANT le déploiement du
 * correctif de stockoutEpisodeService.js (commit "Corrige hasOrder/deliveryStatus figés à 'Sans
 * commande' sur les ruptures résolues") — ces épisodes gardent sinon leur ancien statut figé pour
 * toujours, le correctif ne s'appliquant qu'aux FUTURES résolutions.
 *
 * Approche : computeAndPersistOpenEpisodeStatuses(rposShopId) (la même fonction, déjà déboguée à
 * plusieurs reprises, réutilisée telle quelle pour ne risquer AUCUNE divergence de logique) ne
 * traite que les épisodes status='EN_COURS'. On repasse donc temporairement chaque épisode RESOLUE
 * concerné à EN_COURS, on appelle la fonction (qui recalcule et persiste les bons champs), puis on
 * repasse l'épisode à RESOLUE en restaurant son endedAt/qtyPerdueEstimee/caPerdueEstime d'origine
 * (jamais recalculés par ce script — seule la vraie logique de résolution dans
 * stockoutEpisodeService.js sait les calculer correctement, hors de propos ici).
 *
 * Usage : node scripts/backfill-resolved-episode-status.js [--dry-run]
 *   --dry-run : affiche ce qui serait fait, ne modifie rien.
 */
const prisma = require('../src/utils/prisma');
const { computeAndPersistOpenEpisodeStatuses } = require('../src/services/stockoutEpisodeService');

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const resolvedEpisodes = await prisma.stockoutEpisode.findMany({
    where: { status: 'RESOLUE' },
    select: { id: true, rposShopId: true, endedAt: true, qtyPerdueEstimee: true, caPerdueEstime: true },
  });

  console.log(`[backfill] ${resolvedEpisodes.length} épisode(s) RESOLUE trouvé(s) au total.`);
  if (DRY_RUN) console.log('[backfill] --dry-run actif : aucune écriture ne sera faite.');

  const byShop = new Map();
  for (const e of resolvedEpisodes) {
    if (!byShop.has(e.rposShopId)) byShop.set(e.rposShopId, []);
    byShop.get(e.rposShopId).push(e);
  }

  let shopsDone = 0;
  let episodesUpdated = 0;
  for (const [rposShopId, episodes] of byShop) {
    const ids = episodes.map((e) => e.id);
    const originals = new Map(episodes.map((e) => [e.id, e]));

    if (!DRY_RUN) {
      // Repasse temporairement EN_COURS pour que computeAndPersistOpenEpisodeStatuses les traite.
      await prisma.stockoutEpisode.updateMany({ where: { id: { in: ids } }, data: { status: 'EN_COURS' } });
      await computeAndPersistOpenEpisodeStatuses(rposShopId);
      // Restaure RESOLUE + les champs propres à la résolution, inchangés depuis le début.
      await Promise.all(ids.map((id) => {
        const orig = originals.get(id);
        return prisma.stockoutEpisode.update({
          where: { id },
          data: { status: 'RESOLUE', endedAt: orig.endedAt, qtyPerdueEstimee: orig.qtyPerdueEstimee, caPerdueEstime: orig.caPerdueEstime },
        });
      }));
    }

    episodesUpdated += ids.length;
    shopsDone += 1;
    console.log(`[backfill] Magasin ${rposShopId} : ${ids.length} épisode(s) ${DRY_RUN ? 'à traiter' : 'traité(s)'}.`);
  }

  console.log(`[backfill] Terminé : ${shopsDone} magasin(s), ${episodesUpdated} épisode(s) ${DRY_RUN ? 'seraient mis à jour' : 'mis à jour'}.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[backfill] Échec :', err);
  process.exit(1);
});
