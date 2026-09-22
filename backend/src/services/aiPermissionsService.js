/**
 * Permissions de l'Assistant IA par capacité (CAHIER_DES_CHARGES.md, plan de rôles validé le
 * 15/09/2026). Chaque rôle a un défaut ; un ADMIN peut ensuite personnaliser ce réglage pour un
 * utilisateur précis (User.aiPermissionsJson) sans changer son rôle.
 *
 * Capacités :
 *   revenueShop     : CA du magasin entier (getRevenue sans filtre article/département)
 *   revenueArticle  : CA d'un article ou d'un département précis (getRevenue filtré, part du CA
 *                     dans getArticleDetails/getParetoArticles)
 *   articleDetails  : fiche article, emplacement, prix, promo (getArticleDetails, getPriceChangeHistory)
 *   stock           : stock, ruptures, surstock (getArticleStock, getStoreStock, getStockoutRisks,
 *                     getOverstockArticles, getDlvArticles, getArticleDlvStatus)
 *   sales           : ventes et tendances (getSalesHistory, getParetoArticles)
 *   orders          : commandes et propositions (getOrders, getCurrentProposal)
 *   accuracy        : fiabilité de l'IA (getPredictionAccuracy)
 */

const prisma = require('../utils/prisma');

const CAPABILITIES = ['revenueShop', 'revenueArticle', 'articleDetails', 'stock', 'sales', 'orders', 'accuracy'];

const ALL_ALLOWED = Object.fromEntries(CAPABILITIES.map((c) => [c, true]));

// Défauts par rôle (plan §6) : SHELF_STOCKER et DEPARTMENT_HEAD sont bloqués sur revenueShop dans
// tous les cas ; seul revenueArticle les distingue (le Chef de département peut le voir sur son
// périmètre, le Rayonniste jamais, même pour ses propres articles).
const ROLE_DEFAULTS = {
  ADMIN: ALL_ALLOWED,
  SUPERVISOR: ALL_ALLOWED,
  DIRECTOR: ALL_ALLOWED,
  DEPARTMENT_HEAD: { ...ALL_ALLOWED, revenueShop: false },
  SHELF_STOCKER: { ...ALL_ALLOWED, revenueShop: false, revenueArticle: false },
  // STORE : alias historique conservé pour tout compte pas encore migré (ne devrait plus exister
  // après la migration 20260915190000, gardé par prudence plutôt que de planter sur un rôle inconnu).
  STORE: ALL_ALLOWED,
};

/** Table de correspondance outil -> capacité requise, utilisée par chatbotService.js. */
const TOOL_CAPABILITY = {
  getRevenue: null, // résolu dynamiquement (revenueShop vs revenueArticle) selon la présence d'un filtre ean/department, cf. resolveRevenueCapability
  getRevenueAllShops: 'revenueShop', // même capacité que le CA d'un seul magasin — la restriction ADMIN/SUPERVISOR est appliquée dans chatbotService.js, pas ici
  getArticleDetails: 'articleDetails',
  getArticlesByGisement: 'articleDetails',
  getTopGisements: 'articleDetails',
  getPriceChangeHistory: 'articleDetails',
  getArticleStock: 'stock',
  getStoreStock: 'stock',
  getStockoutRisks: 'stock',
  getOverstockArticles: 'stock',
  getStockMoveHistory: 'stock',
  getDlvArticles: 'stock',
  getArticleDlvStatus: 'stock',
  getSalesHistory: 'sales',
  getParetoArticles: 'sales',
  getOrders: 'orders',
  getCurrentProposal: 'orders',
  getPredictionAccuracy: 'accuracy',
};

/** getRevenue seul est ambigu : CA global (revenueShop) si aucun filtre, CA d'un périmètre précis (revenueArticle) sinon. */
function resolveRevenueCapability({ ean, department }) {
  return (ean || department) ? 'revenueArticle' : 'revenueShop';
}

