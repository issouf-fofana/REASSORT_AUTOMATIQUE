/**
 * AI Store Assistant (CAHIER_DES_CHARGES.md §34-38, étape 11 du plan de montée en autonomie IA).
 *
 * Architecture respectée (§35) : Intent Detection -> Data Retrieval / Tools -> LLM -> Réponse.
 * Le LLM ne reçoit JAMAIS un accès direct à la base : seulement le résultat JSON des outils
 * (chatbotToolsService.js) pertinents à la question posée. La détection d'intention est un choix
 * déterministe par mots-clés (pas un appel LLM) : rapide, gratuit, et suffisant pour orienter vers
 * le bon outil sans faire dépendre le routage lui-même d'un appel réseau supplémentaire.
 */
const prisma = require('../utils/prisma');
const tools = require('./chatbotToolsService');
const { streamWithFallback } = require('./aiForecastService');
const systemConfig = require('./systemConfigService');
const { checkToolPermission, CAPABILITY_LABELS, isEanInUserScope } = require('./aiPermissionsService');

// Noms d'outils valides pour une règle d'intention — sert à ignorer silencieusement une règle
// invalide plutôt que de planter le chatbot si la config CHATBOT_INTENT_RULES est mal éditée
// (ex: faute de frappe sur le nom d'outil depuis un futur outil ajouté à l'UI). Tenu en miroir de
// aiPermissionsService.TOOL_CAPABILITY (sans getStoreStock, jamais une cible directe de règle —
// c'est un repli interne de getArticleStock sans EAN, pas une intention détectable par mot-clé).
const VALID_INTENT_TOOLS = new Set([
  'getPriceChangeHistory', 'getStockMoveHistory', 'getArticleDetails', 'getParetoArticles',
  'getRevenue', 'getStockoutRisks', 'getOverstockArticles', 'getPredictionAccuracy',
  'getOrders', 'getCurrentProposal', 'getSalesHistory', 'getArticleStock',
]);

// Règles par défaut : copie exacte de l'ancien tableau codé en dur, gardée ici comme filet de
// sécurité UNIQUEMENT si la lecture de CHATBOT_INTENT_RULES échoue totalement (base indisponible,
// JSON corrompu au point de ne pas être parsable) — le chatbot ne doit jamais se retrouver sans
// aucune règle de détection. En usage normal, c'est systemConfigService qui fournit déjà ces mêmes
// valeurs par défaut avant toute édition ; celles-ci ne servent que si CET APPEL précis échoue.
const FALLBACK_INTENT_RULES = [
  { keywords: ['changement de prix', 'changé de prix', 'change de prix', 'changement de prix de vente', 'historique de prix', 'historique des prix', 'évolution du prix', 'evolution du prix', 'quand a-t-il changé de prix', 'quand est-ce que le prix', 'log de prix', 'log changement', 'mis en promo', 'mise en promo', 'mis en promotion', 'depuis quand', 'quand est-ce qu\'il', 'quand a-t-il', 'quand il a', 'quand est-il passé', 'a quel moment'], tool: 'getPriceChangeHistory' },
  { keywords: ['pourquoi le stock', 'pourquoi son stock', 'stock a baissé', 'stock a baisse', 'stock a bougé', 'stock a bouge', 'stock a chuté', 'stock a chute', 'stock a diminué', 'stock a diminue', 'mouvement de stock', 'mouvements de stock', 'type de mouvement', 'types de mouvement', 'type de mouvements', 'quel mouvement', 'quels mouvements', 'de la casse', 'en casse', 'casse sur', 'article volé', 'article vole', 'cession de rayon', 'cession entre rayon', 'cession inter-rayon', 'retour fournisseur', 'écart de stock', 'ecart de stock', 'disparition de stock'], tool: 'getStockMoveHistory' },
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

// Cache mémoire court (60s) des règles chargées depuis la config : un rechargement complet à
// CHAQUE question serait un aller-retour base inutile pour une donnée qui change rarement (édition
// manuelle par un admin, pas un flux continu) — même principe que serverCache dans rposClient.js.
let intentRulesCache = null;
let intentRulesCachedAt = 0;
const INTENT_RULES_CACHE_TTL_MS = 60_000;

/**
 * Charge les règles de détection d'intention depuis la config (CHATBOT_INTENT_RULES, éditable
 * depuis Paramètres > IA sans redéploiement — demande du 16/09/2026 : "rend la tab dynamique").
 * Ignore silencieusement une règle individuelle malformée (outil inconnu, keywords vide/absent)
 * plutôt que de faire planter TOUTE la détection d'intention à cause d'une seule règle mal éditée —
 * et retombe entièrement sur FALLBACK_INTENT_RULES si le JSON global est illisible.
 */
async function getIntentRules() {
  const now = Date.now();
  if (intentRulesCache && now - intentRulesCachedAt < INTENT_RULES_CACHE_TTL_MS) return intentRulesCache;

  let rules = FALLBACK_INTENT_RULES;
  try {
    const raw = await systemConfig.getValue(systemConfig.KEYS.CHATBOT_INTENT_RULES);
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const cleaned = parsed.filter((r) => r && Array.isArray(r.keywords) && r.keywords.length && VALID_INTENT_TOOLS.has(r.tool));
      if (cleaned.length) rules = cleaned;
    }
  } catch (err) {
    // JSON corrompu (édition manuelle malheureuse, ou base temporairement indisponible) : reste
    // sur FALLBACK_INTENT_RULES plutôt que de laisser le chatbot sans aucune règle de détection.
  }
  intentRulesCache = rules;
  intentRulesCachedAt = now;
  return rules;
}

