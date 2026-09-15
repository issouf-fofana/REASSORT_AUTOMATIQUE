/**
 * AI Store Assistant (CAHIER_DES_CHARGES.md §34-38, étape 11 du plan de montée en autonomie IA).
 *
 * Architecture respectée (§35) : Intent Detection -> Data Retrieval / Tools -> LLM -> Réponse.
 * Le LLM ne reçoit JAMAIS un accès direct à la base : seulement le résultat JSON des outils
 * (chatbotToolsService.js) pertinents à la question posée. La détection d'intention est un choix
 * déterministe par mots-clés (pas un appel LLM) : rapide, gratuit, et suffisant pour orienter vers
 * le bon outil sans faire dépendre le routage lui-même d'un appel réseau supplémentaire.
 */
const tools = require('./chatbotToolsService');
const { streamWithFallback } = require('./aiForecastService');
const systemConfig = require('./systemConfigService');

// Chaque règle : mots-clés (au moins un doit matcher, insensible à la casse/accents) -> outil à
// appeler. Ordre important : la première règle qui matche gagne, donc les intentions les plus
// spécifiques (rupture, surstock, précision) sont placées avant la règle générique "stock".
const INTENT_RULES = [
  // Fiche article RPOS en direct (emplacement, prix, promo...) placée avant les règles génériques
  // "stock"/"vente" : une question comme "quel est le prix de cet article" ne doit jamais tomber
  // sur getArticleStock (qui ignore prix/emplacement/promo) juste parce qu'elle contient "article"
  // (demande du 15/09/2026 : un admin doit pouvoir demander emplacement, prix actuel, promo, etc.
  // pour un article donné par son code).
  // Historique des changements de PRIX (placé avant getArticleDetails : une question sur "quand"/
  // "changement de prix" porte sur l'historique, pas sur l'état actuel — demande du 15/09/2026).
  { keywords: ['changement de prix', 'changé de prix', 'change de prix', 'changement de prix de vente', 'historique de prix', 'historique des prix', 'évolution du prix', 'evolution du prix', 'quand a-t-il changé de prix', 'quand est-ce que le prix', 'log de prix', 'log changement', 'mis en promo', 'mise en promo', 'mis en promotion', 'depuis quand', 'quand est-ce qu\'il', 'quand a-t-il', 'quand il a', 'quand est-il passé', 'a quel moment'], tool: 'getPriceChangeHistory' },
  { keywords: ['où se trouve', 'ou se trouve', 'emplacement', 'où est', 'ou est', 'quel rayon', 'dans quel rayon', 'adresse rayon', 'prix actuel', 'prix de vente', 'prix promo', 'en promo', 'promotion', 'quel prix', 'combien coûte', 'combien coute', 'fiche article', 'fiche produit', 'fiche complète', 'fiche complete', 'détails de l\'article', 'details de larticle', 'infos article', 'informations sur l\'article', 'toutes les informations', 'tout savoir sur', 'caractéristiques', 'caracteristiques', 'fournisseur de'], tool: 'getArticleDetails' },
  { keywords: ['pareto', '80%', '80 %', 'part du ca', 'part de ca', 'représentent le plus de ca', 'font le plus de ca', 'articles principaux', 'gros vendeurs', 'meilleures ventes', 'top articles', 'top vente'], tool: 'getParetoArticles' },
  { keywords: ['chiffre d\'affaires', 'chiffre daffaire', 'chiffre d affaire', 'le ca', 'du ca', 'au ca', 'ton ca', 'mon ca', 'quel ca', 'ca du', 'ca le', 'ca est', 'ca de', 'combien on a fait', 'combien jai fait', 'combien on a vendu en argent', 'recette du jour', 'recette de'], tool: 'getRevenue' },
  { keywords: ['rupture', 'stock critique', 'risque de rupture', 'va manquer', 'vont manquer', 'plus de stock', 'articles en manque', 'articles manquants', 'quoi va manquer'], tool: 'getStockoutRisks' },
  { keywords: ['surstock', 'trop de stock', 'sur-stock', 'excès de stock', 'exces de stock', 'trop stocké', 'trop stocke', 'articles en trop'], tool: 'getOverstockArticles' },
  { keywords: ['précision', 'fiabilité', 'accuracy', 'erreur de prévision', 'la prévision est bonne', 'fiable', 'lia se trompe', 'l\'ia se trompe', 'taux de reussite', 'taux de réussite'], tool: 'getPredictionAccuracy' },
  { keywords: ['commande', 'commandes récentes', 'qu\'est-ce qui a été commandé', 'quest ce qui a ete commande', 'quoi a ete commande', 'derniere commande', 'dernières commandes'], tool: 'getOrders' },
  { keywords: ['proposition', 'proposition en attente', 'aujourd\'hui', 'quoi commander', 'que dois-je commander', 'quest ce que je dois commander', 'a commander'], tool: 'getCurrentProposal' },
  { keywords: ['vente', 'ventes', 'évolution', 'combien vendu', 'combien vendus', 'combien on a vendu', 'tendance', 'ca se vend comment', 'comment ca vend'], tool: 'getSalesHistory' },
  { keywords: ['stock de', 'stock actuel', 'stock disponible', 'combien il reste', 'combien il en reste', 'reste combien', 'il reste combien'], tool: 'getArticleStock' },
];

