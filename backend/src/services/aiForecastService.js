/**
 * Prévision de quantité à commander par IA (LLM), en remplacement ponctuel ("à la demande") du
 * calcul classique (computeQuantityToOrder) pour une proposition donnée : envoie un résumé
 * statistique de chaque article (pas l'historique brut, pour rester léger en tokens/coût) au LLM
 * configuré, et récupère une quantité suggérée + une courte justification.
 *
 * Multi-fournisseur avec bascule automatique (AiProviderKey, triées par priorité) : si la clé de
 * plus haute priorité échoue (quota épuisé, erreur d'authentification, timeout), on retente avec
 * la suivante, sans intervention de l'utilisateur.
 */
const prisma = require('../utils/prisma');
const crypto = require('./cryptoService');
const systemConfig = require('./systemConfigService');
const { mapWithConcurrency } = require('../utils/concurrency');
const { enqueueAiRequest } = require('../utils/aiRequestQueue');
const shopActivityService = require('./shopActivityService');


// Un seul prompt géant avec tous les articles Pareto d'un magasin (jusqu'à 1000+) risquait de
// dépasser les limites de tokens du modèle ou de prendre plusieurs dizaines de secondes en un seul
// appel bloquant (audit performance). Découpage en lots envoyés en parallèle contrôlé : plus rapide
// au total, et un lot en échec n'invalide pas les autres (chacun retente le fallback multi-clés
// indépendamment).
const ARTICLES_PER_BATCH = 40;
const BATCH_CONCURRENCY = 3;

const DEFAULT_MODEL_BY_PROVIDER = {
  gemini: 'gemini-3.6-flash',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-haiku-latest',
};

/**
 * Construit le résumé statistique envoyé au LLM pour un article : les mêmes indicateurs déjà
 * calculés par le réassort classique (vente moy./sem., tendance, saisonnalité, stock, commandes en
 * cours), pour que le LLM raisonne sur des données déjà normalisées plutôt que du texte brut.
 */
