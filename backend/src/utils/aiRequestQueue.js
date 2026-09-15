/**
 * File d'attente globale pour tous les appels IA (chatbot, suivi de question, analyse d'article,
 * génération de proposition) — demande du 15/09/2026 : "si plusieurs [demandes] viennent, ça ne
 * doit pas créer de conflit". Sans elle, plusieurs utilisateurs/traitements simultanés (chatbot
 * ouvert par deux comptes, génération de proposition en cours pendant qu'un admin pose une question)
 * appelaient tous la même clé API IA en parallèle, sans coordination — risque de saturer le
 * rate-limit du fournisseur (le "429 crédits épuisés" déjà rencontré) plus vite que nécessaire, et
 * aucune garantie d'ordre entre deux requêtes concurrentes sur un même article.
 *
 * Principe : FIFO à concurrence limitée (AI_QUEUE_CONCURRENCY, défaut 3) — chaque appel IA est mis
 * en file, exécuté dès qu'un slot se libère, dans l'ordre d'arrivée. N'affecte jamais les appels
 * RPOS (ventes, stock, commandes) : uniquement les appels vers les fournisseurs IA (Gemini, etc.).
 */
const AI_QUEUE_CONCURRENCY = parseInt(process.env.AI_QUEUE_CONCURRENCY, 10) || 3;

let active = 0;
const waiting = [];

function runNext() {
  if (active >= AI_QUEUE_CONCURRENCY || waiting.length === 0) return;
  const { task, resolve, reject } = waiting.shift();
  active += 1;
  task()
    .then(resolve, reject)
    .finally(() => {
      active -= 1;
      runNext();
    });
}

/**
 * Met `task` (une fonction async) en file et retourne une Promise qui se résout/rejette comme si
 * `task()` avait été appelée directement — seul le MOMENT d'exécution est retardé, jamais son
 * résultat ou ses erreurs transformés.
 */
function enqueueAiRequest(task) {
  return new Promise((resolve, reject) => {
    waiting.push({ task, resolve, reject });
    runNext();
  });
}

/** État courant de la file, pour diagnostic/logs (ex: prévenir l'utilisateur d'une attente longue). */
function getAiQueueStatus() {
  return { active, waitingCount: waiting.length, concurrency: AI_QUEUE_CONCURRENCY };
}

module.exports = { enqueueAiRequest, getAiQueueStatus };