function normalize(str) {
  return (str || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Détection d'intention : renvoie le nom de l'outil le plus pertinent, ou null si aucun ne matche. */
function detectIntent(question) {
  const normalized = normalize(question);
  for (const rule of INTENT_RULES) {
    if (rule.keywords.some((kw) => normalized.includes(normalize(kw)))) return rule.tool;
  }
  return null;
}

/**
 * Tente d'extraire un EAN mentionné explicitement dans la question (13 chiffres consécutifs, ou
 * préfixé/proche d'un mot comme "article"/"ean") — sans ça, getArticleStock/getSalesHistory(ean)
 * ne peuvent pas cibler un article précis à partir d'une question en langage naturel.
 */
function extractEan(question) {
  // Tolère un EAN saisi avec des espaces ("100 661 060") ou des tirets ("100-661-060") en plus du
  // format compact habituel — un utilisateur qui recopie un code depuis un ticket ou un tableur ne
  // tape pas toujours 8-13 chiffres collés (élargi le 15/09/2026 pour couvrir plus de formulations
  // réelles, sans changer le format de retour attendu par les outils : toujours une chaîne compacte).
  const compact = (question || '').replace(/\b(\d[\d\s-]{6,17}\d)\b/g, (m) => m.replace(/[\s-]/g, ''));
  const match = compact.match(/\b\d{8,13}\b/);
  return match ? match[0] : null;
}

/** Tente d'extraire un pourcentage explicite ("80%", "80 %") mentionné dans la question. */
function extractPercentage(question) {
  const match = (question || '').match(/\b(\d{1,3})\s*%/);
  return match ? Math.min(100, parseInt(match[1], 10)) : null;
}

/**
 * Tente d'extraire une date explicite (jj/mm/aaaa, jj-mm-aaaa, ou aaaa-mm-jj) mentionnée dans la
 * question, au format ISO "aaaa-mm-jj" attendu par getRevenue. Tolère un jour à un seul chiffre
 * (ex: "9-09-2026") et une frappe imprécise (l'utilisateur peut taper "?" à la place d'un séparateur
 * suite à une erreur clavier) — d'où une regex sur des chiffres séparés par n'importe quel caractère
 * non numérique plutôt qu'un séparateur strict.
 */
function extractDate(question) {
  const match = (question || '').match(/\b(\d{1,2})\D(\d{1,2})\D(\d{4})\b/) || (question || '').match(/\b(\d{4})\D(\d{1,2})\D(\d{1,2})\b/);
  if (!match) return null;
  // Détermine l'ordre (jj/mm/aaaa vs aaaa/mm/jj) selon la position du groupe à 4 chiffres.
  const [, a, b, c] = match;
  const [day, month, year] = a.length === 4 ? [c, b, a] : [a, b, c];
  const dd = day.padStart(2, '0');
  const mm = month.padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

// Mots-clés qui ne désignent pas une nouvelle intention de données, mais une demande de
// représentation différente ("montre-moi ça en graphique/tableau") du dernier résultat déjà obtenu
// dans la conversation. Sans ce cas particulier, une question comme "tu peux m'envoyer le graph ?"
// ne matchait aucune règle de INTENT_RULES et l'IA répondait à tort "je ne peux pas envoyer de
// graphique" alors que le frontend sait très bien en construire un à partir d'un toolResult déjà là.
const VISUAL_REQUEST_KEYWORDS = ['graph', 'graphique', 'tableau', 'courbe', 'visuel', 'schema', 'diagramme'];

function isVisualRequest(question) {
  const normalized = normalize(question);
  return VISUAL_REQUEST_KEYWORDS.some((kw) => normalized.includes(kw));
}

/**
 * Exécute l'outil détecté avec les paramètres extraits de la question, retourne un objet
 * { toolName, toolResult } prêt à être injecté dans le prompt du LLM. found=false si aucun outil
 * pertinent n'a pu être identifié (le LLM répond alors sans données spécifiques, en le disant).
 * conversationHistory permet de retomber sur le dernier outil utilisé quand la question demande
 * juste une représentation visuelle d'un résultat déjà obtenu, sans nommer une nouvelle donnée.
 */
async function runToolForQuestion(rposShopId, question, { department, conversationHistory, posId } = {}) {
  let toolName = detectIntent(question);

  if (!toolName && isVisualRequest(question) && conversationHistory && conversationHistory.length) {
    const lastWithTool = [...conversationHistory].reverse().find((turn) => turn.toolUsed && turn.toolResult);
    if (lastWithTool) return { toolName: lastWithTool.toolUsed, toolResult: lastWithTool.toolResult, reusedFromHistory: true };
  }

  // Un article mentionné dans un tour précédent ("il", "cet article", "et quand a-t-il changé de
  // prix ?") sans répéter l'EAN : on retombe sur le dernier EAN réellement utilisé dans cette
  // conversation, pour les outils qui portent toujours sur UN article précis — sinon chaque question
  // de suivi obligerait à retaper le code, ce qui n'est pas comment une conversation fonctionne
  // (bug trouvé le 15/09/2026 : "et quand il a été mis en promo ?" répondait "précisez le code EAN"
  // alors que l'article venait d'être identifié deux messages plus tôt).
  const ARTICLE_SCOPED_TOOLS = new Set(['getArticleDetails', 'getPriceChangeHistory', 'getArticleStock', 'getSalesHistory']);

  // Filet de sécurité n°1 : un EAN explicite dans la question mais aucun mot-clé reconnu (ex: "tu
  // peux me dire tout sur cet article : 100446452 ?", formulation imprévue) — plutôt que de
  // répondre "je ne sais pas", on part du principe qu'une question qui cite un EAN précis porte sur
  // CET article, et la fiche complète (getArticleDetails) est la réponse la plus utile par défaut
  // (demande du 15/09/2026 : "il doit avoir tout" pour un article donné par son code).
  if (!toolName && extractEan(question)) toolName = 'getArticleDetails';

  // Filet de sécurité n°2 : aucune intention détectée ET le tour précédent avait déjà utilisé un
  // outil — une question de suivi qui ne répète NI mot-clé NI EAN ("et le 14-09 il y a eu quoi ?",
  // "et avant ça ?", "et pour la semaine dernière ?") est presque toujours une continuation du même
  // sujet, quel qu'il soit (article précis OU ruptures/CA/pareto...), pas une nouvelle intention hors
  // périmètre. Généralisé à tous les outils (pas seulement ARTICLE_SCOPED_TOOLS) : une relance vague
  // après "quels articles sont en rupture ?" doit aussi continuer sur getStockoutRisks, pas juste sur
  // une fiche article (bug trouvé le 15/09/2026 : "et le 14-09 il y a eu quoi" perdait le contexte
  // de l'historique de prix demandé juste avant).
  if (!toolName && conversationHistory && conversationHistory.length) {
    const lastTurn = conversationHistory[conversationHistory.length - 1];
    if (lastTurn.toolUsed) toolName = lastTurn.toolUsed;
  }

  if (!toolName) return { toolName: null, toolResult: null };

  let ean = extractEan(question);
  if (!ean && ARTICLE_SCOPED_TOOLS.has(toolName) && conversationHistory && conversationHistory.length) {
    for (let i = conversationHistory.length - 1; i >= 0; i--) {
      const pastEan = extractEan(conversationHistory[i].question);
      if (pastEan) { ean = pastEan; break; }
    }
  }
  const date = extractDate(question);
  const percentage = extractPercentage(question);

  switch (toolName) {
    case 'getArticleDetails':
      if (!ean) return { toolName, toolResult: { found: false, message: 'Précisez le code EAN de l\'article pour obtenir sa fiche complète (emplacement, prix, promo...).' } };
      if (!posId) return { toolName, toolResult: { found: false, message: 'Serveur RPOS introuvable pour ce magasin.' } };
      return { toolName, toolResult: await tools.getArticleDetails(posId, rposShopId, ean) };
    case 'getPriceChangeHistory':
      if (!ean) return { toolName, toolResult: { found: false, message: 'Précisez le code EAN de l\'article pour consulter son historique de prix.' } };
      if (!posId) return { toolName, toolResult: { found: false, message: 'Serveur RPOS introuvable pour ce magasin.' } };
      return { toolName, toolResult: await tools.getPriceChangeHistory(posId, rposShopId, ean) };
    case 'getParetoArticles':
      return { toolName, toolResult: await tools.getParetoArticles(rposShopId, { thresholdPct: percentage || 80, department }) };
    case 'getRevenue':
      return { toolName, toolResult: await tools.getRevenue(rposShopId, { date, department }) };
    case 'getStockoutRisks':
      return { toolName, toolResult: await tools.getStockoutRisks(rposShopId, { department }) };
    case 'getOverstockArticles':
      return { toolName, toolResult: await tools.getOverstockArticles(rposShopId, { department }) };
    case 'getPredictionAccuracy':
      return { toolName, toolResult: await tools.getPredictionAccuracy(rposShopId, {}) };
    case 'getOrders':
      return { toolName, toolResult: await tools.getOrders(rposShopId, {}) };
    case 'getCurrentProposal':
      return { toolName, toolResult: await tools.getCurrentProposal(rposShopId, { department }) };
    case 'getSalesHistory':
      return { toolName, toolResult: await tools.getSalesHistory(rposShopId, { ean, days: 30, department }) };
    case 'getArticleStock':
      return ean
        ? { toolName, toolResult: await tools.getArticleStock(rposShopId, ean) }
        : { toolName, toolResult: await tools.getStoreStock(rposShopId, { department }) };
    default:
      return { toolName: null, toolResult: null };
  }
}

/**
 * Construit le prompt final : contexte utilisateur (magasin, rayon si précisé — jamais plus que ce
 * que ses permissions autorisent, appliqué en amont par la route), historique de conversation,
 * résultat de l'outil appelé le cas échéant, et consigne stricte de ne jamais inventer de données
 * (§35).
 */
function buildChatbotPrompt({ shopReference, shopName, department, subDepartment, conversationHistory, question, toolName, toolResult, reusedFromHistory, suggestedQuestions }) {
  const context = [
    `Magasin : ${shopReference || ''} ${shopName || ''}`,
    department ? `Rayon sélectionné : ${department}` : null,
    subDepartment ? `Sous-rayon sélectionné : ${subDepartment}` : null,
  ].filter(Boolean).join('\n');

  const historyText = (conversationHistory || [])
    .map((turn) => `Question : ${turn.question}\nRéponse : ${turn.answer}`)
    .join('\n\n');

  let dataSection;
  if (reusedFromHistory) {
    // La question demandait une représentation visuelle (graphique/tableau) d'un résultat déjà
    // obtenu plus tôt dans la conversation : le frontend construit ce visuel lui-même à partir de
    // toolResult (jamais le LLM) — la réponse texte doit juste l'annoncer, pas prétendre ne pas
    // pouvoir en fournir, ni re-décrire toutes les données en detail (déjà visibles dans le visuel).
    dataSection = `L'utilisateur demande une représentation visuelle (graphique ou tableau) des données déjà obtenues précédemment dans cette conversation (outil "${toolName}"). Un graphique ou tableau sera affiché automatiquement juste après ta réponse par l'application — ne dis JAMAIS que tu ne peux pas fournir de graphique. Réponds simplement par une phrase confirmant que la représentation demandée est affichée ci-dessous, sans réénumérer le détail des données (déjà visible dans le visuel).`;
  } else if (toolResult) {
    dataSection = `Données réelles récupérées pour répondre (outil "${toolName}", résultat JSON — utilise UNIQUEMENT ces données, ne complète jamais avec une supposition) :\n${JSON.stringify(toolResult, null, 2)}`;
  } else {
    // Aucun outil de données identifié pour cette question : plutôt qu'un simple "je ne peux pas
    // répondre", l'IA doit lister ce qu'elle sait réellement faire (les mêmes capacités que les
    // questions suggérées de l'UI, éditables dans Paramètres > IA) — sans ça, l'utilisateur ne
    // découvre le périmètre de l'assistant qu'en tâtonnant question par question.
    const capabilitiesList = (suggestedQuestions || []).map((q) => `- ${q}`).join('\n');
    dataSection = `Aucun outil de données spécifique n'a été identifié pour cette question. Dis clairement que tu ne disposes pas de cette donnée précise plutôt que d'inventer un chiffre, PUIS liste explicitement (en puces) les types de questions auxquelles tu peux répondre avec des données réelles, à partir de cette liste :\n${capabilitiesList}`;
  }

  return `Tu es l'Assistant IA Store d'un magasin de grande distribution. Tu réponds aux questions du responsable magasin sur le réassort, les ventes, les stocks et les prévisions.

RÈGLE ABSOLUE (§35 du cahier des charges) : ne réponds JAMAIS avec un chiffre ou une donnée que tu n'as pas reçue explicitement ci-dessous. Si l'information demandée n'est pas dans les données fournies, dis-le clairement plutôt que d'inventer.

Contexte :
${context}

${dataSection}

${historyText ? `Échanges précédents dans cette conversation :\n${historyText}\n\n` : ''}Question du responsable magasin : ${question}

Réponds en français, de façon directe et concise, en Markdown léger (gras **mot** pour les chiffres clés). Règle de format selon le contenu de ta réponse :
- Si la question porte sur "quels articles" (ruptures, surstock, à commander...) et que les données listent plusieurs articles : réponds avec UNE PUCE PAR ARTICLE nommé explicitement (label + chiffre clé, ex: "**LAMP BUR** : rupture dans **2 jours**, réassort suggéré **5** unités"), jamais un total agrégé seul qui masque quels articles précis sont concernés. Maximum 8 puces — au-delà, indique le nombre total et ne détaille que les plus urgents/importants.
- Si la question porte sur une évolution/tendance globale (ventes, CA) sans lister d'articles : un court paragraphe avec les chiffres clés suffit, pas de liste forcée.
- Sinon (réponse à une seule idée) : 1-2 phrases courtes.
Ne réponds jamais par un seul chiffre agrégé quand la question demande explicitement "quels articles" — l'utilisateur veut toujours savoir lesquels, pas seulement combien.
Si la question posée contient PLUSIEURS demandes distinctes (ex: "donne-moi le prix ET l'historique de rupture") et que les données ci-dessus ne couvrent qu'UNE seule de ces demandes : réponds à celle que tu peux avec ces données, PUIS indique explicitement en une phrase que l'autre partie de la question nécessite une question séparée (précise laquelle) — ne l'ignore jamais silencieusement.`;
}

/**
 * Point d'entrée principal : détecte l'intention, appelle l'outil si pertinent, construit le prompt,
 * puis streame la réponse du LLM via onTextChunk (même mécanisme que askFollowUpQuestion).
 */
async function askAssistant({ rposShopId, posId, shopReference, shopName, department, subDepartment, conversationHistory, question, onTextChunk }) {
  const { toolName, toolResult, reusedFromHistory } = await runToolForQuestion(rposShopId, question, { department, conversationHistory, posId });
  const suggestedQuestions = toolResult || reusedFromHistory ? null : await getSuggestedQuestions();
  const prompt = buildChatbotPrompt({ shopReference, shopName, department, subDepartment, conversationHistory, question, toolName, toolResult, reusedFromHistory, suggestedQuestions });

  const { fullText, providerUsed } = await streamWithFallback(prompt, (chunk) => {
    if (onTextChunk) onTextChunk(chunk);
  });

  // toolResult est retourné tel quel (pas reformaté par le LLM) : le frontend construit son
  // graphique/tableau directement à partir de ces vraies données quand leur forme s'y prête
  // (dailyHistory -> graphique, lines/topArticles -> tableau) — jamais un rendu que l'IA aurait pu
  // déformer ou halluciner en le redécrivant dans son texte.
  return { answer: fullText.trim(), providerUsed, toolUsed: toolName, toolResult };
}

// Questions suggérées (§34) : éditables depuis Paramètres > IA (CHATBOT_SUGGESTED_QUESTIONS, une par
// ligne) sans redéploiement — servent aussi de référence pour indiquer au magasin ce que l'assistant
// sait réellement faire quand une question sort du périmètre couvert (cf. buildChatbotPrompt).
async function getSuggestedQuestions() {
  const raw = await systemConfig.getValue(systemConfig.KEYS.CHATBOT_SUGGESTED_QUESTIONS);
  return (raw || '').split('\n').map((q) => q.trim()).filter(Boolean);
}

module.exports = { askAssistant, detectIntent, extractEan, getSuggestedQuestions };