// buildArticleSummary accepte deux formes d'entrée selon l'appelant :
// - une ProposalLine Prisma déjà persistée (dailyHistory en JSON string, stock dans
//   stockAtGeneration, quantité dans quantitySuggested) — cas de runAiForecast/analyzeArticleRealtime ;
// - un objet "proposal" interne pas encore persisté, tel que produit par generateProposal
//   (dailyHistory déjà un tableau, stock dans `stock`, quantité dans quantityProposed, et
//   confidenceScore déjà calculé si generateAndSaveProposal l'a fait avant l'appel IA) — cas de
//   l'intégration IA à la génération elle-même. Éviter de forcer l'appelant à reformater ses
//   données juste pour cet appel, qui n'a pas besoin de cette distinction.
//
// shopConfig (optionnel) : safetyStockRatio et receptionLeadTimeDays, communs à tous les articles
// du même magasin (pas des champs par ligne) — expliquent à l'IA comment systemSuggestedQuantity a
// été construit (marge de sécurité visée, délai de réapprovisionnement pris en compte), plutôt que
// de lui laisser deviner la logique derrière ce chiffre.
function buildArticleSummary(line, shopConfig, shopActivity) {
  let dailyHistory = [];
  if (Array.isArray(line.dailyHistory)) {
    dailyHistory = line.dailyHistory;
  } else if (typeof line.dailyHistory === 'string' && line.dailyHistory) {
    try {
      dailyHistory = JSON.parse(line.dailyHistory);
    } catch {
      dailyHistory = [];
    }
  }

  const classicQuantity = line.quantitySuggested ?? line.quantityProposed ?? 0;
  const currentStock = line.stockAtGeneration ?? line.stock ?? 0;

  // Commande RPOS récente (≤7j, hors plateforme) qui a fait tomber le calcul classique à 0 par
  // construction (cf. excludedAsAlreadyOrderedRpos dans proposalService.js) : jusqu'ici l'IA ne
  // voyait ni cette commande ni ses détails, seulement un substitut recalculé (quantityIfUnblocked)
  // à sa place — elle ne pouvait donc jamais elle-même juger si cette commande suffit. On transmet
  // maintenant les données brutes de la commande, et systemSuggestedQuantity reste le VRAI calcul
  // classique (potentiellement 0), sans substitution — c'est à l'IA de décider si une commande
  // supplémentaire est nécessaire ou si les 0 du système sont justifiés, jamais un blocage imposé
  // avant qu'elle ait pu analyser quoi que ce soit.
  const hasRecentOrder = !!line.excludedAsAlreadyOrderedRpos;

  return {
    ean: line.ean,
    label: line.label,
    // Résultat du calcul classique (computeQuantityToOrder), fourni comme point de départ à l'IA
    // plutôt que de lui laisser calculer une quantité indépendante à partir de zéro — évite des
    // écarts arbitraires entre deux méthodes qui n'ont jamais eu connaissance l'une de l'autre
    // (ex: 53 vs 73 sur le même article), et rend la réponse de l'IA directement actionnable comme
    // un ajustement justifié plutôt qu'un deuxième avis concurrent à départager soi-même. Jamais
    // substitué : si le calcul dit 0 à cause d'une commande récente, l'IA voit ce 0 ET les détails
    // de la commande ci-dessous pour juger elle-même si ce 0 est justifié.
    systemSuggestedQuantity: classicQuantity,
    avgWeeklySales: Number(line.avgWeeklySales?.toFixed(2) ?? 0),
    currentStock,
    orderingUnit: line.orderingUnit,
    daysUntilStockout: line.daysUntilStockout !== null && line.daysUntilStockout !== undefined
      ? Number(line.daysUntilStockout.toFixed(1))
      : null,
    currentOrderedQuantity: line.currentOrderedQuantity || 0,
    // Détail de la commande RPOS récente bloquante, si elle existe (hasRecentOrder=false sinon,
    // tous les champs suivants alors à null) : à ne jamais confondre avec currentOrderedQuantity
    // ci-dessus, qui peut inclure d'autres commandes en cours indépendantes de celle-ci.
    hasRecentOrder,
    recentOrderReference: hasRecentOrder ? (line.rposOrderReference || null) : null,
    recentOrderDate: hasRecentOrder ? (line.rposOrderDate || null) : null,
    recentOrderCount: hasRecentOrder ? (line.rposOrderCount || null) : null,
    // Quantité que le calcul classique aurait proposée en ignorant cette commande récente (le
    // besoin "brut", sans déduire cette commande) : donne à l'IA un ordre de grandeur du besoin
    // total, à comparer elle-même à ce que la commande récente couvre déjà.
    quantityIfIgnoringRecentOrder: hasRecentOrder ? (line.quantityIfUnblocked ?? null) : null,
    revenueSharePct: line.revenueSharePct !== null && line.revenueSharePct !== undefined
      ? Number(line.revenueSharePct.toFixed(2))
      : null,
    seasonalityAdjusted: !!line.seasonalityAdjusted,
    // Écart de vente vs la même période l'an dernier (%, positif = tendance à la hausse) : déjà
    // calculé par le système mais jusqu'ici jamais transmis à l'IA, qui ne pouvait donc pas
    // distinguer une hausse récente structurelle (saisonnalité confirmée) d'un simple bruit
    // statistique sur les dernières semaines de dailyHistory.
    seasonalityDeviationPct: line.seasonalityDeviationPct ?? null,
    forecastMethod: line.forecastMethod || 'flat',
    hadNegativeStock: !!line.hadNegativeStock,
    // Score de confiance du système dans SA PROPRE prévision de base (§20, 0-100) : transmis quand
    // déjà calculé (generateAndSaveProposal le calcule avant l'appel IA), pour que l'IA sache si le
    // point de départ qu'on lui donne est déjà jugé peu fiable en interne — un ajustement mérite
    // d'autant plus d'être envisagé que ce score est bas.
    systemConfidenceScore: line.confidenceScore ?? null,
    // Marge de sécurité visée (ratio appliqué à la vente moyenne) et délai de réapprovisionnement
    // pris en compte dans le calcul classique — communs à tout le magasin, pas par article.
    safetyStockRatio: shopConfig?.safetyStockRatio ?? null,
    receptionLeadTimeDays: shopConfig?.receptionLeadTimeDays ?? null,
    dailyHistory,
    // Statut d'activité du MAGASIN (pas de l'article) — shopActivityService.js : permet à l'IA de
    // distinguer un article peu/pas vendu dans un magasin actif ("absence de vente ≠ magasin actif
    // avec demande nulle" n'exclut pas que la demande soit réellement nulle) d'un magasin qui ne
    // fonctionne plus, où le même historique ne doit jamais être extrapolé en besoin de réassort.
    // null si non calculé (échec réseau ponctuel) : l'IA analyse alors sans cette information plutôt
    // que de se voir imposer une valeur par défaut arbitraire.
    shopActivityStatus: shopActivity?.status ?? null,
    shopMonthsSinceLastActivity: shopActivity?.monthsSinceLastActivity ?? null,
    shopHadActivityBeyondSampleWindow: shopActivity?.hadActivityBeyondSampleWindow ?? null,
    // Anomalies détectées par anomalyService.js (§30, étape 7) : explosion/chute de ventes, stock
    // incohérent (stock disponible mais 0 vente récente malgré une demande habituelle). Présentes
    // ici pour que l'IA privilégie la prudence (VERIFY_STOCK plutôt qu'une commande à l'aveugle,
    // §69) quand un signal anormal existe, au lieu d'extrapoler un historique déjà jugé suspect.
    anomalies: Array.isArray(line.anomalies) ? line.anomalies : (line.anomalies ? JSON.parse(line.anomalies) : []),
    // Tendance générale de l'article sur toute la période analysée (§31) — distincte de
    // seasonalityDeviationPct (comparaison à l'an dernier) : ici, comparaison à l'intérieur de la
    // période courante elle-même.
    trendCategory: line.trendCategory || null,
    trendChangePct: line.trendChangePct ?? null,
  };
}