/**
 * Permissions effectives d'un utilisateur : son réglage personnalisé (aiPermissionsJson) s'il existe,
 * sinon le défaut de son rôle. Jamais un mélange des deux — une personnalisation remplace le défaut
 * capacité par capacité pour rester prévisible (un champ absent du JSON personnalisé retombe sur le
 * défaut du rôle pour CETTE capacité précise, pas sur `false`).
 */
// Défaut "fail-closed" pour tout rôle non reconnu (jamais ALL_ALLOWED) : un bug ailleurs qui écrit
// un rôle invalide en base, ou un role manquant/null, doit se traduire par un blocage de toutes les
// capacités sensibles plutôt qu'un accès complet accidentel — sécurité vérifiée par test le
// 15/09/2026 (audit de robustesse avant de poursuivre l'implémentation).
const FAIL_CLOSED_DEFAULTS = Object.fromEntries(CAPABILITIES.map((c) => [c, false]));

function getEffectivePermissions(user) {
  const roleDefaults = ROLE_DEFAULTS[user?.role] || FAIL_CLOSED_DEFAULTS;
  let custom = null;
  if (user?.aiPermissionsJson) {
    try {
      custom = JSON.parse(user.aiPermissionsJson);
    } catch {
      custom = null; // JSON corrompu : ignoré, retombe sur le défaut du rôle plutôt que de planter
    }
  }
  return { ...roleDefaults, ...(custom || {}) };
}

/**
 * Vérifie si `user` peut utiliser `toolName` avec les paramètres donnés (ean/department utiles
 * uniquement pour désambiguïser getRevenue). Retourne { allowed, capability } — capability est
 * exposée pour un message d'erreur explicite côté chatbot ("le CA du magasin ne vous est pas
 * accessible").
 */
function checkToolPermission(user, toolName, { ean, department } = {}) {
  if (toolName === 'getRevenue') {
    const capability = resolveRevenueCapability({ ean, department });
    return { allowed: !!getEffectivePermissions(user)[capability], capability };
  }

  // Un outil ABSENT de TOOL_CAPABILITY est bloqué par défaut (fail-closed), pas autorisé — un futur
  // outil ajouté au chatbot sans être classé ici doit être refusé jusqu'à classification explicite,
  // jamais accessible par oubli (faille trouvée le 15/09/2026 lors de l'audit de robustesse : un
  // outil inconnu passait "allowed: true" sans aucune vérification).
  if (!(toolName in TOOL_CAPABILITY)) {
    return { allowed: false, capability: 'unclassified' };
  }
  const capability = TOOL_CAPABILITY[toolName];
  if (!capability) return { allowed: true, capability: null }; // explicitement marqué hors périmètre (null), pas juste absent

  const permissions = getEffectivePermissions(user);
  return { allowed: !!permissions[capability], capability };
}

const CAPABILITY_LABELS = {
  revenueShop: 'le chiffre d\'affaires du magasin',
  revenueArticle: 'le chiffre d\'affaires de cet article/département',
  articleDetails: 'la fiche article (prix, emplacement, promotions)',
  stock: 'le stock et les ruptures',
  sales: 'les ventes et tendances',
  orders: 'les commandes et propositions',
  accuracy: 'la fiabilité de l\'IA',
  unclassified: 'cette fonctionnalité',
};

