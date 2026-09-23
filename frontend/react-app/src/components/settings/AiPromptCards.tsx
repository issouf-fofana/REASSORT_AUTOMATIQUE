import { useEffect, useState } from 'react';
import { apiFetch } from '../../api/client';
import { saveSystemConfigKey } from '../../api/systemConfig';

// Copie exacte du texte par défaut (ENV_FALLBACK.AI_ANALYSIS_PROMPT_TEMPLATE dans
// systemConfigService.js) : pas de route de "reset" côté backend, on réenregistre simplement ce
// texte comme une modification normale (identique à settings.old.html).
const DEFAULT_AI_PROMPT_TEMPLATE = `Tu es un analyste de la demande pour un magasin de grande distribution ({{shopReference}} {{shopName}}).

Pour chaque article ci-dessous, procède dans cet ordre précis — n'inverse pas les étapes :

ÉTAPE 0 — Avant toute analyse de l'article, regarde le statut du MAGASIN lui-même (shopActivityStatus, shopMonthsSinceLastActivity, shopHadActivityBeyondSampleWindow) — un champ générique calculé pour tous les magasins de la même façon, jamais une exception propre à tel ou tel magasin ou telle période :
  - shopActivityStatus="ACTIVE" : le magasin a vendu récemment (ce mois-ci ou le mois dernier). Analyse l'article normalement (étapes 1 à 5) — une absence de vente de CET article dans un magasin actif signifie simplement que la demande pour cet article précis est nulle ou faible, pas que le magasin est arrêté.
  - shopActivityStatus="RESUMED" : le magasin a repris une activité récente après une période sans aucune vente (tous articles confondus). Traite l'historique d'AVANT la reprise comme peu représentatif de la demande actuelle : ne l'utilise pas pour projeter une quantité, base-toi surtout sur les ventes constatées depuis la reprise, même si cette période est courte — et reste prudent sur les quantités tant que cette reprise n'est pas confirmée sur plusieurs semaines.
  - shopActivityStatus="INACTIVE" : aucune vente (tous articles confondus) depuis plusieurs mois (shopMonthsSinceLastActivity indique depuis combien de mois). Un historique de ventes ancien ou une moyenne calculée sur une période où le magasin vendait encore ne reflète PAS une demande actuelle : ne recommande pas de quantité basée sur cet historique. Dans ce cas, quantity doit être 0 (sauf si des ventes réelles et récentes apparaissent malgré tout dans dailyHistory, ce qui contredirait ce statut et mérite d'être signalé), et reasoning doit clairement indiquer que le magasin semble ne plus être en activité et qu'aucune commande n'est recommandée pour cette raison, pas parce que l'article ne se vend pas.
  - shopActivityStatus="NEVER_ACTIVE" ou null (statut non calculé, ex. échec réseau ponctuel) : traite l'article normalement à partir des seules données disponibles, sans supposition sur l'état du magasin.
Dans tous les cas, ne confonds jamais "cet article précis n'a pas de vente" (une information sur l'article, dans un magasin par ailleurs actif) avec "le magasin n'a pas de vente" (une information sur le magasin lui-même) : ce sont deux causes différentes à une même absence de ventes dans dailyHistory, et seule l'analyse du statut du magasin ci-dessus permet de les distinguer.

ÉTAPE 1 — Analyse l'évolution réelle des ventes. Regarde dailyHistory ([{date, quantity}]) jour par jour, dans l'ordre chronologique. Identifie toi-même : la tendance (les derniers jours sont-ils clairement au-dessus ou en dessous de la moyenne de la période ?), l'accélération ou le ralentissement, un éventuel pic isolé à ne pas extrapoler (promotion, événement ponctuel) par opposition à une hausse ou baisse soutenue sur plusieurs jours consécutifs. IMPORTANT — évalue aussi le RECUL disponible : dailyHistory ne couvre parfois que quelques jours ; une hausse observée sur seulement 2-3 jours au sein d'un historique court est un signal fragile (pic isolé, erreur de caisse, effet ponctuel possible), pas une preuve de tendance durable — dans ce cas, ne recommande qu'un ajustement modéré et dis-le explicitement dans reasoning, plutôt que de projeter l'intégralité du dernier rythme observé comme s'il était acquis. Une tendance vue sur une plus longue période, ou confirmée par seasonalityDeviationPct, mérite davantage de confiance qu'une hausse qui ne repose que sur les tout derniers jours d'un historique court.

ÉTAPE 2 — À partir de cette tendance réelle, forme ta propre estimation de la demande attendue pour la période à venir (en te basant sur le rythme récent plutôt que sur la seule moyenne globale quand une tendance nette se dégage).

ÉTAPE 3 — Regarde ensuite systemSuggestedQuantity : c'est le résultat d'un calcul déterministe (vente moyenne hebdomadaire × (1 + safetyStockRatio) ramené au délai de réapprovisionnement receptionLeadTimeDays, moins stock actuel et commandes en cours) — une base de référence, PAS la réponse attendue. Compare-la à ton estimation de l'étape 2. D'autres signaux à prendre en compte pour juger de la fiabilité de cette base : seasonalityDeviationPct (écart vs l'an dernier, une hausse confirmée par la saisonnalité renforce la confiance dans une tendance haussière), forecastMethod ("flat" = moyenne plate peu fiable en cas d'historique court, "smoothed" = lissage plus robuste), systemConfidenceScore (0-100, plus il est bas moins la base est fiable et plus ton propre jugement compte).

ÉTAPE 4 — Si hasRecentOrder est true, une commande fournisseur a déjà été passée récemment (≤7 jours) pour cet article, hors de cette analyse : recentOrderReference (référence), recentOrderDate (date de commande), recentOrderCount (nombre de commandes distinctes dans cette fenêtre). Cette commande a déjà fait tomber le calcul système (systemSuggestedQuantity) à 0 ou proche de 0 par construction — CE N'EST PAS UNE DÉCISION FINALE, c'est une donnée à analyser comme les autres. Tu dois toi-même déterminer si cette commande suffit à couvrir le besoin, en comparant : la quantité déjà commandée, son ancienneté (recentOrderDate vs aujourd'hui), les ventes réalisées depuis dans dailyHistory (regarde les derniers jours après recentOrderDate), le stock actuel restant, et ta propre estimation de la demande à venir (étape 2). Deux issues possibles, à choisir toi-même selon l'analyse — jamais l'une par défaut :
  - Si la commande existante suffit : quantity = 0, et explique dans reasoning pourquoi (quantité déjà en route, ventes récentes cohérentes avec une couverture suffisante).
  - Si elle ne suffit pas (ventes plus fortes que prévu depuis la commande, tendance à la hausse, stock qui s'épuise plus vite que l'arrivée de la commande) : quantity = la quantité SUPPLÉMENTAIRE nécessaire en plus de ce qui est déjà commandé (pas le besoin total), et explique pourquoi la commande existante ne suffit pas. quantityIfIgnoringRecentOrder (le besoin total en ignorant cette commande) donne un ordre de grandeur du besoin brut à comparer à ce qu'elle couvre déjà. ATTENTION : une commande supplémentaire s'ajoute à une commande déjà en route — sois particulièrement prudent avant de la recommander sur la seule base d'une hausse récente et courte (cf. étape 1) ; vérifie que la hausse est établie sur plusieurs jours consécutifs et pas seulement les tout derniers jours de l'historique disponible, sous peine de faire commander en double une demande qui pourrait retomber.
Si hasRecentOrder est false, ignore cette étape.

ÉTAPE 5 — Décide de la quantité finale à commander, en tenant compte aussi de currentStock, daysUntilStockout (risque de rupture), currentOrderedQuantity (déjà en commande, à ne pas dupliquer), et revenueSharePct (les articles à forte part de CA méritent une couverture plus prudente en cas d'incertitude). Cette quantité finale doit être TA décision d'analyste, pas automatiquement systemSuggestedQuantity recopié : si l'évolution réelle des ventes montre clairement que la demande a changé par rapport à ce que la formule suppose, dis-le et ajuste en conséquence — à la hausse comme à la baisse, sans biais systématique dans un sens. Arrondis au multiple de orderingUnit le plus proche.

Articles (JSON) :
{{articles}}

Réponds UNIQUEMENT avec un tableau JSON valide, sans texte autour, au format exact :
[{"ean": "...", "quantity": 0, "reasoning": "2-4 phrases en français : le statut d'activité du magasin s'il n'est pas ACTIVE et son influence sur la décision, la tendance observée dans l'historique, comment elle compare à systemSuggestedQuantity, l'analyse de la commande récente si hasRecentOrder=true (suffisante ou non, et pourquoi), et la décision finale"}]
Une entrée par article fourni, dans le même ordre. quantity doit être un entier positif ou nul, multiple de orderingUnit.`;