/**
 * Construit le prompt à partir du template configurable (Paramètres > IA, SystemConfig), pour
 * permettre à un admin d'ajuster les consignes données au LLM sans redéploiement. Remplace les
 * placeholders {{shopReference}}, {{shopName}}, {{articles}} par les valeurs réelles.
 */
async function buildPrompt(shopReference, shopName, articles) {
  const template = await systemConfig.getValue(systemConfig.KEYS.AI_ANALYSIS_PROMPT_TEMPLATE);
  return template
    .replace(/\{\{shopReference\}\}/g, shopReference || '')
    .replace(/\{\{shopName\}\}/g, shopName || '')
    .replace(/\{\{articles\}\}/g, JSON.stringify(articles, null, 2));
}

// Variante du prompt pour l'analyse en direct d'UN SEUL article (panneau "Analyser", clic
// utilisateur) : réutilise les mêmes étapes d'analyse (0 à 5) que le prompt batch — chargées depuis
// le même template configurable, jamais dupliquées en dur ici — mais remplace la consigne finale
// (qui demande un tableau JSON, pensé pour traiter plusieurs articles d'un coup) par un format texte
// simple. Un JSON en cours de construction ne peut pas s'afficher progressivement de façon lisible
// (accolades et guillemets incomplets à l'écran) ; un format "QUANTITE: n" suivi du texte en clair
// permet au frontend d'extraire la quantité dès la première ligne puis de streamer le texte
// d'explication mot à mot, comme une conversation avec un assistant.
async function buildStreamingPrompt(shopReference, shopName, article) {
  const template = await systemConfig.getValue(systemConfig.KEYS.AI_ANALYSIS_PROMPT_TEMPLATE);
  const cutMarker = template.indexOf('Articles (JSON)');
  const analysisSteps = cutMarker !== -1 ? template.slice(0, cutMarker) : template;

  return analysisSteps
    .replace(/\{\{shopReference\}\}/g, shopReference || '')
    .replace(/\{\{shopName\}\}/g, shopName || '')
    + `Article à analyser (JSON) :\n${JSON.stringify(article, null, 2)}\n\n` +
    'Réponds au format texte EXACT suivant, sans rien ajouter avant ni après :\n' +
    'QUANTITE: <entier positif ou nul, multiple de orderingUnit>\n' +
    '<explication en français, MAXIMUM 3 phrases COURTES ou 3 puces (jamais les deux à la fois, jamais plus) — en Markdown LÉGER : gras (**mot**) pour les chiffres ou termes clés, puces ("- ") uniquement si tu listes plusieurs raisons ou facteurs distincts (sinon un paragraphe simple suffit, ne force jamais une liste sur une explication à une seule idée). Va droit à la décision et sa justification la plus importante (tendance ou statut du magasin si pertinent, comparaison à systemSuggestedQuantity si l\'écart est notable, commande récente si hasRecentOrder=true) — pas d\'introduction, pas de récapitulatif final, pas de détail secondaire>';
}

function parseJsonArrayFromText(text) {
  // Les LLM enveloppent parfois la réponse dans un bloc ```json ... ``` malgré la consigne : on
  // extrait le premier tableau JSON trouvé plutôt que d'exiger un JSON.parse strict sur tout le texte.
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('Réponse IA sans tableau JSON reconnaissable');
  return JSON.parse(match[0]);
}

// Sans ce timeout, un appel LLM sans réseau disponible (hors réseau Prosuma/internet) pouvait
// rester bloqué indéfiniment côté navigateur — `fetch` n'échoue pas toujours rapidement sur une
// simple absence de connectivité (dépend du système), et le panneau "L'IA analyse cet article"
// restait figé sans jamais afficher d'erreur. 90s (porté de 25s) : mesuré en pratique qu'un lot de
// ARTICLES_PER_BATCH articles avec gemini-3.6-flash (mode "thinking" actif par défaut, plus lent que
// l'ancien 2.0-flash) prend jusqu'à ~52s pour répondre — 25s faisait échouer systématiquement
// l'ajustement IA à la génération avec un faux "réseau indisponible", alors que le crédit et le
// réseau étaient valides. 90s garde une vraie marge de sécurité au-delà de ce temps de réponse
// mesuré, tout en continuant à détecter une absence réelle de réseau en un temps raisonnable.
const LLM_CALL_TIMEOUT_MS = 90000;

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LLM_CALL_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Aucune réponse après ${LLM_CALL_TIMEOUT_MS / 1000}s (réseau indisponible ou fournisseur trop lent) — vérifiez votre connexion.`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Traduit les erreurs brutes de l'API Gemini en message actionnable (testé unitairement) :
 * le 400 "API_KEY_INVALID" ne vient jamais d'un bug applicatif mais d'une clé rejetée par
 * Google (supprimée, mal copiée, restreinte) — autant le dire clairement plutôt que de
 * renvoyer le JSON brut d'erreur.
 */
function geminiErrorMessage(status, bodyText) {
  const body = bodyText || '';
  if (body.includes('API_KEY_INVALID') || body.includes('API key not valid')) {
    return 'Gemini : clé API invalide (API_KEY_INVALID). Recréez une clé sur Google AI Studio (Get API Key), collez-la en entier sans espace avant/après, et sans restriction bloquant "Generative Language API".';
  }
  if (status === 404 || body.includes('NOT_FOUND')) {
    return `Gemini : modèle introuvable (${status}). Vérifiez le champ "modèle" de la clé (ex: gemini-2.0-flash). Détail : ${body.slice(0, 200)}`;
  }
  if (status === 429 || body.includes('RESOURCE_EXHAUSTED')) {
    return 'Gemini : quota épuisé (429). Attendez ou augmentez le quota dans Google AI Studio.';
  }
  return `Gemini ${status}: ${body.slice(0, 500)}`;
}

async function callGemini(apiKey, model, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model || DEFAULT_MODEL_BY_PROVIDER.gemini}:generateContent?key=${apiKey}`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2 },
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(geminiErrorMessage(res.status, errText));
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Réponse Gemini vide ou inattendue');
  return parseJsonArrayFromText(text);
}

