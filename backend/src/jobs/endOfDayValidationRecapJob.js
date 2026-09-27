/**
 * Job planifié : récap de fin de journée pour les ADMIN (demande du 26/09/2026 : "en fin de journée
 * aussi il dois me dire que pour chaque mag qui on validé les commande sur le système") — 16h30 par
 * défaut, juste après la fermeture de la fenêtre entrepôt (13h). Pour CHAQUE magasin ayant une
 * proposition générée AUJOURD'HUI, indique si elle a été validée ou non — jamais envoyé aux
 * magasins eux-mêmes (ils ont déjà reçu leur alerte de nouvelle proposition + éventuelle relance),
 * uniquement un bilan pour la supervision ADMIN.
 */
const prisma = require('../utils/prisma');
const { notifyAdminsOfEndOfDayRecap } = require('../services/proposalNotificationService');

async function runEndOfDayValidationRecap() {
  // "Aujourd'hui" = depuis minuit heure serveur — cohérent avec le fait que generatedAt est posé
  // par generateAndSaveProposal au moment de la génération (nocturne ou manuelle), toujours dans le
  // fuseau du serveur, jamais un fuseau utilisateur qui varierait d'un compte à l'autre.
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const proposalsToday = await prisma.proposal.findMany({
    where: { generatedAt: { gte: startOfToday } },
    select: {
      id: true,
      rposShopId: true,
      status: true,
      generatedAt: true,
      validatedAt: true,
      lines: { select: { id: true, department: true, quantitySuggested: true } },
      orders: { select: { department: true } },
    },
    orderBy: { generatedAt: 'desc' },
  });

  if (!proposalsToday.length) {
    console.log('[endOfDayValidationRecapJob] Aucune proposition générée aujourd\'hui, rien à récapituler.');
    return { validated: 0, pending: 0 };
  }

  // Un seul magasin peut avoir plusieurs propositions le même jour (régénération manuelle) : on ne
  // garde que la plus récente par magasin (déjà trié par generatedAt desc ci-dessus), cohérent avec
  // "la proposition actuelle de ce magasin aujourd'hui", pas un historique complet de la journée.
  const latestByShop = new Map();
  for (const p of proposalsToday) {
    if (!latestByShop.has(p.rposShopId)) latestByShop.set(p.rposShopId, p);
  }

  const shopIds = [...latestByShop.keys()];
  const shops = await prisma.shop.findMany({
    where: { rposShopId: { in: shopIds } },
    select: { rposShopId: true, reference: true, name: true },
  });

  // Bilan PAR RAYON (pas juste Proposal.status) : demande du 27/09/2026 — un rayon validé pouvait
  // faire passer Proposal.status à VALIDATED alors qu'il restait d'autres rayons non traités
  // (même incohérence corrigée côté écran de validation, cf. PurchaseOrder.tsx), ce qui faisait dire
  // à tort à ce récap "tout validé" quand un seul rayon l'était réellement. Un rayon compte comme
  // "en attente" seulement s'il a au moins une ligne à quantité > 0 (même règle que
  // validateProposalDepartment côté proposalService.js).
  const summaries = shops.map((shop) => {
    const proposal = latestByShop.get(shop.rposShopId);
    const pendingDepartments = new Set(
      proposal.lines.filter((l) => (l.quantitySuggested || 0) > 0).map((l) => l.department || 'Sans rayon'),
    );
    const doneDepartments = new Set(proposal.orders.map((o) => o.department));
    const totalDepartments = pendingDepartments.size;
    const validatedDepartments = [...pendingDepartments].filter((d) => doneDepartments.has(d)).length;
    return {
      shop,
      validated: totalDepartments > 0 && validatedDepartments === totalDepartments,
      validatedDepartments,
      totalDepartments,
      articlesCount: proposal.lines.length,
    };
  });

  const validated = summaries.filter((s) => s.validated).length;
  const pending = summaries.length - validated;

  console.log(`[endOfDayValidationRecapJob] ${summaries.length} magasin(s) avec une proposition aujourd'hui : ${validated} validée(s), ${pending} non validée(s).`);

  try {
    await notifyAdminsOfEndOfDayRecap(summaries);
  } catch (err) {
    // Un échec d'envoi ne doit jamais faire échouer le job lui-même — le calcul a déjà réussi et
    // est loggé ci-dessus, seul l'email n'est pas parti.
    console.error('[endOfDayValidationRecapJob] Récap admin échoué:', err.message);
  }

  return { validated, pending };
}

module.exports = { runEndOfDayValidationRecap };