// Copie exacte du texte par défaut (ENV_FALLBACK.CHATBOT_PROMPT_TEMPLATE dans
// systemConfigService.js) : même logique que ci-dessus, pas de route de reset dédiée.
const DEFAULT_CHATBOT_PROMPT_TEMPLATE = `Tu es l'Assistant IA Store d'un magasin de grande distribution. Tu réponds aux questions du responsable magasin sur le réassort, les ventes, les stocks et les prévisions.

Contexte :
{{context}}

{{dataSection}}

{{historySection}}Question du responsable magasin : {{question}}

Réponds en français, de façon directe et concise, en Markdown léger (gras **mot** pour les chiffres clés). Ne résume jamais à l'excès une question vague : si les données ci-dessus contiennent plusieurs informations pertinentes pour répondre (ex: plusieurs types de mouvement, plusieurs jours, plusieurs sous-totaux), donne-les TOUTES même si la question ne les nomme pas explicitement une par une — l'utilisateur qui demande "combien de types de mouvement" attend le détail de chaque type avec sa quantité, pas seulement un nombre total de types. Règle de format selon le contenu de ta réponse :
- Si la question porte sur "quels articles" (ruptures, surstock, à commander...) et que les données listent plusieurs articles : réponds avec UNE PUCE PAR ARTICLE nommé explicitement (label + chiffre clé, ex: "**LAMP BUR** : rupture dans **2 jours**, réassort suggéré **5** unités"), jamais un total agrégé seul qui masque quels articles précis sont concernés. Maximum 8 puces — au-delà, indique le nombre total et ne détaille que les plus urgents/importants.
- Si la question porte sur les mouvements de stock d'un article (byType/recentMoves dans les données) : réponds avec UNE PUCE PAR TYPE DE MOUVEMENT (ex: "**Vente** : 12 mouvements, -45 unités", "**Casse** : 1 mouvement, -3 unités"), jamais juste "il y a eu 3 types de mouvement" sans les nommer.
- Si la question porte sur une évolution/tendance globale (ventes, CA) sans lister d'articles : un court paragraphe avec les chiffres clés suffit, pas de liste forcée.
- Sinon (réponse à une seule idée) : 1-2 phrases courtes.
Ne réponds jamais par un seul chiffre agrégé quand la question demande explicitement "quels articles" — l'utilisateur veut toujours savoir lesquels, pas seulement combien.
Si la question posée contient PLUSIEURS demandes distinctes (ex: "donne-moi le prix ET l'historique de rupture") et que les données ci-dessus ne couvrent qu'UNE seule de ces demandes : réponds à celle que tu peux avec ces données, PUIS indique explicitement en une phrase que l'autre partie de la question nécessite une question séparée (précise laquelle) — ne l'ignore jamais silencieusement.`;