async function callOpenAi(apiKey, model, prompt) {
  const res = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL_BY_PROVIDER.openai,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`OpenAI ${res.status}: ${errText}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('Réponse OpenAI vide ou inattendue');
  return parseJsonArrayFromText(text);
}

async function callAnthropic(apiKey, model, prompt) {
  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL_BY_PROVIDER.anthropic,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`Anthropic ${res.status}: ${errText}`);
  }
  const data = await res.json();
  const text = data.content?.[0]?.text;
  if (!text) throw new Error('Réponse Anthropic vide ou inattendue');
  return parseJsonArrayFromText(text);
}

const CALLERS = { gemini: callGemini, openai: callOpenAi, anthropic: callAnthropic };

/**
 * Lit un flux SSE (Server-Sent Events) ligne par ligne depuis chaque fournisseur LLM, et appelle
 * onChunk(textDelta) pour chaque fragment de texte reçu — permet d'afficher le texte au fur et à
 * mesure côté frontend plutôt que d'attendre la réponse complète. Chaque fournisseur encode son
 * flux différemment (extractText reçoit l'objet JSON d'un événement SSE et renvoie le texte à en
 * extraire, ou null si l'événement ne contient pas de texte exploitable).
 */
async function readSseStream(res, extractText, onChunk) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';

  // Boucle de lecture du flux SSE : `while (true)` volontaire (sortie par `break`
  // quand le flux est terminé) — pas une condition constante oubliée.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // dernière ligne potentiellement incomplète, conservée pour le prochain chunk

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const jsonStr = trimmed.slice(5).trim();
      if (jsonStr === '[DONE]') continue;
      try {
        const event = JSON.parse(jsonStr);
        const text = extractText(event);
        if (text) {
          fullText += text;
          onChunk(text);
        }
      } catch {
        // fragment JSON incomplet à cheval sur deux chunks réseau : ignoré, la ligne complète
        // arrivera dans un prochain chunk (comportement SSE normal, pas une vraie erreur).
      }
    }
  }
  return fullText;
}

async function streamGemini(apiKey, model, prompt, onChunk) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model || DEFAULT_MODEL_BY_PROVIDER.gemini}:streamGenerateContent?alt=sse&key=${apiKey}`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2 },
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`Gemini ${res.status}: ${errText}`);
  }
  return readSseStream(res, (event) => event.candidates?.[0]?.content?.parts?.[0]?.text, onChunk);
}

async function streamOpenAi(apiKey, model, prompt, onChunk) {
  const res = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL_BY_PROVIDER.openai,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      stream: true,
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`OpenAI ${res.status}: ${errText}`);
  }
  return readSseStream(res, (event) => event.choices?.[0]?.delta?.content, onChunk);
}

async function streamAnthropic(apiKey, model, prompt, onChunk) {
  const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL_BY_PROVIDER.anthropic,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`Anthropic ${res.status}: ${errText}`);
  }
  return readSseStream(res, (event) => (event.type === 'content_block_delta' ? event.delta?.text : null), onChunk);
}

const STREAM_CALLERS = { gemini: streamGemini, openai: streamOpenAi, anthropic: streamAnthropic };

/**
 * Variante streamée de callWithFallback, pour l'analyse en direct d'un seul article : appelle
 * onChunk(textDelta) au fil de la réponse. Même logique de bascule multi-clés que la version batch
 * — si un fournisseur échoue AVANT d'avoir streamé quoi que ce soit, on retente avec le suivant ;
 * s'il a déjà commencé à streamer puis échoue en cours de route, l'erreur remonte telle quelle
 * (annuler un flux partiellement affiché à l'utilisateur pour le recommencer ailleurs serait plus
 * déroutant qu'un message d'erreur clair à ce stade).
 */
