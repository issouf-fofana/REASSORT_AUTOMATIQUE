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
const { streamWithFallback, callWithFallback } = require('./aiForecastService');
const systemConfig = require('./systemConfigService');
const { checkToolPermission, CAPABILITY_LABELS, isEanInUserScope } = require('./aiPermissionsService');
const featureRequestService = require('./featureRequestService');

// Noms d'outils valides pour une règle d'intention — sert à ignorer silencieusement une règle
// invalide plutôt que de planter le chatbot si la config CHATBOT_INTENT_RULES est mal éditée
// (ex: faute de frappe sur le nom d'outil depuis un futur outil ajouté à l'UI). Tenu en miroir de
// aiPermissionsService.TOOL_CAPABILITY (sans getStoreStock, jamais une cible directe de règle —
// c'est un repli interne de getArticleStock sans EAN, pas une intention détectable par mot-clé).
const VALID_INTENT_TOOLS = new Set([
  'getPriceChangeHistory', 'getStockMoveHistory', 'getArticleDetails', 'getArticlesByGisement', 'getTopGisements', 'getParetoArticles',
  'getRevenue', 'getRevenueAllShops', 'getStockoutRisks', 'getOverstockArticles', 'getPredictionAccuracy',
  'getOrders', 'getCurrentProposal', 'getSalesHistory', 'getArticleStock', 'getArticleStockAllShops', 'getDlvArticles', 'getArticleDlvStatus',
]);