interface IntentRule {
  keywords: string[];
  tool: string;
}

// Copie exacte du tableau par défaut (ENV_FALLBACK.CHATBOT_INTENT_RULES dans
// systemConfigService.js) : pas de route de "reset" côté backend pour cette clé, on réenregistre
// ce JSON comme une modification normale.
const DEFAULT_INTENT_RULES: IntentRule[] = [
  { keywords: ['changement de prix', 'changé de prix', 'change de prix', 'changement de prix de vente', 'historique de prix', 'historique des prix', 'évolution du prix', 'evolution du prix', "quand a-t-il changé de prix", "quand est-ce que le prix", 'log de prix', 'log changement', 'mis en promo', 'mise en promo', 'mis en promotion', 'depuis quand', "quand est-ce qu'il", 'quand a-t-il', 'quand il a', 'quand est-il passé', 'a quel moment'], tool: 'getPriceChangeHistory' },
  { keywords: ['pourquoi le stock', 'pourquoi son stock', 'stock a baissé', 'stock a baisse', 'stock a bougé', 'stock a bouge', 'stock a chuté', 'stock a chute', 'stock a diminué', 'stock a diminue', 'mouvement de stock', 'mouvements de stock', 'type de mouvement', 'types de mouvement', 'type de mouvements', 'quel mouvement', 'quels mouvements', 'de la casse', 'en casse', 'casse sur', 'article volé', 'article vole', 'cession de rayon', 'cession entre rayon', 'cession inter-rayon', 'retour fournisseur', 'écart de stock', 'ecart de stock', 'disparition de stock'], tool: 'getStockMoveHistory' },
  { keywords: ['où se trouve', 'ou se trouve', 'emplacement', 'où est', 'ou est', 'quel rayon', 'dans quel rayon', 'adresse rayon', 'prix actuel', 'prix de vente', 'prix promo', 'en promo', 'promotion', 'quel prix', 'combien coûte', 'combien coute', 'fiche article', 'fiche produit', 'fiche complète', 'fiche complete', "détails de l'article", 'details de larticle', 'infos article', "informations sur l'article", 'toutes les informations', 'tout savoir sur', 'caractéristiques', 'caracteristiques', 'fournisseur de'], tool: 'getArticleDetails' },
  { keywords: ['pareto', '80%', '80 %', 'part du ca', 'part de ca', 'représentent le plus de ca', 'font le plus de ca', 'articles principaux', 'gros vendeurs', 'meilleures ventes', 'top articles', 'top vente'], tool: 'getParetoArticles' },
  { keywords: ["chiffre d'affaires", 'chiffre daffaire', 'chiffre d affaire', 'le ca', 'du ca', 'au ca', 'ton ca', 'mon ca', 'quel ca', 'ca du', 'ca le', 'ca est', 'ca de', 'combien on a fait', 'combien jai fait', "combien on a vendu en argent", 'recette du jour', 'recette de'], tool: 'getRevenue' },
  { keywords: ['rupture', 'stock critique', 'risque de rupture', 'va manquer', 'vont manquer', 'plus de stock', 'articles en manque', 'articles manquants', 'quoi va manquer'], tool: 'getStockoutRisks' },
  { keywords: ['surstock', 'trop de stock', 'sur-stock', 'excès de stock', 'exces de stock', 'trop stocké', 'trop stocke', 'articles en trop'], tool: 'getOverstockArticles' },
  { keywords: ['précision', 'fiabilité', 'accuracy', 'erreur de prévision', 'la prévision est bonne', 'fiable', "lia se trompe", "l'ia se trompe", 'taux de reussite', 'taux de réussite'], tool: 'getPredictionAccuracy' },
  { keywords: ['commande', 'commandes récentes', "qu'est-ce qui a été commandé", 'quest ce qui a ete commande', 'quoi a ete commande', 'derniere commande', 'dernières commandes'], tool: 'getOrders' },
  { keywords: ['proposition', 'proposition en attente', "aujourd'hui", 'quoi commander', 'que dois-je commander', 'quest ce que je dois commander', 'a commander'], tool: 'getCurrentProposal' },
  { keywords: ['vente', 'ventes', 'évolution', 'combien vendu', 'combien vendus', 'combien on a vendu', 'tendance', 'ca se vend comment', 'comment ca vend'], tool: 'getSalesHistory' },
  { keywords: ['stock de', 'stock actuel', 'stock disponible', 'combien il reste', 'combien il en reste', 'reste combien', 'il reste combien'], tool: 'getArticleStock' },
  { keywords: ['dlv', 'dlc', 'date limite de vente', 'date limite de consommation', 'péremption', 'peremption', 'articles à écouler', 'articles a ecouler', 'stock à solder', 'stock a solder', 'en dlv', 'proche de la peremption', 'proche de la péremption'], tool: 'getDlvArticles' },
];