async function streamWithFallbackImpl(prompt, onChunk) {
  const keys = await prisma.aiProviderKey.findMany({
    where: { isActive: true },
    orderBy: { priority: 'asc' },
  });
  if (keys.length === 0) {
    throw new Error('Aucune clé API IA configurée. Ajoutez-en une dans Paramètres > IA.');
  }

  const errors = [];
  for (const key of keys) {
    const streamer = STREAM_CALLERS[key.provider];
    if (!streamer) {
      errors.push(`${key.label}: fournisseur "${key.provider}" non supporté`);
      continue;
    }
    let startedStreaming = false;
    try {
      const apiKey = crypto.decrypt(key.encryptedApiKey);
      const fullText = await streamer(apiKey, key.model, prompt, (chunk) => {
        startedStreaming = true;
        onChunk(chunk);
      });
      await prisma.aiProviderKey.update({
        where: { id: key.id },
        data: { lastUsedAt: new Date(), lastError: null, lastErrorAt: null },
      });
      return { fullText, providerUsed: key.provider };
    } catch (err) {
      errors.push(`${key.label} (${key.provider}): ${err.message}`);
      await prisma.aiProviderKey.update({
        where: { id: key.id },
        data: { lastError: err.message, lastErrorAt: new Date() },
      }).catch(() => {});
      if (startedStreaming) throw err; // déjà affiché du texte à l'utilisateur, pas de bascule silencieuse
    }
  }
  throw new Error(`Toutes les clés IA ont échoué :\n${errors.join('\n')}`);
}

// File d'attente globale (demande du 15/09/2026) : chaque appel IA passe par enqueueAiRequest plutôt
// que d'appeler le fournisseur directement, pour qu'un pic de demandes simultanées (plusieurs
// utilisateurs sur le chatbot, génération de proposition en cours) ne parte pas toutes en parallèle
// sur la même clé API sans coordination — voir utils/aiRequestQueue.js pour le principe complet.
function streamWithFallback(prompt, onChunk) {
  return enqueueAiRequest(() => streamWithFallbackImpl(prompt, onChunk));
}

/**
 * Essaie chaque clé API active par ordre de priorité jusqu'à ce qu'une réponde avec succès.
 * Journalise l'échec (lastError/lastErrorAt) sur la clé fautive pour visibilité côté UI, sans
 * bloquer l'essai des clés suivantes.
 */
async function callWithFallbackImpl(prompt) {
  const keys = await prisma.aiProviderKey.findMany({
    where: { isActive: true },
    orderBy: { priority: 'asc' },
  });
  if (keys.length === 0) {
    throw new Error('Aucune clé API IA configurée. Ajoutez-en une dans Paramètres > IA.');
  }

  const errors = [];
  for (const key of keys) {
    const caller = CALLERS[key.provider];
    if (!caller) {
      errors.push(`${key.label}: fournisseur "${key.provider}" non supporté`);
      continue;
    }
    try {
      const apiKey = crypto.decrypt(key.encryptedApiKey);
      const result = await caller(apiKey, key.model, prompt);
      await prisma.aiProviderKey.update({
        where: { id: key.id },
        data: { lastUsedAt: new Date(), lastError: null, lastErrorAt: null },
      });
      return { result, providerUsed: key.provider, keyLabel: key.label };
    } catch (err) {
      errors.push(`${key.label} (${key.provider}): ${err.message}`);
      await prisma.aiProviderKey.update({
        where: { id: key.id },
        data: { lastError: err.message, lastErrorAt: new Date() },
      }).catch(() => {});
    }
  }
  throw new Error(`Toutes les clés IA ont échoué :\n${errors.join('\n')}`);
}

// Même file d'attente globale que streamWithFallback (voir son commentaire ci-dessus) — les deux
// fonctions sont les deux seuls points d'entrée réels vers un fournisseur IA dans tout le backend.
function callWithFallback(prompt) {
  return enqueueAiRequest(() => callWithFallbackImpl(prompt));
}

/**
 * Teste une clé API isolément (bouton "Tester" dans Paramètres > IA) : envoie un prompt minimal,
 * sans toucher à une proposition ni à AiForecastRun — juste pour vérifier que la clé est valide et
 * que le fournisseur répond, avant de s'en servir sur une vraie analyse.
 */
async function testProviderKey(keyId) {
  const key = await prisma.aiProviderKey.findUnique({ where: { id: keyId } });
  if (!key) throw new Error('Clé introuvable');

  const caller = CALLERS[key.provider];
  if (!caller) throw new Error(`Fournisseur "${key.provider}" non supporté`);

  const testPrompt = 'Réponds UNIQUEMENT avec ce tableau JSON, sans texte autour : [{"ean": "TEST", "quantity": 1, "reasoning": "ok"}]';

  try {
    const apiKey = crypto.decrypt(key.encryptedApiKey);
    const start = Date.now();
    const result = await caller(apiKey, key.model, testPrompt);
    const durationMs = Date.now() - start;
    await prisma.aiProviderKey.update({
      where: { id: keyId },
      data: { lastUsedAt: new Date(), lastError: null, lastErrorAt: null },
    });
    return { success: true, durationMs, sample: result };
  } catch (err) {
    await prisma.aiProviderKey.update({
      where: { id: keyId },
      data: { lastError: err.message, lastErrorAt: new Date() },
    }).catch(() => {});
    throw err;
  }
}

