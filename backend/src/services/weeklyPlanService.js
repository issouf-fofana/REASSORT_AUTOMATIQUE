/**
 * Rattache chaque Proposal générée à un WeeklyReplenishmentPlan (CAHIER_DES_CHARGES.md §11,
 * étape 1 du plan de montée en autonomie IA). Ne modifie ni ne remplace le calcul existant
 * (proposalService.js) : ajoute uniquement le lien "cette génération couvre quelle semaine",
 * pour que les étapes suivantes (révisions explicites, réajustement quotidien) aient une base
 * sur laquelle s'appuyer sans devoir la reconstruire après coup.
 */
const prisma = require('../utils/prisma');


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

/**
 * Historique complet d'un plan hebdomadaire (CAHIER_DES_CHARGES.md §12-13, étape 2) : la liste
 * de ses révisions (une par génération pour cette semaine cible, dans l'ordre chronologique) et,
 * pour chaque article présent dans au moins une révision, l'évolution de la quantité proposée
 * d'une révision à l'autre — pour répondre à "lundi 100, mardi 120, +20".
 *
 * Ne modifie ni ne consulte le calcul en temps réel : lit uniquement ce qui a déjà été persisté à
 * chaque génération (ProposalLine.quantitySuggested), donc aucun appel RPOS ici.
 */
async function getWeeklyPlanHistory(weeklyPlanId) {
  const plan = await prisma.weeklyReplenishmentPlan.findUnique({
    where: { id: weeklyPlanId },
    include: {
      revisions: {
        orderBy: { generatedAt: 'asc' },
        include: { lines: { select: { ean: true, label: true, quantitySuggested: true } } },
      },
    },
  });
  if (!plan) return null;

  const revisions = plan.revisions.map((rev, index) => ({
    id: rev.id,
    revisionNumber: index + 1,
    generatedAt: rev.generatedAt,
    status: rev.status,
    articleCount: rev.lines.length,
  }));

  // Regroupe par EAN la quantité proposée à chaque révision où l'article apparaît (un article peut
  // être absent d'une révision, ex: sorti du Pareto entre-temps — pas d'entrée pour cette révision
  // plutôt qu'une quantité à 0, pour ne pas laisser croire qu'une baisse à 0 a été calculée).
  // Chaque point porte aussi l'écart vs la révision précédente où l'article apparaissait
  // (changeVsPrevious, null au premier point) : un aller-retour (100 → 200 → 100) a une variation
  // globale de 0 mais a bien bougé entre-temps — sans ce détail, il restait invisible en bas du tri.
  const byEan = new Map();
  plan.revisions.forEach((rev, index) => {
    for (const line of rev.lines) {
      if (!byEan.has(line.ean)) byEan.set(line.ean, { ean: line.ean, label: line.label, history: [] });
      const entry = byEan.get(line.ean);
      const previous = entry.history.length ? entry.history[entry.history.length - 1].quantitySuggested : null;
      entry.history.push({
        revisionNumber: index + 1,
        proposalId: rev.id,
        quantitySuggested: line.quantitySuggested,
        changeVsPrevious: previous === null ? null : line.quantitySuggested - previous,
      });
    }
  });

  const articles = Array.from(byEan.values()).map((art) => {
    const first = art.history[0];
    const last = art.history[art.history.length - 1];
    const maxStepVariation = art.history.reduce(
      (max, h) => (h.changeVsPrevious === null ? max : Math.max(max, Math.abs(h.changeVsPrevious))),
      0
    );
    return {
      ean: art.ean,
      label: art.label,
      history: art.history,
      variation: art.history.length > 1 ? last.quantitySuggested - first.quantitySuggested : 0,
      maxStepVariation,
    };
  });
  // Les articles dont la quantité a le plus bougé intéressent en premier (c'est ce qu'un responsable
  // veut voir : "qu'est-ce qui a changé ?") — en retenant le plus fort entre l'écart global
  // (première → dernière révision) et le plus gros saut d'une révision à l'autre, pour que les
  // allers-retours (fort mouvement puis retour au point de départ) remontent aussi.
  articles.sort((a, b) => Math.max(Math.abs(b.variation), b.maxStepVariation) - Math.max(Math.abs(a.variation), a.maxStepVariation));

  return {
    id: plan.id,
    rposShopId: plan.rposShopId,
    rposShopReference: plan.rposShopReference,
    targetWeekStart: plan.targetWeekStart,
    targetWeekEnd: plan.targetWeekEnd,
    status: plan.status,
    revisions,
    articles,
  };
}

/**
 * Plan d'un magasin dont la semaine cible contient `date` (par défaut aujourd'hui) : le lundi de
 * cette semaine calendaire EST targetWeekStart, donc directement startOfWeekUTC(date) — pas
 * besoin de computeTargetWeek ici, qui répond à une question différente ("quelle est la semaine
 * SUIVANT la fin d'une période d'analyse", utile seulement au moment de générer une proposition).
 */
async function findWeeklyPlanForDate(rposShopId, date = new Date()) {
  const targetWeekStart = startOfWeekUTC(date);
  return prisma.weeklyReplenishmentPlan.findUnique({
    where: { rposShopId_targetWeekStart: { rposShopId, targetWeekStart } },
  });
}

module.exports = {
  computeTargetWeek,
  attachProposalToWeeklyPlan,
  startOfWeekUTC,
  getWeeklyPlanHistory,
  findWeeklyPlanForDate,
};