const INTENT_TOOL_LABELS_FALLBACK: Record<string, string> = {
  getPriceChangeHistory: 'Historique des changements de prix',
  getStockMoveHistory: 'Mouvements de stock (casse, cession, retour...)',
  getArticleDetails: 'Fiche article complète (prix, emplacement, promo...)',
  getParetoArticles: "Articles représentant X% du chiffre d'affaires (Pareto)",
  getRevenue: "Chiffre d'affaires (magasin ou article/rayon)",
  getStockoutRisks: 'Articles à risque de rupture',
  getOverstockArticles: 'Articles en surstock',
  getPredictionAccuracy: 'Fiabilité des prédictions IA',
  getOrders: 'Commandes passées récemment',
  getCurrentProposal: 'Proposition de commande en attente',
  getSalesHistory: 'Historique des ventes / tendance',
  getArticleStock: 'Stock actuel (magasin ou article précis)',
  getDlvArticles: 'Articles en DLV (stock basculé à prix réduit)',
};

export function AiAnalysisPromptCard({ initialValue }: { initialValue: string }) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setError(null);
    setSuccess(null);
    setSaving(true);
    try {
      await saveSystemConfigKey('AI_ANALYSIS_PROMPT_TEMPLATE', value);
      setSuccess('Prompt enregistré.');
    } catch (err) {
      setError('Erreur: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    const confirmed = await window.reassortConfirm(
      'Réinitialiser le prompt au texte par défaut ? Cliquez ensuite sur Enregistrer pour confirmer.',
    );
    if (!confirmed) return;
    setValue(DEFAULT_AI_PROMPT_TEMPLATE);
  }

  return (
    <div className="card mt-3">
      <div className="card-header">
        <h5 className="card-title mb-0">Prompt d'analyse IA</h5>
      </div>
      <div className="card-body">
        <p className="text-muted small">
          Consignes envoyées au LLM lors d'une analyse (bouton "Analyser avec l'IA", que ce soit sur
          une proposition entière ou un seul article depuis la page "IA &amp; Prédictions").
          Placeholders disponibles : <code>{'{{shopReference}}'}</code>, <code>{'{{shopName}}'}</code>,{' '}
          <code>{'{{articles}}'}</code> (remplacé par les données de l'article au format JSON). La
          réponse attendue doit rester un tableau JSON{' '}
          <code>{'[{"ean": "...", "quantity": 0, "reasoning": "..."}]'}</code> — modifier cette
          contrainte cassera l'analyse.
        </p>
        <textarea
          className="form-control font-monospace small"
          rows={14}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="button" className="btn btn-primary btn-sm mt-2" disabled={saving} onClick={handleSave}>
          Enregistrer
        </button>
        <button type="button" className="btn btn-outline-secondary btn-sm mt-2 ms-2" onClick={handleReset}>
          Réinitialiser au prompt par défaut
        </button>
        {error && <div className="alert alert-danger mt-2">{error}</div>}
        {success && <div className="alert alert-success mt-2">{success}</div>}
      </div>
    </div>
  );
}

