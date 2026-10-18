/**
 * Job planifié : résout sector/department pour tous les épisodes EN_COURS encore à null —
 * automatise ce que le script ponctuel scripts/backfillStockoutEpisodeSector.js ne faisait qu'à la
 * demande (jamais exécuté en prod, bug resté visible : "il n'affiche plus ceux qui son avec les
 * commande" / 381 épisodes sur 396 encore "Sans secteur" malgré le correctif RPOS déjà déployé).
 * Demande explicite du 18/10/2026 : "fais en sorte quil s'applique a tout ancien comme nouveau les
 * incohereance la" — un épisode FUTUR est déjà résolu correctement à sa création
 * (detectStockoutEpisodes → diagnoseCause avec repli RPOS), ce job couvre les épisodes déjà
 * ouverts AVANT ce correctif, et reste un filet de sécurité continu plutôt qu'une action
 * ponctuelle à relancer manuellement à chaque nouveau cas.
 *
 * diagnoseCause() fait un vrai appel RPOS par article concerné (jamais en masse) — volontairement
 * peu fréquent (toutes les 6h, aligné sur la capture de stock) pour rester léger : le nombre
 * d'épisodes encore non résolus décroît à chaque passage, jamais un gros lot répété inutilement.
 */
const prisma = require('../utils/prisma');
const { diagnoseCause } = require('../services/stockoutEpisodeService');

async function runStockoutSectorBackfillJob() {
  console.log('[stockoutSectorBackfillJob] Résolution démarrée...');

  const episodes = await prisma.stockoutEpisode.findMany({
    where: { status: 'EN_COURS', sector: null },
    select: { id: true, rposShopId: true, ean: true, rposPosId: true },
  });

  console.log(`[stockoutSectorBackfillJob] ${episodes.length} épisode(s) EN_COURS avec sector=null à résoudre...`);

  let resolved = 0;
  let stillNull = 0;
  for (const ep of episodes) {
    const diagnosis = await diagnoseCause(ep.rposShopId, ep.ean, ep.rposPosId);
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
    if (diagnosis.sector) resolved += 1;
    else stillNull += 1;
  }

  console.log(`[stockoutSectorBackfillJob] Terminé : ${resolved} résolu(s), ${stillNull} resté(s) sans secteur (article jamais vu ni par une proposition ni par RPOS — rare).`);
}

module.exports = { runStockoutSectorBackfillJob };
