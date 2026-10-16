/**
 * Script de rattrapage ponctuel (16/10/2026) : recalcule sector/department/causeProposee/
 * niveauConfiance pour les épisodes EN_COURS créés AVANT l'ajout du champ sector à
 * StockoutEpisode — diagnoseCause() ne tourne qu'à la création d'un épisode (dans
 * detectStockoutEpisodes), jamais en relecture, donc les épisodes déjà ouverts au moment du
 * déploiement restaient bloqués à sector=null pour toujours (bug signalé : 414/414 articles
 * "Sans secteur" sur un magasin où des propositions existent pourtant bien).
 *
 * Usage : node scripts/backfillStockoutEpisodeSector.js
 * Ne touche jamais les épisodes déjà RESOLUE (leur diagnostic reste un instantané historique,
 * cohérent avec le principe que causeProposee n'est normalement jamais réévalué après coup).
 */
const prisma = require('../src/utils/prisma');
const { diagnoseCause } = require('../src/services/stockoutEpisodeService');

async function main() {
  const episodes = await prisma.stockoutEpisode.findMany({
    where: { status: 'EN_COURS', sector: null },
    select: { id: true, rposShopId: true, ean: true },
  });

  console.log(`[backfill] ${episodes.length} épisode(s) EN_COURS avec sector=null à corriger...`);

  let updated = 0;
  let stillNull = 0;
  for (const ep of episodes) {
    const diagnosis = await diagnoseCause(ep.rposShopId, ep.ean);
    await prisma.stockoutEpisode.update({
      where: { id: ep.id },
      data: {
        sector: diagnosis.sector || null,
        department: diagnosis.department || null,
        label: diagnosis.label || undefined,
        causeProposee: diagnosis.cause,
        niveauConfiance: diagnosis.confiance,
        commandeRefUtile: diagnosis.commandeRef || null,
      },
    });
    if (diagnosis.sector) updated += 1;
    else stillNull += 1;
  }

  console.log(`[backfill] Terminé : ${updated} épisode(s) corrigé(s) avec un secteur trouvé, ${stillNull} resté(s) sans secteur (article jamais proposé — comportement normal).`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('[backfill] Échec :', err);
  process.exit(1);
});
