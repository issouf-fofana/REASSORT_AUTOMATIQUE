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
  // "mouvement sur l'article"/"mouvements sur" ajoutés le 06/10/2026 (bug trouvé en conversation
  // réelle : "donne moi le mouvement sur l'article X à la date du..." ne matchait aucun mot-clé —
  // seuls "mouvement DE stock"/"pourquoi LE stock" l'étaient — tombait sur le filet LLM générique,
  // qui a répondu avec la fiche article au lieu de l'historique de mouvements demandé).
  // "évolué le stock"/"évolution du stock" ajoutés le 12/10/2026 (bug trouvé en conditions réelles :
  // "comment a évolué le stock de 100337863" matchait "stock de" de la règle getArticleStock PLUS
  // LOIN dans cette liste — aucun mot-clé de CETTE règle ne couvrait "évolué"/"évolution", malgré que
  // ce soit la vraie intention : l'évolution/l'historique des mouvements, pas le stock actuel à
  // l'instant T). Doit rester AVANT getArticleStock (déjà le cas, cf. ordre de cette liste) pour
  // gagner sur son propre "stock de"/"stock du" plus générique.
  { keywords: ['pourquoi le stock', 'pourquoi son stock', 'stock a baissé', 'stock a baisse', 'stock a bougé', 'stock a bouge', 'stock a chuté', 'stock a chute', 'stock a diminué', 'stock a diminue', 'évolué le stock', 'evolue le stock', 'évolution du stock', 'evolution du stock', 'évolution de son stock', 'evolution de son stock', 'historique du stock', 'historique de son stock', 'mouvement de stock', 'mouvements de stock', 'mouvement sur', 'mouvements sur', 'le mouvement', 'les mouvements', 'type de mouvement', 'types de mouvement', 'type de mouvements', 'quel mouvement', 'quels mouvements', 'de la casse', 'en casse', 'casse sur', 'article volé', 'article vole', 'cession de rayon', 'cession entre rayon', 'cession inter-rayon', 'retour fournisseur', 'écart de stock', 'ecart de stock', 'disparition de stock'], tool: 'getStockMoveHistory' },
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
  // getPosOnlyValidatedOrders ajouté le 14/10/2026 (demande explicite : "les commandes qui ont été
  // validées aujourd'hui sur le pos et pas sur la plateforme seulement") — DOIT rester AVANT la
  // règle getValidatedOrders générique juste en dessous : "commande validée sur le pos"/"hors
  // plateforme" contient aussi "commande validée" et matcherait sinon à tort la règle générique
  // (qui ne couvre QUE les commandes créées par cette plateforme, l'inverse de ce qui est demandé
  // ici). Bug trouvé en test réel le 14/10/2026 : un premier jeu de mots-clés au singulier
  // ("validée sur le pos") ne matchait JAMAIS la formulation plurielle réelle ("validées sur le
  // pos") — le matching ici est un simple .includes() sur la question normalisée, jamais une regex
  // tolérante au pluriel/accord, donc chaque variante grammaticale plausible doit être listée
  // explicitement. Mots-clés courts ("sur le pos", "sur la caisse") combinés uniquement à des
  // formulations contenant déjà "commande"/"valid" plus haut dans cette liste n'étant pas un risque
  // ici car cette règle teste "le pos"/"la plateforme" eux-mêmes, suffisamment spécifiques pour ne
  // jamais apparaître dans une question générale sur les commandes.
  { keywords: ['sur le pos', 'sur la caisse', 'pas sur la plateforme', 'hors plateforme', 'hors de la plateforme', 'sans passer par la plateforme', 'en dehors de la plateforme'], tool: 'getPosOnlyValidatedOrders' },
  // "commande(s) du/au fournisseur" ajouté le 14/10/2026 (demande explicite : "je dois pouvoir
  // demande les commande lie a un fournisseur ex le fournisseur centrale") — une question du type
  // "donne moi les commandes du fournisseur central cette semaine" ne contient ni "validée" ni "sur
  // le pos", seulement "commande" + "fournisseur" : sans cette règle, elle ne matchait RIEN (gap
  // trouvé en test réel, detectIntent renvoyait null). Volontairement large sur "commande" +
  // "fournisseur" dans la même question plutôt qu'une phrase figée, pour couvrir aussi "quelles
  // commandes chez le fournisseur X", "commande passée à ce fournisseur"... — reste spécifique
  // (nécessite les deux mots) donc aucun risque de capter une question sans rapport.
  { keywords: ['commande fournisseur', 'commandes fournisseur', 'commande au fournisseur', 'commandes au fournisseur', 'commande du fournisseur', 'commandes du fournisseur', 'commande de ce fournisseur', 'commandes de ce fournisseur', 'commande chez le fournisseur', 'commandes chez le fournisseur', 'commande passée à ce fournisseur', 'commande passee a ce fournisseur'], tool: 'getValidatedOrders' },
  // getValidatedOrders ajouté le 06/10/2026 (demande explicite : détail complet RPOS d'une commande
  // VALIDÉE — qui a validé, fournisseur, dates, statut) — placé AVANT getOrders générique ci-dessous
  // pour les mêmes raisons que getOrderAnomalies/getOrders juste au-dessus : "commandes validées"
  // contient "commande" mais désigne un besoin précis (détail RPOS), jamais la liste interne basique.
  // 'commande validé'/'commandes validé' (sans accord pluriel/féminin) ajoutés le 14/10/2026 : bug
  // trouvé en test réel, "donne moi les commande validé aujoudhui" (faute de frappe courante,
  // accord manquant) ne matchait aucune des variantes déjà listées (toutes avec le "e" final de
  // l'accord) et tombait sur null — aucun outil déclenché du tout.
  { keywords: ['commande validée', 'commandes validées', 'commande validee', 'commandes validees', 'commande validé', 'commandes validé', 'commande valide', 'commandes valide', 'qui a validé', 'qui a valide', 'commande a été validée', 'commande a ete validee'], tool: 'getValidatedOrders' },
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
  { keywords: ['proposition', 'proposition en attente', 'proposition du jour', 'proposition de commande', 'quoi commander', 'que dois-je commander', 'quest ce que je dois commander', 'a commander', 'periode de couverture', 'période de couverture', 'periode couverte', 'période couverte', 'quelle periode porte', 'quelle période porte', 'sur combien de jours', 'horizon de la commande', 'horizon de commande'], tool: 'getCurrentProposal' },
  // getLastSoldArticle ajouté le 12/10/2026 (demande d'évolution réelle du 05/10/2026, "Consultation
  // du dernier article vendu en temps réel" — aucun outil n'existait avant). Placé AVANT
  // getSalesHistory (mot-clé "vente"/"ventes" plus générique juste en dessous) pour que "dernier
  // article vendu" ne soit jamais absorbé par la règle de ventes générique.
  { keywords: ['dernier article vendu', 'dernier produit vendu', 'dernière vente', 'derniere vente', 'qu\'est-ce qui vient d\'être vendu', 'qu est ce qui vient d etre vendu', 'quel a été le dernier article', 'quel a ete le dernier article'], tool: 'getLastSoldArticle' },
  // "vendue"/"vendues" ajoutés le 12/10/2026 (bug trouvé en testant en conditions réelles :
  // "quelles quantités de X ont été vendues entre le 1er et le 10 octobre" ne matchait AUCUNE règle
  // — "vente"/"ventes" ne couvrent jamais le participe passé féminin "vendue(s)", et "combien
  // vendu(s)" exige "combien" en tête, absent ici. La question tombait alors sur le filet LLM de
  // repli, qui a bien choisi getSalesHistory mais sans jamais transmettre la plage de dates précisée
  // (pas de params.dateRangeStart/End dans son schéma — cf. detectIntentViaLlm), d'où une réponse
  // "les données ne contiennent pas le détail sur cette période" alors que la donnée existe bien.
  { keywords: ['vente', 'ventes', 'vendue', 'vendues', 'quantité vendue', 'quantite vendue', 'quantités vendues', 'quantites vendues', 'évolution', 'combien vendu', 'combien vendus', 'combien on a vendu', 'tendance', 'ca se vend comment', 'comment ca vend'], tool: 'getSalesHistory' },
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