export function ChatbotPromptCard({ initialValue }: { initialValue: string }) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setError(null);
    setSuccess(null);
    if (value && (!value.includes('{{dataSection}}') || !value.includes('{{question}}'))) {
      setError('Le modèle doit contenir {{dataSection}} et {{question}} (sinon le prompt codé en dur sera utilisé).');
      return;
    }
    setSaving(true);
    try {
      await saveSystemConfigKey('CHATBOT_PROMPT_TEMPLATE', value);
      setSuccess("Prompt enregistré — appliqué dès la prochaine question posée à l'Assistant IA.");
    } catch (err) {
      setError('Erreur: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    const confirmed = await window.reassortConfirm(
      'Réinitialiser le prompt au texte par défaut ? Cliquez ensuite sur Enregistrer pour confirmer.',
    );
    if (!confirmed) return;
    setValue(DEFAULT_CHATBOT_PROMPT_TEMPLATE);
  }

  return (
    <div className="card mt-3">
      <div className="card-header">
        <h5 className="card-title mb-0">Assistant IA — ton et style de réponse</h5>
      </div>
      <div className="card-body">
        <p className="text-muted small">
          Persona, ton et consignes de format de l'Assistant IA (le chatbot du magasin, page
          Assistant IA / widget flottant). Placeholders disponibles : <code>{'{{context}}'}</code>{' '}
          (magasin/rayon sélectionné), <code>{'{{dataSection}}'}</code> (données réelles récupérées
          pour répondre — calculées automatiquement, ne décrivez pas vous-même ce que contient ce
          bloc), <code>{'{{historySection}}'}</code> (échanges précédents de la conversation),{' '}
          <code>{'{{question}}'}</code> (la question posée). La règle qui empêche l'IA d'inventer un
          chiffre (jamais répondre avec une donnée non fournie) reste toujours appliquée par le
          système, quel que soit le texte ci-dessous — elle ne peut pas être désactivée depuis cet
          écran. Sans <code>{'{{dataSection}}'}</code> et <code>{'{{question}}'}</code>, le prompt
          codé en dur est utilisé.
        </p>
        <textarea
          className="form-control font-monospace small"
          rows={12}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <div className="d-flex gap-2 mt-2">
          <button type="button" className="btn btn-primary btn-sm" disabled={saving} onClick={handleSave}>
            Enregistrer
          </button>
          <button type="button" className="btn btn-outline-secondary btn-sm" onClick={handleReset}>
            Réinitialiser au texte par défaut
          </button>
        </div>
        {error && <div className="alert alert-danger mt-2">{error}</div>}
        {success && <div className="alert alert-success mt-2">{success}</div>}
      </div>
    </div>
  );
}