/**
 * Analyse un ensemble d'articles par lots (ARTICLES_PER_BATCH, en parallèle contrôlé par
 * BATCH_CONCURRENCY) : construit le résumé de chaque article (buildArticleSummary), appelle le LLM
 * configuré avec fallback multi-clés, et retourne les suggestions obtenues par EAN. Un lot en échec
 * n'empêche jamais les autres de réussir — c'est à l'appelant de décider quoi faire des articles
 * sans suggestion (fallback sur le calcul classique, cf. generateAndSaveProposal et runAiForecast).
 * Factorisé ici car utilisé à deux endroits : l'analyse à la demande sur une proposition déjà
 * générée (runAiForecast) et, désormais, l'analyse intégrée à chaque génération elle-même.
 */
async function analyzeArticlesBatch(lines, shopReference, shopName, shopConfig, posId, shopId, onProgress) {
  const reportProgress = onProgress || (() => {});
  // Une seule sonde d'activité pour tout le magasin (pas par article) : échantillonnage RPOS léger,
  // mis en cache 24h par shopActivityService — jamais recalculé article par article. Un échec
  // réseau ponctuel (hors réseau Prosuma, cf. contrainte connue) ne doit jamais bloquer l'analyse
  // IA : l'article est alors envoyé sans ce statut plutôt que d'échouer toute la génération.
  let shopActivity = null;
  if (posId && shopId) {
    try {
      shopActivity = await shopActivityService.getShopActivityProfile(posId, shopId);
    } catch {
      shopActivity = null;
    }
  }

  const summaries = lines.map((line) => buildArticleSummary(line, shopConfig, shopActivity));
  const batches = [];
  for (let i = 0; i < summaries.length; i += ARTICLES_PER_BATCH) {
    batches.push(summaries.slice(i, i + ARTICLES_PER_BATCH));
  }

  const byEan = new Map();
  let providerUsed = null;
  const batchErrors = [];
  let batchesDone = 0;

  reportProgress({ articlesTotal: summaries.length, articlesProcessed: 0 });

  await mapWithConcurrency(batches, BATCH_CONCURRENCY, async (batch) => {
    try {
      const prompt = await buildPrompt(shopReference, shopName, batch);
      const { result, providerUsed: usedForBatch } = await callWithFallback(prompt);
      providerUsed = providerUsed || usedForBatch;
      for (const r of result) byEan.set(String(r.ean), r);
    } catch (err) {
      batchErrors.push(err.message);
    } finally {
      batchesDone += 1;
      reportProgress({ articlesTotal: summaries.length, articlesProcessed: Math.min(batchesDone * ARTICLES_PER_BATCH, summaries.length) });
    }
  });

  return { byEan, providerUsed, batchErrors, totalBatches: batches.length };
}

/**
 * Lance une analyse IA sur les lignes d'une proposition existante : construit le résumé par
 * article, appelle le LLM (avec fallback multi-clés), et persiste le résultat dans AiForecastRun
 * sans jamais modifier la proposition classique — l'utilisateur choisit explicitement d'appliquer
 * ou non les quantités suggérées à la validation.
 */
async function runAiForecast(proposalId, requestedBy) {
  const proposal = await prisma.proposal.findUnique({ where: { id: proposalId }, include: { lines: true } });
  if (!proposal) throw new Error('Proposition introuvable');

  const run = await prisma.aiForecastRun.create({
    data: { proposalId, rposShopId: proposal.rposShopId, status: 'RUNNING', requestedBy },
  });

  try {
    const shopConfig = { safetyStockRatio: proposal.safetyStockRatioUsed, receptionLeadTimeDays: proposal.receptionLeadTimeDaysUsed };
    const { byEan, providerUsed, batchErrors, totalBatches } = await analyzeArticlesBatch(
      proposal.lines, proposal.rposShopReference, proposal.rposShopName, shopConfig,
      proposal.rposPosId, proposal.rposShopId
    );

    // Un lot en échec ne bloque pas les autres : les articles concernés gardent simplement la
    // quantité calculée classiquement (fallback silencieux), plutôt que de faire échouer toute
    // l'analyse pour une panne partielle sur une fraction des articles.
    const lineData = proposal.lines.map((line) => {
      const suggestion = byEan.get(line.ean);
      return {
        runId: run.id,
        ean: line.ean,
        label: line.label,
        quantitySuggested: suggestion ? Math.max(0, Number(suggestion.quantity) || 0) : line.quantitySuggested,
        reasoning: suggestion?.reasoning || null,
      };
    });

    if (byEan.size === 0 && totalBatches > 0) {
      throw new Error(`Tous les lots ont échoué :\n${batchErrors.join('\n')}`);
    }

    await prisma.aiForecastLine.createMany({ data: lineData });
    await prisma.aiForecastRun.update({
      where: { id: run.id },
      data: {
        status: 'DONE',
        providerUsed,
        completedAt: new Date(),
        errorMessage: batchErrors.length > 0 ? `${batchErrors.length}/${totalBatches} lot(s) en échec (fallback sur le calcul classique pour ces articles) :\n${batchErrors.join('\n')}` : null,
      },
    });

    return prisma.aiForecastRun.findUnique({ where: { id: run.id }, include: { lines: true } });
  } catch (err) {
    await prisma.aiForecastRun.update({
      where: { id: run.id },
      data: { status: 'ERROR', errorMessage: err.message, completedAt: new Date() },
    });
    throw err;
  }
}

