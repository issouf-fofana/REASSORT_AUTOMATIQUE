/**
 * Rattache chaque Proposal générée à un WeeklyReplenishmentPlan (CAHIER_DES_CHARGES.md §11,
 * étape 1 du plan de montée en autonomie IA). Ne modifie ni ne remplace le calcul existant
 * (proposalService.js) : ajoute uniquement le lien "cette génération couvre quelle semaine",
 * pour que les étapes suivantes (révisions explicites, réajustement quotidien) aient une base
 * sur laquelle s'appuyer sans devoir la reconstruire après coup.
 */
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/**
 * Lundi 00:00:00 (UTC) de la semaine contenant `date`. getUTCDay() renvoie 0 pour dimanche,
 * donc le décalage jusqu'au lundi précédent est de 6 jours ce jour-là, sinon (jour - 1).
 */
function startOfWeekUTC(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay();
  const diffToMonday = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - diffToMonday);
  return d;
}

/**
 * Détermine la semaine cible d'une proposition à partir de la fin de sa période d'analyse.
 * Exemple (CAHIER_DES_CHARGES.md §55) : analyse jusqu'au 7 septembre (dimanche) -> cible le lundi
 * suivant, 8 → 14 septembre. Si la période d'analyse se termine un jour autre que dimanche (ex:
 * génération manuelle en milieu de semaine, mode YESTERDAY/CUSTOM), la cible est la semaine
 * calendaire suivant immédiatement celle de la fin d'analyse, jamais la semaine en cours : on ne
 * veut pas qu'une génération de mercredi vise une semaine déjà entamée depuis lundi.
 */
function computeTargetWeek(analysisPeriodEnd) {
  const currentWeekStart = startOfWeekUTC(analysisPeriodEnd);
  const analysisEndIsBeforeOrAtWeekStart = analysisPeriodEnd.getTime() <= currentWeekStart.getTime();
  const targetWeekStart = analysisEndIsBeforeOrAtWeekStart
    ? currentWeekStart
    : new Date(currentWeekStart.getTime() + WEEK_MS);
  const targetWeekEnd = new Date(targetWeekStart.getTime() + WEEK_MS);
  return { targetWeekStart, targetWeekEnd };
}

/**
 * Récupère (ou crée) le WeeklyReplenishmentPlan de ce magasin pour la semaine cible dérivée de
 * `analysisPeriodEnd`, puis y rattache `proposalId` comme nouvelle révision. Appelé après la
 * création de la Proposal (elle doit déjà exister pour être reliée).
 */
async function attachProposalToWeeklyPlan({ proposalId, rposShopId, rposShopReference, rposPosId, analysisPeriodEnd }) {
  const { targetWeekStart, targetWeekEnd } = computeTargetWeek(analysisPeriodEnd);

  const plan = await prisma.weeklyReplenishmentPlan.upsert({
    where: { rposShopId_targetWeekStart: { rposShopId, targetWeekStart } },
    update: {}, // le plan existe déjà pour cette semaine : on ne fait que le référencer, pas le modifier
    create: {
      rposShopId,
      rposShopReference,
      rposPosId,
      targetWeekStart,
      targetWeekEnd,
      status: 'ACTIVE',
    },
  });

  await prisma.proposal.update({
    where: { id: proposalId },
    data: { weeklyPlanId: plan.id },
  });

  return plan;
}

module.exports = { computeTargetWeek, attachProposalToWeeklyPlan, startOfWeekUTC };