function normalize(str) {
  return (str || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Détection d'intention : renvoie le nom de l'outil le plus pertinent, ou null si aucun ne matche. */
// "quels articles font X% du CA" (n'importe quel X, pas seulement 80%) : les mots-clés Pareto
// fixes ('80%', 'part du ca'...) ne couvraient qu'une formulation précise — "font 150% du CA" ou
// "font 30% du CA" contient "du ca" et matchait à tort la règle générique getRevenue (placée après
// Pareto dans INTENT_RULES, mais gagnante puisque Pareto ne matchait rien du tout) — faille trouvée
// le 16/09/2026 lors d'un test exhaustif de questions. Cette regex détecte le motif "article(s) +
// pourcentage + CA" avant la boucle de mots-clés fixes, quel que soit le nombre demandé.
const PARETO_PATTERN_REGEX = /articles?.*\d{1,3}\s*%.*(ca\b|chiffre)|.*\d{1,3}\s*%.*(ca\b|chiffre).*articles?/;

async function detectIntent(question) {
  const normalized = normalize(question);
  if (PARETO_PATTERN_REGEX.test(normalized)) return 'getParetoArticles';
  const rules = await getIntentRules();
  for (const rule of rules) {
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
  // Bornée [1, 100] : un seuil de 0% ou négatif ("font 0% du CA", "-10% du CA" — ce dernier ne
  // matche même pas cette regex faute de signe géré, mais 0 le peut) n'a pas de sens pour un cumul
  // Pareto qui s'arrête au premier article dépassant le seuil — un seuil à 0 s'arrêterait après le
  // tout premier article listé, jamais l'intention réelle de l'utilisateur (faille trouvée le
  // 16/09/2026). Retombe sur le défaut de l'outil (80) plutôt qu'un seuil qui ne représente rien.
  if (!match) return null;
  const value = parseInt(match[1], 10);
  return value >= 1 && value <= 100 ? value : null;
}

/**
 * Tente d'extraire une date explicite (jj/mm/aaaa, jj-mm-aaaa, ou aaaa-mm-jj) mentionnée dans la
 * question, au format ISO "aaaa-mm-jj" attendu par getRevenue. Tolère un jour à un seul chiffre
 * (ex: "9-09-2026") et une frappe imprécise (l'utilisateur peut taper "?" à la place d'un séparateur
 * suite à une erreur clavier) — d'où une regex sur des chiffres séparés par n'importe quel caractère
 * non numérique plutôt qu'un séparateur strict.
 */
/**
 * Extrait une date complète (jj/mm/aaaa) de la question. Gère aussi un JOUR SEUL ("le 14", "au 14
 * septembre") — sans ce cas, "quelle etait le CA du mag le 14" ne matchait AUCUN pattern (aucun
 * mois/année chiffré dans le texte) et `date` restait `null`, faisant retomber getRevenue sur son
 * défaut ("les dernières 24h à partir de maintenant") — une période qui n'a plus rien à voir avec
 * le jour demandé, sans que rien ne le signale à l'utilisateur (faille trouvée le 16/09/2026 : la
 * réponse citait un CA complètement différent du vrai CA RPOS du 14, sans jamais dire "je n'ai pas
 * compris quel jour"). `referenceDate` (mois/année de complément, cf. resolveDayOnlyDate) doit
 * venir de la donnée réelle la plus récente en base pour CE magasin, jamais de l'horloge système —
 * même principe que periodService.js (l'heure système du serveur peut être décalée par rapport aux
 * vraies dates de vente, notamment en environnement de test).
 */
function extractDate(question) {
  const full = (question || '').match(/\b(\d{1,2})\D(\d{1,2})\D(\d{4})\b/) || (question || '').match(/\b(\d{4})\D(\d{1,2})\D(\d{1,2})\b/);
  if (full) {
    // Détermine l'ordre (jj/mm/aaaa vs aaaa/mm/jj) selon la position du groupe à 4 chiffres.
    const [, a, b, c] = full;
    const [day, month, year] = a.length === 4 ? [c, b, a] : [a, b, c];
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  // Jour seul : "le 14", "au 14", "du 14" (jamais un nombre isolé sans ce préfixe, pour éviter de
  // confondre avec une quantité/un pourcentage mentionné ailleurs dans la question).
  const dayOnly = (question || '').match(/\b(?:le|au|du)\s+(\d{1,2})\b/i);
  return dayOnly ? { dayOnly: parseInt(dayOnly[1], 10) } : null;
}

/**
 * Résout un jour seul (1-31) en date complète "aaaa-mm-jj", en complétant mois/année avec la
 * dernière vente locale connue pour ce magasin — jamais avec l'horloge système (cf. extractDate).
 * Prend le mois de cette dernière vente si le jour demandé lui est antérieur ou égal, sinon le mois
 * précédent (question posée pour un jour "futur" par rapport à la dernière donnée connue = c'était
 * forcément le mois d'avant). Retourne null si aucune vente n'existe encore pour ce magasin (rien à
 * compléter).
 */
async function resolveDayOnlyDate(rposShopId, day) {
  if (!Number.isInteger(day) || day < 1 || day > 31) return null; // "le 45" ou similaire : rien à résoudre, pas de date bancale
  const lastSale = await prisma.salesLine.findFirst({
    where: { rposShopId },
    orderBy: { date: 'desc' },
    select: { date: true },
  });
  if (!lastSale) return null;
  const ref = lastSale.date;
  let year = ref.getUTCFullYear();
  let month = ref.getUTCMonth(); // 0-indexé
  if (day > ref.getUTCDate()) {
    month -= 1;
    if (month < 0) { month = 11; year -= 1; }
  }
  const dd = String(day).padStart(2, '0');
  const mm = String(month + 1).padStart(2, '0');
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
async function runToolForQuestion(rposShopId, question, { department, conversationHistory, posId, user } = {}) {
  let toolName = await detectIntent(question);

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
  const ARTICLE_SCOPED_TOOLS = new Set(['getArticleDetails', 'getPriceChangeHistory', 'getArticleStock', 'getSalesHistory', 'getStockMoveHistory']);

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
  const rawDate = extractDate(question);
  const date = rawDate && typeof rawDate === 'object' ? await resolveDayOnlyDate(rposShopId, rawDate.dayOnly) : rawDate;
  const percentage = extractPercentage(question);

  // Permissions IA par capacité (plan de rôles validé le 15/09/2026) : vérifiées ici, APRÈS avoir
  // résolu ean/department, car getRevenue est ambigu (CA magasin vs CA article/département — seul
  // le second est autorisé à un Chef de département) et ne peut être tranché qu'une fois ces
  // paramètres connus. Une permission refusée ne fait JAMAIS planter la conversation : le LLM reçoit
  // un toolResult explicite (found: false + raison), jamais un accès direct bloqué en silence.
  // TOUJOURS appliquée, même si `user` est absent (fail-closed) : un appelant qui omet `user` (bug,
  // futur code, appel direct au service hors route HTTP) ne doit jamais recevoir un accès complet
  // par défaut — faille de sécurité trouvée et corrigée le 15/09/2026 lors de l'audit de robustesse
  // (checkToolPermission gère déjà un user manquant/invalide en fail-closed via ROLE_DEFAULTS).
  {
    const { allowed, capability } = checkToolPermission(user, toolName, { ean: extractEan(question), department });
    if (!allowed) {
      const label = CAPABILITY_LABELS[capability] || capability;
      return { toolName, toolResult: { found: false, permissionDenied: true, message: `Vous n'avez pas accès à ${label} avec votre compte.` } };
    }
  }

  // Un article ciblé explicitement par son EAN (fiche article, historique de prix, stock, ventes...)
  // doit rester dans le rayon assigné d'un Rayonniste/Chef de département — la capacité seule
  // (articleDetails/stock/sales) ne suffit pas, elle est autorisée à tous les rôles par défaut.
  if (ean && ARTICLE_SCOPED_TOOLS.has(toolName)) {
    const inScope = await isEanInUserScope(rposShopId, ean, user);
    if (!inScope) {
      return { toolName, toolResult: { found: false, permissionDenied: true, message: 'Vous n\'avez pas accès à cet article, il n\'est pas dans votre périmètre.' } };
    }
  }

  switch (toolName) {
    case 'getArticleDetails':
      if (!ean) return { toolName, toolResult: { found: false, message: 'Précisez le code EAN de l\'article pour obtenir sa fiche complète (emplacement, prix, promo...).' } };
      if (!posId) return { toolName, toolResult: { found: false, message: 'Serveur RPOS introuvable pour ce magasin.' } };
      return { toolName, toolResult: await tools.getArticleDetails(posId, rposShopId, ean) };
    case 'getPriceChangeHistory':
      if (!ean) return { toolName, toolResult: { found: false, message: 'Précisez le code EAN de l\'article pour consulter son historique de prix.' } };
      if (!posId) return { toolName, toolResult: { found: false, message: 'Serveur RPOS introuvable pour ce magasin.' } };
      return { toolName, toolResult: await tools.getPriceChangeHistory(posId, rposShopId, ean) };
    case 'getStockMoveHistory':
      if (!ean) return { toolName, toolResult: { found: false, message: 'Précisez le code EAN de l\'article pour voir ses mouvements de stock (casse, cession, retour...).' } };
      if (!posId) return { toolName, toolResult: { found: false, message: 'Serveur RPOS introuvable pour ce magasin.' } };
      return { toolName, toolResult: await tools.getStockMoveHistory(posId, rposShopId, ean, { days: 14 }) };
    case 'getParetoArticles':
      return { toolName, toolResult: await tools.getParetoArticles(rposShopId, { thresholdPct: percentage || 80, department }) };
    case 'getRevenue':
      return { toolName, toolResult: await tools.getRevenue(rposShopId, { date, department, ean }) };
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
async function buildChatbotPrompt({ shopReference, shopName, department, subDepartment, conversationHistory, question, toolName, toolResult, reusedFromHistory, suggestedQuestions }) {
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
    // Aucun outil de données identifié pour cette question : deux cas très différents à distinguer
    // (demande du 16/09/2026 : "si je pose une question qu'il ne comprend pas, il doit demander une
    // clarification ou proposer des questions") —
    //   1) la question est AMBIGUË/mal formulée mais se rapproche visiblement d'une capacité connue
    //      (ex: faute de frappe, tournure inhabituelle, référence implicite à "cet article" sans
    //      EAN identifiable) : l'IA doit proposer 1-3 reformulations précises et cliquables plutôt
    //      que de renvoyer la liste générique — l'utilisateur n'a alors qu'à cliquer/recopier au
    //      lieu de deviner la bonne formulation par tâtonnement.
    //   2) la question est HORS PÉRIMÈTRE (aucun rapport avec le réassort/ventes/stock) : là seule
    //      la liste générique des capacités a du sens, une reformulation ne servirait à rien.
    // Le LLM tranche lui-même entre les deux cas au vu de la question réelle — cette distinction ne
    // peut pas être détectée de façon fiable par mots-clés (ARTICLE_SCOPED_TOOLS ne couvre pas tous
    // les cas d'ambiguïté possibles).
    const capabilitiesList = (suggestedQuestions || []).map((q) => `- ${q}`).join('\n');
    dataSection = `Aucun outil de données spécifique n'a été identifié pour cette question — deux cas possibles, à distinguer toi-même :
1) Si la question semble porter sur un sujet couvert (ventes, stock, CA, commandes, article...) mais est formulée de façon ambiguë, incomplète ou avec une faute qui empêche de la traiter avec certitude (ex: référence à "cet article" sans code EAN identifiable, formulation qui pourrait viser plusieurs données différentes) : dis que tu n'es pas sûr de bien comprendre, PUIS propose 1 à 3 reformulations précises et concrètes de CETTE question précise (pas une liste générique) que l'utilisateur peut reposer telles quelles pour obtenir une réponse.
2) Si la question n'a manifestement aucun rapport avec le réassort, les ventes, le stock, les commandes ou la prévision (hors périmètre) : dis clairement que tu ne disposes pas de cette donnée, PUIS liste explicitement (en puces) les types de questions auxquelles tu peux répondre avec des données réelles, à partir de cette liste :\n${capabilitiesList}`;
  }

  // Persona/ton/consignes de format éditables depuis Paramètres > IA (CHATBOT_PROMPT_TEMPLATE,
  // demande du 16/09/2026 : "il ne faut pas mettre en dur dans le code"), avec placeholders
  // {{context}}/{{dataSection}}/{{historySection}}/{{question}} remplacés ici. La règle
  // anti-hallucination (§35) et les consignes sur salesCount/articleLineCount restent codées en
  // dur ci-dessous, préfixées avant le template — jamais dans la partie éditable, pour qu'une
  // modification depuis l'UI ne puisse jamais désactiver cette protection.
  const template = await systemConfig.getValue(systemConfig.KEYS.CHATBOT_PROMPT_TEMPLATE);
  const historySection = historyText ? `Échanges précédents dans cette conversation :\n${historyText}\n\n` : '';
  const persona = template
    .replace('{{context}}', context)
    .replace('{{dataSection}}', dataSection)
    .replace('{{historySection}}', historySection)
    .replace('{{question}}', question);

  return `RÈGLE ABSOLUE (§35 du cahier des charges) : ne réponds JAMAIS avec un chiffre ou une donnée que tu n'as pas reçue explicitement ci-dessous. Si l'information demandée n'est pas dans les données fournies, dis-le clairement plutôt que d'inventer.

Si les données contiennent un champ "salesCount"/"totalSalesCount" (nombre de ventes = tickets de caisse distincts) non nul : c'est la bonne réponse à "combien de ventes"/"nombre de ventes", y compris par article ou par jour précis (dailyHistory[].salesCount pour un jour donné). Si ce champ est null, dis explicitement que le nombre de tickets n'est pas disponible pour cette période plutôt que d'utiliser "articleLineCount"/"totalQuantity"/"quantity" à sa place. Les champs "articleLineCount"/"totalQuantity"/"quantity" sont des LIGNES ou QUANTITÉS d'articles vendus (un article vendu = une ligne, plusieurs unités possibles par vente) : ne les présente JAMAIS comme "nombre de ventes" ou "nombre de tickets" — utilise-les seulement si la question porte explicitement sur le nombre/la quantité d'articles vendus.

${persona}`;
}

/**
 * Point d'entrée principal : détecte l'intention, appelle l'outil si pertinent, construit le prompt,
 * puis streame la réponse du LLM via onTextChunk (même mécanisme que askFollowUpQuestion).
 */
async function askAssistant({ rposShopId, posId, shopReference, shopName, department, subDepartment, conversationHistory, question, onTextChunk, user }) {
  const { toolName, toolResult, reusedFromHistory } = await runToolForQuestion(rposShopId, question, { department, conversationHistory, posId, user });
  const suggestedQuestions = toolResult || reusedFromHistory ? null : await getSuggestedQuestions();
  const prompt = await buildChatbotPrompt({ shopReference, shopName, department, subDepartment, conversationHistory, question, toolName, toolResult, reusedFromHistory, suggestedQuestions });

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

module.exports = { askAssistant, detectIntent, extractEan, getSuggestedQuestions, VALID_INTENT_TOOLS };