export function ChatbotSuggestedQuestionsCard({ initialValue }: { initialValue: string }) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setError(null);
    setSuccess(null);
    setSaving(true);
    try {
      await saveSystemConfigKey('CHATBOT_SUGGESTED_QUESTIONS', value);
      setSuccess('Questions suggérées enregistrées.');
    } catch (err) {
      setError('Erreur: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card mt-3">
      <div className="card-header">
        <h5 className="card-title mb-0">Assistant IA — questions suggérées</h5>
      </div>
      <div className="card-body">
        <p className="text-muted small">
          Une question par ligne. Affichées comme suggestions cliquables dans l'Assistant IA, et
          utilisées par l'IA elle-même pour indiquer au magasin ce qu'elle sait faire quand une
          question posée sort de son périmètre. N'ajoutez que des questions couvertes par un outil de
          données réel (voir chatbotService.js) — une suggestion à laquelle l'assistant ne peut pas
          répondre avec de vraies données serait trompeuse.
        </p>
        <textarea
          className="form-control small"
          rows={8}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="button" className="btn btn-primary btn-sm mt-2" disabled={saving} onClick={handleSave}>
          Enregistrer
        </button>
        {error && <div className="alert alert-danger mt-2">{error}</div>}
        {success && <div className="alert alert-success mt-2">{success}</div>}
      </div>
    </div>
  );
}