async function getLatestAiForecast(proposalId) {
  return prisma.aiForecastRun.findFirst({
    where: { proposalId },
    orderBy: { requestedAt: 'desc' },
    include: { lines: true },
  });
}

/**
 * Analyse IA en direct d'un seul article (page "IA & Prédictions") : appelle le LLM immédiatement
 * sur cet article uniquement, sans persister d'AiForecastRun (analyse ponctuelle à la demande, pas
 * une génération complète de proposition) — retourne directement la suggestion ou lève une erreur.
 * Le résultat n'est pas mis en cache : chaque clic relance un vrai appel, cohérent avec l'attente
 * d'une analyse "en temps réel" plutôt qu'un résultat pré-calculé.
 */
async function analyzeArticleRealtime({ shopReference, shopName, line, shopConfig, posId, shopId }) {
  let shopActivity = null;
  if (posId && shopId) {
    try {
      shopActivity = await shopActivityService.getShopActivityProfile(posId, shopId);
    } catch {
      shopActivity = null;
    }
  }
  const summary = buildArticleSummary(line, shopConfig, shopActivity);
  const prompt = await buildPrompt(shopReference, shopName, [summary]);
  const { result, providerUsed } = await callWithFallback(prompt);
  const suggestion = result.find((r) => String(r.ean) === String(line.ean)) || result[0];
  if (!suggestion) throw new Error('Réponse IA sans suggestion exploitable pour cet article');
  return {
    quantity: Math.max(0, Number(suggestion.quantity) || 0),
    reasoning: suggestion.reasoning || null,
    providerUsed,
  };
}

// Format de sortie attendu du prompt streamé (cf. buildStreamingPrompt) : une première ligne
// "QUANTITE: n", puis le texte d'explication qui suit. Extrait la quantité au fil de la réponse
// dès que la première ligne est complète (elle arrive en tout premier, avant tout le texte
// d'explication), pour que le frontend affiche le nombre recommandé sans attendre la fin du stream.
const QUANTITY_LINE_RE = /^QUANTITE:\s*(-?\d+(?:\.\d+)?)\s*\n+/i;

/**
 * Variante streamée de analyzeArticleRealtime (panneau "Analyser", clic utilisateur) : appelle
 * onTextChunk(text) au fil de la réponse de l'IA pour un affichage progressif façon conversation,
 * et onQuantity(n) dès que la quantité recommandée est identifiée (généralement en tout début de
 * réponse). Retourne le résultat final complet une fois le stream terminé.
 */
async function analyzeArticleRealtimeStream({ shopReference, shopName, line, shopConfig, posId, shopId, onTextChunk, onQuantity }) {
  let shopActivity = null;
  if (posId && shopId) {
    try {
      shopActivity = await shopActivityService.getShopActivityProfile(posId, shopId);
    } catch {
      shopActivity = null;
    }
  }
  const summary = buildArticleSummary(line, shopConfig, shopActivity);
  const prompt = await buildStreamingPrompt(shopReference, shopName, summary);

  let buffer = '';
  let quantity = null;
  let quantityAnnounced = false;
  let reasoningStarted = false;

  const { fullText, providerUsed } = await streamWithFallback(prompt, (chunk) => {
    buffer += chunk;
    if (!quantityAnnounced) {
      const match = buffer.match(QUANTITY_LINE_RE);
      if (match) {
        quantity = Math.max(0, Math.round(Number(match[1])));
        quantityAnnounced = true;
        if (onQuantity) onQuantity(quantity);
        buffer = buffer.slice(match[0].length);
        reasoningStarted = true;
        if (buffer && onTextChunk) onTextChunk(buffer); // reste du chunk déjà reçu après la ligne QUANTITE
        buffer = '';
        return;
      }
      // La ligne QUANTITE n'est pas encore complète (coupée entre deux chunks réseau) : on
      // attend le prochain chunk plutôt que d'afficher un fragment de "QUANTITE: " à l'écran.
      return;
    }
    if (reasoningStarted && onTextChunk) onTextChunk(chunk);
  });

  if (quantity === null) {
    // Le modèle n'a pas respecté le format demandé : tentative de repli sur un nombre trouvé en
    // tout début de texte plutôt que d'échouer entièrement sur un résultat par ailleurs exploitable.
    const fallbackMatch = fullText.match(/-?\d+(?:\.\d+)?/);
    quantity = fallbackMatch ? Math.max(0, Math.round(Number(fallbackMatch[0]))) : 0;
  }

  const reasoning = quantityAnnounced ? fullText.replace(QUANTITY_LINE_RE, '').trim() : fullText.trim();
  return { quantity, reasoning: reasoning || null, providerUsed };
}

