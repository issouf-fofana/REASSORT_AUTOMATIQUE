/**
 * Script de rattrapage ponctuel (18/10/2026) : corrige les commandes déjà marquées à tort
 * receptionStatus='RECUE_ESTIMEE' par receptionSyncJob.js AVANT le correctif de
 * computeExpectedReceptionDate — une commande validée un samedi (ou après 14h un jour ouvrable)
 * passait "reçue (estimée)" dès le lendemain calendaire (ex: le dimanche), un jour où l'entrepôt ne
 * travaille jamais, au lieu d'attendre la VRAIE date de livraison (lundi/mardi selon le magasin).
 * Bug signalé avec capture : "il dis recu or ya pas d'arrivage c'est demain il von etre livré... la
 * relge si une commande et fait le samedi, il va ertre livré lundi ou mardi".
 *
 * Une fois une commande passée à RECUE_ESTIMEE/ANNULEE, receptionSyncJob.js ne la revoit plus
 * jamais (TERMINAL_STATUSES) — corriger seulement le calcul pour les FUTURES commandes ne répare
 * donc pas celles déjà mal marquées. Ce script :
 *   1. Recalcule la vraie expectedReceptionDate (computeExpectedReceptionDate) pour les commandes
 *      RECUE_ESTIMEE liées à un épisode de rupture encore EN_COURS.
 *   2. Si la vraie date n'est pas encore atteinte (le passage à "reçue" était donc prématuré),
 *      repasse la commande à EN_ATTENTE_RECEPTION et corrige expectedReceptionDate/
 *      actualReceptionDate — receptionSyncJob.js la reverra alors au prochain passage, au bon
 *      moment cette fois.
 *   3. Si la vraie date est déjà dépassée, laisse le statut RECUE_ESTIMEE tel quel (il était
 *      prématuré mais la conclusion reste correcte aujourd'hui) — corrige juste
 *      expectedReceptionDate pour que l'affichage soit cohérent avec la vraie règle.
 *
 * Usage : node scripts/fixWeekendReceptionDates.js
 */
const prisma = require('../src/utils/prisma');
const { computeExpectedReceptionDate } = require('../src/services/stockoutEpisodeService');

async function main() {
  // Commandes RECUE_ESTIMEE liées à un épisode encore EN_COURS — celles liées à un épisode déjà
  // RESOLUE n'ont plus d'impact pratique (la rupture est terminée, peu importe la date exacte).
  const openEpisodes = await prisma.stockoutEpisode.findMany({
    where: { status: 'EN_COURS' },
    select: { rposShopId: true, ean: true },
  });
  const shopIds = [...new Set(openEpisodes.map((e) => e.rposShopId))];
  const eansByShop = new Map();
  for (const e of openEpisodes) {
    if (!eansByShop.has(e.rposShopId)) eansByShop.set(e.rposShopId, new Set());
    eansByShop.get(e.rposShopId).add(e.ean);
  }

  const reassortConfigs = await prisma.reassortConfig.findMany({
    where: { rposShopId: { in: shopIds } },
    select: { rposShopId: true, weekendDeliveryDay: true },
  });
  const weekendDayByShop = new Map(reassortConfigs.map((c) => [c.rposShopId, c.weekendDeliveryDay || 'LUNDI']));

  const candidateOrders = await prisma.proposalOrder.findMany({
    where: { receptionStatus: 'RECUE_ESTIMEE' },
    select: { id: true, createdAt: true, actualReceptionDate: true, proposal: { select: { rposShopId: true } } },
  });

  console.log(`[fix-weekend] ${candidateOrders.length} commande(s) RECUE_ESTIMEE à vérifier...`);

  let revertedToWaiting = 0;
  let dateCorrectedOnly = 0;
  let skipped = 0;
  const now = new Date();

  for (const order of candidateOrders) {
    const rposShopId = order.proposal.rposShopId;
    const eans = eansByShop.get(rposShopId);
    if (!eans) { skipped += 1; continue; } // aucun épisode EN_COURS pour ce magasin, pas concerné

    const weekendDeliveryDay = weekendDayByShop.get(rposShopId) || 'LUNDI';
    const realExpected = computeExpectedReceptionDate(order.createdAt, weekendDeliveryDay);

    if (realExpected > now) {
      // La vraie date n'est pas encore atteinte : le passage à "reçue" était prématuré, on revient
      // en arrière pour que receptionSyncJob.js la revoit au bon moment.
      await prisma.proposalOrder.update({
        where: { id: order.id },
        data: { receptionStatus: 'EN_ATTENTE_RECEPTION', expectedReceptionDate: realExpected, actualReceptionDate: null },
      });
      revertedToWaiting += 1;
    } else {
      // La vraie date est déjà dépassée : conclusion correcte, juste l'affichage à aligner.
      await prisma.proposalOrder.update({
        where: { id: order.id },
        data: { expectedReceptionDate: realExpected },
      });
      dateCorrectedOnly += 1;
    }
  }

  console.log(`[fix-weekend] Terminé : ${revertedToWaiting} commande(s) repassée(s) en attente (date prématurée corrigée), ${dateCorrectedOnly} date(s) alignée(s) sans changement de statut, ${skipped} ignorée(s) (pas de rupture en cours liée).`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('[fix-weekend] Échec :', err);
  process.exit(1);
});
