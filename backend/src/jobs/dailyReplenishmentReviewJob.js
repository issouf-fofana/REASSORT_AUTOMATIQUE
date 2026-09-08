/**
 * Job planifié : réajustement quotidien continu (CAHIER_DES_CHARGES.md §15-16, étape 3 du plan de
 * montée en autonomie IA).
 *
 * Pour chaque WeeklyReplenishmentPlan actif dont la dernière révision n'est PAS encore validée
 * (Proposal.status = GENERATED), recalcule la proposition avec les ventes/stock observés depuis
 * la dernière révision, et ne crée une nouvelle révision que si le changement de quantité totale
 * dépasse REVISION_CHANGE_THRESHOLD — pas à chaque exécution si rien n'a significativement bougé
 * (§16 : "Si elle change de moins de 10%, pas nécessairement de nouvelle révision").
 *
 * Version simple de cette étape (décision explicite) : ne traite QUE les plans dont la dernière
 * révision est encore GENERATED. Un plan dont la dernière révision est déjà VALIDATED n'est pas
 * touché ici — le calcul du "besoin restant après commande déjà validée" (§14) est une étape
 * séparée, plus complexe (distinction recommendedQuantity / orderedQuantity), qui ne modifie pas
 * encore computeQuantityToOrder à ce stade.
 */
const { PrismaClient } = require('@prisma/client');
const { generateProposal, generateAndSaveProposal } = require('../services/proposalService');
const systemConfig = require('../services/systemConfigService');
const { mapWithConcurrency } = require('../utils/concurrency');

const prisma = new PrismaClient();

// Un plan par magasin par semaine (contrainte @@unique) : traiter plusieurs magasins en parallèle
// reste raisonnable, chacun interrogeant un serveur RPOS potentiellement différent (même principe
// que nightlyProposalJob.js).
const SHOP_CONCURRENCY = 3;

function sumQuantities(proposals) {
  return proposals.reduce((sum, p) => sum + (p.quantityProposed || 0), 0);
}

/**
 * Revoit un plan hebdomadaire donné : recalcule sans sauvegarder (generateProposal, pas
 * generateAndSaveProposal) pour comparer d'abord au total de la dernière révision, et ne persiste
 * une nouvelle révision (generateAndSaveProposal, qui se rattache automatiquement au même plan
 * via attachProposalToWeeklyPlan — étape 1) que si le changement dépasse le seuil configuré.
 */
async function reviewPlan(plan, threshold) {
  const lastRevision = await prisma.proposal.findFirst({
    where: { weeklyPlanId: plan.id },
    orderBy: { generatedAt: 'desc' },
    include: { lines: { select: { quantitySuggested: true } } },
  });
  if (!lastRevision) return { skipped: true, reason: 'no-revision' };

  const previousTotal = lastRevision.lines.reduce((sum, l) => sum + l.quantitySuggested, 0);

  const result = await generateProposal(plan.rposPosId, plan.rposShopId, undefined, plan.rposShopReference);
  const newTotal = sumQuantities(result.proposals);

  const changeRatio = previousTotal > 0 ? Math.abs(newTotal - previousTotal) / previousTotal : (newTotal > 0 ? 1 : 0);
  if (changeRatio < threshold) {
    return { skipped: true, reason: 'below-threshold', previousTotal, newTotal, changeRatio };
  }

  // Le changement dépasse le seuil : persiste `result` (déjà calculé ci-dessus pour la
  // comparaison) au lieu de tout recalculer une seconde fois — chaque calcul complet coûte
  // plusieurs minutes (pagination RPOS sur des milliers de lignes de vente + fiches produit),
  // un second appel identique aurait doublé le temps de ce job pour rien.
  const { proposal } = await generateAndSaveProposal({
    posId: plan.rposPosId,
    shopId: plan.rposShopId,
    shopReference: plan.rposShopReference,
    shopName: plan.rposShopReference, // le nom exact du magasin n'est pas stocké sur le plan ; la référence suffit à l'identifier
  }, result);

  // generateAndSaveProposal rattache la nouvelle Proposal à la semaine cible qu'elle calcule
  // elle-même à partir de sa propre période d'analyse (attachProposalToWeeklyPlan, étape 1) — qui
  // peut diverger du plan `plan` que CE job est en train de revoir (ex: config de période changée
  // entre-temps, magasin en mode CUSTOM avec une plage figée hors de la semaine cible attendue).
  // On force donc explicitement le rattachement au plan revu ici, pour garantir que la continuité
  // de révisions que ce job doit assurer n'est jamais cassée par un calcul de semaine différent.
  if (proposal.weeklyPlanId !== plan.id) {
    await prisma.proposal.update({ where: { id: proposal.id }, data: { weeklyPlanId: plan.id } });
    proposal.weeklyPlanId = plan.id;
  }

  return { skipped: false, previousTotal, newTotal, changeRatio, newProposalId: proposal.id };
}

async function runDailyReplenishmentReview() {
  const threshold = parseFloat(await systemConfig.getValue(systemConfig.KEYS.REVISION_CHANGE_THRESHOLD)) || 0.10;
  const now = new Date();

  // Seuls les plans dont la semaine cible n'est pas encore terminée ET dont la dernière révision
  // n'est pas déjà validée sont candidats au réajustement — cf. limitation assumée en tête de fichier.
  const activePlans = await prisma.weeklyReplenishmentPlan.findMany({
    where: {
      status: 'ACTIVE',
      targetWeekEnd: { gt: now },
      revisions: { some: { status: 'GENERATED' } },
      NOT: { revisions: { some: { status: 'VALIDATED' } } },
    },
  });

  console.log(`[dailyReplenishmentReviewJob] Révision de ${activePlans.length} plan(s) actif(s) (seuil=${threshold * 100}%)...`);

  const results = { reviewed: 0, revised: 0, skipped: 0, failed: 0 };
  await mapWithConcurrency(activePlans, SHOP_CONCURRENCY, async (plan) => {
    try {
      const outcome = await reviewPlan(plan, threshold);
      results.reviewed += 1;
      if (outcome.skipped) {
        results.skipped += 1;
        console.log(`[dailyReplenishmentReviewJob] ${plan.rposShopReference} : pas de nouvelle révision (${outcome.reason}${outcome.changeRatio !== undefined ? `, variation ${(outcome.changeRatio * 100).toFixed(1)}%` : ''})`);
      } else {
        results.revised += 1;
        console.log(`[dailyReplenishmentReviewJob] ${plan.rposShopReference} : nouvelle révision (${outcome.previousTotal} -> ${outcome.newTotal}, +${(outcome.changeRatio * 100).toFixed(1)}%)`);
      }
    } catch (error) {
      results.failed += 1;
      console.error(`[dailyReplenishmentReviewJob] Échec pour ${plan.rposShopReference}:`, error.message);
    }
  });

  console.log(`[dailyReplenishmentReviewJob] Terminé : ${results.revised} révisé(s), ${results.skipped} inchangé(s), ${results.failed} échec(s).`);
  return results;
}

module.exports = { runDailyReplenishmentReview };