// Exemples de questions par capacité (demande du 16/09/2026 : "créer une vue qui guide les questions
// que chaque profil peut poser") — mêmes formulations que celles reconnues par INTENT_RULES
// (chatbotService.js), pour que le guide affiché corresponde exactement à ce que l'IA sait détecter,
// jamais un exemple qui échouerait silencieusement une fois posé pour de vrai. Tenu à jour à la main
// en miroir de INTENT_RULES — pas de source unique automatique entre les deux, faute d'un identifiant
// commun autre que le nom de la capacité elle-même.
const CAPABILITY_EXAMPLES = {
  revenueShop: ['Quel est le chiffre d\'affaires du magasin aujourd\'hui ?', 'Quelle était la recette d\'hier ?'],
  revenueArticle: ['Quel est le chiffre d\'affaires de cet article ?', 'Quelle part du CA fait mon rayon ?'],
  articleDetails: ['Où se trouve cet article ?', 'Quel est le prix de vente de cet article ?', 'Quand a-t-il changé de prix ?'],
  stock: ['Quel est le stock de cet article ?', 'Quels articles risquent d\'être en rupture ?', 'Quels articles sont en surstock ?', 'Pourquoi le stock de cet article a bougé ?'],
  sales: ['Comment évoluent les ventes ce mois-ci ?', 'Quels articles font le plus de chiffre d\'affaires ?'],
  orders: ['Quelles commandes ont été passées récemment ?', 'Quels articles dois-je commander aujourd\'hui ?'],
  accuracy: ['Quelle est la fiabilité de l\'IA sur ce magasin ?'],
};

/**
 * Guide des questions possibles pour `user`, à afficher directement dans l'Assistant IA ("Ce que je
 * peux vous demander") — reflète les permissions RÉELLEMENT appliquées (rôle + personnalisation
 * éventuelle via aiPermissionsJson), jamais une liste générique identique pour tout le monde. Une
 * capacité refusée est listée séparément avec son libellé, pour que l'utilisateur comprenne à
 * l'avance qu'une question sur ce sujet sera refusée plutôt que de le découvrir après coup.
 */
function getCapabilityGuide(user) {
  const permissions = getEffectivePermissions(user);
  const allowed = [];
  const denied = [];
  for (const capability of CAPABILITIES) {
    const entry = { capability, label: CAPABILITY_LABELS[capability], examples: CAPABILITY_EXAMPLES[capability] || [] };
    if (permissions[capability]) allowed.push(entry);
    else denied.push(entry);
  }
  return { allowed, denied };
}

// Rôles bornés à un département/rayon précis (User.assignedDepartment) — plan de rôles validé le
// 15/09/2026, étape 3 : DEPARTMENT_HEAD/SHELF_STOCKER ne doivent voir, dans une proposition de
// commande, QUE les lignes de leur périmètre, jamais les autres rayons du même magasin.
const DEPARTMENT_SCOPED_ROLES = new Set(['DEPARTMENT_HEAD', 'SHELF_STOCKER']);

// Rôles bornés à un seul magasin fixe (User.rposShopId) — même ensemble que SINGLE_SHOP_ROLES dans
// middleware/auth.js, dupliqué ici volontairement pour éviter une dépendance circulaire
// (middleware/auth.js ne doit dépendre d'aucun service métier) — les deux DOIVENT rester identiques,
// modifiez-les ensemble si un rôle change de catégorie.
const SINGLE_SHOP_ROLES = new Set(['STORE', 'DIRECTOR', 'DEPARTMENT_HEAD', 'SHELF_STOCKER']);

/**
 * Guide "Ce que je peux faire sur la plateforme" (demande du 16/09/2026 : "chaque user dois voir ce
 * quil peux faire sur la plaforme", au-delà des seules questions du chatbot) — pages accessibles et
 * actions clés par rôle. Reflète les règles RÉELLEMENT appliquées par le code (requireAdmin,
 * SINGLE_SHOP_ROLES, DEPARTMENT_SCOPED_ROLES dans les routes backend) : cette fonction ne fait que
 * DÉCRIRE ces règles en français pour l'affichage, jamais les appliquer elle-même — la sécurité
 * réelle reste portée par les routes/middlewares, pas par ce texte. Si une règle change dans une
 * route, ce texte doit être mis à jour en conséquence (pas de source unique automatique, faute d'un
 * moyen fiable de dériver une description humaine directement du code des routes).
 */
