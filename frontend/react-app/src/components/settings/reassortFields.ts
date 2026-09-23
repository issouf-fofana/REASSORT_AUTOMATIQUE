// Définition des champs du formulaire "Paramètres de réassort" (frontend/settings.old.html, tab
// #tab-reassort). Un tableau de champs plutôt que 15 blocs JSX quasi identiques copiés-collés :
// plus sûr contre une erreur de copie (mauvais id, mauvais texte d'aide) et plus facile à faire
// évoluer si un nouveau réglage s'ajoute. Le texte d'aide (helpHtml) est repris mot pour mot de
// l'ancienne page HTML — jamais reformulé, pour ne pas introduire une divergence de sens.

export type FieldKind = 'number' | 'select' | 'switch' | 'range' | 'date-range';

export interface SelectOption {
  value: string;
  label: string;
}

export interface ReassortField {
  id: string; // clé dans ReassortConfig (payload API), ex: "paretoThreshold"
  kind: FieldKind;
  label: string;
  unit?: string; // suffixe affiché (%, jour(s), CFA...)
  min?: number;
  max?: number;
  step?: number;
  options?: SelectOption[]; // pour kind: 'select'
  helpHtml: string; // reproduit tel quel depuis l'ancienne page, HTML léger autorisé (gras, <br>)
  warningHtml?: string; // encadré orange conditionnel (ex: période longue)
  showWarningIf?: (value: unknown) => boolean;
}

export const PERIOD_MODE_OPTIONS: SelectOption[] = [
  { value: 'YESTERDAY', label: 'Hier' },
  { value: 'LAST_7_DAYS', label: '7 derniers jours' },
  { value: 'LAST_30_DAYS', label: '30 derniers jours' },
  { value: 'LAST_60_DAYS', label: '2 mois' },
  { value: 'LAST_90_DAYS', label: '3 mois' },
  { value: 'LAST_120_DAYS', label: '4 mois' },
  { value: 'LAST_180_DAYS', label: '6 mois' },
  { value: 'LAST_365_DAYS', label: '1 an' },
  { value: 'ALL_TIME', label: 'Toutes les données disponibles' },
  { value: 'CUSTOM', label: 'Période personnalisée' },
];

// Périodes considérées "longues" (cf. settings.old.html #config-period-long-warning) : au-delà,
// une moyenne simple risque de diluer une tendance récente — le message recommande le lissage.
export const LONG_PERIOD_MODES = new Set(['LAST_90_DAYS', 'LAST_120_DAYS', 'LAST_180_DAYS', 'LAST_365_DAYS', 'ALL_TIME']);