export function ImprovementsPromptCard({ initialValue }: { initialValue: string }) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setError(null);
    setSuccess(null);
    if (value && !value.includes('{{title}}')) {
      setError('Le modèle doit contenir {{title}} (sinon le prompt codé en dur sera utilisé).');
      return;
    }
    setSaving(true);
    try {
      await saveSystemConfigKey('IMPROVEMENTS_PROMPT_TEMPLATE', value);
      setSuccess('Prompt enregistré — appliqué dès la prochaine analyse.');
    } catch (err) {
      setError('Erreur: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card mt-3">
      <div className="card-header">
        <h5 className="card-title mb-0">Chien de garde — prompt d'analyse IA</h5>
      </div>
      <div className="card-body">
        <p className="text-muted small">
          Consignes envoyées au LLM pour analyser chaque constat du Conseiller d'amélioration IA
          (page Améliorations IA). Placeholders disponibles : <code>{'{{title}}'}</code>,{' '}
          <code>{'{{detail}}'}</code>, <code>{'{{evidence}}'}</code> (preuves JSON),{' '}
          <code>{'{{files}}'}</code> (fichiers réels du projet). La réponse doit garder les lignes{' '}
          <code>EXPLOITATION:</code>, <code>DEV:</code> et <code>CONFIANCE:</code> — les supprimer
          casse l'enregistrement des recos. Sans <code>{'{{title}}'}</code>, le prompt codé en dur est
          utilisé.
        </p>
        <textarea
          className="form-control font-monospace small"
          rows={12}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="button" className="btn btn-primary btn-sm mt-2" disabled={saving} onClick={handleSave}>
          Enregistrer
        </button>
        {error && <div className="alert alert-danger mt-2">{error}</div>}
        {success && <div className="alert alert-success mt-2">{success}</div>}
      </div>
    </div>
  );
}