// Libellé pluriel du rôle, utilisé pour nommer explicitement "qui" peut faire quoi (demande du
// 16/09/2026 : "si il est directeur ... on lui [dit] les directeur peuvent faire ........") — un
// Directeur doit voir "Les Directeurs peuvent...", pas une formulation neutre en "vous" qui pourrait
// aussi bien s'appliquer à n'importe quel rôle.
const ROLE_PLURAL_LABELS = {
  ADMIN: 'Les Administrateurs',
  SUPERVISOR: 'Les Superviseurs',
  DIRECTOR: 'Les Directeurs',
  DEPARTMENT_HEAD: 'Les Chefs de département',
  SHELF_STOCKER: 'Les Rayonnistes',
  STORE: 'Les comptes Magasin',
};

function getPlatformGuide(user) {
  const role = user?.role;
  const isAdmin = role === 'ADMIN';
  const isSupervisor = role === 'SUPERVISOR';
  const isSingleShop = SINGLE_SHOP_ROLES.has(role);
  const isDepartmentScoped = DEPARTMENT_SCOPED_ROLES.has(role);
  const roleLabel = ROLE_PLURAL_LABELS[role] || 'Ce compte';
  const scopeLabel = isDepartmentScoped
    ? 'votre rayon assigné'
    : isSingleShop
    ? 'votre magasin'
    : isSupervisor
    ? 'vos magasins supervisés'
    : 'tous les magasins';
  // Variante à la 3e personne du pluriel ("leur magasin"), pour les phrases qui commencent par
  // roleLabel ("Les Directeurs peuvent...") — jamais mélanger "Les Directeurs" avec "votre magasin"
  // dans la même phrase, grammaticalement incohérent.
  const scopeLabelTheir = isDepartmentScoped
    ? 'leur rayon assigné'
    : isSingleShop
    ? 'leur magasin'
    : isSupervisor
    ? 'leurs magasins supervisés'
    : 'tous les magasins';

  const pages = [
    { name: 'Tableau de bord', description: `Vue d'ensemble des propositions et indicateurs de ${scopeLabel}.` },
    { name: 'Assistant IA', description: `Poser des questions en langage naturel sur ${scopeLabel} (ventes, stock, commandes...).` },
    { name: 'Proposition de commande', description: `Consulter et valider les propositions de réassort de ${scopeLabel}.` },
    { name: 'Historique', description: `Historique des commandes déjà validées pour ${scopeLabel}.` },
    { name: 'Ventes synchronisées', description: `Consulter les ventes déjà synchronisées pour ${scopeLabel}.` },
    { name: 'IA & Prédictions', description: `Prédictions et fiabilité de l'IA pour ${scopeLabel}.` },
  ];
  if (isAdmin) {
    pages.push(
      { name: 'Vue globale', description: 'Indicateurs agrégés sur tous les magasins (réservé Administrateur).' },
      { name: 'Améliorations IA', description: 'Constats et recommandations du Conseiller d\'amélioration IA (réservé Administrateur).' },
      { name: 'Journal d\'audit', description: 'Historique des erreurs techniques remontées par l\'application (réservé Administrateur).' },
      { name: 'Utilisateurs', description: 'Créer, modifier et désactiver les comptes de la plateforme (réservé Administrateur).' },
      { name: 'Paramètres', description: 'Configuration technique complète : réassort, synchronisation, RPOS, IA, planification (réservé Administrateur).' },
    );
  }

  const actions = [];
  if (isDepartmentScoped) {
    actions.push(`${roleLabel} peuvent voir et valider uniquement les articles de ${scopeLabelTheir} dans une proposition de commande — les autres rayons du même magasin ne sont pas affichés.`);
  } else {
    actions.push(`${roleLabel} peuvent voir et valider l'ensemble des articles d'une proposition de commande pour ${scopeLabelTheir}.`);
  }
  if (role === 'SHELF_STOCKER') {
    actions.push(`${roleLabel} peuvent poser des questions à l'Assistant IA sur les articles de leur rayon, mais jamais sur le chiffre d'affaires (ni du magasin, ni de leurs propres articles).`);
  } else if (role === 'DEPARTMENT_HEAD') {
    actions.push(`${roleLabel} peuvent poser des questions à l'Assistant IA sur les articles de leur rayon, y compris leur chiffre d'affaires — mais jamais le chiffre d'affaires global du magasin.`);
  } else {
    actions.push(`${roleLabel} peuvent poser toute question à l'Assistant IA sur le périmètre ci-dessus, y compris le chiffre d'affaires.`);
  }
  if (isAdmin) {
    actions.push(`${roleLabel} peuvent créer, modifier, désactiver un compte et lui assigner un rôle, un magasin et des permissions IA personnalisées.`);
    actions.push(`${roleLabel} peuvent modifier toute la configuration technique (clés API IA, synchronisation, planification des tâches automatiques, connexion aux serveurs RPOS).`);
  } else {
    actions.push(`${roleLabel} n'ont aucun accès aux paramètres techniques de la plateforme, ni à la gestion des comptes — ces écrans ne sont visibles que par un Administrateur.`);
  }
  if (isSupervisor) {
    actions.push(`${roleLabel} peuvent changer de magasin actif parmi la liste de leurs magasins supervisés, sans pouvoir en ajouter eux-mêmes (assigné par un Administrateur).`);
  }

  return { role: role || null, roleLabel, scopeLabel, pages, actions };
}