export const REASSORT_FIELDS: ReassortField[] = [
  {
    id: 'paretoThreshold',
    kind: 'number',
    label: 'Seuil Pareto (analyse 20/80)',
    unit: '%',
    min: 1,
    max: 100,
    step: 1,
    helpHtml:
      "<strong>À quoi ça sert :</strong> le système classe tous les articles vendus par chiffre d'affaires décroissant, " +
      'puis cumule ce CA jusqu\'à atteindre le pourcentage choisi ici. Seuls les articles inclus dans ce cumul ' +
      'sont considérés comme "prioritaires" et proposés à la commande.<br>' +
      "<strong>Exemple :</strong> avec 80%, si 15% des articles génèrent déjà 80% du CA du magasin, seuls ces " +
      '15% seront analysés pour la proposition — les articles à très faible rotation sont ignorés.<br>' +
      "<strong>Effet d'un changement :</strong> baisser ce seuil (ex: 60%) réduit le nombre d'articles proposés " +
      "(plus sélectif) ; l'augmenter (ex: 95%) en inclut davantage, y compris des articles à faible volume.",
  },
  {
    id: 'safetyStockRatio',
    kind: 'number',
    label: 'Stock de sécurité',
    unit: '% de la vente moyenne',
    min: 0,
    max: 200,
    step: 5,
    helpHtml:
      "<strong>À quoi ça sert :</strong> marge de précaution ajoutée au besoin calculé, pour absorber les variations " +
      "de vente d'une semaine à l'autre et éviter les ruptures si les ventes accélèrent.<br>" +
      '<strong>Formule appliquée :</strong> quantité proposée = vente moyenne + (vente moyenne × ce %) − stock actuel − déjà en commande.<br>' +
      '<strong>Exemple :</strong> un article qui se vend 100 unités/semaine, avec 50% de marge de sécurité et 30 en stock, ' +
      'donnera une proposition de (100 + 50) − 30 = 120 unités.<br>' +
      "<strong>Effet d'un changement :</strong> 0% = pas de marge (risque de rupture plus élevé) ; 100% = double la " +
      'vente moyenne en marge (moins de rupture, mais plus de stock immobilisé).',
  },
  {
    id: 'periodMode',
    kind: 'select',
    label: "Période d'analyse des ventes",
    options: PERIOD_MODE_OPTIONS,
    helpHtml:
      "<strong>À quoi ça sert :</strong> définit la fenêtre de ventes utilisée pour calculer le classement Pareto " +
      'et la vente moyenne de chaque article.<br>' +
      '<strong>Important :</strong> ces périodes sont calculées depuis la <em>dernière vente réelle</em> du magasin, ' +
      'pas depuis la date du jour — utile si le magasin est temporairement fermé, le calcul reste basé sur son ' +
      'activité réelle plutôt que de ne rien trouver.<br>' +
      '<strong>Personnalisée :</strong> permet de fixer des dates fixes (ex: analyser uniquement décembre pour les ' +
      "fêtes), plutôt qu'une fenêtre glissante.<br>" +
      '<strong>Toutes les données disponibles :</strong> remonte jusqu\'à la toute première vente connue du ' +
      'magasin (peut prendre plus de temps à calculer si l\'historique est long).',
    warningHtml:
      '<strong>Période longue sélectionnée :</strong> avec plusieurs mois ou années de données, une moyenne ' +
      "simple peut diluer une évolution récente (ex: un article qui vend plus depuis peu serait noyé dans un " +
      'an d\'historique). Pensez à activer la <strong>prévision par lissage exponentiel</strong> ci-dessous ' +
      'pour donner plus de poids aux ventes récentes.',
    showWarningIf: (v) => LONG_PERIOD_MODES.has(String(v)),
  },
  {
    id: 'treatNegativeStockAsZero',
    kind: 'select',
    label: 'Stock négatif',
    options: [
      { value: 'true', label: 'Ramener à 0 avant calcul (par défaut)' },
      { value: 'false', label: 'Garder la valeur négative réelle' },
    ],
    helpHtml:
      "<strong>À quoi ça sert :</strong> un stock négatif dans RPOS signifie que l'article continue d'être vendu " +
      "alors que le système indique qu'il n'y en a plus — le stock affiché n'est donc plus synchronisé avec la " +
      'réalité physique du magasin.<br>' +
      "<strong>Comment ça se corrige :</strong> ce n'est jamais ce système de réassort qui remet le stock à jour. " +
      "Seuls deux événements côté RPOS le peuvent : une <strong>intégration de facture</strong> (réception d'une " +
      'commande fournisseur, qui recrédite le stock) ou un <strong>inventaire physique</strong> (comptage manuel ' +
      "qui recale le stock système sur le stock réel). Tant que l'un des deux n'a pas eu lieu, le stock reste " +
      'négatif et peu fiable pour cet article.<br>' +
      '<strong>"Ramener à 0" :</strong> le besoin est calculé uniquement sur la vente moyenne, sans tenir compte ' +
      'du stock négatif (comportement historique, plus prudent) — la page Proposition de commande signale ces ' +
      'articles avec un badge "Stock non fiable".<br>' +
      '<strong>"Garder la valeur négative" :</strong> le déficit réel s\'ajoute à la quantité à commander, et le ' +
      'stock négatif reste visible tel quel dans la colonne "Stock actuel" pour signaler l\'anomalie.',
  },
  {
    id: 'ignoreRposStockInCalculation',
    kind: 'select',
    label: 'Génération sans réseau Prosuma',
    options: [
      { value: 'false', label: 'Utiliser le stock RPOS en temps réel (par défaut)' },
      { value: 'true', label: 'Ignorer le stock RPOS (générer uniquement sur les ventes)' },
    ],
    helpHtml:
      '<strong>À quoi ça sert :</strong> le stock actuel, le prix et le colisage d\'un article viennent de RPOS en ' +
      'temps réel — sans accès au réseau Prosuma, une génération de proposition échoue normalement dès qu\'un ' +
      "article n'est plus en cache local depuis moins de 15 minutes.<br>" +
      '<strong>Si activé :</strong> la génération réutilise le dernier stock/prix/colisage connu en cache local, ' +
      'même vieux de plusieurs jours, au lieu d\'appeler RPOS — et le <strong>stock est ignoré dans le calcul du ' +
      "besoin</strong> (traité comme inconnu, jamais utilisé tel quel car potentiellement périmé). Le besoin est " +
      "alors couvert uniquement sur la base des ventes réelles, ce qui peut sur-proposer si du stock existe déjà " +
      'en réalité — vérifiez physiquement le stock avant de valider une commande générée dans ce mode. ' +
      'Un article jamais vu au moins une fois reste exclu, faute de prix/colisage connus.',
  },
  {
    id: 'recentOrderMaxAgeDays',
    kind: 'number',
    label: 'Ignorer les commandes RPOS de plus de',
    unit: 'jour(s)',
    min: 1,
    max: 365,
    step: 1,
    helpHtml:
      "<strong>À quoi ça sert :</strong> avant de proposer un article, le système vérifie s'il a déjà une " +
      'commande passée dans RPOS sur ce nombre de jours en arrière — si oui, l\'article est considéré ' +
      '"déjà commandé" et son besoin est ramené à 0 (visible avec un bouton "Débloquer et commander ' +
      'quand même" sur la page Proposition de commande).<br>' +
      '<strong>Pourquoi une limite :</strong> une commande RPOS, même très ancienne (parfois plusieurs ' +
      'mois), reste indéfiniment "en attente" tant qu\'elle n\'est pas marquée "livrée" — ce qui n\'arrive ' +
      "jamais sur les commandes centrales. Sans cette limite, un vieux reliquat de commande bloquerait " +
      "le réassort d'un article pourtant épuisé depuis longtemps.<br>" +
      '<strong>Par défaut : 3 jours.</strong> Diminuez pour ne vérifier que les commandes très récentes ' +
      '(hier, avant-hier) ; augmentez pour être plus prudent sur les délais de livraison longs.',
  },
  {
    id: 'revenueSharePeriodDays',
    kind: 'number',
    label: 'Période de référence pour le % du CA magasin',
    unit: 'jour(s)',
    min: 1,
    max: 90,
    step: 1,
    helpHtml:
      "<strong>À quoi ça sert :</strong> pour chaque article proposé, affiche sa part dans le chiffre d'affaires " +
      'total du magasin sur cette période (colonne "% CA magasin" de la page Proposition de commande), pour ' +
      "visualiser l'importance de chaque article.<br>" +
      '<strong>Exemple :</strong> 1 jour = part du CA d\'hier ; 7 jours = part du CA sur les 7 derniers jours.',
  },
  {
    id: 'overstockThresholdMultiplier',
    kind: 'number',
    label: 'Seuil de surstock (KPI Tableau de bord)',
    unit: '× besoin théorique',
    min: 1,
    max: 10,
    step: 0.1,
    helpHtml:
      "<strong>À quoi ça sert :</strong> définit à partir de quel dépassement du besoin théorique (vente " +
      'moyenne + stock de sécurité) une quantité commandée est comptée comme "surstock" dans le KPI ' +
      '"Taux de surstock" du Tableau de bord.<br>' +
      '<strong>Exemple :</strong> avec 1.5, un article dont le besoin théorique est de 10 unités mais dont la ' +
      'quantité finalement commandée dépasse 15 unités est compté en surstock.<br>' +
      "<strong>Effet d'un changement :</strong> baisser ce seuil (ex: 1.2) rend le KPI plus sensible aux petits " +
      "dépassements ; l'augmenter (ex: 3) ne compte que les très gros écarts.",
  },
  {
    id: 'splitOrdersByDepartment',
    kind: 'select',
    label: 'Séparation des commandes par rayon',
    options: [
      { value: 'true', label: 'Une commande par rayon (par défaut)' },
      { value: 'false', label: 'Une seule commande globale' },
    ],
    helpHtml:
      "<strong>À quoi ça sert :</strong> lors de la validation, regroupe les articles proposés par rayon " +
      '(ex: PRODUITS FRAIS, PRODUITS SECS) et crée une commande fournisseur RPOS distincte pour chaque ' +
      'rayon, au lieu d\'une seule commande mélangeant tous les rayons.<br>' +
      '<strong>"Une commande par rayon" :</strong> respecte le processus habituel de préparation des ' +
      'commandes en magasin, où chaque rayon reçoit sa propre commande.<br>' +
      '<strong>"Une seule commande globale" :</strong> comportement plus simple, utile si le magasin ou le ' +
      'fournisseur ne sépare pas ses commandes par rayon.',
  },
  {
    id: 'forecastAccuracyWindowDays',
    kind: 'number',
    label: 'Précision des prévisions — fenêtre de mesure',
    unit: 'jour(s)',
    min: 0,
    max: 90,
    step: 1,
    helpHtml:
      '<strong>À quoi ça sert :</strong> une fois une commande validée, ce délai définit la fenêtre pendant ' +
      'laquelle on mesure les ventes réelles pour les comparer à la prévision (KPI "Précision des prévisions" ' +
      "du Tableau de bord). Une ligne n'est évaluée qu'une fois cette fenêtre écoulée.<br>" +
      '<strong>Exemple :</strong> avec 7 jours, on compare la vente moyenne prévue sur 7 jours à la quantité ' +
      'réellement vendue durant les 7 jours suivant la validation.',
  },
  {
    id: 'forecastAccuracyThresholdPct',
    kind: 'number',
    label: 'Précision des prévisions — seuil de tolérance',
    unit: '%',
    min: 0,
    max: 100,
    step: 1,
    helpHtml:
      '<strong>À quoi ça sert :</strong> écart maximal toléré entre la vente moyenne prévue et la quantité ' +
      'réellement vendue sur la fenêtre de mesure pour qu\'une ligne soit comptée comme "prévision précise".<br>' +
      '<strong>Exemple :</strong> avec 20%, une prévision de 10 unités reste "précise" si la vente réelle est ' +
      'entre 8 et 12 unités.<br>' +
      "<strong>Effet d'un changement :</strong> baisser ce seuil (ex: 10%) rend le KPI plus exigeant ; " +
      "l'augmenter (ex: 40%) tolère des écarts plus larges.",
  },
  {
    id: 'seasonalityComparisonEnabled',
    kind: 'select',
    label: 'Saisonnalité',
    options: [
      { value: 'false', label: 'Désactivée (par défaut)' },
      { value: 'true', label: 'Activée' },
    ],
    helpHtml:
      "<strong>À quoi ça sert :</strong> compare la période d'analyse actuelle à la même période N années en " +
      'arrière, et ajuste la vente moyenne prévue si un écart significatif est détecté (ex: forte hausse des ' +
      "ventes de chocolat à la même période l'année dernière), pour ne pas se baser uniquement sur la " +
      'moyenne récente.<br>' +
      '<strong>Important :</strong> la comparaison se fait toujours par rapport à la dernière vente réelle du ' +
      'magasin, jamais à la date du jour — reste donc valable même sur un magasin fermé ou en test.<br>' +
      "<strong>Si aucune donnée n'existe pour la période N-1 :</strong> l'ajustement est simplement ignoré " +
      'pour cette génération, sans erreur.',
  },
  {
    id: 'seasonalityLookbackYears',
    kind: 'number',
    label: "Nombre d'années en arrière",
    unit: 'an(s)',
    min: 1,
    max: 5,
    step: 1,
    helpHtml: "1 = compare à l'année dernière.",
  },
  {
    id: 'seasonalityAdjustmentThresholdPct',
    kind: 'number',
    label: "Seuil de déclenchement de l'ajustement",
    unit: '%',
    min: 0,
    max: 200,
    step: 1,
    helpHtml: 'Écart entre les deux périodes au-delà duquel la prévision est ajustée.',
  },
  {
    id: 'receptionLeadTimeDays',
    kind: 'number',
    label: 'Délai de réception des commandes',
    unit: 'jour(s)',
    min: 0,
    max: 30,
    step: 1,
    helpHtml:
      "<strong>À quoi ça sert :</strong> délai moyen entre la validation d'une commande et sa réception " +
      'physique par ce magasin. Sert à préremplir la date de livraison proposée à la validation, et ' +
      '(si activé ci-dessous) à dimensionner le besoin sur cette durée plutôt que sur une semaine fixe.',
  },
  {
    id: 'useReceptionLeadTimeInCalculation',
    kind: 'select',
    label: 'Utiliser le délai dans le calcul du besoin',
    options: [
      { value: 'false', label: 'Non — garder le calcul historique (par défaut)' },
      { value: 'true', label: 'Oui — couvrir le délai de réception' },
    ],
    helpHtml:
      '<strong>Non (par défaut) :</strong> le besoin couvre toujours une semaine de vente, comme ' +
      "aujourd'hui — aucun changement de comportement.<br>" +
      '<strong>Oui :</strong> le besoin est calculé pour couvrir uniquement le délai de réception ' +
      'ci-dessus (ex: 3 jours de vente au lieu de 7) — change le résultat pour tous les articles du ' +
      'magasin, à activer seulement après validation sur un magasin pilote.',
  },
  {
    id: 'excludeGenericArticlesBelowPrice',
    kind: 'number',
    label: 'Exclure les articles génériques en dessous de',
    unit: 'CFA',
    min: 0,
    step: 0.5,
    helpHtml:
      "<strong>À quoi ça sert :</strong> certains articles RPOS sont des agrégats génériques d'un rayon " +
      'entier (ex: "FRUITS &amp; LEGUMES" à 1 CFA/unité) plutôt que de vrais produits vendables ' +
      'individuellement — ils faussent totalement le calcul avec des quantités proposées énormes. ' +
      'Tout article dont le prix de vente est strictement inférieur à ce seuil est exclu de la ' +
      'proposition. Mettre à 0 pour désactiver ce filtre.',
  },
];