/**
 * Question libre posée par le magasin sur une recommandation déjà donnée (cf. demande explicite :
 * "le magasin doit pouvoir demander à l'IA pourquoi elle recommande une quantité donnée" — combien
 * de jours de couverture, tendance en hausse/baisse, comparaison au calcul statistique, etc.).
 * Réutilise le même résumé de données (buildArticleSummary) que l'analyse initiale, pour que l'IA
 * réponde à partir des VRAIES données de l'article plutôt que du texte de raisonnement seul (qui
 * peut ne pas contenir tous les chiffres nécessaires pour répondre à une question de suivi précise,
 * ex: "quelle est la moyenne sur les 10 derniers jours ?" si le raisonnement initial n'a pas cité ce
 * chiffre exact). previousReasoning et conversationHistory donnent le contexte de ce qui a déjà été
 * dit, pour permettre l'enchaînement de questions ("et pourquoi pas plus ?" après une 1ère réponse).
 */
async function askFollowUpQuestion({ shopReference, shopName, line, shopConfig, posId, shopId, previousQuantity, previousReasoning, conversationHistory, question, onTextChunk }) {
  let shopActivity = null;
  if (posId && shopId) {
    try {
      shopActivity = await shopActivityService.getShopActivityProfile(posId, shopId);
    } catch {
      shopActivity = null;
    }
  }
  const summary = buildArticleSummary(line, shopConfig, shopActivity);

  const historyText = (conversationHistory || [])
    .map((turn) => `Question du magasin : ${turn.question}\nTa réponse précédente : ${turn.answer}`)
    .join('\n\n');

  const prompt =
    `Tu es un analyste de la demande pour un magasin de grande distribution (${shopReference || ''} ${shopName || ''}). ` +
    'Tu as déjà analysé un article et recommandé une quantité à commander. Le magasin te pose maintenant une question de suivi sur cette recommandation. ' +
    'Réponds UNIQUEMENT à partir des données réelles ci-dessous (jamais d\'invention ni de généralité). ' +
    'Pour une question de type "pourquoi" : construis une vraie explication CAUSALE ("parce que X, donc Y"), pas une liste de chiffres juxtaposés sans lien entre eux — le magasin voit déjà ces chiffres à l\'écran (stock, vente moyenne, colisage), ce qu\'il veut c\'est comprendre le RAISONNEMENT qui les relie à cette quantité précise, comme s\'il demandait à un collègue expérimenté de lui expliquer sa décision à voix haute. Cite les chiffres seulement à l\'appui de ce raisonnement, jamais comme une simple récitation de données déjà visibles. ' +
    'Reste TRÈS bref et direct (1-3 phrases COURTES maximum formant un raisonnement suivi), en français, sans réintroduire toute l\'analyse depuis le début ni ajouter de récapitulatif final — le magasin a déjà vu ta première explication et veut juste la réponse à sa question précise. ' +
    'N\'utilise une liste à puces QUE si la question porte explicitement sur plusieurs éléments distincts et sans lien causal entre eux (ex: "donne-moi 3 dates" ou "compare ces 2 quantités") — jamais pour une question "pourquoi", qui appelle un raisonnement suivi, pas une énumération. ' +
    'Une durée inférieure à 1 jour (ex: 0,7 jour) est un chiffre abstrait pour le magasin : convertis-la toujours en heures approximatives ("environ 17h", "moins d\'une journée") au lieu de la laisser en fraction de jour brute.\n\n' +
    `Données de l'article (JSON) :\n${JSON.stringify(summary, null, 2)}\n\n` +
    `Ta recommandation précédente : ${previousQuantity} unité(s).\n` +
    `Ton explication précédente : ${previousReasoning || '(aucune)'}\n\n` +
    (historyText ? `Échanges précédents dans cette conversation :\n${historyText}\n\n` : '') +
    `Nouvelle question du magasin : ${question}\n\n` +
    'Réponds directement à cette question, sans préambule. Format Markdown LÉGER : gras (**mot**) pour les chiffres ou termes clés uniquement.';

  const { fullText, providerUsed } = await streamWithFallback(prompt, (chunk) => {
    if (onTextChunk) onTextChunk(chunk);
  });

  return { answer: fullText.trim(), providerUsed };
}

module.exports = { runAiForecast, getLatestAiForecast, testProviderKey, buildArticleSummary, analyzeArticleRealtime, analyzeArticleRealtimeStream, analyzeArticlesBatch, askFollowUpQuestion, streamWithFallback, callWithFallback, geminiErrorMessage };
