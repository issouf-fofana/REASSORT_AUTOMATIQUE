// Contenu du "Guide du projet" (23/09/2026). Un groupe = une section du sommaire. Chaque section =
// une fonctionnalité, avec un statut (done | partial | planned). Rédigé à partir d'un inventaire
// exhaustif du code (backend/src/services, jobs, routes, schema.prisma) — chaque affirmation
// technique correspond à du code réellement présent, pas une supposition.
//
// Champs d'une fonctionnalité (feature) :
//   id, title, icon, status, intro (courte accroche), why (pourquoi ça existe),
//   what (ce que ça fait, en langage simple), technical (détail technique bref, encadré discret),
//   pages: [{ href, label }]
window.PROJECT_GUIDE_CONTENT = [
  {
    label: 'À propos de ce guide',
    sections: [
      {
        id: 'intro',
        title: 'Comment lire ce guide',
        icon: 'solar:document-text-bold-duotone',
        features: [
          {
            why: 'Le projet a grandi avec beaucoup de fonctionnalités ajoutées au fil des besoins réels — ce guide sert de carte d\'ensemble pour ne pas se perdre, que ce soit pour découvrir le projet ou retrouver comment fonctionne une fonctionnalité précise.',
            what: 'Chaque section explique une fonctionnalité : pourquoi elle a été construite, ce qu\'elle fait concrètement, et où la trouver dans l\'application. Le badge en haut de chaque section indique si elle est <strong>Terminée</strong> (utilisable en production), <strong>En cours</strong> (fonctionne déjà mais reste incomplète sur un point précis, expliqué dans la section) ou <strong>À venir</strong> (pas encore construite). Les encadrés gris donnent un détail technique pour qui veut aller plus loin, sans qu\'il soit nécessaire de les lire pour comprendre l\'essentiel.',
          },
        ],
      },
    ],
  },

  {
    label: 'Récupération des données (RPOS)',
    sections: [
      {
        id: 'sync-shops',
        title: 'Liste des magasins',
        icon: 'solar:shop-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Sans ça, le menu déroulant "Magasin" présent sur presque toutes les pages devrait interroger en direct les serveurs de caisse à chaque ouverture de page — jusqu\'à 15-20 secondes d\'attente observées quand le magasin n\'était pas encore en cache.',
            what: 'Une fois par heure, l\'application récupère automatiquement la liste à jour des magasins (nom, référence, serveur de caisse associé) et la garde en mémoire locale, pour que le sélecteur de magasin s\'affiche instantanément partout dans l\'application.',
            technical: 'Appel RPOS : <code>/api/shop/</code>. Tourne toutes les heures (tâche planifiée).',
          },
        ],
      },
      {
        id: 'sync-sales',
        title: 'Récupération des ventes',
        icon: 'solar:cart-large-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Sans une copie locale des ventes, chaque calcul de réassort ou chaque graphique d\'évolution d\'un article devrait attendre plusieurs minutes pendant que le système parcourt tout l\'historique du serveur de caisse.',
            what: 'Toutes les 15 minutes, l\'application va chercher les ventes récentes de chaque magasin et les copie dans sa propre base — seulement les nouvelles ventes depuis la dernière fois, pas tout l\'historique à chaque fois. Une petite marge de recouvrement couvre le cas d\'une caisse qui aurait été hors-ligne temporairement et dont les ventes remontent en retard.',
            technical: 'Appel RPOS : <code>/api/product_line/</code>. Synchronisation incrémentale par magasin.',
            pages: [{ href: '/sales-history', label: 'Ventes synchronisées' }],
          },
        ],
      },
      {
        id: 'sync-backfill',
        title: 'Récupération massive de l\'historique (rattrapage)',
        icon: 'solar:history-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Le premier chargement de l\'historique complet d\'un magasin (plusieurs mois, potentiellement des millions de lignes de vente) est trop volumineux pour se faire d\'un coup — il faut pouvoir l\'interrompre et le reprendre sans perdre le travail déjà fait ni dupliquer des données.',
            what: 'Découpe la récupération d\'un gros historique en tranches gérables, avec possibilité de mettre en pause, reprendre après une coupure réseau ou un redémarrage du serveur, et annuler proprement. Peut traiter plusieurs magasins à la suite en une seule fois.',
            pages: [{ href: '/settings', label: 'Paramètres > Fichiers de ventes' }],
          },
        ],
      },
      {
        id: 'sync-coverage',
        title: 'Contrôle des trous dans l\'historique',
        icon: 'solar:magnifer-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Une coupure réseau ponctuelle peut laisser un jour incomplet dans les données sans que personne ne s\'en aperçoive — ce contrôle le détecte automatiquement au lieu de devoir relancer une récupération complète "au cas où".',
            what: 'Chaque nuit à 23h59, pour chaque magasin, compare le nombre de ventes attendu (côté serveur de caisse) au nombre réellement enregistré localement, jour par jour. Si un écart est détecté sur un jour précis, relance une récupération ciblée uniquement sur ce jour-là.',
          },
        ],
      },
      {
        id: 'sync-manual-import',
        title: 'Import manuel de fichiers de ventes',
        icon: 'solar:file-download-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Une alternative rapide quand un export de ventes est déjà disponible sous forme de fichier (déposé par un transfert automatique), pour éviter un appel réseau plus lent vers le serveur de caisse — et un filet de sécurité en cas d\'indisponibilité du partage réseau habituel.',
            what: 'Permet de déposer un fichier d\'export de ventes directement dans l\'application pour qu\'il soit intégré à la base locale, sans attendre la synchronisation automatique.',
            pages: [{ href: '/settings', label: 'Paramètres > Fichiers de ventes' }],
          },
        ],
      },
      {
        id: 'sync-dlv',
        title: 'Suivi des DLV (stock à prix réduit)',
        icon: 'solar:tag-price-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Quand un article approche de sa date limite, le magasin en bascule une partie du stock sur un code article séparé pour le vendre à prix réduit. Sans en tenir compte, le calcul de réassort verrait un stock "normal" plus élevé qu\'il ne l\'est réellement, et proposerait une quantité trop faible.',
            what: 'Chaque jour, l\'application récupère la liste des articles actuellement basculés en DLV et retire cette quantité du stock "normal" utilisé pour calculer le besoin de réassort — pour ne jamais faire croire qu\'un stock déjà mis de côté à prix réduit est encore disponible à la vente normale.',
            technical: 'Appel RPOS : <code>/api/end_of_life_product/</code>. Un seul appel par serveur de caisse (donnée partagée entre tous ses magasins), remplacement complet de la liste à chaque passage — RPOS ne signale jamais quand un article n\'est plus en DLV, donc seuls les articles avec un stock DLV réellement positif sont conservés.',
            pages: [{ href: '/purchase-order', label: 'Proposition de commande' }],
          },
        ],
      },
      {
        id: 'sync-reception',
        title: 'Suivi de réception des commandes',
        icon: 'solar:delivery-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Savoir si une commande passée a bien été livrée, pour ne pas proposer de recommander un article déjà réapprovisionné.',
            what: 'Estime le statut de réception d\'une commande à partir du délai de livraison configuré pour le magasin, une fois ce délai écoulé. <strong>Attention :</strong> ce statut est une estimation, jamais une confirmation réelle de livraison — le système de caisse ne fournit tout simplement pas cette information de façon fiable pour les commandes passées par ce fournisseur central. Seule l\'annulation d\'une commande est une information certaine.',
            technical: 'Le statut RPOS de la commande n\'est pas un indicateur fiable de réception réelle (confirmé : aucune vraie livraison n\'est jamais enregistrée côté caisse pour ce fournisseur). "Reçue (estimée)" apparaît après écoulement du délai configuré, jamais comme une certitude.',
          },
        ],
      },
      {
        id: 'sync-stock-moves',
        title: 'Mouvements de caisse (explication des variations de stock)',
        icon: 'solar:transfer-horizontal-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Un stock qui baisse ne vient pas toujours d\'une vente : casse, transfert entre rayons, retour au fournisseur, inventaire... Sans cette information, le système pourrait confondre une perte de marchandise avec de la demande client réelle, et proposer une quantité faussée.',
            what: 'Interroge l\'historique des mouvements de stock du serveur de caisse pour expliquer une variation de stock au-delà des seules ventes — utilisé par l\'assistant IA (pour répondre à "pourquoi le stock a bougé"), par la fiche détaillée d\'un article, et par le calcul de réassort lui-même pour repérer une casse ou une perte récurrente. Un mouvement de casse n\'est jamais compté comme une vente, et inversement.',
            technical: 'Appels RPOS : <code>/api/stock_move/</code>, <code>/api/stock_move_type/</code>.',
          },
        ],
      },
      {
        id: 'sync-orders-create',
        title: 'Création et envoi des commandes fournisseur',
        icon: 'solar:cart-check-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'C\'est le cœur du réassort : transformer une proposition calculée en une vraie commande transmise au système de caisse, qui la fera parvenir au fournisseur central.',
            what: 'Envoie la commande calculée au système de caisse, en la marquant clairement comme créée par cette plateforme (pour la distinguer d\'une commande passée manuellement). Peut créer une commande séparée par rayon plutôt qu\'une seule commande mélangeant tous les rayons, selon le réglage du magasin.',
            technical: 'Appels RPOS : <code>/api/supplier_order/</code> (création), <code>/api/supplier_order_line/</code> (ajout des articles).',
            pages: [{ href: '/purchase-order', label: 'Proposition de commande' }],
          },
        ],
      },
      {
        id: 'sync-orders-history',
        title: 'Historique et annulation des commandes',
        icon: 'solar:clipboard-list-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Pouvoir consulter et, si besoin, annuler une commande déjà passée sans devoir ouvrir le système de caisse séparément.',
            what: 'Liste toutes les commandes fournisseur passées pour un magasin, avec leur détail article par article, et permet d\'en annuler une directement depuis l\'application.',
            pages: [{ href: '/purchase-list', label: 'Historique' }],
          },
        ],
      },
      {
        id: 'sync-products',
        title: 'Référentiel articles, prix et rayons',
        icon: 'solar:box-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Le calcul de réassort a besoin de connaître le rayon d\'un article, son prix, son fournisseur et son colisage pour produire une proposition cohérente.',
            what: 'Récupère et met en cache les informations de base de chaque article (rayon, prix, historique de changement de prix, emplacement en rayon) pour éviter de resolliciter le système de caisse à chaque calcul.',
            technical: 'Appels RPOS : <code>/api/product/</code>, <code>/api/department/</code>, <code>/api/product_price_change_log/</code>, <code>/api/product_addressing/</code>, <code>/api/supplier/</code>.',
          },
        ],
      },
    ],
  },

  {
    label: 'Calcul du réassort',
    sections: [
      {
        id: 'reassort-core',
        title: 'Le calcul de la quantité à commander',
        icon: 'solar:calculator-bold-duotone',
        status: 'done',
        intro: 'Le moteur central de tout le projet.',
        features: [
          {
            why: 'C\'est la question à laquelle tout le reste du projet sert à répondre : combien commander de chaque article ?',
            what: 'Pour chaque article, calcule la quantité à commander en tenant compte de la vente moyenne prévue, d\'une marge de sécurité, du stock déjà présent en magasin, et de ce qui est déjà en commande — le résultat est toujours arrondi au colisage réel de l\'article (pas de demi-carton).',
            technical: 'Formule : besoin = (vente moyenne prévue sur la période à couvrir) + (marge de sécurité) − (stock actuel) − (déjà en commande), arrondi au colisage.',
            pages: [{ href: '/purchase-order', label: 'Proposition de commande' }],
          },
        ],
      },
      {
        id: 'reassort-pareto',
        title: 'Priorisation des articles importants (Pareto)',
        icon: 'solar:chart-2-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Un magasin peut avoir des milliers de références — calculer en détail chacune d\'elles ralentirait inutilement le système pour des articles qui pèsent très peu dans le chiffre d\'affaires.',
            what: 'Ne calcule en détail que les articles qui, ensemble, représentent une part significative du chiffre d\'affaires du magasin (80% par défaut, réglable) — pour concentrer l\'effort sur ce qui compte vraiment.',
          },
        ],
      },
      {
        id: 'reassort-smoothing',
        title: 'Prévision par lissage (donner plus de poids aux ventes récentes)',
        icon: 'solar:graph-new-up-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Une simple moyenne sur toute la période analysée réagit lentement à un changement récent de rythme de vente — un article qui vend plus depuis 2 semaines resterait sous-estimé si on regarde une moyenne sur 3 mois.',
            what: 'Une option (à activer) qui donne plus de poids aux ventes des derniers jours qu\'aux ventes anciennes, pour que le système réagisse plus vite à une accélération ou un ralentissement réel. Si l\'historique disponible est trop court pour être fiable, retombe automatiquement sur la moyenne classique.',
            pages: [{ href: '/settings', label: 'Paramètres > Réassort' }],
          },
        ],
      },
      {
        id: 'reassort-weekday',
        title: 'Prise en compte du jour de la semaine',
        icon: 'solar:calendar-mark-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Un article ne se vend pas au même rythme tous les jours (ex: plus fort le samedi) — répartir uniformément la demande sur la semaine sous-estime le besoin si la commande doit couvrir un jour habituellement plus vendeur.',
            what: 'Calcule, pour chaque article, un profil de vente par jour de semaine à partir de son historique réel, et l\'utilise pour répartir la demande sur les jours effectivement couverts par la commande plutôt que de supposer une vente identique chaque jour. Si l\'historique est trop court, retombe sur une répartition uniforme.',
            pages: [{ href: '/purchase-order', label: 'Proposition de commande' }],
          },
        ],
      },
      {
        id: 'reassort-seasonality',
        title: 'Ajustement de saisonnalité',
        icon: 'solar:calendar-bold-duotone',
        status: 'partial',
        features: [
          {
            why: 'Une période comme Noël ou la rentrée scolaire peut avoir un rythme de vente très différent du reste de l\'année — comparer à la même période l\'année précédente permet d\'anticiper une hausse ou baisse attendue.',
            what: 'Compare la période analysée à la même période un ou plusieurs ans auparavant, et ajuste la quantité prévue si l\'écart dépasse un seuil configurable.',
            technical: '<strong>Terminée mais désactivée par défaut</strong> — à activer explicitement par magasin dans les Paramètres, pas un comportement automatique.',
            pages: [{ href: '/settings', label: 'Paramètres > Réassort' }],
          },
        ],
      },
      {
        id: 'reassort-safety-stock',
        title: 'Stock de sécurité et délai de livraison',
        icon: 'solar:shield-check-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Se protéger contre une vente plus forte que prévue, et tenir compte du fait qu\'un article avec un long délai de livraison doit être commandé plus en avance qu\'un article livré rapidement.',
            what: 'Ajoute une marge de précaution proportionnelle à la vente moyenne (réglable par magasin), et peut calculer le besoin sur la durée réelle du délai de livraison fournisseur plutôt que sur une semaine fixe.',
            pages: [{ href: '/settings', label: 'Paramètres > Réassort' }],
          },
        ],
      },
      {
        id: 'reassort-sufficiency',
        title: 'Détection d\'une commande déjà suffisante',
        icon: 'solar:check-circle-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Si une commande est déjà en cours pour un article, il faut savoir si elle couvre déjà le besoin ou non, plutôt que de simplement soustraire un chiffre sans explication.',
            what: 'Explique en langage clair si une commande déjà en cours pour un article suffit à couvrir le besoin ou non — avec un badge visible directement sur la proposition.',
            pages: [{ href: '/purchase-order', label: 'Proposition de commande' }],
          },
        ],
      },
      {
        id: 'reassort-offline',
        title: 'Mode dégradé (sans réseau)',
        icon: 'solar:wi-fi-router-minimalistic-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Permettre de générer une proposition même quand la connexion au réseau du système de caisse est indisponible.',
            what: 'Une option (désactivée par défaut) qui utilise les dernières données connues en cache plutôt que d\'aller les chercher en direct, au prix d\'un stock potentiellement un peu daté.',
            pages: [{ href: '/settings', label: 'Paramètres > Réassort' }],
          },
        ],
      },
      {
        id: 'reassort-generic-exclusion',
        title: 'Exclusion des articles génériques (poids libre)',
        icon: 'solar:forbidden-circle-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Un article comme "FRUITS & LÉGUMES" à 1 CFA l\'unité est en réalité un code générique utilisé pour peser des produits en vrac, pas un vrai article individuel — l\'inclure dans le calcul produirait des quantités absurdes.',
            what: 'Exclut automatiquement du calcul tout article dont le prix est en dessous d\'un seuil configurable, considéré comme un code générique plutôt qu\'un vrai produit.',
            pages: [{ href: '/settings', label: 'Paramètres > Réassort' }],
          },
        ],
      },
      {
        id: 'reassort-exclusions-tracking',
        title: 'Traçabilité des articles exclus',
        icon: 'solar:list-check-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Comprendre pourquoi certains articles n\'apparaissent pas dans la proposition, plutôt que de se demander si le calcul a un problème.',
            what: 'Garde le détail de chaque article écarté du calcul et la raison (stock négatif, déjà commandé, article non trouvé, article générique...), consultable pour comprendre pourquoi le "reste du chiffre d\'affaires non proposé" n\'est jamais à zéro.',
            pages: [{ href: '/purchase-order', label: 'Proposition de commande' }],
          },
        ],
      },
      {
        id: 'reassort-weekly-plan',
        title: 'Plan de réassort hebdomadaire',
        icon: 'solar:calendar-search-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Avant cette fonctionnalité, chaque nouvelle génération de proposition remplaçait purement et simplement la précédente — aucun lien ne subsistait entre ce qui avait été prévu en début de semaine et ce qui était recalculé plus tard avec les ventes des jours écoulés.',
            what: 'Rattache chaque génération de proposition à une semaine cible précise, en gardant l\'historique des révisions successives de cette même semaine plutôt que de perdre la trace des versions précédentes.',
            pages: [{ href: '/purchase-order', label: 'Proposition de commande > Historique de la semaine' }],
          },
        ],
      },
      {
        id: 'reassort-daily-review',
        title: 'Réajustement quotidien du plan',
        icon: 'solar:refresh-circle-bold-duotone',
        status: 'partial',
        features: [
          {
            why: 'Les ventes et le stock évoluent chaque jour — un plan calculé en début de semaine peut devenir moins pertinent au fil des jours si rien ne le met à jour.',
            what: 'Recalcule chaque jour le plan actif d\'un magasin avec les ventes et le stock observés depuis le dernier calcul, et ne crée une nouvelle révision que si le changement dépasse un seuil significatif (pour ne pas générer une révision à chaque petite variation).',
            technical: 'Version simple assumée comme incomplète : un plan déjà validé par un humain n\'est pas encore retouché ici — calculer "le besoin restant après une commande déjà validée" est une étape plus complexe, pas encore construite.',
          },
        ],
      },
      {
        id: 'reassort-nightly',
        title: 'Génération automatique chaque nuit',
        icon: 'solar:moon-stars-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Pour que la proposition de réassort soit déjà prête et à jour quand le responsable de magasin se connecte le matin, sans qu\'il ait besoin de la lancer lui-même.',
            what: 'Chaque nuit, génère automatiquement la proposition de réassort de tous les magasins actifs, 3 magasins à la fois pour ne pas surcharger le système de caisse.',
          },
        ],
      },
      {
        id: 'reassort-shop-activity',
        title: 'Détection d\'un magasin actif ou fermé',
        icon: 'solar:shop-2-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Un article qui ne se vend presque plus dans un magasin fermé récemment ne doit pas être traité comme un article en perte de vitesse dans un magasin qui fonctionne normalement.',
            what: 'Détermine si un magasin est réellement en activité sur la période analysée, pour donner ce contexte à l\'analyse IA et éviter une mauvaise interprétation d\'un rythme de vente faible.',
          },
        ],
      },
      {
        id: 'reassort-order-anomaly',
        title: 'Détection d\'anomalies de commande',
        icon: 'solar:danger-triangle-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Une quantité proposée très différente de ce qu\'un humain valide habituellement pour cet article mérite d\'être signalée avant validation, plutôt que découverte après coup.',
            what: 'Compare chaque quantité proposée à l\'historique des quantités réellement validées par un humain pour ce même article, et signale un écart statistique important. Ne décide jamais elle-même si la commande est correcte ou non — c\'est toujours un humain qui confirme ou écarte l\'alerte.',
            pages: [{ href: '/order-anomalies', label: 'Anomalies de commande' }],
          },
        ],
      },
    ],
  },

  {
    label: 'Intelligence artificielle',
    sections: [
      {
        id: 'ai-forecast',
        title: 'Prévision par IA à la demande',
        icon: 'solar:magic-stick-3-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Le calcul classique donne une base fiable, mais une IA peut repérer des nuances (tendance, contexte) qu\'une formule seule ne voit pas.',
            what: 'Envoie un résumé des données de chaque article à un modèle d\'IA, qui propose une quantité et une courte explication. Si un fournisseur IA échoue (quota dépassé, panne), le système bascule automatiquement sur un autre fournisseur configuré.',
            pages: [{ href: '/purchase-order', label: 'Proposition de commande' }, { href: '/ai-predictions', label: 'IA & Prédictions' }],
          },
        ],
      },
      {
        id: 'ai-chatbot',
        title: 'Assistant IA (chatbot)',
        icon: 'solar:chat-round-dots-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Permettre de poser une question en langage naturel ("quel est le chiffre d\'affaires du rayon frais hier ?") plutôt que de devoir naviguer dans plusieurs pages pour trouver l\'information.',
            what: 'Répond aux questions en identifiant d\'abord quelle donnée réelle est demandée, va la chercher dans les vraies données du magasin, puis reformule la réponse en langage naturel — l\'IA ne répond jamais avec un chiffre inventé, et n\'a jamais un accès direct à la base de données.',
            pages: [{ href: '/ai-assistant', label: 'Assistant IA' }],
          },
        ],
      },
      {
        id: 'ai-confidence',
        title: 'Score de confiance par article',
        icon: 'solar:shield-star-bold-duotone',
        status: 'partial',
        features: [
          {
            why: 'Savoir à quel point une prévision est fiable pour un article donné, plutôt que de traiter toutes les prévisions comme également sûres.',
            what: 'Calcule un score de confiance en combinant plusieurs signaux disponibles (quantité d\'historique, stabilité des ventes, précision passée, qualité des données). Le score reste volontairement prudent quand un signal manque, plutôt que de deviner.',
            technical: 'Version assumée incomplète par les auteurs : certains signaux idéaux (détection d\'anomalie affinée, modèle de comportement propre au magasin/article) ne sont pas encore intégrés au calcul.',
          },
        ],
      },
      {
        id: 'ai-anomaly-detection',
        title: 'Détection de signaux de vente anormaux',
        icon: 'solar:pulse-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Repérer un pic ou une chute de vente inhabituelle pour recommander la prudence plutôt qu\'une commande automatique en cas de signal anormal.',
            what: 'Analyse les données déjà disponibles à la génération pour détecter des signaux anormaux, sans jamais décider elle-même quoi faire — elle alimente le score de confiance et l\'analyse IA, qui elles orientent vers la prudence si besoin.',
          },
        ],
      },
      {
        id: 'ai-outcome-tracking',
        title: 'Suivi des prédictions vs la réalité',
        icon: 'solar:chart-square-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Une prévision n\'a de valeur que si on vérifie ensuite si elle était juste — sans ce suivi, impossible de savoir objectivement si l\'IA est fiable.',
            what: 'Une fois la période prévue écoulée, compare automatiquement ce qui avait été prévu à ce qui s\'est réellement vendu, sans jamais modifier la proposition déjà faite — c\'est une mesure pure, après coup.',
            pages: [{ href: '/ai-predictions', label: 'IA & Prédictions' }],
          },
        ],
      },
      {
        id: 'ai-shadow',
        title: 'Mode Simulation IA (comparaison Humain vs IA)',
        icon: 'solar:users-group-two-rounded-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Savoir objectivement, sur l\'historique réel, si les corrections humaines sur les propositions de l\'IA étaient justifiées ou non — la base pour juger si l\'IA pourrait un jour se passer de validation humaine.',
            what: 'Sur les commandes où un humain a modifié la quantité proposée par l\'IA, compare a posteriori (une fois les ventes réelles connues) qui avait raison : l\'IA ou la correction humaine. Un score de confiance global s\'affiche sur la Vue Globale.',
            pages: [{ href: '/admin-dashboard', label: 'Vue globale' }, { href: '/ai-quality#tab-autonomy', label: 'Qualité & IA > Préparation à l\'autonomie' }],
          },
        ],
      },
      {
        id: 'ai-decision-log',
        title: 'Journal des décisions IA',
        icon: 'solar:document-text-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Avant cette fonctionnalité, revoir "qu\'est-ce que l\'IA a décidé la semaine dernière sur cet article, et pourquoi ?" obligeait à rouvrir chaque commande une par une.',
            what: 'Historique consultable et filtrable de chaque décision prise par l\'IA (quantité proposée, raisonnement, action), sans avoir à rouvrir chaque commande.',
            pages: [{ href: '/ai-quality#tab-decision-log', label: 'Qualité & IA > Journal des décisions' }],
          },
        ],
      },
      {
        id: 'ai-article-analysis',
        title: 'Analyse IA d\'un article précis',
        icon: 'solar:magnifer-zoom-in-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Comprendre en détail pourquoi une quantité précise a été proposée pour un article, et pouvoir poser des questions de suivi.',
            what: 'Ouvre un panneau détaillé pour un article, avec l\'explication de l\'IA et la possibilité de poser des questions complémentaires sur ce même article.',
            pages: [{ href: '/purchase-order', label: 'Proposition de commande (panneau détail article)' }],
          },
        ],
      },
      {
        id: 'ai-mastery',
        title: 'Maîtrise IA par domaine',
        icon: 'solar:medal-ribbons-star-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Suivre la fiabilité de l\'IA séparément par domaine métier (ex: précision des prévisions, qualité du chatbot) plutôt qu\'avec un seul score global qui masquerait les différences.',
            what: 'Calcule un score de maîtrise par domaine, avec deux méthodes distinctes : quand une vraie mesure existe (précision des prévisions), le score se base sur des résultats vérifiés ; pour les autres domaines sans mesure directe, il se base sur le volume et l\'ancienneté des corrections nécessaires — une correction récente pèse plus qu\'une ancienne, le système "oublie" progressivement une erreur corrigée depuis longtemps.',
            pages: [{ href: '/ai-mastery', label: 'Mémoire du modèle' }],
          },
        ],
      },
      {
        id: 'ai-autonomy',
        title: 'Préparation à l\'autonomie',
        icon: 'solar:medal-star-bold-duotone',
        status: 'partial',
        features: [
          {
            why: 'Donner un indicateur objectif de progression de l\'IA vers moins de supervision humaine — jamais une bascule automatique, uniquement informatif.',
            what: 'Mesure 7 critères réels et positionne le système sur une échelle de supervision (de "chaque décision validée par un humain" à "autonome"). Un palier n\'est confirmé que s\'il se maintient sur plusieurs évaluations consécutives, jamais sur un seul bon résultat.',
            technical: '2 des 7 critères n\'ont aujourd\'hui aucune source de données réelle et restent explicitement non mesurés, plutôt que d\'être inventés — ils sont exclus du score global.',
            pages: [{ href: '/ai-quality#tab-autonomy', label: 'Qualité & IA > Préparation à l\'autonomie' }],
          },
        ],
      },
      {
        id: 'ai-improvements',
        title: 'Conseiller d\'amélioration IA',
        icon: 'solar:bolt-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Certains problèmes restent invisibles sans creuser la base de données : des prédictions jamais évaluées, une tâche planifiée qui dérive, un biais systématique, une question du chatbot restée sans bonne réponse.',
            what: 'Détecte automatiquement, chaque jour, ces problèmes silencieux par des vérifications systématiques (jamais par une IA pour ce constat lui-même), puis une IA propose une explication et une piste de correction pour les cas les plus importants. Une fois une correction appliquée, le système revérifie ensuite si le problème s\'est vraiment amélioré.',
            pages: [{ href: '/ai-quality', label: 'Qualité & IA > Améliorations IA' }],
          },
        ],
      },
      {
        id: 'ai-corrections',
        title: 'Journal unifié des corrections',
        icon: 'solar:clipboard-check-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Garder une trace complète de chaque correction, qu\'elle vienne d\'une auto-correction confirmée de l\'IA ou d\'une correction de code faite en développement, pour ne jamais refaire la même erreur.',
            what: 'Un seul journal regroupe les deux types de correction, avec le détail complet : erreur constatée, cause, correction apportée, et liens vers des corrections similaires déjà résolues.',
            pages: [{ href: '/ai-quality#tab-corrections', label: 'Qualité & IA > Journal des corrections' }],
          },
        ],
      },
      {
        id: 'ai-permissions',
        title: 'Permissions IA par rôle',
        icon: 'solar:lock-keyhole-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Un rayonniste ne doit pas pouvoir demander à l\'assistant IA le chiffre d\'affaires global du magasin, même s\'il connaît la bonne question à poser.',
            what: 'Chaque rôle a un accès par défaut à certaines catégories de données (stock, ventes, chiffre d\'affaires...), personnalisable pour un utilisateur précis sans changer son rôle.',
            pages: [{ href: '/ai-guide', label: 'Mon accès' }],
          },
        ],
      },
      {
        id: 'ai-usage',
        title: 'Suivi de la consommation IA',
        icon: 'solar:wallet-money-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Savoir combien coûte réellement l\'usage de l\'IA et anticiper si un quota risque d\'être atteint trop tôt, plutôt que d\'être surpris par une clé qui ne fonctionne plus.',
            what: 'Suit chaque appel réel à un fournisseur IA, avec une répartition par fournisseur et par usage (chatbot, prévisions...), consultable sur une période.',
          },
        ],
      },
      {
        id: 'ai-keys',
        title: 'Gestion sécurisée des clés IA',
        icon: 'solar:key-minimalistic-square-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Une clé API donne accès à un service payant — elle ne doit jamais être lisible en clair, même en cas d\'accès direct à la base de données.',
            what: 'Stocke les clés des fournisseurs d\'IA de façon chiffrée, jamais en texte lisible.',
            pages: [{ href: '/settings', label: 'Paramètres > IA' }],
          },
        ],
      },
    ],
  },

  {
    label: 'Automatisation',
    sections: [
      {
        id: 'auto-mode',
        title: 'Mode Auto (commande sans validation humaine)',
        icon: 'solar:bolt-circle-bold-duotone',
        status: 'partial',
        features: [
          {
            why: 'Une fois l\'IA suffisamment fiable (mesurable via le Mode Simulation), permettre de passer les commandes automatiquement sans intervention humaine, sur les magasins où c\'est activé.',
            what: 'Accepte la quantité proposée par l\'IA telle quelle sur toutes les lignes, crée la commande automatiquement chaque nuit juste après la génération — au choix, en la laissant "en préparation" (pour vérification avant envoi réel) ou en la validant directement vers l\'entrepôt. En cas d\'échec, une alerte visible est créée plutôt que de rester silencieuse.',
            technical: '<strong>Désactivé par défaut, à activer par magasin</strong> — l\'usage recommandé est de commencer par le magasin pilote, en mode "créer sans valider", avant d\'envisager une activation plus large une fois le Mode Simulation confirmé fiable dans le temps.',
            pages: [{ href: '/settings', label: 'Paramètres > Réassort' }],
          },
        ],
      },
      {
        id: 'auto-cron',
        title: 'Planification des tâches automatiques',
        icon: 'solar:clock-circle-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Coordonner l\'exécution de toutes les tâches récurrentes (synchronisation, génération nocturne, contrôles...) sans qu\'elles se chevauchent ou se lancent en double.',
            what: 'Orchestre les tâches planifiées avec un verrou par tâche : si une exécution précédente n\'est pas terminée, une seconde ne démarre pas en parallèle.',
          },
        ],
      },
      {
        id: 'auto-job-health',
        title: 'Suivi de santé des tâches planifiées',
        icon: 'solar:heart-pulse-bold-duotone',
        status: 'partial',
        features: [
          {
            why: 'Savoir si une tâche automatique a échoué plusieurs fois de suite, sans devoir aller lire les journaux techniques du serveur.',
            what: 'Garde le dernier statut et le nombre d\'échecs consécutifs de chaque tâche planifiée, visible dans les Paramètres.',
            technical: 'Pas encore d\'alerte automatique envoyée par email ou messagerie en cas d\'échec — seul le compteur existe aujourd\'hui, consultable manuellement.',
            pages: [{ href: '/settings', label: 'Paramètres' }],
          },
        ],
      },
      {
        id: 'auto-manual-trigger',
        title: 'Déclenchement manuel des tâches',
        icon: 'solar:play-circle-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Pouvoir relancer une tâche à la demande (par exemple après une correction) sans attendre son prochain horaire planifié.',
            what: 'Permet à un administrateur de déclencher manuellement n\'importe quelle tâche planifiée depuis l\'interface.',
            pages: [{ href: '/settings', label: 'Paramètres' }],
          },
        ],
      },
    ],
  },

  {
    label: 'Qualité, fiabilité et suivi',
    sections: [
      {
        id: 'quality-errors',
        title: 'Journal des erreurs applicatives',
        icon: 'solar:bug-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Détecter et diagnostiquer un problème technique dès qu\'il survient, sans dépendre d\'un utilisateur qui le signale.',
            what: 'Enregistre automatiquement chaque erreur technique survenue côté serveur ou côté navigateur, en regroupant les occurrences d\'un même type d\'erreur pour ne pas noyer l\'information. Conservé 30 jours.',
            pages: [{ href: '/ai-quality#tab-errors', label: 'Qualité & IA > Journal des erreurs' }],
          },
        ],
      },
      {
        id: 'quality-periods',
        title: 'Périodes d\'analyse configurables',
        icon: 'solar:calendar-mark-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Permettre d\'analyser les ventes sur des durées variées selon le besoin — un article saisonnier ou à faible rotation demande souvent un historique plus long qu\'un article à forte rotation.',
            what: 'Choix de la fenêtre de ventes utilisée pour le calcul : hier, 7/30/60/90/120/180/365 jours, une période personnalisée, ou toutes les données disponibles. Calculée depuis la dernière vente réelle du magasin, pas depuis la date du jour, pour rester pertinente même sur un magasin temporairement fermé.',
            pages: [{ href: '/settings', label: 'Paramètres > Réassort' }],
          },
        ],
      },
      {
        id: 'quality-product-analytics',
        title: 'Analyse détaillée d\'un article',
        icon: 'solar:chart-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Voir la courbe de vente réelle d\'un article, ses points de commande passés et une projection de la prochaine commande probable.',
            what: 'Affiche une analyse graphique complète d\'un article, en lisant en priorité la base locale (plus rapide) avec un repli vers le système de caisse en direct si nécessaire.',
          },
        ],
      },
      {
        id: 'quality-kpi',
        title: 'Indicateurs de pilotage',
        icon: 'solar:pie-chart-2-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Mesurer objectivement la performance du réassort : les propositions sont-elles suivies telles quelles, y a-t-il des ruptures ou du surstock, les prévisions sont-elles précises ?',
            what: 'Calcule le taux de conformité (commandes validées sans modification), le taux de rupture, le taux de surstock, et la précision des prévisions — utilisés notamment pour juger quand un magasin ou un article pourrait passer en validation automatique.',
            pages: [{ href: '/admin-dashboard', label: 'Vue globale' }],
          },
        ],
      },
      {
        id: 'quality-dashboard',
        title: 'Tableau de bord administrateur',
        icon: 'solar:widget-5-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Avoir une vue d\'ensemble de tous les magasins en un seul endroit, plutôt que de devoir consulter chaque magasin séparément.',
            what: 'Regroupe les indicateurs clés (rupture, surstock, conformité, précision IA, confiance IA) sur l\'ensemble des magasins.',
            pages: [{ href: '/admin-dashboard', label: 'Vue globale' }],
          },
        ],
      },
    ],
  },

  {
    label: 'Administration et sécurité',
    sections: [
      {
        id: 'admin-roles',
        title: 'Rôles et permissions',
        icon: 'solar:users-group-rounded-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Chaque personne dans l\'organisation n\'a pas besoin (ni le droit) de voir les mêmes informations — un rayonniste n\'a pas à voir le chiffre d\'affaires global du magasin.',
            what: 'Cinq niveaux de rôle : Administrateur (tous les magasins et la configuration), Superviseur (plusieurs magasins choisis), Directeur (un magasin entier), Chef de département (un rayon assigné, jamais le chiffre d\'affaires du magasin entier), Rayonniste (un ou plusieurs rayons, sans jamais voir de chiffre d\'affaires).',
            pages: [{ href: '/users-list', label: 'Utilisateurs' }],
          },
        ],
      },
      {
        id: 'admin-ldap',
        title: 'Connexion avec l\'identifiant réseau (Active Directory)',
        icon: 'solar:server-square-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Permettre à un employé de se connecter avec son identifiant réseau habituel plutôt que de créer un compte séparé rien que pour cette application.',
            what: 'Vérifie l\'identifiant et le mot de passe directement auprès de l\'annuaire de l\'entreprise au moment de la connexion.',
            pages: [{ href: '/login', label: 'Connexion' }],
          },
        ],
      },
      {
        id: 'admin-rpos-servers',
        title: 'Configuration des serveurs de caisse',
        icon: 'solar:server-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'L\'organisation utilise plusieurs serveurs de caisse (un par groupe de magasins) — chacun doit être configuré avec ses propres identifiants de connexion.',
            what: 'Gère la liste des serveurs de caisse connus et leurs identifiants d\'accès, un par un ou en masse.',
            pages: [{ href: '/settings', label: 'Paramètres > Serveurs RPOS' }],
          },
        ],
      },
      {
        id: 'admin-config',
        title: 'Configuration par magasin et générale',
        icon: 'solar:settings-bold-duotone',
        status: 'done',
        features: [
          {
            why: 'Chaque magasin peut avoir des besoins différents (délai de livraison, stratégie de calcul...) — tout doit être ajustable sans intervention technique.',
            what: 'Tous les réglages métier (seuils, marges, options de calcul, Mode Auto...) sont modifiables depuis l\'interface, magasin par magasin ou en masse pour plusieurs magasins à la fois.',
            pages: [{ href: '/settings', label: 'Paramètres' }],
          },
        ],
      },
    ],
  },
];