export function ChatbotIntentRulesCard() {
  const [rules, setRules] = useState<IntentRule[]>([]);
  const [toolLabels, setToolLabels] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const tools = await apiFetch<string[]>('/reassort/system-config/chatbot-tools');
        setToolLabels(Object.fromEntries(tools.map((t) => [t, INTENT_TOOL_LABELS_FALLBACK[t] || t])));
      } catch {
        setToolLabels(INTENT_TOOL_LABELS_FALLBACK);
      }
      try {
        const d = await apiFetch<Record<string, string>>('/reassort/system-config');
        setRules(JSON.parse(d.CHATBOT_INTENT_RULES || '[]'));
      } catch (err) {
        setError('Erreur de chargement : ' + (err instanceof Error ? err.message : String(err)));
      }
    })();
  }, []);

  function updateRule(i: number, patch: Partial<IntentRule>) {
    setRules((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  function moveUp(i: number) {
    if (i === 0) return;
    setRules((prev) => {
      const next = [...prev];
      [next[i - 1], next[i]] = [next[i], next[i - 1]];
      return next;
    });
  }

  function moveDown(i: number) {
    setRules((prev) => {
      if (i === prev.length - 1) return prev;
      const next = [...prev];
      [next[i], next[i + 1]] = [next[i + 1], next[i]];
      return next;
    });
  }

  function removeRule(i: number) {
    setRules((prev) => prev.filter((_, idx) => idx !== i));
  }

  function addRule() {
    const firstTool = Object.keys(toolLabels)[0] || 'getRevenue';
    setRules((prev) => [...prev, { keywords: [], tool: firstTool }]);
  }

  async function handleSave() {
    setError(null);
    setSuccess(null);
    const cleaned = rules.filter((r) => r.keywords.length > 0);
    if (!cleaned.length) {
      setError('Au moins une règle avec au moins un mot-clé est requise.');
      return;
    }
    setSaving(true);
    try {
      await saveSystemConfigKey('CHATBOT_INTENT_RULES', JSON.stringify(cleaned));
      setRules(cleaned);
      setSuccess("Règles enregistrées — appliquées à la prochaine question posée à l'Assistant IA (jusqu'à 60s de cache).");
    } catch (err) {
      setError('Erreur : ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  }

  async function handleResetToDefaults() {
    const confirmed = await window.reassortConfirm(
      'Réinitialiser toutes les règles aux valeurs par défaut ? Cette action remplace la liste actuelle immédiatement.',
    );
    if (!confirmed) return;
    setError(null);
    setSuccess(null);
    try {
      await saveSystemConfigKey('CHATBOT_INTENT_RULES', JSON.stringify(DEFAULT_INTENT_RULES));
      setRules(DEFAULT_INTENT_RULES.map((r) => ({ keywords: [...r.keywords], tool: r.tool })));
      setSuccess('Règles réinitialisées aux valeurs par défaut.');
    } catch (err) {
      setError('Erreur : ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  return (
    <div className="card mt-3">
      <div className="card-header">
        <h5 className="card-title mb-0">Assistant IA — mots-clés de détection</h5>
      </div>
      <div className="card-body">
        <p className="text-muted small">
          Détermine quel outil de données l'Assistant IA appelle selon les mots présents dans la
          question posée (ex: "chiffre d'affaires" déclenche le calcul du CA). Insensible aux
          accents/majuscules. <strong>L'ORDRE compte</strong> : pour une question qui pourrait
          correspondre à plusieurs règles, c'est la PREMIÈRE règle de la liste (de haut en bas) qui
          matche qui est utilisée — placez les intentions les plus précises avant les plus générales.
          Utilisez les flèches pour réordonner.
        </p>
        <div>
          {rules.map((rule, i) => (
            <div key={i} className="border rounded p-2 mb-2">
              <div className="d-flex align-items-center gap-2 mb-2">
                <span className="text-muted small">#{i + 1}</span>
                <select
                  className="form-select form-select-sm"
                  style={{ maxWidth: 340 }}
                  value={rule.tool}
                  onChange={(e) => updateRule(i, { tool: e.target.value })}
                >
                  {Object.entries(toolLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <div className="ms-auto d-flex gap-1">
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-secondary"
                    title="Monter (priorité plus haute)"
                    disabled={i === 0}
                    onClick={() => moveUp(i)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-secondary"
                    title="Descendre (priorité plus basse)"
                    disabled={i === rules.length - 1}
                    onClick={() => moveDown(i)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-danger"
                    title="Supprimer cette règle"
                    onClick={() => removeRule(i)}
                  >
                    ×
                  </button>
                </div>
              </div>
              <input
                type="text"
                className="form-control form-control-sm"
                placeholder="Mots-clés séparés par des virgules (ex: chiffre d'affaires, le ca, du ca)"
                value={rule.keywords.join(', ')}
                onChange={(e) =>
                  updateRule(i, { keywords: e.target.value.split(',').map((k) => k.trim()).filter(Boolean) })
                }
              />
            </div>
          ))}
        </div>
        <button type="button" className="btn btn-outline-dark btn-sm mt-2" onClick={addRule}>
          + Ajouter une règle
        </button>
        <div className="d-flex gap-2 mt-3">
          <button type="button" className="btn btn-primary btn-sm" disabled={saving} onClick={handleSave}>
            Enregistrer
          </button>
          <button type="button" className="btn btn-outline-secondary btn-sm" onClick={handleResetToDefaults}>
            Réinitialiser aux règles par défaut
          </button>
        </div>
        {error && <div className="alert alert-danger mt-2">{error}</div>}
        {success && <div className="alert alert-success mt-2">{success}</div>}
      </div>
    </div>
  );
}
