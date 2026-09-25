/**
 * Demandes d'évolution produit remontées par l'Assistant IA (demande du 25/09/2026, spec
 * "Comportement général de l'IA" fournie par l'utilisateur) : quand l'assistant ne sait pas
 * répondre à une question parce que la fonctionnalité n'existe pas encore, et que le besoin en vaut
 * la peine, il enregistre ici un besoin structuré — après avoir vérifié qu'une demande similaire
 * n'existe pas déjà (auquel cas il l'enrichit au lieu de dupliquer, cf. enrichFeatureRequest).
 *
 * Principe de transparence (règle §9 de la spec) : ce service ne fait QUE ce que son nom dit —
 * createFeatureRequest crée réellement une ligne en base, enrichFeatureRequest en ajoute réellement
 * une note. C'est à l'appelant (chatbotService.js) de ne jamais dire à l'utilisateur "j'ai enregistré
 * votre demande" sans avoir réellement appelé l'une de ces deux fonctions et attendu son résultat.
 */
const prisma = require('../utils/prisma');
const { callWithFallback } = require('./aiForecastService');

const OPEN_STATUSES = ['new', 'needs_information', 'pending', 'in_progress'];

/**
 * Recherche sémantique via LLM (demande explicite du 25/09/2026 : une recherche par mots-clés rate
 * trop de reformulations du même besoin) : donne au LLM la liste des demandes encore ouvertes
 * (titre + résumé du problème) et le nouveau besoin, lui demande de choisir la plus proche ou aucune.
 * Ne fait JAMAIS planter l'appelant : une erreur (LLM indisponible, réponse mal formée) retombe sur
 * "aucune correspondance trouvée", ce qui a pour seul effet de créer une nouvelle demande plutôt que
 * d'en enrichir une existante — jamais bloquant, jamais une donnée inventée.
 */
async function findSimilarRequest(newRequestSummary) {
  const openRequests = await prisma.featureRequest.findMany({
    where: { status: { in: OPEN_STATUSES } },
    select: { id: true, title: true, problem: true },
    orderBy: { createdAt: 'desc' },
    take: 100, // borne raisonnable : au-delà, un prompt trop long dégraderait la pertinence du LLM
  });
  if (!openRequests.length) return null;

  const catalog = openRequests
    .map((r, i) => `${i + 1}. [id=${r.id}] "${r.title}" — ${r.problem.slice(0, 300)}`)
    .join('\n');

  const prompt = `Voici une liste de demandes d'évolution déjà enregistrées pour une application de gestion de stock/réassort :
${catalog}

Nouveau besoin signalé par un utilisateur : "${newRequestSummary}"

Ce nouveau besoin correspond-il RÉELLEMENT au même besoin fonctionnel qu'une des demandes ci-dessus (pas juste un sujet vaguement proche) ? Réponds UNIQUEMENT avec un tableau JSON contenant UN SEUL objet, sans aucun texte avant ni après, au format exact :
[{"matchId": "<id exact de la demande correspondante, ou null si aucune ne correspond réellement>"}]`;

  // callWithFallback (aiForecastService.js) applique TOUJOURS parseJsonArrayFromText côté chaque
  // fournisseur (callGemini/callOpenAi/callAnthropic) : la réponse attendue est donc systématiquement
  // un TABLEAU JSON, jamais un objet nu — même contrainte que detectIntentViaLlm (chatbotService.js).
  try {
    const { result } = await callWithFallback(prompt, 'feature-request-similarity');
    const parsed = Array.isArray(result) ? result[0] : null;
    if (!parsed || !parsed.matchId) return null;
    return openRequests.find((r) => r.id === parsed.matchId) || null;
  } catch (err) {
    console.error('[featureRequestService] Recherche de demande similaire indisponible:', err.message);
    return null;
  }
}

/**
 * Crée une nouvelle demande, avec sa première note (le besoin tel que compris depuis la
 * conversation). `user` peut être absent (voir FeatureRequestNote.userId, nullable) mais ne devrait
 * jamais l'être en usage normal — l'assistant est toujours authentifié.
 */
async function createFeatureRequest({ title, problem, expectedBehavior, context, user }) {
  return prisma.featureRequest.create({
    data: {
      title,
      problem,
      expectedBehavior: expectedBehavior || null,
      context: context || null,
      status: 'new',
      notes: {
        create: [{ userId: user?.id || null, content: problem }],
      },
    },
    include: { notes: true },
  });
}

/** Ajoute une note (nouvel utilisateur signalant le même besoin, ou précision complémentaire) à une
 * demande existante — ne crée jamais de doublon, c'est tout l'intérêt par rapport à createFeatureRequest. */
async function enrichFeatureRequest(requestId, { content, user }) {
  const request = await prisma.featureRequest.findUnique({ where: { id: requestId } });
  if (!request) throw new Error('Demande introuvable.');

  await prisma.featureRequestNote.create({
    data: { requestId, userId: user?.id || null, content },
  });
  return prisma.featureRequest.update({
    where: { id: requestId },
    data: { updatedAt: new Date() },
    include: { notes: { orderBy: { createdAt: 'asc' } } },
  });
}

async function listFeatureRequests({ status } = {}) {
  return prisma.featureRequest.findMany({
    where: status ? { status } : undefined,
    include: { notes: { orderBy: { createdAt: 'asc' }, include: { user: { select: { name: true, email: true } } } } },
    orderBy: { updatedAt: 'desc' },
  });
}

async function getFeatureRequest(id) {
  return prisma.featureRequest.findUnique({
    where: { id },
    include: { notes: { orderBy: { createdAt: 'asc' }, include: { user: { select: { name: true, email: true } } } } },
  });
}

const VALID_STATUSES = ['new', 'needs_information', 'pending', 'in_progress', 'resolved', 'closed'];

async function updateFeatureRequestStatus(id, status) {
  if (!VALID_STATUSES.includes(status)) throw new Error(`Statut invalide : ${status}`);
  return prisma.featureRequest.update({ where: { id }, data: { status } });
}

module.exports = {
  findSimilarRequest,
  createFeatureRequest,
  enrichFeatureRequest,
  listFeatureRequests,
  getFeatureRequest,
  updateFeatureRequestStatus,
  VALID_STATUSES,
};