// Règles par défaut : copie exacte de l'ancien tableau codé en dur, gardée ici comme filet de
// sécurité UNIQUEMENT si la lecture de CHATBOT_INTENT_RULES échoue totalement (base indisponible,
// JSON corrompu au point de ne pas être parsable) — le chatbot ne doit jamais se retrouver sans
// aucune règle de détection. En usage normal, c'est systemConfigService qui fournit déjà ces mêmes
// valeurs par défaut avant toute édition ; celles-ci ne servent que si CET APPEL précis échoue.
const FALLBACK_INTENT_RULES = [
  { keywords: ['changement de prix', 'changé de prix', 'change de prix', 'changement de prix de vente', 'historique de prix', 'historique des prix', 'évolution du prix', 'evolution du prix', 'quand a-t-il changé de prix', 'quand est-ce que le prix', 'le prix a changé', 'le prix a change', 'quand le prix', 'prix a changé', 'log de prix', 'log changement', 'mis en promo', 'mise en promo', 'mis en promotion', 'depuis quand', 'quand est-ce qu\'il', 'quand a-t-il', 'quand il a', 'quand est-il passé', 'a quel moment'], tool: 'getPriceChangeHistory' },
  { keywords: ['pourquoi le stock', 'pourquoi son stock', 'stock a baissé', 'stock a baisse', 'stock a bougé', 'stock a bouge', 'stock a chuté', 'stock a chute', 'stock a diminué', 'stock a diminue', 'mouvement de stock', 'mouvements de stock', 'type de mouvement', 'types de mouvement', 'type de mouvements', 'quel mouvement', 'quels mouvements', 'de la casse', 'en casse', 'casse sur', 'article volé', 'article vole', 'cession de rayon', 'cession entre rayon', 'cession inter-rayon', 'retour fournisseur', 'écart de stock', 'ecart de stock', 'disparition de stock'], tool: 'getStockMoveHistory' },
  { keywords: ['où se trouve', 'ou se trouve', 'emplacement', 'où est', 'ou est', 'quel rayon', 'dans quel rayon', 'adresse rayon', 'prix actuel', 'prix de vente', 'prix promo', 'en promo', 'promotion', 'quel prix', 'combien coûte', 'combien coute', 'fiche article', 'fiche produit', 'fiche complète', 'fiche complete', 'détails de l\'article', 'details de larticle', 'infos article', 'informations sur l\'article', 'toutes les informations', 'tout savoir sur', 'caractéristiques', 'caracteristiques', 'fournisseur de'], tool: 'getArticleDetails' },
  { keywords: ['pareto', '80%', '80 %', 'part du ca', 'part de ca', 'représentent le plus de ca', 'font le plus de ca', 'articles principaux', 'gros vendeurs', 'meilleures ventes', 'top articles', 'top vente'], tool: 'getParetoArticles' },
  { keywords: ['chiffre d\'affaires', 'chiffre daffaire', 'chiffre d affaire', 'le ca', 'du ca', 'au ca', 'ton ca', 'mon ca', 'quel ca', 'ca du', 'ca le', 'ca est', 'ca de', 'combien on a fait', 'combien jai fait', 'combien on a vendu en argent', 'recette du jour', 'recette de'], tool: 'getRevenue' },
  { keywords: ['rupture', 'stock critique', 'risque de rupture', 'va manquer', 'vont manquer', 'plus de stock', 'articles en manque', 'articles manquants', 'quoi va manquer'], tool: 'getStockoutRisks' },
  { keywords: ['surstock', 'trop de stock', 'sur-stock', 'excès de stock', 'exces de stock', 'trop stocké', 'trop stocke', 'articles en trop'], tool: 'getOverstockArticles' },
  { keywords: ['précision', 'fiabilité', 'accuracy', 'erreur de prévision', 'la prévision est bonne', 'fiable', 'lia se trompe', 'l\'ia se trompe', 'taux de reussite', 'taux de réussite'], tool: 'getPredictionAccuracy' },
  // Le mot-clé générique 'commande' seul a été retiré (bug trouvé le 21/09/2026, campagne de
  // fuzzing large) : matchait à tort par sous-chaîne "commander", "commandé", "commandes anormales"
  // — écrasant getCurrentProposal ("quoi commander") et getOverstockArticles ("trop commandé") dans
  // 5 cas sur 8 échecs trouvés. Ne garder que des expressions assez précises pour ne jamais matcher
  // un simple verbe conjugué ou une question sur un AUTRE sujet contenant accidentellement ce radical.
  { keywords: ['mes commandes', 'commandes en cours', 'commandes récentes', 'liste des commandes', 'qu\'est-ce qui a été commandé', 'quest ce qui a ete commande', 'quoi a ete commande', 'derniere commande', 'dernières commandes'], tool: 'getOrders' },
  // "aujourd'hui" retiré (bug trouvé le 21/09/2026, campagne de fuzzing large) : trop générique,
  // matchait à tort N'IMPORTE QUELLE question du jour (ex: "chiffre d'affaire aujourd'hui" tombait
  // sur getCurrentProposal au lieu de getRevenue). "proposition"/"commander" restent assez précis
  // pour cet outil sans avoir besoin de ce mot-clé fourre-tout.
  { keywords: ['proposition', 'proposition en attente', 'proposition du jour', 'proposition de commande', 'quoi commander', 'que dois-je commander', 'quest ce que je dois commander', 'a commander'], tool: 'getCurrentProposal' },
  { keywords: ['vente', 'ventes', 'évolution', 'combien vendu', 'combien vendus', 'combien on a vendu', 'tendance', 'ca se vend comment', 'comment ca vend'], tool: 'getSalesHistory' },
  { keywords: ['stock de', 'stock actuel', 'stock disponible', 'combien il reste', 'combien il en reste', 'reste combien', 'il reste combien', 'disponibilite', 'disponibilité', 'est-il disponible', 'est il disponible'], tool: 'getArticleStock' },
  // DLV (demande du 22/09/2026) : PAS une date de péremption, un stock basculé manuellement par le
  // personnel sur un EAN distinct pour écoulement à prix réduit — cf. chatbotToolsService.js.
  { keywords: ['dlv', 'dlc', 'date limite de vente', 'date limite de consommation', 'péremption', 'peremption', 'articles à écouler', 'articles a ecouler', 'stock à solder', 'stock a solder', 'en dlv', 'proche de la peremption', 'proche de la péremption'], tool: 'getDlvArticles' },
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

// "gisement"/"adressage" (position physique de stockage en magasin, distincte du rayon/département)
// doit gagner sur toute règle générique concurrente (ex: "ventes", "chiffre") — sans cette priorité,
// une question comme "tops ventes du gisement X" matche d'abord getSalesHistory (mot-clé "ventes")
// et le LLM n'a jamais l'occasion de router vers getArticlesByGisement (bug trouvé le 18/09/2026 :
// le nouvel outil n'était utilisable QUE si la question ne contenait aucun autre mot-clé concurrent).
// Deux formes : un nom précis après le mot ("du gisement PETITS ELECTRO-MENAGERS", capturé), ou
// juste le mot seul/générique ("chaque gisement", "tous les gisements", "par gisement" — aucun
// nom capturable). Router vers getArticlesByGisement dans LES DEUX CAS : sans nom, l'outil répond
// lui-même "précisez le gisement" (réponse honnête) plutôt que de retomber sur un autre outil qui
// donnerait une fausse impression de réponse correcte (bug trouvé le 18/09/2026 : "tops ventes de
// CHAQUE gisement", sans nom, retombait sur getSalesHistory qui répondait un classement plausible
// mais sans aucun rapport avec un gisement).
const GISEMENT_MENTION_REGEX = /\b(?:gisement|adressage)s?\b/i;
const GISEMENT_NAME_REGEX = /\b(?:gisement|adressage)s?\s+(?:de\s+|du\s+|au\s+|le\s+)?([^?.!]+)/i;

// "tous/chaque/l'ensemble de mes magasins" en même temps qu'une question de CA (demande du
// 19/09/2026, réservé ADMIN/SUPERVISOR — cf. runToolForQuestion) doit gagner sur la règle générique
// getRevenue (mot-clé "ca") — sans cette priorité, "quel est le CA de tous les magasins" retombait
// sur getRevenue (mono-magasin, celui de la conversation en cours), donnant une fausse impression
// de réponse correcte pour une seule agence au lieu du classement demandé.
const ALL_SHOPS_REVENUE_REGEX = /\b(tous les|toutes les|chaque|l'ensemble des?|l'ensemble de mes|mes)\s+magasins?\b.*\b(ca\b|chiffre)|\b(ca\b|chiffre).*\b(tous les|toutes les|chaque|l'ensemble des?|l'ensemble de mes|mes)\s+magasins?\b/i;

// Même principe que ALL_SHOPS_REVENUE_REGEX (demande du 25/09/2026, "dans tout les magasin ... il
// peux chercher") : "tous/chaque/l'ensemble de mes magasins" en même temps qu'une question de stock
// doit gagner sur la règle générique getArticleStock (mono-magasin).
const ALL_SHOPS_STOCK_REGEX = /\b(tous les|toutes les|chaque|l'ensemble des?|l'ensemble de mes|mes)\s+magasins?\b.*\bstocks?\b|\bstocks?\b.*\b(tous les|toutes les|chaque|l'ensemble des?|l'ensemble de mes|mes)\s+magasins?\b/i;

async function detectIntent(question) {
  const normalized = normalize(question);
  if (PARETO_PATTERN_REGEX.test(normalized)) return 'getParetoArticles';
  if (ALL_SHOPS_REVENUE_REGEX.test(question)) return 'getRevenueAllShops';
  if (ALL_SHOPS_STOCK_REGEX.test(question)) return 'getArticleStockAllShops';
  if (GISEMENT_MENTION_REGEX.test(question)) return 'getArticlesByGisement';
  const rules = await getIntentRules();
  for (const rule of rules) {
    if (rule.keywords.some((kw) => normalized.includes(normalize(kw)))) return rule.tool;
  }
  return null;
}

/**
 * Extrait le nom du gisement mentionné dans la question ("le gisement <nom>"), ou null si le mot
 * apparaît seul/générique ("chaque gisement", "tous les gisements") — dans ce dernier cas,
 * getArticlesByGisement reçoit gisementQuery=null et répond lui-même "précisez lequel".
 */
function extractGisement(question) {
  const match = (question || '').match(GISEMENT_NAME_REGEX);
  if (!match) return null;
  const captured = match[1].trim();
  // Un mot générique/de liaison juste après ("gisement chaque", "gisements tous/tout", "gisements
  // SUR 90 jours" — trouvé en fuzzing le 18/09/2026, "sur 90 jours" capturé à tort comme faux nom
  // de gisement) ne désigne aucun nom réel — évite de chercher un "gisement" littéralement nommé
  // d'après un de ces mots.
  const GENERIC_WORDS = new Set(['chaque', 'tous', 'tout', 'toutes', 'les', 'des', 'de', 'sur', 'pour', 'avec', 'dans']);
  const firstWord = captured.split(/\s+/)[0].toLowerCase();
  return GENERIC_WORDS.has(firstWord) ? null : captured;
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
 * Tente d'extraire un nombre de jours explicite ("sur 90 jours", "les 60 derniers jours") mentionné
 * dans la question — utilisé par getTopGisements (ajouté le 18/09/2026, faille trouvée en fuzzing :
 * "top gisements sur 90 jours" ignorait complètement le "90 jours" et utilisait le défaut 30j).
 * Bornée [1, 365] : au-delà, le volume RPOS/local devient peu réaliste pour ce calcul.
 */
function extractDays(question) {
  // Un ou deux mots de liaison optionnels entre le nombre et "jour(s)" (ex: "30 DERNIERS jours",
  // "7 jours GLISSANTS") — la forme stricte "X jours" collée ratait ces formulations pourtant
  // courantes (bug trouvé le 19/09/2026 : "sur les 30 derniers jours" ignoré, days retombait à 1).
  const match = (question || '').match(/\b(\d{1,3})\s+(?:\w+\s+){0,2}?jours?\b/i);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  return value >= 1 && value <= 365 ? value : null;
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

// Catalogue des outils présenté au LLM pour le function-calling de repli (voir TOOL_CALL_SYSTEM
// PROMPT ci-dessous). Signature UNIFORME (rposShopId implicite + params nommés) pour les 13 outils,
// y compris les 3 dont la vraie fonction JS prend des paramètres positionnels différents
// (getArticleDetails/getPriceChangeHistory/getStockMoveHistory prennent posId/shopId/ean en positionnel
// — cf. chatbotToolsService.js) : la traduction vers la vraie signature se fait dans
// callToolByName ci-dessous, jamais exposée au LLM qui ne doit connaître qu'une forme simple.
const TOOL_CATALOG = [
  { name: 'getRevenue', description: 'Chiffre d\'affaires (CA) du magasin, d\'un rayon ou d\'un article, sur une date ou période.', params: { date: 'date ISO aaaa-mm-jj, optionnel', department: 'rayon, optionnel', ean: 'code EAN article, optionnel' } },
  { name: 'getRevenueAllShops', description: 'Classement du CA de TOUS les magasins accessibles à l\'utilisateur (réservé aux comptes multi-magasins) — utile pour "le CA de tous les magasins", "chiffre d\'affaires de chaque magasin", jamais pour une question sur UN seul magasin précis.', params: { date: 'date ISO aaaa-mm-jj, optionnel' } },
  { name: 'getSalesHistory', description: 'Historique/évolution des ventes (quantités, tendance) sur les derniers jours, du magasin ou d\'un article.', params: { ean: 'code EAN article, optionnel', days: 'nombre de jours, optionnel (défaut 30)', department: 'rayon, optionnel' } },
  { name: 'getArticleDetails', description: 'Fiche complète d\'un article précis : emplacement/rayon, prix actuel, promo en cours, fournisseur.', params: { ean: 'code EAN article, OBLIGATOIRE' } },
  { name: 'getArticlesByGisement', description: 'Liste tous les articles rangés dans un gisement précis (position physique de stockage en magasin, ex: "PETITS ELECTRO-MENAGERS", "ACCESSOIRES DE CUISINE") — à ne pas confondre avec le rayon/département (classification produit). Utile pour "quels articles sont dans tel gisement", "tops ventes par gisement/emplacement".', params: { gisement: 'nom ou code approximatif du gisement recherché, OBLIGATOIRE' } },
  { name: 'getTopGisements', description: 'Classement des gisements (positions physiques de stockage) par chiffre d\'affaires généré — utile quand la question porte sur les gisements SANS en nommer un précis (ex: "top des gisements", "quels gisements vendent le plus").', params: { days: 'nombre de jours de la période, optionnel (défaut 30)' } },
  { name: 'getPriceChangeHistory', description: 'Historique des changements de prix (dont mises en promo) d\'un article précis.', params: { ean: 'code EAN article, OBLIGATOIRE' } },
  { name: 'getStockMoveHistory', description: 'Mouvements de stock d\'un article précis (casse, vol, cession de rayon, retour fournisseur) expliquant une variation de stock.', params: { ean: 'code EAN article, OBLIGATOIRE' } },
  { name: 'getArticleStock', description: 'Stock actuel disponible, du magasin entier/un rayon, ou d\'un article précis si un EAN est donné.', params: { ean: 'code EAN article, optionnel', department: 'rayon, optionnel' } },
  { name: 'getArticleStockAllShops', description: 'Stock d\'un article précis dans TOUS les magasins accessibles à l\'utilisateur (réservé aux comptes multi-magasins) — utile pour "le stock de l\'article X dans tous les magasins", jamais pour une question sur UN seul magasin précis.', params: { ean: 'code EAN article, requis' } },
  { name: 'getCurrentProposal', description: 'Proposition de réassort du jour (quoi commander), du magasin ou d\'un rayon.', params: { department: 'rayon, optionnel' } },
  { name: 'getStockoutRisks', description: 'Articles en risque de rupture de stock prochainement.', params: { department: 'rayon, optionnel' } },
  { name: 'getOverstockArticles', description: 'Articles en surstock (trop de stock par rapport aux ventes).', params: { department: 'rayon, optionnel' } },
  { name: 'getParetoArticles', description: 'Articles Pareto : ceux qui réalisent le plus gros pourcentage du chiffre d\'affaires (loi des 80/20).', params: { thresholdPct: 'seuil en pourcentage 1-100, optionnel (défaut 80)', department: 'rayon, optionnel' } },
  { name: 'getPredictionAccuracy', description: 'Fiabilité/précision des prévisions de l\'IA (taux de réussite, erreur de prévision).', params: {} },
  { name: 'getOrders', description: 'Commandes récentes passées par le magasin.', params: {} },
  { name: 'getDlvArticles', description: 'Articles ayant actuellement du stock en DLV (Date Limite de Vente courte — un stock basculé manuellement par le personnel sur un EAN distinct pour écoulement à prix réduit, PAS une date de péremption automatique), du magasin entier ou d\'un article précis si un EAN est donné.', params: { ean: 'code EAN article, optionnel' } },
];

const TOOL_CALL_SYSTEM_PROMPT_HEADER = `Tu es un routeur d'intention pour un assistant de réassort en magasin. Voici la liste des outils de données disponibles, au format JSON :
${JSON.stringify(TOOL_CATALOG, null, 2)}

Question de l'utilisateur : `;

const TOOL_CALL_INSTRUCTIONS = `

Réponds UNIQUEMENT avec un tableau JSON contenant UN SEUL objet, sans aucun texte avant ni après, au format exact :
[{"tool": "<nom exact d'un outil ci-dessus, ou null si aucun ne correspond>", "params": {<paramètres nommés selon la description de l'outil choisi, ou objet vide>}}]
Si un outil exige un EAN "OBLIGATOIRE" et qu'aucun code EAN n'est identifiable dans la question, réponds tool: null plutôt que d'inventer un EAN.`;

/**
 * Filet de repli n°3 (après mots-clés, EAN explicite, continuation d'historique) : quand aucune
 * règle déterministe n'a permis d'identifier un outil, on demande au LLM lui-même de choisir parmi
 * le catalogue — plutôt que d'abandonner directement sur "je ne comprends pas" pour une question mal
 * formulée par rapport aux mots-clés connus mais dont l'intention réelle est claire pour un LLM.
 * Approche "JSON structuré par prompt" (validée le 17/09/2026) plutôt que function-calling natif de
 * chaque fournisseur : un seul prompt uniforme, réutilise callWithFallback tel quel (même bascule
 * multi-clés que le reste du chatbot), aucun adaptateur par fournisseur à maintenir. Ne remplace
 * JAMAIS le routage par mots-clés (rapide et gratuit) — n'est appelé qu'en dernier recours.
 * Ne fait JAMAIS planter la conversation : toute erreur (LLM indisponible, JSON invalide, outil
 * inconnu) retombe silencieusement sur null, exactement comme si aucune intention n'avait été
 * détectée.
 */
async function detectIntentViaLlm(question) {
  try {
    const prompt = TOOL_CALL_SYSTEM_PROMPT_HEADER + question + TOOL_CALL_INSTRUCTIONS;
    const { result } = await callWithFallback(prompt, 'chatbot-intent-routing');
    const choice = Array.isArray(result) ? result[0] : null;
    if (!choice || !choice.tool) return null;
    if (!VALID_INTENT_TOOLS.has(choice.tool)) return null;
    return { toolName: choice.tool, params: choice.params && typeof choice.params === 'object' ? choice.params : {} };
  } catch (err) {
    // LLM indisponible, JSON mal formé, toutes les clés en échec... : jamais remonté à l'utilisateur,
    // le chatbot se comporte comme si aucun outil n'avait été identifié (message générique existant).
    return null;
  }
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

  // "gisement" + un EAN explicite ("quel gisement pour l'article X", "gisement de l'article X") :
  // la question demande LE gisement DE cet article précis, pas une liste d'articles D'UN gisement —
  // sens inverse de getArticlesByGisement, déjà couvert par getArticleDetails (champ location, cf.
  // chatbotToolsService.js) sans nouveau tool. Doit gagner sur GISEMENT_MENTION_REGEX (bug trouvé le
  // 18/09/2026 lors d'un test de fuzzing : "quel gisement pour l'article 100144265" répondait
  // "aucun gisement trouvé" au lieu de chercher le gisement DE cet article précis).
  if (toolName === 'getArticlesByGisement' && extractEan(question)) toolName = 'getArticleDetails';

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

  // Filet de sécurité n°3 : function-calling par LLM (cf. detectIntentViaLlm), dernier recours
  // avant d'abandonner — uniquement si aucune règle déterministe ci-dessus n'a rien trouvé du tout.
  let llmParams = null;
  if (!toolName) {
    const llmFallbackEnabled = (await systemConfig.getValue(systemConfig.KEYS.CHATBOT_LLM_FALLBACK_ENABLED)) === 'true';
    if (llmFallbackEnabled) {
      const llmChoice = await detectIntentViaLlm(question);
      if (llmChoice) { toolName = llmChoice.toolName; llmParams = llmChoice.params; }
    }
  }

  if (!toolName) return { toolName: null, toolResult: null };

  let ean = extractEan(question) || (llmParams && ARTICLE_SCOPED_TOOLS.has(toolName) ? llmParams.ean : null) || null;
  if (!ean && ARTICLE_SCOPED_TOOLS.has(toolName) && conversationHistory && conversationHistory.length) {
    for (let i = conversationHistory.length - 1; i >= 0; i--) {
      const pastEan = extractEan(conversationHistory[i].question);
      if (pastEan) { ean = pastEan; break; }
    }
  }
  const rawDate = extractDate(question);
  const date = (rawDate && typeof rawDate === 'object' ? await resolveDayOnlyDate(rposShopId, rawDate.dayOnly) : rawDate) || (llmParams ? llmParams.date : null) || null;
  const percentage = extractPercentage(question) || (llmParams ? llmParams.thresholdPct : null) || null;
  const gisementQuery = extractGisement(question) || (llmParams ? llmParams.gisement : null) || null;
  const daysQuery = extractDays(question) || (llmParams ? llmParams.days : null) || null;

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
    const { allowed, capability } = checkToolPermission(user, toolName, { ean, department });
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

  // Tout appel d'outil peut lever une exception (RPOS injoignable, timeout réseau — cf. rposClient.js)
  // en plus de retourner normalement un found:false. Sans ce filet, une panne RPOS transitoire ferait
  // planter TOUTE la conversation avec une exception non gérée au lieu de dégrader proprement comme le
  // reste du chatbot (bug trouvé le 17/09/2026 lors d'une campagne de test de robustesse : une question
  // ciblant un article via un EAN inventé par le LLM, sans RPOS joignable, remontait une exception brute
  // jusqu'à l'appelant HTTP au lieu d'un message d'erreur normal).
  try {
    switch (toolName) {
      case 'getArticleDetails':
        if (!ean) return { toolName, toolResult: { found: false, message: 'Précisez le code EAN de l\'article pour obtenir sa fiche complète (emplacement, prix, promo...).' } };
        if (!posId) return { toolName, toolResult: { found: false, message: 'Serveur RPOS introuvable pour ce magasin.' } };
        return { toolName, toolResult: await tools.getArticleDetails(posId, rposShopId, ean) };
      case 'getArticlesByGisement':
        if (!posId) return { toolName, toolResult: { found: false, message: 'Serveur RPOS introuvable pour ce magasin.' } };
        // Aucun nom de gisement précisé ("chaque gisement", "mes gisements") : bascule sur un
        // classement TOP gisements (getTopGisements) plutôt que de bloquer sur "précisez lequel" —
        // répond réellement à l'intention de la question plutôt que de forcer une reformulation
        // (demande du 18/09/2026).
        if (!gisementQuery) return { toolName: 'getTopGisements', toolResult: await tools.getTopGisements(posId, rposShopId, { days: daysQuery || 30 }) };
        return { toolName, toolResult: await tools.getArticlesByGisement(posId, rposShopId, gisementQuery, { days: daysQuery || 30 }) };
      case 'getTopGisements':
        if (!posId) return { toolName, toolResult: { found: false, message: 'Serveur RPOS introuvable pour ce magasin.' } };
        return { toolName, toolResult: await tools.getTopGisements(posId, rposShopId, { days: daysQuery || 30 }) };
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
      case 'getRevenueAllShops': {
        // Réservé ADMIN/SUPERVISOR (demande du 19/09/2026) : un DIRECTOR/DEPARTMENT_HEAD/
        // SHELF_STOCKER (compte à un seul magasin fixe) retombe silencieusement sur SON magasin
        // seul plutôt que sur une erreur — cohérent avec le principe qu'une question mal formulée
        // ne doit jamais planter, et un classement à un seul élément reste une réponse valide.
        if (!user || (user.role !== 'ADMIN' && user.role !== 'SUPERVISOR')) {
          return { toolName, toolResult: await tools.getRevenue(rposShopId, { date, department, ean }) };
        }
        const allowedShopIds = user.role === 'ADMIN'
          ? (await prisma.shop.findMany({ select: { rposShopId: true } })).map((s) => s.rposShopId)
          : (await prisma.supervisedShop.findMany({ where: { userId: user.id }, select: { rposShopId: true } })).map((s) => s.rposShopId);
        return { toolName, toolResult: await tools.getRevenueAllShops(allowedShopIds, { date, days: daysQuery || 1 }) };
      }
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
      case 'getArticleStockAllShops': {
        if (!ean) return { toolName, toolResult: { found: false, message: "Précisez le code EAN de l'article pour consulter son stock dans tous les magasins." } };
        // Même repli que getRevenueAllShops : un compte à un seul magasin fixe retombe
        // silencieusement sur SON magasin seul plutôt que sur une erreur.
        if (!user || (user.role !== 'ADMIN' && user.role !== 'SUPERVISOR')) {
          return { toolName: 'getArticleStock', toolResult: await tools.getArticleStock(rposShopId, ean) };
        }
        const allowedShopIds = user.role === 'ADMIN'
          ? (await prisma.shop.findMany({ select: { rposShopId: true } })).map((s) => s.rposShopId)
          : (await prisma.supervisedShop.findMany({ where: { userId: user.id }, select: { rposShopId: true } })).map((s) => s.rposShopId);
        return { toolName, toolResult: await tools.getArticleStockAllShops(allowedShopIds, ean) };
      }
      case 'getDlvArticles':
        return ean
          ? { toolName: 'getArticleDlvStatus', toolResult: await tools.getArticleDlvStatus(rposShopId, ean) }
          : { toolName, toolResult: await tools.getDlvArticles(rposShopId, {}) };
      default:
        return { toolName: null, toolResult: null };
    }
  } catch (err) {
    return { toolName, toolResult: { found: false, message: `Donnée momentanément indisponible (${err.message}). Réessayez dans quelques instants.` } };
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
    // getParetoArticles (demande du 19/09/2026 : "quand on demande les articles qui font 80% du CA,
    // qu'il découpe par rayon") — le JSON contient DEUX classements (departments, groupé par rayon
    // réel, ET lines, détail par article individuel) : sans cette consigne explicite, le LLM
    // choisissait tantôt l'un tantôt l'autre selon la formulation de la question, incohérent d'une
    // fois à l'autre pour la même intention.
    const paretoNote = toolName === 'getParetoArticles'
      ? '\n\nIMPORTANT pour cette réponse : présente le classement PAR RAYON (champ "departments" du JSON, déjà trié par part de CA décroissante) comme structure principale de ta réponse — jamais la liste "lines" (détail par article individuel) sauf si la question porte explicitement sur des articles précis plutôt que des rayons. Pour chaque rayon, indique son nom, sa part de CA et son nombre d\'articles contributeurs.'
        + (toolResult.departmentDataIncomplete
          ? ` ATTENTION : "Rayon non renseigné" représente ${toolResult.unassignedRevenueSharePct}% du CA, une part anormalement élevée — signale-le explicitement dans ta réponse comme une limite de données actuelle (la dernière génération de proposition ne couvre probablement pas assez d'articles pour connaître leur rayon), pas comme un vrai rayon au même titre que les autres.`
          : '')
      : '';
    dataSection = `Données réelles récupérées pour répondre (outil "${toolName}", résultat JSON — utilise UNIQUEMENT ces données, ne complète jamais avec une supposition) :\n${JSON.stringify(toolResult, null, 2)}${paretoNote}`;
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
 * Décide si la conversation en cours doit donner lieu à l'enregistrement (ou l'enrichissement) d'une
 * demande d'évolution produit (spec "Comportement général de l'IA", demande du 25/09/2026, règles
 * §2-§9) — appelé UNIQUEMENT quand aucun outil de données n'a répondu à la question (sinon ce n'est
 * pas un manque fonctionnel, juste une question normale déjà traitée). Un second appel LLM séparé de
 * la réponse conversationnelle (celle-ci reste streamée normalement) : ce second appel raisonne sur
 * TOUTE la conversation pour juger si (a) elle contient assez d'information pour constituer une
 * demande exploitable, et (b) l'utilisateur ne pose pas juste une question hors périmètre sans
 * intention d'évolution (§14 : ne pas transformer toute conversation en ticket).
 * Ne fait JAMAIS planter la conversation ni prétendre avoir enregistré quoi que ce soit qui ne l'a
 * pas été réellement (§9) : une erreur à n'importe quelle étape retombe silencieusement sur featureRequest: null.
 */
async function maybeTrackFeatureRequest({ conversationHistory, question, answer }) {
  try {
    const llmFeatureTrackingEnabled = (await systemConfig.getValue(systemConfig.KEYS.CHATBOT_FEATURE_TRACKING_ENABLED)) === 'true';
    if (!llmFeatureTrackingEnabled) return null;

    const historyText = (conversationHistory || [])
      .map((turn) => `Utilisateur : ${turn.question}\nAssistant : ${turn.answer}`)
      .join('\n\n');

    const prompt = `Tu analyses une conversation entre un utilisateur et l'assistant IA d'une application de gestion de stock/réassort en magasin. L'assistant vient de répondre qu'il ne pouvait pas répondre avec certitude à la dernière question (fonctionnalité manquante, donnée non disponible, ou question hors périmètre des données réelles).

Conversation précédente :
${historyText || '(aucune)'}

Dernière question de l'utilisateur : "${question}"
Réponse de l'assistant : "${answer}"

Détermine si cette conversation révèle un VRAI besoin d'évolution du produit (une fonctionnalité manquante ou une amélioration que l'utilisateur souhaite concrètement), à distinguer d'une simple question mal comprise ou totalement hors sujet.

Réponds UNIQUEMENT avec un tableau JSON contenant UN SEUL objet, sans aucun texte avant ni après, au format exact :
[{"isFeatureRequest": true/false, "readyToRecord": true/false, "title": "<titre court, ou null>", "problem": "<résumé fidèle du besoin tel qu'exprimé par l'utilisateur, sans rien inventer, ou null>", "expectedBehavior": "<comportement attendu s'il a été précisé, ou null>", "clarifyingQuestion": "<UNE seule question précise à poser à l'utilisateur pour compléter ce besoin, ou null>"}]

"readyToRecord" doit être false si le besoin est réel mais encore trop vague pour être exploitable par un développeur sans poser de question de clarification supplémentaire — dans ce cas, remplis "clarifyingQuestion" avec une question concrète (ex: "Voulez-vous exporter uniquement les graphiques, ou l'ensemble de l'analyse avec les chiffres ?") plutôt que de laisser deviner ce qui manque. Ne remplis JAMAIS "clarifyingQuestion" quand "readyToRecord" est true (le besoin est déjà assez clair).`;

    // callWithFallback (aiForecastService.js) applique TOUJOURS parseJsonArrayFromText côté chaque
    // fournisseur : la réponse attendue est systématiquement un TABLEAU JSON, jamais un objet nu —
    // même contrainte que detectIntentViaLlm ci-dessus.
    const { result } = await callWithFallback(prompt, 'chatbot-feature-tracking');
    const decision = Array.isArray(result) ? result[0] : null;
    if (!decision || !decision.isFeatureRequest || !decision.title || !decision.problem) return null;

    return decision;
  } catch (err) {
    console.error('[chatbotService] Analyse de suivi des demandes d\'évolution indisponible:', err.message);
    return null;
  }
}

/**
 * Enregistre effectivement la demande décidée par maybeTrackFeatureRequest : cherche d'abord une
 * demande similaire déjà ouverte (§4) pour l'enrichir (§5-§6) plutôt que d'en créer une nouvelle (§7).
 * Retourne un résumé factuel de ce qui a RÉELLEMENT été fait, pour que le texte de réponse au client
 * (cf. askAssistant) ne prétende jamais un enregistrement qui n'a pas eu lieu (§9).
 */
async function recordFeatureRequest(decision, { user }) {
  const similar = await featureRequestService.findSimilarRequest(`${decision.title} — ${decision.problem}`);
  if (similar) {
    await featureRequestService.enrichFeatureRequest(similar.id, { content: decision.problem, user });
    return { action: 'enriched', requestId: similar.id, title: similar.title };
  }
  const created = await featureRequestService.createFeatureRequest({
    title: decision.title,
    problem: decision.problem,
    expectedBehavior: decision.expectedBehavior,
    user,
  });
  return { action: 'created', requestId: created.id, title: created.title };
}

/**
 * Point d'entrée principal : détecte l'intention, appelle l'outil si pertinent, construit le prompt,
 * puis streame la réponse du LLM via onTextChunk (même mécanisme que askFollowUpQuestion).
 * `pendingFeatureRequest` (optionnel) : demande d'évolution encore en cours de clarification depuis
 * un tour précédent de CETTE conversation (ChatbotConversation.pendingFeatureRequestJson) — quand
 * présent, force le suivi de demande à s'exécuter AVANT le routage normal vers un outil de données
 * (cf. plus bas), pour ne jamais perdre une clarification en cours à cause d'un mot-clé métier dans
 * la réponse de l'utilisateur (bug trouvé le 26/09/2026 : "je veux les alertes de rupture et le CA"
 * en réponse à une clarification faisait basculer sur getRevenue/getStockoutRisks, la demande
 * d'origine — un résumé quotidien WhatsApp — n'étant alors jamais complétée ni enregistrée).
 */
async function askAssistant({ rposShopId, posId, shopReference, shopName, department, subDepartment, conversationHistory, question, onTextChunk, user, pendingFeatureRequest }) {
  const { toolName, toolResult, reusedFromHistory } = await runToolForQuestion(rposShopId, question, { department, conversationHistory, posId, user });
  // En clarification active, le suivi de demande doit passer AVANT tout affichage de données : la
  // réponse de l'utilisateur à "quelles infos voulez-vous dans ce résumé ?" ne doit jamais être
  // interprétée comme une nouvelle question de données, même si elle mentionne "CA"/"rupture".
  const skipToolForPendingClarification = !!pendingFeatureRequest;
  const effectiveToolResult = skipToolForPendingClarification ? null : toolResult;
  const suggestedQuestions = effectiveToolResult || reusedFromHistory ? null : await getSuggestedQuestions();
  const prompt = skipToolForPendingClarification
    ? `Tu es l'Assistant IA d'une application de gestion de stock/réassort. Tu avais précédemment demandé une précision à l'utilisateur au sujet d'un besoin d'évolution non encore disponible dans l'application : "${pendingFeatureRequest.problem}". L'utilisateur répond maintenant : "${question}". Accuse réception de sa précision en une phrase brève, sans inventer de fonctionnalité ni prétendre l'avoir déjà mise en place.`
    : await buildChatbotPrompt({ shopReference, shopName, department, subDepartment, conversationHistory, question, toolName, toolResult: effectiveToolResult, reusedFromHistory, suggestedQuestions });

  const { fullText, providerUsed } = await streamWithFallback(prompt, (chunk) => {
    if (onTextChunk) onTextChunk(chunk);
  }, 'chatbot-answer');

  // Suivi des demandes d'évolution (§2-§9 de la spec) : uniquement quand aucun outil de données n'a
  // répondu à la question (toolResult null, ou ignoré parce qu'une clarification était en attente) —
  // une question normale déjà traitée par un outil n'est jamais un manque fonctionnel. Se produit
  // APRÈS le streaming de la réponse conversationnelle principale (elle a besoin du texte de cette
  // réponse pour juger), jamais à sa place.
  // Un post-scriptum est ajouté au texte final ET streamé comme un chunk supplémentaire (demande du
  // 26/09/2026 : "il dois lui dire quil a enregistré ca demande") — l'utilisateur doit voir
  // explicitement que sa demande a été prise en compte, jamais un enregistrement silencieux qu'il ne
  // peut pas constater. Transparence stricte (§9) : ce message n'apparaît QUE si l'enregistrement a
  // réellement eu lieu, jamais anticipé avant que recordFeatureRequest n'ait effectivement réussi.
  let featureRequest = null;
  let newPendingFeatureRequest = null;
  let finalAnswer = fullText.trim();
  if (!effectiveToolResult && !reusedFromHistory) {
    try {
      // Avec une clarification en attente, on fusionne le besoin déjà connu et la précision qui vient
      // d'être donnée : le LLM de suivi juge sur l'ensemble, jamais seulement sur ce dernier message
      // isolé (qui, seul, ne ressemble à rien — ex: "surtout les ruptures et le CA de la veille").
      const effectiveQuestion = pendingFeatureRequest
        ? `Besoin déjà exprimé précédemment : ${pendingFeatureRequest.problem}\nPrécision supplémentaire de l'utilisateur : ${question}`
        : question;
      const decision = await maybeTrackFeatureRequest({ conversationHistory, question: effectiveQuestion, answer: finalAnswer });
      if (decision && decision.readyToRecord) {
        featureRequest = await recordFeatureRequest(decision, { user });
        const confirmation = featureRequest.action === 'enriched'
          ? `\n\n✅ J'ai bien noté ce besoin et l'ai ajouté à une demande déjà enregistrée (« ${featureRequest.title} »). Si vous avez d'autres précisions à ajouter, n'hésitez pas à me les donner.`
          : `\n\n✅ J'ai enregistré ce besoin comme demande d'évolution (« ${featureRequest.title} »), transmise à l'équipe de développement. Si vous avez d'autres précisions à ajouter, n'hésitez pas à me les donner.`;
        finalAnswer += confirmation;
        if (onTextChunk) onTextChunk(confirmation);
      } else if (decision && decision.clarifyingQuestion) {
        // Besoin réel mais encore trop vague pour être exploitable (§3 de la spec : "poser des
        // questions ciblées") — rien n'est enregistré tant que la précision n'est pas obtenue.
        // newPendingFeatureRequest persiste ce besoin sur la conversation (cf. route ask-stream) pour
        // que le tour suivant force à nouveau ce suivi, quel que soit son contenu.
        newPendingFeatureRequest = { title: decision.title, problem: decision.problem, expectedBehavior: decision.expectedBehavior };
        const clarification = `\n\n${decision.clarifyingQuestion}`;
        finalAnswer += clarification;
        if (onTextChunk) onTextChunk(clarification);
      }
    } catch (err) {
      // Un échec d'enregistrement (contrainte base, service indisponible...) ne doit JAMAIS faire
      // échouer toute la réponse de l'assistant — sans ce filet, l'erreur remontait jusqu'au catch
      // global de la route ask-stream (routes/reassort/ai.js), qui envoyait un événement SSE "error"
      // à la place de "done" : le texte déjà streamé restait affiché côté utilisateur (buffer local),
      // mais featureRequest/wantsVisual n'étaient jamais transmis, et rien ne signalait l'échec (bug
      // trouvé le 26/09/2026 : une demande détectée par le LLM de suivi n'apparaissait jamais sur la
      // page Demandes d'évolution, sans aucune erreur visible pour l'utilisateur).
      console.error('[chatbotService] Enregistrement de la demande d\'évolution échoué:', err.message);
      // En cas d'échec avec une clarification déjà en attente, on la garde telle quelle plutôt que de
      // la perdre silencieusement (l'utilisateur pourra réessayer sans tout redécrire).
      if (pendingFeatureRequest) newPendingFeatureRequest = pendingFeatureRequest;
    }
  }

  // toolResult est retourné tel quel (pas reformaté par le LLM) : le frontend construit son
  // graphique/tableau directement à partir de ces vraies données quand leur forme s'y prête
  // (dailyHistory -> graphique, lines/topArticles -> tableau) — jamais un rendu que l'IA aurait pu
  // déformer ou halluciner en le redécrivant dans son texte.
  // `wantsVisual` (demande du 25/09/2026, bug trouvé sur capture d'écran : "Quels articles risquent
  // d'être en rupture ?" affichait la réponse texte PUIS un gros tableau non demandé) — le frontend
  // affichait le tableau dès que toolResult contenait des lignes, sans jamais regarder si la question
  // demandait réellement une représentation visuelle. Calculé ici pour rester la seule source de
  // vérité (même logique qu'isVisualRequest, déjà utilisée pour router vers reusedFromHistory) :
  // vrai seulement si la question mentionne explicitement un mot-clé visuel ("tableau", "graphique"...)
  // OU si elle réutilise un résultat déjà affiché visuellement plus tôt dans la conversation. Une
  // simple question texte ("quels articles risquent d'être en rupture ?") ne doit renvoyer QUE la
  // réponse en langage naturel, jamais un tableau brut en plus.
  return { answer: finalAnswer, providerUsed, toolUsed: toolName, toolResult: effectiveToolResult, wantsVisual: isVisualRequest(question) || !!reusedFromHistory, featureRequest, pendingFeatureRequest: newPendingFeatureRequest };
}

// Questions suggérées (§34) : éditables depuis Paramètres > IA (CHATBOT_SUGGESTED_QUESTIONS, une par
// ligne) sans redéploiement — servent aussi de référence pour indiquer au magasin ce que l'assistant
// sait réellement faire quand une question sort du périmètre couvert (cf. buildChatbotPrompt).
async function getSuggestedQuestions() {
  const raw = await systemConfig.getValue(systemConfig.KEYS.CHATBOT_SUGGESTED_QUESTIONS);
  return (raw || '').split('\n').map((q) => q.trim()).filter(Boolean);
}

module.exports = { askAssistant, detectIntent, extractEan, getSuggestedQuestions, VALID_INTENT_TOOLS, isVisualRequest };
