/**
 * Règles de détection d'intention du chatbot par défaut (liste éditable depuis Paramètres > IA,
 * CHATBOT_INTENT_RULES) — source UNIQUE, partagée entre chatbotService.js (qui l'utilisait en tant
 * que FALLBACK_INTENT_RULES local) et systemConfigService.js (qui en gardait une COPIE séparée dans
 * ENV_FALLBACK, jamais synchronisée). Les deux copies avaient divergé en pratique : getValue()
 * (systemConfigService.js) retombe sur ENV_FALLBACK dès que la ligne est absente en base, jamais sur
 * FALLBACK_INTENT_RULES de chatbotService.js, qui n'était donc en réalité JAMAIS consultée — un
 * mot-clé ajouté uniquement là-bas (bug constaté le 06/10/2026 : plusieurs correctifs de la journée
 * n'avaient aucun effet réel pour cette raison précise) ne changeait rien tant qu'aucune ligne
 * CHATBOT_INTENT_RULES n'était déjà présente en base. Fusionné ici en un seul fichier sans
 * dépendance circulaire (chatbotService.js -> systemConfigService.js dans un seul sens ; les deux
 * peuvent désormais require() ce fichier neutre sans créer de cycle).
 *
 * L'ORDRE compte : la première règle dont un mot-clé matche la question gagne (cf. detectIntent,
 * chatbotService.js). La règle Pareto générique (X% du CA, n'importe quel X) reste codée en dur
 * dans chatbotService.js (PARETO_PATTERN_REGEX, une vraie regex, pas un mot-clé exact) — hors de
 * cette liste éditable, toujours vérifiée en premier.
 */
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
  // "le prix de" (sans "vente"/"actuel") ajouté le 05/10/2026 (bug trouvé en testant la recherche
  // par nom : "quel est le prix de l'article codys ?" ne matchait aucun mot-clé existant — seuls
  // "prix de vente"/"prix actuel"/"quel prix" l'étaient — donc tombait sur le filet LLM générique au
  // lieu de cette règle déterministe, qui seule sait basculer vers searchArticlesByName/EAN manquant.
  { keywords: ['où se trouve', 'ou se trouve', 'emplacement', 'où est', 'ou est', 'quel rayon', 'dans quel rayon', 'adresse rayon', 'prix actuel', 'prix de vente', 'prix promo', 'en promo', 'promotion', 'quel prix', 'le prix de', 'prix de l\'article', 'prix de larticle', 'combien coûte', 'combien coute', 'fiche article', 'fiche produit', 'fiche complète', 'fiche complete', 'détails de l\'article', 'details de larticle', 'infos article', 'informations sur l\'article', 'toutes les informations', 'tout savoir sur', 'caractéristiques', 'caracteristiques', 'fournisseur de'], tool: 'getArticleDetails' },
  // "les chiffres du jour"/"chiffres d'aujourd'hui" ajoutés le 06/10/2026 (bug trouvé en conversation
  // réelle : une relance naturelle après une salutation, "je veux les chiffres du jour", ne matchait
  // aucun mot-clé — ni "ca" isolé ni "chiffre d'affaires" en toutes lettres — et tombait sur le
  // filet LLM de routage, ajoutant ~5s avant même la réponse pour une formulation pourtant courante).
  { keywords: ['chiffre d\'affaires', 'chiffre daffaire', 'chiffre d affaire', 'le ca', 'du ca', 'au ca', 'ton ca', 'mon ca', 'quel ca', 'ca du', 'ca le', 'ca est', 'ca de', 'combien on a fait', 'combien jai fait', 'combien on a vendu en argent', 'recette du jour', 'recette de', 'les chiffres du jour', 'chiffres du jour', 'chiffres d\'aujourd\'hui', 'chiffres daujourdhui', 'les chiffres d\'aujourd\'hui'], tool: 'getRevenue' },
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
  // getValidatedOrders ajouté le 06/10/2026 (demande explicite : détail complet RPOS d'une commande
  // VALIDÉE — qui a validé, fournisseur, dates, statut) — placé AVANT getOrders générique ci-dessous
  // pour les mêmes raisons que getOrderAnomalies/getOrders juste au-dessus : "commandes validées"
  // contient "commande" mais désigne un besoin précis (détail RPOS), jamais la liste interne basique.
  { keywords: ['commande validée', 'commandes validées', 'commande validee', 'commandes validees', 'qui a validé', 'qui a valide', 'commande a été validée', 'commande a ete validee'], tool: 'getValidatedOrders' },
  { keywords: ['mes commandes', 'commandes en cours', 'commandes récentes', 'liste des commandes', 'qu\'est-ce qui a été commandé', 'quest ce qui a ete commande', 'quoi a ete commande', 'derniere commande', 'dernières commandes'], tool: 'getOrders' },
  // "aujourd'hui" retiré (bug trouvé le 21/09/2026, campagne de fuzzing large) : trop générique,
  // matchait à tort N'IMPORTE QUELLE question du jour (ex: "chiffre d'affaire aujourd'hui" tombait
  // sur getCurrentProposal au lieu de getRevenue). "proposition"/"commander" restent assez précis
  // pour cet outil sans avoir besoin de ce mot-clé fourre-tout.
  // explainProposalQuantity ajouté le 06/10/2026 (demande explicite : "pourquoi cette quantité...
  // il doit pouvoir m'expliquer") — placé AVANT getCurrentProposal générique ci-dessous : "pourquoi"
  // + un mot de quantité désigne un besoin d'EXPLICATION précise (appel IA en direct), jamais la
  // simple liste/le résumé de la proposition.
  { keywords: ['pourquoi cette quantité', 'pourquoi cette quantite', 'pourquoi cette qté', 'pourquoi commander autant', 'explique cette quantité', 'explique cette quantite', 'justifie cette quantité', 'justifie cette quantite'], tool: 'explainProposalQuantity' },
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

module.exports = { FALLBACK_INTENT_RULES };