/**
 * Filtre les lignes d'une proposition (ProposalLine[]) selon le département/rayon assigné à
 * l'utilisateur — no-op pour tout rôle non borné à un département (ADMIN, SUPERVISOR, DIRECTOR).
 * `user.assignedDepartment` peut contenir plusieurs noms séparés par une virgule (SHELF_STOCKER
 * multi-rayons, cf. schema.prisma) — une ligne est gardée si SON department correspond à l'UN
 * d'entre eux (comparaison exacte, insensible à la casse/espaces superflus).
 */
function filterProposalLinesForUser(lines, user) {
  if (!user || !DEPARTMENT_SCOPED_ROLES.has(user.role)) return lines;
  if (!user.assignedDepartment) return []; // rôle restreint sans département assigné : rien à montrer, jamais tout par défaut

  const allowed = new Set(
    user.assignedDepartment.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean)
  );
  return lines.filter((line) => line.department && allowed.has(line.department.trim().toLowerCase()));
}

/**
 * Vérifie qu'un article précis (EAN) est dans le périmètre de département de `user`, pour tout
 * endroit où un article est ciblé explicitement par son EAN plutôt qu'obtenu depuis une liste déjà
 * filtrée en amont (chatbot, analyse IA ponctuelle d'un article...) — sans ce contrôle, un
 * Rayonniste/Chef de département pourrait interroger n'importe quel article hors de son rayon en
 * connaissant/mentionnant simplement son EAN (faille trouvée le 16/09/2026 : le chatbot répondait
 * avec le stock réel d'un article d'un autre rayon dès que l'EAN était cité dans la question).
 * Retourne true si l'accès est autorisé (rôles non bornés par département toujours autorisés, ou
 * article jamais proposé donc rien à comparer).
 */
async function isEanInUserScope(shopId, ean, user) {
  if (!user || !DEPARTMENT_SCOPED_ROLES.has(user.role)) return true;
  if (!ean || !shopId) return true;
  const latestLineForEan = await prisma.proposalLine.findFirst({
    where: { ean, proposal: { rposShopId: shopId } },
    orderBy: { proposal: { generatedAt: 'desc' } },
    select: { department: true },
  });
  if (!latestLineForEan) return true; // article jamais proposé : rien à restreindre ici
  return filterProposalLinesForUser([latestLineForEan], user).length > 0;
}

module.exports = {
  CAPABILITIES,
  ROLE_DEFAULTS,
  CAPABILITY_LABELS,
  DEPARTMENT_SCOPED_ROLES,
  getEffectivePermissions,
  checkToolPermission,
  resolveRevenueCapability,
  filterProposalLinesForUser,
  isEanInUserScope,
  getCapabilityGuide,
  getPlatformGuide,
};
