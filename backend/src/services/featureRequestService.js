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
const outlookMailService = require('./outlookMailService');
const { renderMailTemplate } = require('./mailTemplateService');

// Toutes les infos utiles sur un contributeur, déjà présentes sur le compte (demande du 26/09/2026 :
// "il faut récupérer toutes les informations disponibles sur l'utilisateur : nom, magasin, rôle,
// e-mail") — jamais dupliquées sur FeatureRequestNote elle-même : le compte reste la source de
// vérité, une simple relation suffit (cf. FeatureRequestNote.userId dans le schéma).
const USER_SELECT = {
  name: true,
  email: true,
  role: true,
  rposShopReference: true,
  rposShopName: true,
  assignedDepartment: true,
};

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
    include: { notes: { orderBy: { createdAt: 'asc' }, include: { user: { select: USER_SELECT } } } },
    orderBy: { updatedAt: 'desc' },
  });
}

async function getFeatureRequest(id) {
  return prisma.featureRequest.findUnique({
    where: { id },
    include: { notes: { orderBy: { createdAt: 'asc' }, include: { user: { select: USER_SELECT } } } },
  });
}

/** Un e-mail par contributeur DISTINCT (jamais deux fois au même compte, même s'il a laissé
 * plusieurs notes) — même principe que sendMailToEachRecipient (proposalNotificationService.js) :
 * chaque envoi est individuel pour permettre une salutation personnalisée, et un échec sur UN
 * destinataire ne doit jamais empêcher les autres de recevoir le leur. */
async function notifyContributorsOfResolution(request) {
  const byEmail = new Map();
  for (const note of request.notes) {
    if (note.user?.email) byEmail.set(note.user.email, note.user);
  }
  for (const user of byEmail.values()) {
    try {
      const htmlBody = renderMailTemplate(
        'Votre demande a été traitée',
        `
          <p>Bonjour ${user.name},</p>
          <p>Bonne nouvelle : votre demande d'évolution <strong>« ${request.title} »</strong> a été traitée.</p>
          <p>Vous pouvez dès à présent poser vos questions normalement à l'Assistant IA — cette fonctionnalité est maintenant disponible.</p>
        `,
        { severity: 'info' },
      );
      await outlookMailService.sendMail({
        to: user.email,
        subject: `Réassort Automatique — votre demande "${request.title}" a été traitée`,
        htmlBody,
      });
    } catch (err) {
      console.error(`[featureRequestService] Notification de résolution échouée pour ${user.email}:`, err.message);
    }
  }
}

const VALID_STATUSES = ['new', 'needs_information', 'pending', 'in_progress', 'resolved', 'closed'];

/**
 * Changement de statut manuel par un développeur/ADMIN (§8 de la spec). Quand le nouveau statut est
 * "resolved" (demande du 26/09/2026 : "alerter l'utilisateur par e-mail pour lui indiquer que sa
 * demande a bien été prise en compte et qu'il peut désormais poser ses questions"), un e-mail est
 * envoyé à chaque contributeur distinct de la demande — jamais sur les autres statuts (in_progress,
 * closed...), qui ne représentent pas une résolution effective pour l'utilisateur. Un échec d'envoi
 * ne doit jamais empêcher le changement de statut lui-même de réussir (l'email est un effet de bord,
 * pas la donnée d'autorité).
 */
async function updateFeatureRequestStatus(id, status) {
  if (!VALID_STATUSES.includes(status)) throw new Error(`Statut invalide : ${status}`);
  const previous = await prisma.featureRequest.findUnique({ where: { id } });
  if (!previous) throw new Error('Demande introuvable.');

  const updated = await prisma.featureRequest.update({ where: { id }, data: { status } });

  if (status === 'resolved' && previous.status !== 'resolved') {
    const full = await getFeatureRequest(id);
    await notifyContributorsOfResolution(full).catch((err) => {
      console.error(`[featureRequestService] Notification de résolution échouée pour la demande ${id}:`, err.message);
    });
  }

  return updated;
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
