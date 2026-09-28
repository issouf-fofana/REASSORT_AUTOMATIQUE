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
  'getOrderAnomalies', 'getStockoutRisksAllShops', 'getOverstockArticlesAllShops', 'getPendingProposalsAllShops', 'getOrderAnomaliesAllShops',
  'getPredictionAccuracyAllShops', 'getRevenueTrendAllShops', 'getSilentShops', 'getShopUsers', 'getDataAvailability',
]);

// Règles par défaut : copie exacte de l'ancien tableau codé en dur, gardée ici comme filet de
// sécurité UNIQUEMENT si la lecture de CHATBOT_INTENT_RULES échoue totalement (base indisponible,
// JSON corrompu au point de ne pas être parsable) — le chatbot ne doit jamais se retrouver sans
// aucune règle de détection. En usage normal, c'est systemConfigService qui fournit déjà ces mêmes
// valeurs par défaut avant toute édition ; celles-ci ne servent que si CET APPEL précis échoue.
const FALLBACK_INTENT_RULES = [
  { keywords: ['changement de prix', 'changé de prix', 'change de prix', 'changement de prix de vente', 'historique de prix', 'historique des prix', 'évolution du prix', 'evolution du prix', 'quand a-t-il changé de prix', 'quand est-ce que le prix', 'le prix a changé', 'le prix a change', 'quand le prix', 'prix a changé', 'log de prix', 'log changement', 'mis en promo', 'mise en promo', 'mis en promotion', 'depuis quand', 'quand est-ce qu\'il', 'quand a-t-il', 'quand il a', 'quand est-il passé', 'a quel moment'], tool: 'getPriceChangeHistory' },
  { keywords: ['pourquoi le stock', 'pourquoi son stock', 'stock a baissé', 'stock a baisse', 'stock a bougé', 'stock a bouge', 'stock a chuté', 'stock a chute', 'stock a diminué', 'stock a diminue', 'mouvement de stock', 'mouvements de stock', 'type de mouvement', 'types de mouvement', 'type de mouvements', 'quel mouvement', 'quels mouvements', 'de la casse', 'en casse', 'casse sur', 'article volé', 'article vole', 'cession de rayon', 'cession entre rayon', 'cession inter-rayon', 'retour fournisseur', 'écart de stock', 'ecart de stock', 'disparition de stock'], tool: 'getStockMoveHistory' },
  // Pareto AVANT ArticleDetails (bug trouvé le 27/09/2026 lors d'un test réel : "quel rayon vend le
  // mieux ?" répondait la fiche du dernier article consulté) — "quel rayon" (ArticleDetails, cherche
  // le rayon D'UN article précis) est un sous-ensemble textuel de "quel rayon vend le mieux/le plus"
  // (Pareto, classement des rayons), donc ArticleDetails gagnait toujours en premier tant qu'il était
  // testé avant dans cette liste ("premier qui matche gagne", cf. detectIntent). Les deux règles
  // avaient pourtant déjà cet ordre inversé en théorie (PARETO_PATTERN_REGEX testé avant dans
  // detectIntent) mais celui-ci ne couvre que le motif "X% du CA", jamais "quel rayon vend le mieux"
  // qui ne passe que par cette liste générique.
  { keywords: ['pareto', '80%', '80 %', 'part du ca', 'part de ca', 'représentent le plus de ca', 'font le plus de ca', 'articles principaux', 'gros vendeurs', 'meilleures ventes', 'top articles', 'top vente', 'quel rayon vend le mieux', 'quel rayon vend le plus', 'meilleur rayon', 'rayon qui vend le plus', 'rayon qui vend le mieux', 'classement des rayons', 'comparer les rayons', 'comparaison des rayons'], tool: 'getParetoArticles' },
  { keywords: ['où se trouve', 'ou se trouve', 'emplacement', 'où est', 'ou est', 'quel rayon', 'dans quel rayon', 'adresse rayon', 'prix actuel', 'prix de vente', 'prix promo', 'en promo', 'promotion', 'quel prix', 'combien coûte', 'combien coute', 'fiche article', 'fiche produit', 'fiche complète', 'fiche complete', 'détails de l\'article', 'details de larticle', 'infos article', 'informations sur l\'article', 'toutes les informations', 'tout savoir sur', 'caractéristiques', 'caracteristiques', 'fournisseur de'], tool: 'getArticleDetails' },
  { keywords: ['chiffre d\'affaires', 'chiffre daffaire', 'chiffre d affaire', 'le ca', 'du ca', 'au ca', 'ton ca', 'mon ca', 'quel ca', 'ca du', 'ca le', 'ca est', 'ca de', 'combien on a fait', 'combien jai fait', 'combien on a vendu en argent', 'recette du jour', 'recette de'], tool: 'getRevenue' },
  { keywords: ['rupture', 'stock critique', 'risque de rupture', 'va manquer', 'vont manquer', 'plus de stock', 'articles en manque', 'articles manquants', 'quoi va manquer'], tool: 'getStockoutRisks' },
  { keywords: ['surstock', 'trop de stock', 'sur-stock', 'excès de stock', 'exces de stock', 'trop stocké', 'trop stocke', 'articles en trop'], tool: 'getOverstockArticles' },
  { keywords: ['précision', 'fiabilité', 'accuracy', 'erreur de prévision', 'la prévision est bonne', 'fiable', 'lia se trompe', 'l\'ia se trompe', 'taux de reussite', 'taux de réussite'], tool: 'getPredictionAccuracy' },
  // Le mot-clé générique 'commande' seul a été retiré (bug trouvé le 21/09/2026, campagne de
  // fuzzing large) : matchait à tort par sous-chaîne "commander", "commandé", "commandes anormales"
  // — écrasant getCurrentProposal ("quoi commander") et getOverstockArticles ("trop commandé") dans
  // 5 cas sur 8 échecs trouvés. Ne garder que des expressions assez précises pour ne jamais matcher
  // un simple verbe conjugué ou une question sur un AUTRE sujet contenant accidentellement ce radical.
  // Placé AVANT la règle getOrders générique ci-dessous : "anomalie(s) de commande" contient
  // "commande" mais désigne un besoin précis, jamais la simple liste des commandes récentes.
  { keywords: ['anomalie', 'anomalies', 'commande anormale', 'commandes anormales', 'quantité anormale', 'quantite anormale', 'écart de commande', 'ecart de commande'], tool: 'getOrderAnomalies' },
  { keywords: ['mes commandes', 'commandes en cours', 'commandes récentes', 'liste des commandes', 'qu\'est-ce qui a été commandé', 'quest ce qui a ete commande', 'quoi a ete commande', 'derniere commande', 'dernières commandes'], tool: 'getOrders' },
  // "aujourd'hui" retiré (bug trouvé le 21/09/2026, campagne de fuzzing large) : trop générique,
  // matchait à tort N'IMPORTE QUELLE question du jour (ex: "chiffre d'affaire aujourd'hui" tombait
  // sur getCurrentProposal au lieu de getRevenue). "proposition"/"commander" restent assez précis
  // pour cet outil sans avoir besoin de ce mot-clé fourre-tout.
  { keywords: ['proposition', 'proposition en attente', 'proposition du jour', 'proposition de commande', 'quoi commander', 'que dois-je commander', 'quest ce que je dois commander', 'a commander'], tool: 'getCurrentProposal' },
  { keywords: ['vente', 'ventes', 'évolution', 'combien vendu', 'combien vendus', 'combien on a vendu', 'tendance', 'ca se vend comment', 'comment ca vend'], tool: 'getSalesHistory' },
  // "son stock"/"le stock" ajoutés le 27/09/2026 (bug trouvé via une question à deux volets : "le CA
  // de cet article et son stock est à combien ?" — le segment isolé "son stock est à combien" ne
  // matchait aucun mot-clé existant, tous exigeant "stock de/actuel/disponible" explicite).
  // "stock du magasin" ajouté le 27/09/2026 (bug trouvé via test réel : "quel est le stock du
  // magasin ?" ne matchait aucun mot-clé existant, tous exigeant "stock de/actuel/disponible/son
  // stock" — jamais "stock du").
  { keywords: ['stock de', 'stock du', 'stock actuel', 'stock disponible', 'son stock', 'le stock est', 'stock est a', 'stock est à', 'combien il reste', 'combien il en reste', 'reste combien', 'il reste combien', 'disponibilite', 'disponibilité', 'est-il disponible', 'est il disponible'], tool: 'getArticleStock' },
  // DLV (demande du 22/09/2026) : PAS une date de péremption, un stock basculé manuellement par le
  // personnel sur un EAN distinct pour écoulement à prix réduit — cf. chatbotToolsService.js.
  { keywords: ['dlv', 'dlc', 'date limite de vente', 'date limite de consommation', 'péremption', 'peremption', 'articles à écouler', 'articles a ecouler', 'stock à solder', 'stock a solder', 'en dlv', 'proche de la peremption', 'proche de la péremption'], tool: 'getDlvArticles' },
  // Ajouté le 27/09/2026 : "est-ce que le système peut répondre combien d'utilisateurs sont dans ce
  // magasin ?" — donnée de gestion des comptes (pas ventes/stock/réassort), réservée ADMIN
  // (aiPermissionsService.js, capacité dédiée) contrairement au reste des capacités du chatbot.
  { keywords: ['combien d\'utilisateurs', 'combien dutilisateurs', 'combien de user', 'combien de comptes', 'nombre d\'utilisateurs', 'nombre dutilisateurs', 'utilisateurs de ce magasin', 'comptes de ce magasin', 'qui travaille dans ce magasin', 'qui a accès à ce magasin', 'qui a acces a ce magasin'], tool: 'getShopUsers' },
  // Ajouté le 28/09/2026 (spec §7 : "Données disponibles : du DD/MM/AAAA au DD/MM/AAAA") : répond à
  // "depuis quand avez-vous mes données ?" / "sur combien de temps portent vos données ?" — distinct
  // de getSalesHistory (l'évolution DES VENTES elles-mêmes) : ici la question porte sur l'étendue de
  // l'historique disponible, pas sur un chiffre de vente.
  { keywords: ['depuis quand avez-vous', 'depuis quand avez vous', 'depuis quand tu as', 'depuis quand as-tu', 'depuis quand as tu', 'historique disponible', 'données disponibles', 'donnees disponibles', 'combien de temps d\'historique', 'combien de temps dhistorique', 'sur quelle période portent vos données', 'sur quelle periode portent vos donnees', 'jusqu\'où remonte', 'jusqu ou remonte', 'jusqu\'où peut-on remonter', 'jusqu ou peut on remonter'], tool: 'getDataAvailability' },
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

// "tous/chaque/mes magasins" + un mot-clé du domaine concerné (demande du 26/09/2026, pilotage
// réseau pour un compte multi-magasins) — même principe que les deux regex ci-dessus : sans cette
// priorité, "quels magasins ont des ruptures ?" retomberait sur getStockoutRisks mono-magasin.
// Motif COMPLET (pas juste un préfixe malgré le nom conservé pour cohérence avec les regex
// ci-dessous) : "quels?/quelles? magasins" contient déjà "magasins", ne jamais lui ajouter
// "\s+magasins?" par-dessus (bug trouvé le 26/09/2026 : dupliquait "magasins" et ne matchait plus
// jamais rien).
// Bug trouvé le 27/09/2026 (campagne de test dynamique) : "le\\s+réseau\\s+(entier|complet)?" ne
// matchait JAMAIS "le réseau" seul (ni même "le réseau entier") — le \s+ obligatoire avant un groupe
// optionnel vide laisse le curseur juste après l'espace, à une position où le \b de fin de motif ne
// peut jamais se satisfaire (aucune transition mot/non-mot à cet endroit précis quand le groupe est
// vide). Restructuré en rendant l'espace ET le qualificatif optionnels ensemble (\s+(entier|complet))?.
const ALL_SHOPS_PREFIX = "(tous les|toutes les|chaque|quels?|quelles?|l'ensemble des?|l'ensemble de mes|mes)\\s+magasins?|magasins?\\s+(du réseau|de mon réseau|de notre réseau)|(tout|toute)\\s+le\\s+réseau|le\\s+réseau(\\s+(entier|complet))?";
const ALL_SHOPS_STOCKOUT_REGEX = new RegExp(`\\b(${ALL_SHOPS_PREFIX})\\b.*\\b(rupture|risque)|\\b(rupture|risque).*\\b(${ALL_SHOPS_PREFIX})\\b`, 'i');
const ALL_SHOPS_OVERSTOCK_REGEX = new RegExp(`\\b(${ALL_SHOPS_PREFIX})\\b.*\\bsurstock|\\bsurstock.*\\b(${ALL_SHOPS_PREFIX})\\b`, 'i');
const ALL_SHOPS_PENDING_PROPOSAL_REGEX = new RegExp(`\\b(${ALL_SHOPS_PREFIX})\\b.*\\b(proposition|valid)|\\b(proposition|valid).*\\b(${ALL_SHOPS_PREFIX})\\b`, 'i');
const ALL_SHOPS_ANOMALY_REGEX = new RegExp(`\\b(${ALL_SHOPS_PREFIX})\\b.*\\banomalie|\\banomalie.*\\b(${ALL_SHOPS_PREFIX})\\b`, 'i');
// Pas de \b après "fiabilité" (même bug d'accent que ALL_SHOPS_TREND_REGEX ci-dessous : un \b après
// un "é" final n'est jamais reconnu par le moteur regex JS, "fiabilité\b" ne matchait donc jamais).
const ALL_SHOPS_ACCURACY_REGEX = new RegExp(`\\b(${ALL_SHOPS_PREFIX})\\b.*(précision|precision|fiabilité|fiabilite)|(précision|precision|fiabilité|fiabilite).*\\b(${ALL_SHOPS_PREFIX})\\b`, 'i');
// Pas de \b devant "évolu" (bug JS classique trouvé le 26/09/2026 : \b ne reconnaît pas un accent
// en début de mot comme un caractère "de mot", "\bévolu" ne matchait donc jamais "évolue"/"évolution").
const ALL_SHOPS_TREND_REGEX = new RegExp(`\\b(${ALL_SHOPS_PREFIX})\\b.*(évolu|evolu|progresse|tendance)|(évolu|evolu|progresse|tendance).*\\b(${ALL_SHOPS_PREFIX})\\b`, 'i');
// "silencieux"/"sans vente" n'a de sens QUE pour une question réseau (jamais une formulation
// mono-magasin plausible) — pas besoin du préfixe "tous les magasins" pour celui-ci.
const SILENT_SHOPS_REGEX = /magasins?\s+(silencieux|sans vente|inactifs?)|aucune vente\b.*magasins?|pas de vente\b.*(depuis|récente)/i;

async function detectIntent(question) {
  const normalized = normalize(question);
  if (PARETO_PATTERN_REGEX.test(normalized)) return 'getParetoArticles';
  if (SILENT_SHOPS_REGEX.test(question)) return 'getSilentShops';
  if (ALL_SHOPS_STOCKOUT_REGEX.test(question)) return 'getStockoutRisksAllShops';
  if (ALL_SHOPS_OVERSTOCK_REGEX.test(question)) return 'getOverstockArticlesAllShops';
  if (ALL_SHOPS_ANOMALY_REGEX.test(question)) return 'getOrderAnomaliesAllShops';
  if (ALL_SHOPS_ACCURACY_REGEX.test(question)) return 'getPredictionAccuracyAllShops';
  if (ALL_SHOPS_PENDING_PROPOSAL_REGEX.test(question)) return 'getPendingProposalsAllShops';
  if (ALL_SHOPS_TREND_REGEX.test(question)) return 'getRevenueTrendAllShops';
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

/**
 * Tente d'extraire une référence de magasin CIBLÉ explicitement dans la question ("le magasin 035",
 * "magasin 414 a combien fait ?"), distinct du magasin courant de la conversation — demande du
 * 27/09/2026 : un ADMIN qui demande "le magasin 035 a un CA de combien hier ?" recevait un refus
 * ("les données transmises ne contiennent pas... du magasin 035") car aucun outil ne savait cibler
 * un AUTRE magasin par sa référence, seulement "tous les magasins" (déjà pris en charge) ou le
 * magasin de la session en cours. Réservé aux comptes multi-magasins (vérifié à l'appel, jamais ici).
 * Exige le mot "magasin"/"mag" explicitement avant le nombre (jamais un nombre isolé dans la
 * question, qui serait presque toujours autre chose : un pourcentage, une quantité, un jour du
 * mois...) — "mag" ajouté le 27/09/2026 (bug trouvé via test réel : "le CA du mag 110 hier ?"
 * n'était pas reconnu, seul "magasin" en toutes lettres l'était, le repli silencieux sur le
 * magasin de la session passait alors inaperçu).
 */
function extractTargetShopReference(question) {
  const match = (question || '').match(/\b(?:magasins?|mag)\s+(?:n[o°]\s*)?(\d{2,4})\b/i);
  return match ? match[1] : null;
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
 * Résolveur de périodes en français (bug trouvé le 27/09/2026, campagne de test dynamique après
 * résolution de la panne disque qui avait empêché toute exécution) : jusqu'ici, aucune formulation
 * de période autre que "jj/mm/aaaa" (extractDate) ou "N jours" (extractDays) n'était comprise.
 * "aujourd'hui", "hier", "cette semaine", "la semaine dernière", "ce mois-ci", "le mois dernier",
 * "sur N mois" retombaient SILENCIEUSEMENT sur le défaut de chaque outil (souvent days=1 ou 30),
 * sans jamais avertir l'utilisateur que sa période n'avait pas été prise en compte — l'utilisateur
 * pouvait ainsi croire lire le CA "du mois dernier" alors qu'il s'agissait des dernières 24h.
 *
 * Renvoie soit { days: N } (fenêtre glissante de N jours, compatible avec le paramètre `days` déjà
 * utilisé par tous les outils), soit { date: 'aaaa-mm-jj' } pour "aujourd'hui"/"hier" (un seul jour
 * calendaire précis, réutilise le paramètre `date` déjà géré par getRevenue), soit null si aucune
 * formulation reconnue (laisse alors extractDate/extractDays tenter leur propre détection, inchangée).
 *
 * Choix de calcul pour "cette semaine"/"la semaine dernière"/"ce mois-ci"/"le mois dernier" : calendaire
 * (depuis lundi de la semaine courante, depuis le 1er du mois courant, etc.), pas une fenêtre glissante
 * de 7/30 jours — c'est le sens naturel de ces expressions et distinct de "les 7 derniers jours" (déjà
 * couvert par extractDays) qui reste une fenêtre glissante explicite. "sur N mois" est en revanche
 * converti en N*30 jours glissants (approximation documentée : pas de vrai calendrier ici, cohérent
 * avec le fait qu'aucun outil de ce fichier ne raisonne autrement qu'en fenêtre de jours pour une
 * durée en mois — seuls "ce mois-ci"/"le mois dernier" méritent un calcul calendaire strict car ce
 * sont des expressions qui désignent un mois précis, pas une durée approximative).
 *
 * Horloge système utilisée ici (Date.now()), contrairement à resolveDayOnlyDate qui se cale sur la
 * dernière vente connue : ces expressions relatives ("aujourd'hui", "cette semaine"...) désignent le
 * moment réel où la question est posée, pas une date à déduire des données déjà en base.
 */
function resolveDateRange(question) {
  const q = normalize(question || '');

  // "sur 3 mois" / "sur les 3 derniers mois" / "3 mois" — avant "mois dernier"/"ce mois" pour ne pas
  // confondre un nombre explicite de mois avec la formulation calendaire "le mois dernier".
  const monthsMatch = q.match(/\b(\d{1,2})\s+(?:derniers?\s+)?mois\b/);
  if (monthsMatch) {
    const n = parseInt(monthsMatch[1], 10);
    if (n >= 1 && n <= 24) return { days: n * 30 };
  }

  if (/\bavant[ -]hier\b/.test(q)) {
    const d = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    return { date: d.toISOString().slice(0, 10) };
  }
  if (/\bhier\b/.test(q)) {
    const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
    return { date: d.toISOString().slice(0, 10) };
  }
  if (/\baujourd\s*'?\s*hui\b/.test(q)) {
    return { date: new Date().toISOString().slice(0, 10) };
  }

  if (/\b(la\s+)?semaine\s+derniere\b|\bsemaine\s+precedente\b/.test(q)) {
    // Semaine calendaire ISO précédente (lundi -> dimanche). Le nombre de jours écoulés depuis le
    // début de CETTE semaine-là jusqu'à maintenant sert de fenêtre `days` (compatible avec le seul
    // paramètre que les outils savent consommer) : les outils filtrent sur `date >= now - days*24h`,
    // donc englober toute la semaine dernière + la semaine courante écoulée est nécessaire pour ne
    // rien couper — un peu plus large que la semaine dernière seule, mais jamais moins.
    const now = new Date();
    const dayOfWeek = (now.getUTCDay() + 6) % 7; // 0 = lundi
    const daysSinceLastMonday = dayOfWeek + 7;
    return { days: daysSinceLastMonday + 1 };
  }
  if (/\bcette\s+semaine\b/.test(q)) {
    // Depuis lundi de la semaine courante (convention déjà utilisée pour les rapports hebdomadaires
    // du projet : semaine calendaire ISO, pas une fenêtre glissante de 7 jours).
    const now = new Date();
    const dayOfWeek = (now.getUTCDay() + 6) % 7; // 0 = lundi ... 6 = dimanche
    return { days: dayOfWeek + 1 };
  }

  if (/\b(le\s+)?mois\s+dernier\b|\bmois\s+precedent\b/.test(q)) {
    const now = new Date();
    // Nombre de jours écoulés depuis le 1er du mois précédent jusqu'à maintenant — englobe tout le
    // mois précédent complet (même logique que "semaine dernière" ci-dessus : les outils ne savent
    // filtrer que par une fenêtre glissante de N jours, jamais par bornes calendaires arbitraires).
    const firstOfLastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const daysSince = Math.ceil((now.getTime() - firstOfLastMonth.getTime()) / (24 * 60 * 60 * 1000));
    return { days: daysSince };
  }
  if (/\bce\s+mois([ -]ci)?\b|\bmois\s+en\s+cours\b|\bmois\s+courant\b/.test(q)) {
    const now = new Date();
    const firstOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const daysSince = Math.ceil((now.getTime() - firstOfMonth.getTime()) / (24 * 60 * 60 * 1000)) || 1;
    return { days: daysSince };
  }

  return null;
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
  { name: 'getOrderAnomalies', description: 'Anomalies détectées sur des commandes récentes (quantité validée nettement supérieure ou inférieure à l\'habitude du magasin) — jamais présentées comme des erreurs certaines, seulement des écarts à vérifier.', params: {} },
  { name: 'getStockoutRisksAllShops', description: 'Nombre d\'articles en risque de rupture, PAR MAGASIN, sur tout le réseau accessible au compte (réservé ADMIN/SUPERVISOR) — utile pour "quels magasins ont des ruptures ?", jamais pour une question sur un seul magasin précis.', params: {} },
  { name: 'getOverstockArticlesAllShops', description: 'Nombre d\'articles en surstock, PAR MAGASIN, sur tout le réseau accessible au compte (réservé ADMIN/SUPERVISOR).', params: {} },
  { name: 'getPendingProposalsAllShops', description: 'Magasins ayant encore une proposition de commande non validée, sur tout le réseau accessible au compte (réservé ADMIN/SUPERVISOR) — utile pour "quelles propositions sont encore en attente ?".', params: {} },
  { name: 'getOrderAnomaliesAllShops', description: 'Anomalies de commande, PAR MAGASIN, sur tout le réseau accessible au compte (réservé ADMIN/SUPERVISOR).', params: {} },
  { name: 'getPredictionAccuracyAllShops', description: 'Classement des magasins par fiabilité des prévisions IA, sur tout le réseau accessible au compte (réservé ADMIN/SUPERVISOR) — utile pour "quel magasin a la meilleure précision ?".', params: {} },
  { name: 'getRevenueTrendAllShops', description: 'Évolution du chiffre d\'affaires de chaque magasin entre deux périodes consécutives, sur tout le réseau accessible au compte (réservé ADMIN/SUPERVISOR) — utile pour "le réseau progresse-t-il ?", "classe les magasins par évolution des ventes".', params: { currentDays: 'durée en jours de la période récente à comparer, optionnel (défaut 30)' } },
  { name: 'getSilentShops', description: 'Magasins du réseau sans aucune vente synchronisée récemment (signal d\'alerte : magasin peut-être hors service ou mal synchronisé), réservé ADMIN/SUPERVISOR — utile pour "y a-t-il des magasins silencieux ?".', params: {} },
  { name: 'getDlvArticles', description: 'Articles ayant actuellement du stock en DLV (Date Limite de Vente courte — un stock basculé manuellement par le personnel sur un EAN distinct pour écoulement à prix réduit, PAS une date de péremption automatique), du magasin entier ou d\'un article précis si un EAN est donné.', params: { ean: 'code EAN article, optionnel' } },
  { name: 'getDataAvailability', description: 'Étendue réelle de l\'historique de ventes disponible en base pour ce magasin (date la plus ancienne / la plus récente) — utile pour "depuis quand avez-vous mes données ?", "sur combien de temps portent vos données ?", avant de lancer une comparaison sur une longue période (12 mois, année précédente...).', params: {} },
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
 * Périmètre "tous magasins" d'un compte (demande du 26/09/2026, pilotage réseau) : tous les magasins
 * pour ADMIN, seulement les magasins supervisés pour SUPERVISOR — même règle déjà appliquée par
 * getRevenueAllShops/getArticleStockAllShops, extraite ici pour être réutilisée par les 5 nouveaux
 * outils réseau sans dupliquer cette résolution à chaque case du switch ci-dessous.
 */
async function resolveAllowedShopIds(user) {
  if (!user) return [];
  if (user.role === 'ADMIN') return (await prisma.shop.findMany({ select: { rposShopId: true } })).map((s) => s.rposShopId);
  if (user.role === 'SUPERVISOR') return (await prisma.supervisedShop.findMany({ where: { userId: user.id }, select: { rposShopId: true } })).map((s) => s.rposShopId);
  return [];
}

/**
 * Exécute l'outil détecté avec les paramètres extraits de la question, retourne un objet
 * { toolName, toolResult } prêt à être injecté dans le prompt du LLM. found=false si aucun outil
 * pertinent n'a pu être identifié (le LLM répond alors sans données spécifiques, en le disant).
 * conversationHistory permet de retomber sur le dernier outil utilisé quand la question demande
 * juste une représentation visuelle d'un résultat déjà obtenu, sans nommer une nouvelle donnée.
 * Renommée depuis runToolForQuestion (cf. wrapper du même nom juste après) : cette fonction ne gère
 * plus qu'UN SEUL segment de question à la fois, jamais une phrase à double intention.
 */
async function runSingleTool(rposShopId, question, { department, conversationHistory, posId, user } = {}) {
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
  // getRevenue ajouté le 28/09/2026 (bug réel observé en conversation : "Quel est le chiffre
  // d'affaires de cet article ?" juste après avoir consulté un EAN précis retombait sur le CA de
  // TOUT le magasin au lieu de réutiliser cet EAN — getRevenue n'est PAS toujours scopé à un seul
  // article comme les autres outils de ce set (il sert aussi de CA magasin sans EAN), mais quand la
  // question dit explicitement "cet article" sans EAN, il doit réutiliser le dernier EAN de la
  // conversation comme tous les autres outils ci-dessous, jamais retomber silencieusement sur un
  // périmètre plus large que celui demandé.
  const ARTICLE_SCOPED_TOOLS = new Set(['getArticleDetails', 'getPriceChangeHistory', 'getArticleStock', 'getSalesHistory', 'getStockMoveHistory', 'getRevenue']);

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
  //
  // Restreint aux questions commençant par "et"/"aussi"/"sinon" (bug trouvé le 27/09/2026 : ce filet
  // capturait aussi une question totalement hors sujet et sans aucun rapport avec la précédente
  // ("tu prends la donnée en local ou en serveur ?", posée juste après "le CA aujourd'hui ?") — sans
  // restriction, toute question sans mot-clé reconnu réutilisait le dernier outil, poussant le LLM à
  // improviser une réponse à partir d'un JSON sans rapport plutôt que de dire honnêtement qu'il ne
  // sait pas répondre à ce type de question (violation silencieuse de la règle anti-hallucination
  // §35, cf. buildChatbotPrompt). Une vraie relance elliptique commence quasi systématiquement par
  // une conjonction de continuation ; une nouvelle question autonome (même courte) commence par un
  // vrai début de phrase ("tu peux...", "quel est...").
  const FOLLOWUP_STARTER_REGEX = /^(et|aussi|sinon|donc)\b/i;
  if (!toolName && conversationHistory && conversationHistory.length && FOLLOWUP_STARTER_REGEX.test(question.trim())) {
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

  // getRevenue seul est ambigu par nature (CA magasin ENTIER par défaut, contrairement aux autres
  // outils de ARTICLE_SCOPED_TOOLS qui portent TOUJOURS sur un seul article) : une question sans EAN
  // ni référence explicite à un article ("le magasin a un CA de combien ?", posée fraîchement après
  // avoir discuté d'un article) ne doit JAMAIS être silencieusement rétrécie au dernier EAN de la
  // conversation — seule une phrase qui renvoie explicitement à "cet/cette article/produit" déclenche
  // la réutilisation pour cet outil précis.
  const REFERS_TO_ARTICLE_REGEX = /\b(cet|cette|ce|l')\s*(article|produit)\b/i;
  let ean = extractEan(question) || (llmParams && ARTICLE_SCOPED_TOOLS.has(toolName) ? llmParams.ean : null) || null;
  const canReuseEanForTool = toolName !== 'getRevenue' || REFERS_TO_ARTICLE_REGEX.test(question);
  if (!ean && ARTICLE_SCOPED_TOOLS.has(toolName) && canReuseEanForTool && conversationHistory && conversationHistory.length) {
    for (let i = conversationHistory.length - 1; i >= 0; i--) {
      const pastEan = extractEan(conversationHistory[i].question);
      if (pastEan) { ean = pastEan; break; }
    }
  }
  const rawDate = extractDate(question);
  const explicitDate = rawDate && typeof rawDate === 'object' ? await resolveDayOnlyDate(rposShopId, rawDate.dayOnly) : rawDate;
  const explicitDays = extractDays(question);
  // resolveDateRange ("hier", "cette semaine", "le mois dernier"...) n'intervient QUE si aucune date
  // ou nombre de jours explicite n'a déjà été trouvé par extractDate/extractDays ci-dessus — une
  // formulation numérique précise ("le 14/09/2026", "les 45 derniers jours") reste toujours prioritaire
  // sur une formulation relative détectée par erreur dans la même question (peu probable mais sans
  // ambiguïté à trancher autrement).
  const naturalRange = (!explicitDate && !explicitDays) ? resolveDateRange(question) : null;
  const date = explicitDate || naturalRange?.date || (llmParams ? llmParams.date : null) || null;
  const percentage = extractPercentage(question) || (llmParams ? llmParams.thresholdPct : null) || null;
  const gisementQuery = extractGisement(question) || (llmParams ? llmParams.gisement : null) || null;
  const daysQuery = explicitDays || naturalRange?.days || (llmParams ? llmParams.days : null) || null;

  // Un ADMIN/SUPERVISOR peut cibler UN AUTRE magasin que celui de la session en cours en le nommant
  // explicitement ("le magasin 035 a un CA de combien ?", cf. extractTargetShopReference) — jamais
  // pour un rôle mono-magasin (STORE/DIRECTOR/...), qui reste cloisonné à son unique magasin comme
  // partout ailleurs. Uniquement pour getRevenue pour l'instant (seul cas demandé le 27/09/2026) ;
  // extensible à d'autres outils mono-magasin si besoin. rposShopId de la session reste le défaut si
  // la référence ne correspond à aucun magasin réel ou hors du périmètre autorisé de l'utilisateur —
  // jamais un magasin arbitraire, exposé à quelqu'un qui n'y a pas droit.
  let effectiveShopId = rposShopId;
  let targetShopLabel = null;
  if (toolName === 'getRevenue' && user && (user.role === 'ADMIN' || user.role === 'SUPERVISOR')) {
    const targetReference = extractTargetShopReference(question);
    if (targetReference) {
      const allowedShopIds = await resolveAllowedShopIds(user);
      const targetShop = await prisma.shop.findFirst({ where: { reference: targetReference, rposShopId: { in: allowedShopIds } } });
      if (targetShop) {
        effectiveShopId = targetShop.rposShopId;
        targetShopLabel = `${targetShop.reference} ${targetShop.name}`;
      }
    }
  }

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
        // days jamais transmis avant le 28/09/2026 (même bug que getRevenue ci-dessous, trouvé lors
        // de l'audit période/Pareto) : "Pareto sur 3 mois" retombait toujours sur 30 jours en dur
        // sans jamais le signaler. days omis (undefined) quand non précisé par l'utilisateur : dans
        // ce cas, getParetoArticles résout maintenant lui-même LA MÊME période que la génération de
        // proposition (resolvePeriod, config.periodMode du magasin) plutôt qu'un défaut arbitraire
        // différent — spec du 28/09/2026 §5 : "pas de logique Pareto différente entre le chatbot et
        // la proposition".
        return { toolName, toolResult: await tools.getParetoArticles(posId, rposShopId, { thresholdPct: percentage, department, days: daysQuery || null }) };
      case 'getRevenue': {
        // Bug trouvé le 27/09/2026 : `days` n'était jamais transmis à getRevenue (seul `date` l'était),
        // alors que getRevenue accepte bien un `days` pour une fenêtre glissante (défaut interne 1 jour
        // seulement) — "le CA de cette semaine"/"le CA sur 3 mois" retombait toujours sur les dernières
        // 24h sans jamais utiliser daysQuery/resolveDateRange. `date` reste prioritaire quand présent
        // (getRevenue.js ignore déjà `days` si `date` est fourni).
        // days: daysQuery seul (pas de `|| 1`, spec du 28/09/2026 §1) : quand ni date ni days ne sont
        // précisés pour une question sur un ARTICLE précis, getRevenue résout maintenant lui-même la
        // période d'analyse par défaut du magasin (posId transmis ci-dessous) plutôt qu'un repli
        // silencieux sur 1 jour — imposer `|| 1` ici aurait empêché ce nouveau comportement de
        // s'appliquer.
        const revenueResult = await tools.getRevenue(effectiveShopId, { date, days: daysQuery || null, department, ean, posId });
        // targetShopLabel présent seulement si un AUTRE magasin a été explicitement ciblé (cf. plus
        // haut) : le LLM doit alors préciser DANS QUEL magasin, sinon la réponse resterait ambiguë
        // pour un ADMIN qui vient de nommer un magasin différent du sien.
        return { toolName, toolResult: targetShopLabel ? { ...revenueResult, targetShopLabel } : revenueResult };
      }
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
        // Même bug que getSalesHistory (days ignoré) : "la fiabilité de l'IA ce mois-ci" retombait
        // silencieusement sur le défaut de l'outil (90 jours) sans jamais utiliser daysQuery.
        return { toolName, toolResult: await tools.getPredictionAccuracy(rposShopId, { days: daysQuery || 90 }) };
      case 'getOrders':
        // Idem : "mes commandes du mois dernier" ignorait daysQuery et retombait sur le défaut (14j).
        return { toolName, toolResult: await tools.getOrders(rposShopId, { days: daysQuery || 14 }) };
      case 'getOrderAnomalies':
        // getOrderAnomalies ne connaît pas de notion de période (statut PENDING/ACKNOWLEDGED/DISMISSED
        // + limit uniquement, cf. chatbotToolsService.js) : aucune régression de période à corriger ici,
        // contrairement à getOrders — laissé inchangé intentionnellement.
        return { toolName, toolResult: await tools.getOrderAnomalies(rposShopId, {}) };
      // Outils "tous magasins" (demande du 26/09/2026, pilotage réseau) : réservés ADMIN/SUPERVISOR,
      // même repli silencieux sur le seul magasin courant que getRevenueAllShops pour tout autre
      // rôle — une question mal formulée ne doit jamais planter.
      case 'getStockoutRisksAllShops': {
        if (!user || (user.role !== 'ADMIN' && user.role !== 'SUPERVISOR')) {
          return { toolName: 'getStockoutRisks', toolResult: await tools.getStockoutRisks(rposShopId, { department }) };
        }
        return { toolName, toolResult: await tools.getStockoutRisksAllShops(await resolveAllowedShopIds(user), {}) };
      }
      case 'getOverstockArticlesAllShops': {
        if (!user || (user.role !== 'ADMIN' && user.role !== 'SUPERVISOR')) {
          return { toolName: 'getOverstockArticles', toolResult: await tools.getOverstockArticles(rposShopId, { department }) };
        }
        return { toolName, toolResult: await tools.getOverstockArticlesAllShops(await resolveAllowedShopIds(user), {}) };
      }
      case 'getPendingProposalsAllShops': {
        if (!user || (user.role !== 'ADMIN' && user.role !== 'SUPERVISOR')) {
          return { toolName: 'getCurrentProposal', toolResult: await tools.getCurrentProposal(rposShopId, { department }) };
        }
        return { toolName, toolResult: await tools.getPendingProposalsAllShops(await resolveAllowedShopIds(user)) };
      }
      case 'getOrderAnomaliesAllShops': {
        if (!user || (user.role !== 'ADMIN' && user.role !== 'SUPERVISOR')) {
          return { toolName: 'getOrderAnomalies', toolResult: await tools.getOrderAnomalies(rposShopId, {}) };
        }
        return { toolName, toolResult: await tools.getOrderAnomaliesAllShops(await resolveAllowedShopIds(user)) };
      }
      case 'getPredictionAccuracyAllShops': {
        if (!user || (user.role !== 'ADMIN' && user.role !== 'SUPERVISOR')) {
          return { toolName: 'getPredictionAccuracy', toolResult: await tools.getPredictionAccuracy(rposShopId, {}) };
        }
        return { toolName, toolResult: await tools.getPredictionAccuracyAllShops(await resolveAllowedShopIds(user), {}) };
      }
      case 'getRevenueTrendAllShops': {
        if (!user || (user.role !== 'ADMIN' && user.role !== 'SUPERVISOR')) {
          return { toolName: 'getRevenue', toolResult: await tools.getRevenue(rposShopId, { date, department, ean }) };
        }
        return { toolName, toolResult: await tools.getRevenueTrendAllShops(await resolveAllowedShopIds(user), { currentDays: daysQuery || 30 }) };
      }
      case 'getSilentShops': {
        if (!user || (user.role !== 'ADMIN' && user.role !== 'SUPERVISOR')) {
          // Pas d'équivalent single-shop pertinent (un compte à un seul magasin sait déjà s'il est
          // silencieux) : répond simplement hors périmètre plutôt que de rediriger vers un autre outil.
          return { toolName, toolResult: { found: false, message: 'Cette vue réseau est réservée aux comptes multi-magasins.' } };
        }
        return { toolName, toolResult: await tools.getSilentShops(await resolveAllowedShopIds(user), {}) };
      }
      case 'getCurrentProposal':
        return { toolName, toolResult: await tools.getCurrentProposal(rposShopId, { department }) };
      case 'getSalesHistory':
        // Bug trouvé le 27/09/2026 (lecture de code confirmée puis testée dynamiquement) : `days`
        // était codé en dur à 30, ignorant totalement `daysQuery` (extrait par extractDays/
        // resolveDateRange) — "les ventes des 7 derniers jours" retournait en réalité 30 jours de
        // ventes sans jamais le signaler. Aligné sur les autres cases (getRevenueTrendAllShops,
        // getTopGisements, getRevenueAllShops) qui utilisaient déjà `daysQuery || <défaut>`.
        return { toolName, toolResult: await tools.getSalesHistory(rposShopId, { ean, days: daysQuery || 30, department }) };
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
      case 'getDataAvailability':
        return { toolName, toolResult: await tools.getDataAvailability(rposShopId) };
      case 'getShopUsers':
        // Donnée de gestion des comptes (qui a accès à quoi), pas ventes/stock/réassort — réservée
        // ADMIN uniquement, contrairement au reste des capacités du chatbot (checkToolPermission
        // gère déjà revenueShop/stock/orders/etc. mais n'a pas de notion de "gestion des comptes" :
        // vérifié explicitement ici plutôt que d'ajouter une capacité dédiée pour ce seul outil).
        if (!user || user.role !== 'ADMIN') {
          return { toolName, toolResult: { found: false, permissionDenied: true, message: 'Seul un compte Administrateur peut consulter la liste des utilisateurs d\'un magasin.' } };
        }
        return { toolName, toolResult: await tools.getShopUsers(rposShopId) };
      default:
        return { toolName: null, toolResult: null };
    }
  } catch (err) {
    // Message adapté à un utilisateur final (demande du 26/09/2026 : "au lieu de mettre erreur tu
    // me dis par exemple le serveur est injoignable, merci de contacter l'admin ou actualiser et
    // ressayer") — le message brut de rposClient.js ("vérifiez la connexion réseau/VPN") n'a aucun
    // sens pour un utilisateur magasin qui ne gère pas de VPN ; distingué ici du cas générique pour
    // ne jamais l'exposer tel quel.
    const isRposUnreachable = /injoignable/i.test(err.message);
    const message = isRposUnreachable
      ? 'Le serveur de votre magasin est momentanément injoignable. Merci de réessayer dans quelques instants, ou de contacter votre administrateur si le problème persiste.'
      : `Donnée momentanément indisponible (${err.message}). Réessayez dans quelques instants.`;
    return { toolName, toolResult: { found: false, message } };
  }
}

// Sépare une question en segments sur les conjonctions de coordination les plus courantes dans une
// phrase à double intention ("le CA de cet article et son stock ?", "quoi commander aujourd'hui et
// y a-t-il des anomalies ?") — volontairement restreint à "et"/"puis"/"ainsi que" en DÉBUT de
// proposition plutôt qu'un découpage naïf sur chaque "et" du texte (couperait à tort "chips ET
// biscuits" ou "produits d'entretien"). Limité à 2 segments : une question à 3 intentions ou plus
// reste hors périmètre pour l'instant, plutôt que de complexifier sans demande explicite en ce sens.
const QUESTION_SPLIT_REGEX = /\s+(?:et|puis|ainsi que)\s+(?=\w)/i;

function splitCompoundQuestion(question) {
  const parts = question.split(QUESTION_SPLIT_REGEX);
  if (parts.length < 2) return null;
  return [parts[0], parts.slice(1).join(' et ')];
}

/**
 * Point d'entrée public (nom historique conservé) : gère maintenant le cas d'une question à DEUX
 * intentions dans la même phrase (demande du 27/09/2026, bug signalé : "le CA de cet article ET son
 * stock ?" ne répondait qu'au CA, le stock étant purement ignoré). Reste un simple passe-plat vers
 * runSingleTool pour toute question à une seule intention (l'immense majorité des cas) — AUCUN
 * changement de comportement pour ces cas-là, seul un nouveau chemin s'ajoute pour le cas composé.
 *
 * Le second résultat est exposé sous une clé séparée (secondaryToolName/secondaryToolResult), JAMAIS
 * fusionné dans toolResult lui-même : le frontend (AiAssistant.tsx, buildVisualFromToolResult)
 * suppose un toolResult unique pour construire un graphique/tableau — y injecter une liste casserait
 * ce contrat sans navigateur disponible pour vérifier le rendu réel. toolResult reste donc toujours
 * l'objet de l'outil PRINCIPAL comme avant ; le secondaire n'est utilisé que dans le texte du prompt
 * (cf. buildChatbotPrompt) pour que le LLM réponde aussi au second volet de la question.
 */
async function runToolForQuestion(rposShopId, question, options = {}) {
  const primary = await runSingleTool(rposShopId, question, options);
  if (!primary.toolName) return primary;

  const segments = splitCompoundQuestion(question);
  if (!segments) return primary;

  const [firstSegment, secondSegment] = segments;
  // Le premier segment doit rester celui qui porte l'intention principale déjà résolue (sinon la
  // question n'était pas vraiment composée, juste une phrase contenant "et" sans rapport avec une
  // seconde intention, ex: "les articles en rupture et en surstock" — un seul segment ferait double
  // emploi avec le même outil).
  const secondIntent = await detectIntent(secondSegment);
  if (!secondIntent || secondIntent === primary.toolName) return primary;

  // Le second segment isolé ("son stock est à combien ?") ne contient généralement plus l'EAN,
  // déjà cité dans le premier ("le CA de l'article 100013729 et..."). Réutilise le mécanisme
  // existant de retour sur le dernier EAN d'un tour de conversation précédent (cf. plus haut,
  // ARTICLE_SCOPED_TOOLS) en injectant le premier segment comme historique simulé — sans ça, le
  // second outil répondrait sur le magasin entier au lieu de l'article visé par la question.
  const secondaryOptions = {
    ...options,
    conversationHistory: [...(options.conversationHistory || []), { question: firstSegment, toolUsed: null, toolResult: null }],
  };
  const secondary = await runSingleTool(rposShopId, secondSegment, secondaryOptions);
  if (!secondary.toolName || secondary.toolName === primary.toolName) return primary;

  return { ...primary, secondaryToolName: secondary.toolName, secondaryToolResult: secondary.toolResult };
}

/**
 * Construit le prompt final : contexte utilisateur (magasin, rayon si précisé — jamais plus que ce
 * que ses permissions autorisent, appliqué en amont par la route), historique de conversation,
 * résultat de l'outil appelé le cas échéant, et consigne stricte de ne jamais inventer de données
 * (§35).
 */
async function buildChatbotPrompt({ shopReference, shopName, department, subDepartment, conversationHistory, question, toolName, toolResult, reusedFromHistory, suggestedQuestions, secondaryToolName, secondaryToolResult }) {
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
    // Ajouté le 28/09/2026 (demande explicite : "si il n'a pas la donnée, qu'il le dise clairement,
    // sinon qu'il dise qu'il est en cours de développement et qu'il prend note, l'admin sera alerté
    // une fois disponible") — un outil qui a matché la question mais répond found:false (article
    // absent de la dernière proposition, période sans vente, rayon non précisé...) n'est PAS une
    // simple absence de résultat à expliquer techniquement : shouldTrackFeatureRequest (plus bas)
    // enregistre déjà automatiquement ce cas comme suggestion, donc la réponse doit le refléter
    // honnêtement plutôt que de laisser une formulation vague ("les données ne contiennent pas...").
    if (toolResult.found === false) {
      dataSection += `\n\nIMPORTANT : cet outil n'a pas trouvé la donnée demandée (found: false, voir le message ci-dessus pour la raison précise). Dis-le clairement à l'utilisateur avec cette raison précise (jamais une formule vague type "les données fournies ne contiennent pas..."), PUIS ajoute que cette limite a été notée et sera examinée par l'équipe, qui pourra alerter l'utilisateur par email une fois disponible — ne dis jamais que la fonctionnalité existe déjà ou qu'elle sera disponible à une date précise que tu ne connais pas.`;
    }
    // Question à deux intentions dans la même phrase (demande du 27/09/2026, bug signalé : "le CA de
    // cet article et son stock ?" ne répondait qu'au CA) — le second résultat est donné en texte
    // seulement, JAMAIS retourné comme toolResult au frontend (cf. commentaire de runToolForQuestion :
    // le frontend suppose un toolResult unique pour construire un graphique/tableau).
    if (secondaryToolResult) {
      dataSection += `\n\nLa question contient AUSSI une seconde demande distincte, à laquelle tu dois répondre en plus de la première (les deux dans la même réponse) — données réelles pour ce second volet (outil "${secondaryToolName}") :\n${JSON.stringify(secondaryToolResult, null, 2)}`;
    }
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

Si les données contiennent un champ "lastSyncedAt" non nul : les ventes ne sont jamais consultées en temps réel sur le serveur magasin, elles sont synchronisées en base toutes les 15 minutes — précise donc TOUJOURS dans ta réponse jusqu'à quelle date ET heure les données sont à jour, au format complet "JJ mois AAAA à HHhMM" (ex: "données à jour jusqu'au 27 septembre 2026 à 14h32"), converti depuis lastSyncedAt en heure lisible (fuseau Africa/Abidjan) — la DATE fait TOUJOURS partie de la mention, jamais seulement l'heure seule, même quand la période demandée est "aujourd'hui" (bug constaté le 27/09/2026 : l'heure seule, sans date, devenait ambiguë/trompeuse dès que la période portait sur plusieurs jours passés, ex: "le mois dernier" affichait juste "12h30" sans dire de quel jour). Si la question porte sur "aujourd'hui"/le jour même, ajoute en plus que les ventes les plus récentes (moins de 15 minutes) peuvent ne pas encore être comptabilisées. Si "lastSyncedAt" est absent ou null (aucune vente trouvée sur la période), ne mentionne pas cette fraîcheur, elle n'a pas de sens sans donnée.

Si les données contiennent un champ "targetShopLabel" non nul : la question ciblait explicitement un AUTRE magasin que celui de la session en cours (un ADMIN/SUPERVISOR a nommé ce magasin par sa référence) — précise TOUJOURS dans ta réponse le nom de ce magasin (ex: "Le chiffre d'affaires du magasin 035 XYZ..."), jamais une réponse qui laisserait croire qu'il s'agit du magasin habituel de la conversation.

Si les données contiennent des champs "periodStart"/"periodEnd" (28/09/2026, "toujours afficher clairement la période d'analyse") : précise TOUJOURS la période exacte utilisée pour ce chiffre, au format "du JJ/MM/AAAA au JJ/MM/AAAA" (ou une seule date si periodStart et periodEnd tombent le même jour calendaire), convertie depuis ces champs ISO en heure lisible (fuseau Africa/Abidjan) — jamais seulement "days"/"date" en interne sans reformuler en dates lisibles. Si la conversation contient DÉJÀ un autre chiffre calculé sur une période DIFFÉRENTE (ex: le CA du jour puis le CA sur 30 jours), indique explicitement que ces deux chiffres portent sur des périodes différentes plutôt que de les laisser côte à côte sans le dire — ne jamais laisser croire que deux chiffres sur des fenêtres différentes se comparent directement.

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
  const { toolName, toolResult, reusedFromHistory, secondaryToolName, secondaryToolResult } = await runToolForQuestion(rposShopId, question, { department, conversationHistory, posId, user });
  // En clarification active, le suivi de demande doit passer AVANT tout affichage de données : la
  // réponse de l'utilisateur à "quelles infos voulez-vous dans ce résumé ?" ne doit jamais être
  // interprétée comme une nouvelle question de données, même si elle mentionne "CA"/"rupture".
  const skipToolForPendingClarification = !!pendingFeatureRequest;
  const effectiveToolResult = skipToolForPendingClarification ? null : toolResult;
  const suggestedQuestions = effectiveToolResult || reusedFromHistory ? null : await getSuggestedQuestions();
  const prompt = skipToolForPendingClarification
    ? `Tu es l'Assistant IA d'une application de gestion de stock/réassort. Tu avais précédemment demandé une précision à l'utilisateur au sujet d'un besoin d'évolution non encore disponible dans l'application : "${pendingFeatureRequest.problem}". L'utilisateur répond maintenant : "${question}". Accuse réception de sa précision en une phrase brève, sans inventer de fonctionnalité ni prétendre l'avoir déjà mise en place.`
    : await buildChatbotPrompt({ shopReference, shopName, department, subDepartment, conversationHistory, question, toolName, toolResult: effectiveToolResult, reusedFromHistory, suggestedQuestions, secondaryToolName, secondaryToolResult: skipToolForPendingClarification ? null : secondaryToolResult });

  const { fullText, providerUsed } = await streamWithFallback(prompt, (chunk) => {
    if (onTextChunk) onTextChunk(chunk);
  }, 'chatbot-answer');

  // Suivi des demandes d'évolution (§2-§9 de la spec) NE bloque plus la réponse principale (demande
  // du 28/09/2026 : "pourquoi le chatbot prend du temps pour répondre" — ce 2e appel LLM, complet et
  // synchrone, retardait la fin de CHAQUE question hors-sujet/non reconnue de plusieurs secondes,
  // alors que l'utilisateur avait déjà lu sa réponse). Extrait dans runFeatureRequestTracking
  // ci-dessous, appelé par la route ask-stream APRÈS avoir envoyé l'événement SSE "done" — le message
  // assistant est mis à jour en base une fois ce suivi terminé (cf. routes/reassort/ai.js), jamais
  // achevé avant que la conversation n'ait déjà été rendue à l'utilisateur.
  const finalAnswer = fullText.trim();
  // Bug trouvé le 28/09/2026 (conversation réelle) : shouldTrackFeatureRequest ne se déclenchait QUE
  // si AUCUN outil n'avait matché la question (toolResult null) — un outil qui matche mais répond
  // honnêtement found:false ("Article introuvable dans la dernière proposition", "les données
  // fournies ne contiennent pas...") ne déclenchait jamais le suivi, alors que c'est EXACTEMENT le
  // cas où l'utilisateur bute sur une vraie limite de données/fonctionnalité qui mériterait d'être
  // notée (demande explicite : "si il n'a pas la donnée, qu'il le dise et prenne note"). Un outil
  // qui a RÉELLEMENT répondu (found true, ou found absent pour les outils qui ne l'utilisent pas)
  // ne déclenche toujours pas le suivi — seul un found:false explicite (ou l'absence totale d'outil)
  // compte comme une lacune à faire remonter.
  const toolFoundNothing = effectiveToolResult && typeof effectiveToolResult === 'object' && effectiveToolResult.found === false;
  const shouldTrackFeatureRequest = (!effectiveToolResult || toolFoundNothing) && !reusedFromHistory;

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
  return {
    answer: finalAnswer, providerUsed, toolUsed: toolName, toolResult: effectiveToolResult,
    wantsVisual: isVisualRequest(question) || !!reusedFromHistory,
    featureRequest: null, pendingFeatureRequest,
    // Consommés uniquement par la route ask-stream, jamais renvoyés au client (cf. plus bas) — tout
    // ce dont runFeatureRequestTracking a besoin pour tourner après coup, sans redemander ces
    // valeurs au moment de l'appeler.
    _featureTrackingContext: shouldTrackFeatureRequest ? { conversationHistory, question, answer: finalAnswer, pendingFeatureRequest, user } : null,
  };
}

/**
 * Exécute le suivi de demande d'évolution (§2-§9) APRÈS que la réponse principale a déjà été
 * envoyée à l'utilisateur (cf. commentaire dans askAssistant ci-dessus) — jamais awaité par la route
 * avant d'envoyer l'événement SSE "done". `onUpdate(patch)` est appelé une seule fois si ce suivi
 * produit un texte à ajouter ou un nouvel état de clarification à persister ; reste silencieux
 * (n'appelle jamais onUpdate) si rien ne change, pour ne jamais réécrire un message pour rien.
 */
async function runFeatureRequestTracking({ conversationHistory, question, answer, pendingFeatureRequest, user }, onUpdate) {
  try {
    // Avec une clarification en attente, on fusionne le besoin déjà connu et la précision qui vient
    // d'être donnée : le LLM de suivi juge sur l'ensemble, jamais seulement sur ce dernier message
    // isolé (qui, seul, ne ressemble à rien — ex: "surtout les ruptures et le CA de la veille").
    const effectiveQuestion = pendingFeatureRequest
      ? `Besoin déjà exprimé précédemment : ${pendingFeatureRequest.problem}\nPrécision supplémentaire de l'utilisateur : ${question}`
      : question;
    const decision = await maybeTrackFeatureRequest({ conversationHistory, question: effectiveQuestion, answer });

    if (decision && decision.readyToRecord) {
      const featureRequest = await recordFeatureRequest(decision, { user });
      const confirmation = featureRequest.action === 'enriched'
        ? `\n\n✅ J'ai bien noté ce besoin et l'ai ajouté à une demande déjà enregistrée (« ${featureRequest.title} »). Si vous avez d'autres précisions à ajouter, n'hésitez pas à me les donner.`
        : `\n\n✅ J'ai enregistré ce besoin comme demande d'évolution (« ${featureRequest.title} »), transmise à l'équipe de développement. Si vous avez d'autres précisions à ajouter, n'hésitez pas à me les donner.`;
      onUpdate({ appendText: confirmation, featureRequest, pendingFeatureRequest: null });
    } else if (decision && decision.clarifyingQuestion) {
      // Besoin réel mais encore trop vague pour être exploitable (§3 de la spec : "poser des
      // questions ciblées") — rien n'est enregistré tant que la précision n'est pas obtenue.
      const newPendingFeatureRequest = { title: decision.title, problem: decision.problem, expectedBehavior: decision.expectedBehavior };
      onUpdate({ appendText: `\n\n${decision.clarifyingQuestion}`, featureRequest: null, pendingFeatureRequest: newPendingFeatureRequest });
    }
    // decision null (pas un vrai besoin d'évolution) : rien à ajouter, onUpdate jamais appelé.
  } catch (err) {
    // Un échec d'enregistrement (contrainte base, service indisponible...) ne doit JAMAIS faire
    // planter ce traitement en tâche de fond — il tourne après que la réponse a déjà été rendue,
    // aucun appelant n'attend son résultat pour continuer.
    console.error('[chatbotService] Enregistrement de la demande d\'évolution échoué:', err.message);
  }
}

// Questions suggérées (§34) : éditables depuis Paramètres > IA (CHATBOT_SUGGESTED_QUESTIONS, une par
// ligne) sans redéploiement — servent aussi de référence pour indiquer au magasin ce que l'assistant
// sait réellement faire quand une question sort du périmètre couvert (cf. buildChatbotPrompt).
async function getSuggestedQuestions() {
  const raw = await systemConfig.getValue(systemConfig.KEYS.CHATBOT_SUGGESTED_QUESTIONS);
  return (raw || '').split('\n').map((q) => q.trim()).filter(Boolean);
}

module.exports = { askAssistant, runFeatureRequestTracking, detectIntent, extractEan, extractDays, extractDate, resolveDateRange, getSuggestedQuestions, VALID_INTENT_TOOLS, isVisualRequest, runToolForQuestion };
