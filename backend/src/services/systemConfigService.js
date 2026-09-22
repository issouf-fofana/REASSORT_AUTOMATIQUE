const prisma = require('../utils/prisma');


const KEYS = {
  SALES_FILES_DIR: 'SALES_FILES_DIR',
  RPOS_BASE_URL: 'RPOS_BASE_URL',
  RPOS_USER: 'RPOS_USER',
  RPOS_PASSWORD: 'RPOS_PASSWORD',
  JWT_SECRET: 'JWT_SECRET',
  JWT_EXPIRES_IN: 'JWT_EXPIRES_IN',
  NIGHTLY_PROPOSAL_CRON: 'NIGHTLY_PROPOSAL_CRON',
  RPOS_RETRY_ATTEMPTS: 'RPOS_RETRY_ATTEMPTS',
  RPOS_RETRY_DELAY_MS: 'RPOS_RETRY_DELAY_MS',
  LAST_SALE_SEARCH_WINDOWS_DAYS: 'LAST_SALE_SEARCH_WINDOWS_DAYS',
  PRODUCT_INSIGHT_CACHE_TTL_HOURS: 'PRODUCT_INSIGHT_CACHE_TTL_HOURS',
  ADMIN_DASHBOARD_STOCKOUT_ALERT_THRESHOLD: 'ADMIN_DASHBOARD_STOCKOUT_ALERT_THRESHOLD',
  MAX_SALES_LINES_PER_GENERATION: 'MAX_SALES_LINES_PER_GENERATION',
  RECEPTION_SYNC_CRON: 'RECEPTION_SYNC_CRON',
  SALES_SYNC_CRON: 'SALES_SYNC_CRON',
  SHOPS_SYNC_CRON: 'SHOPS_SYNC_CRON',
  // Synchronisation locale des DLV actives (end_of_life_product, demande du 22/09/2026) : un
  // stock qui a basculé sur un EAN DLV distinct doit être retiré du stock "normal" pris en compte
  // pour calculer la quantité à recommander de l'article d'origine (proposalService.js).
  PRODUCT_EOL_SYNC_CRON: 'PRODUCT_EOL_SYNC_CRON',
  // Réajustement quotidien continu (CAHIER_DES_CHARGES.md §15-16, étape 3) : noms alignés sur la
  // configuration recommandée §54 (DAILY_REVIEW_CRON, REVISION_CHANGE_THRESHOLD).
  DAILY_REVIEW_CRON: 'DAILY_REVIEW_CRON',
  REVISION_CHANGE_THRESHOLD: 'REVISION_CHANGE_THRESHOLD',
  // Seuil "rupture invisible" de la détection d'anomalies (anomalyService.js, étape 7) : vente
  // moyenne journalière habituelle (unités/jour) à partir de laquelle un silence total des ventes
  // sur les derniers jours, malgré un stock disponible, est jugé incohérent. Baissable (ex: 0.5)
  // pour surveiller aussi les articles lents, au prix de plus de faux positifs sur les intermittents.
  ANOMALY_MIN_DAILY_SALES: 'ANOMALY_MIN_DAILY_SALES',
  // Évaluation des prédictions passées (CAHIER_DES_CHARGES.md §22, étape 5) : compare prédiction
  // et réalité une fois la période cible terminée.
  PREDICTION_OUTCOME_CRON: 'PREDICTION_OUTCOME_CRON',
  // Chien de garde du Conseiller d'amélioration IA (première brique AI Center, §44) : détection
  // quotidienne des anomalies silencieuses + évaluation d'effet des recos appliquées.
  IMPROVEMENTS_CRON: 'IMPROVEMENTS_CRON',
  // Récap quotidien de couverture des ventes (demande du 22/09/2026 : "au moins à 23h59:59 on est
  // sûr que il a tout pris") — compare RPOS vs local jour par jour pour la journée qui vient de se
  // terminer, sur CHAQUE magasin, et relance une récupération ciblée en cas d'écart. Distinct de la
  // synchro incrémentale (SALES_SYNC_CRON, toutes les 15 min, fenêtre glissante de 48h seulement).
  SALES_DAILY_RECAP_CRON: 'SALES_DAILY_RECAP_CRON',
  // Interrupteur marche/arrêt par job planifié, indépendant de son expression cron : à OFF, le job
  // ne se déclenche plus du tout jusqu'à réactivation (au lieu de devoir vider/deviner une
  // expression cron qui ne se déclenche jamais pour le "désactiver").
  NIGHTLY_PROPOSAL_ENABLED: 'NIGHTLY_PROPOSAL_ENABLED',
  RECEPTION_SYNC_ENABLED: 'RECEPTION_SYNC_ENABLED',
  SALES_SYNC_ENABLED: 'SALES_SYNC_ENABLED',
  SALES_DAILY_RECAP_ENABLED: 'SALES_DAILY_RECAP_ENABLED',
  // Restreint la synchro des ventes (job planifié + bouton "Lancer maintenant") à une liste de
  // magasins précise (rposShopId séparés par virgule) au lieu de tous les magasins actifs — utile
  // pour se concentrer sur un ou quelques magasins pendant les tests, sans désactiver la synchro
  // globalement pour tout le monde (SALES_SYNC_ENABLED reste le marche/arrêt général). Vide (défaut)
  // = comportement historique, tous les magasins actifs.
  SALES_SYNC_SHOP_IDS: 'SALES_SYNC_SHOP_IDS',
  SHOPS_SYNC_ENABLED: 'SHOPS_SYNC_ENABLED',
  PRODUCT_EOL_SYNC_ENABLED: 'PRODUCT_EOL_SYNC_ENABLED',
  DAILY_REVIEW_ENABLED: 'DAILY_REVIEW_ENABLED',
  PREDICTION_OUTCOME_ENABLED: 'PREDICTION_OUTCOME_ENABLED',
  IMPROVEMENTS_ENABLED: 'IMPROVEMENTS_ENABLED',
  // Si "true", chaque génération de proposition (nocturne, manuelle, réajustement quotidien)
  // envoie ses articles à l'IA pour ajuster la quantité calculée classiquement avant de
  // l'enregistrer comme "Qté proposée" — au lieu de laisser cette étape à un appel manuel séparé
  // ("Analyser" par article). Off par défaut : impact fort (coût API, temps de génération
  // multiplié par lot LLM) à activer en connaissance de cause, testable magasin par magasin en
  // attendant via l'analyse à la demande déjà existante.
  AI_QUANTITY_ADJUSTMENT_ENABLED: 'AI_QUANTITY_ADJUSTMENT_ENABLED',
  // Prompt utilisé pour l'analyse IA d'un article (aiForecastService.js) : éditable depuis
  // Paramètres > IA (admin) sans redéploiement. Placeholders remplacés avant l'envoi au LLM :
  // {{shopReference}}, {{shopName}}, {{articles}} (JSON des articles à analyser).
  AI_ANALYSIS_PROMPT_TEMPLATE: 'AI_ANALYSIS_PROMPT_TEMPLATE',
  // Persona/ton/consignes de format du chatbot (chatbotService.js buildChatbotPrompt) : éditable
  // depuis Paramètres > IA (admin), demande du 16/09/2026 ("les prompts de configuration il ne faut
  // pas mettre en dur dans le code"). Placeholders : {{context}} (magasin/rayon sélectionné),
  // {{dataSection}} (données réelles récupérées ou liste des capacités — calculé par le code selon
  // la question, jamais éditable ici), {{historySection}}, {{question}}. La règle anti-hallucination
  // (§35 du cahier des charges — ne jamais inventer un chiffre) et le nom exact des champs
  // salesCount/articleLineCount restent codés en dur dans buildChatbotPrompt, PAS dans ce template :
  // une modification malheureuse depuis l'UI ne doit jamais pouvoir désactiver cette protection.
  CHATBOT_PROMPT_TEMPLATE: 'CHATBOT_PROMPT_TEMPLATE',
  // Questions suggérées affichées dans l'Assistant IA (chatbotService.js) — une question par ligne.
  // Éditable depuis Paramètres > IA (admin), sans redéploiement. Sert aussi de liste de référence
  // pour indiquer au magasin ce que l'assistant sait réellement faire quand une question posée sort
  // du périmètre couvert (cf. buildChatbotPrompt, dataSection de repli).
  CHATBOT_SUGGESTED_QUESTIONS: 'CHATBOT_SUGGESTED_QUESTIONS',
  // Prompt du chien de garde (improvementService.js) : modèle d'analyse des constats, avec
  // placeholders {{title}} {{detail}} {{evidence}} {{files}}. Éditable depuis Paramètres > IA
  // (admin), sans redéploiement — permet d'ajuster le comportement de l'IA (ton, format,
  // fichiers de référence) sans toucher au code.
  IMPROVEMENTS_PROMPT_TEMPLATE: 'IMPROVEMENTS_PROMPT_TEMPLATE',
  // Règles de détection d'intention du chatbot (chatbotService.js INTENT_RULES) — demande du
  // 16/09/2026 : "rend la tab dynamique au cas ou je veux ajouter des mot ou corrigé". Stocké en
  // JSON (tableau [{keywords: string[], tool: string}, ...]), édité via un formulaire structuré
  // dans Paramètres > IA (pas un textarea JSON brut : une erreur de syntaxe ne doit jamais pouvoir
  // casser le chatbot). L'ORDRE du tableau compte (la première règle qui matche gagne) — l'UI doit
  // permettre de réordonner, pas seulement ajouter/supprimer.
  CHATBOT_INTENT_RULES: 'CHATBOT_INTENT_RULES',
  // Filet de repli n°3 du chatbot (chatbotService.js detectIntentViaLlm, ajouté le 17/09/2026) :
  // quand aucune règle de mots-clés ne matche une question, demande au LLM lui-même de choisir un
  // outil parmi le catalogue plutôt que d'abandonner sur "je ne comprends pas". Off par défaut,
  // même raison que AI_QUANTITY_ADJUSTMENT_ENABLED : coût et latence d'un appel LLM supplémentaire
  // par question ambiguë, à activer explicitement une fois vérifié en conditions réelles.
  CHATBOT_LLM_FALLBACK_ENABLED: 'CHATBOT_LLM_FALLBACK_ENABLED',
};

// Clés dont la valeur ne doit jamais être renvoyée en clair par l'API une fois enregistrée
// (mot de passe, secret de signature) : on peut les modifier (écriture) mais pas les relire,
// comme un champ mot de passe classique. Protège même si l'UI est compromise après coup.
const SENSITIVE_KEYS = new Set([KEYS.RPOS_PASSWORD, KEYS.JWT_SECRET]);

// Valeurs d'amorçage : utilisées tant que l'admin n'a pas explicitement défini une valeur dans
// la base depuis la page Paramètres. Une fois définie en base, la base prévaut toujours sur
// process.env (permet de tout changer à chaud, sans redéploiement).
const ENV_FALLBACK = {
  [KEYS.SALES_FILES_DIR]: () => '/mnt/asten/DONNEES VENTES ASTEN',
  [KEYS.RPOS_BASE_URL]: () => process.env.RPOS_BASE_URL || 'https://pos1-prod-prosuma.prosuma.pos',
  [KEYS.RPOS_USER]: () => process.env.RPOS_USER || '',
  [KEYS.RPOS_PASSWORD]: () => process.env.RPOS_PASSWORD || '',
  [KEYS.JWT_SECRET]: () => process.env.JWT_SECRET || '',
  [KEYS.JWT_EXPIRES_IN]: () => process.env.JWT_EXPIRES_IN || '7d',
  [KEYS.NIGHTLY_PROPOSAL_CRON]: () => process.env.NIGHTLY_PROPOSAL_CRON || '0 4 * * *',
  [KEYS.RPOS_RETRY_ATTEMPTS]: () => '3',
  [KEYS.RPOS_RETRY_DELAY_MS]: () => '500',
  [KEYS.LAST_SALE_SEARCH_WINDOWS_DAYS]: () => '31,93,366,1830,7320',
  [KEYS.PRODUCT_INSIGHT_CACHE_TTL_HOURS]: () => '24',
  [KEYS.ADMIN_DASHBOARD_STOCKOUT_ALERT_THRESHOLD]: () => '0.30',
  [KEYS.MAX_SALES_LINES_PER_GENERATION]: () => '20000',
  [KEYS.RECEPTION_SYNC_CRON]: () => process.env.RECEPTION_SYNC_CRON || '0 * * * *',
  // Toutes les 15 minutes par défaut : fenêtre courte car chaque passage ne resynchronise que
  // les ventes depuis la dernière synchro de chaque magasin (incrémental), donc peu coûteux.
  [KEYS.SALES_SYNC_CRON]: () => process.env.SALES_SYNC_CRON || '*/15 * * * *',
  // Toutes les heures : la liste des magasins change très rarement (ajout/fermeture manuelle).
  [KEYS.SHOPS_SYNC_CRON]: () => process.env.SHOPS_SYNC_CRON || '0 * * * *',
  // Toutes les heures par défaut : une DLV créée manuellement par le personnel n'a pas besoin
  // d'être reflétée à la minute près dans le calcul de réassort (généré au plus une fois par jour).
  [KEYS.PRODUCT_EOL_SYNC_CRON]: () => process.env.PRODUCT_EOL_SYNC_CRON || '15 * * * *',
  // Après le job nocturne de génération (4h) et la synchro des ventes de la veille : laisse le
  // temps aux ventes de la nuit/matinée d'être disponibles avant de recalculer (CAHIER_DES_CHARGES.md §15).
  [KEYS.DAILY_REVIEW_CRON]: () => process.env.DAILY_REVIEW_CRON || '30 6 * * *',
  // Une fois par jour, en dehors des heures de pointe des autres jobs : évalue les prédictions dont
  // la semaine cible s'est terminée depuis le dernier passage (pas besoin de fréquence plus élevée,
  // les cibles ne changent qu'une fois par semaine).
  [KEYS.PREDICTION_OUTCOME_CRON]: () => process.env.PREDICTION_OUTCOME_CRON || '0 7 * * *',
  // 10% par défaut (CAHIER_DES_CHARGES.md §16, exemple donné) : en dessous, le changement de
  // quantité totale proposée n'est pas jugé assez significatif pour justifier une nouvelle révision.
  [KEYS.REVISION_CHANGE_THRESHOLD]: () => '0.10',
  // Quotidien à 7h30 par défaut, après l'évaluation des prédictions (7h) pour bénéficier des
  // mesures les plus fraîches. Actif par défaut : une exécution sans nouveau constat ne coûte
  // rien (ni LLM, ni écriture grâce à la déduplication).
  [KEYS.IMPROVEMENTS_CRON]: () => process.env.IMPROVEMENTS_CRON || '30 7 * * *',
  // 23:59 par défaut : la journée qui vient tout juste de se terminer est vérifiée dans la même
  // minute calendaire, avant que la synchro incrémentale de minuit ne commence à couvrir le
  // lendemain — pas de raison technique de repousser plus tard, RPOS a déjà toutes les ventes de la
  // journée à cette heure (un magasin ferme toujours avant 23:59).
  [KEYS.SALES_DAILY_RECAP_CRON]: () => process.env.SALES_DAILY_RECAP_CRON || '59 23 * * *',
  // 1 unité/jour par défaut : en dessous de ce rythme habituel, un silence récent des ventes
  // n'est pas signalé comme rupture invisible (cf. ANOMALY_MIN_DAILY_SALES ci-dessus).
  [KEYS.ANOMALY_MIN_DAILY_SALES]: () => '1',
  [KEYS.AI_ANALYSIS_PROMPT_TEMPLATE]: () => `Tu es un analyste de la demande pour un magasin de grande distribution ({{shopReference}} {{shopName}}).

Pour chaque article ci-dessous, procède dans cet ordre précis — n'inverse pas les étapes :

ÉTAPE 0 — Avant toute analyse de l'article, regarde le statut du MAGASIN lui-même (shopActivityStatus, shopMonthsSinceLastActivity, shopHadActivityBeyondSampleWindow) — un champ générique calculé pour tous les magasins de la même façon, jamais une exception propre à tel ou tel magasin ou telle période :
  - shopActivityStatus="ACTIVE" : le magasin a vendu récemment (ce mois-ci ou le mois dernier). Analyse l'article normalement (étapes 1 à 5) — une absence de vente de CET article dans un magasin actif signifie simplement que la demande pour cet article précis est nulle ou faible, pas que le magasin est arrêté.
  - shopActivityStatus="RESUMED" : le magasin a repris une activité récente après une période sans aucune vente (tous articles confondus). Traite l'historique d'AVANT la reprise comme peu représentatif de la demande actuelle : ne l'utilise pas pour projeter une quantité, base-toi surtout sur les ventes constatées depuis la reprise, même si cette période est courte — et reste prudent sur les quantités tant que cette reprise n'est pas confirmée sur plusieurs semaines.
  - shopActivityStatus="INACTIVE" : aucune vente (tous articles confondus) depuis plusieurs mois (shopMonthsSinceLastActivity indique depuis combien de mois). Un historique de ventes ancien ou une moyenne calculée sur une période où le magasin vendait encore ne reflète PAS une demande actuelle : ne recommande pas de quantité basée sur cet historique. Dans ce cas, quantity doit être 0 (sauf si des ventes réelles et récentes apparaissent malgré tout dans dailyHistory, ce qui contredirait ce statut et mérite d'être signalé), et reasoning doit clairement indiquer que le magasin semble ne plus être en activité et qu'aucune commande n'est recommandée pour cette raison, pas parce que l'article ne se vend pas.
  - shopActivityStatus="NEVER_ACTIVE" : aucune vente trouvée sur toute la fenêtre échantillonnée (24 mois) — traite comme INACTIVE ci-dessus (quantity=0, le magasin n'a jamais vendu sur cette longue période).
  - shopActivityStatus="UNKNOWN" (impossible de vérifier l'activité du magasin, ex. échec réseau RPOS sur toute la fenêtre d'échantillonnage) ou null (statut non calculé) : NE CONCLUS JAMAIS que le magasin est inactif dans ce cas — traite l'article normalement à partir des seules données disponibles (dailyHistory, stock), sans aucune supposition sur l'état du magasin. Un statut UNKNOWN signifie "on ne sait pas", jamais "inactif" — ne jamais recommander quantity=0 pour ce motif précis.
Dans tous les cas, ne confonds jamais "cet article précis n'a pas de vente" (une information sur l'article, dans un magasin par ailleurs actif) avec "le magasin n'a pas de vente" (une information sur le magasin lui-même) : ce sont deux causes différentes à une même absence de ventes dans dailyHistory, et seule l'analyse du statut du magasin ci-dessus permet de les distinguer.

ÉTAPE 0bis — Regarde ensuite anomalies ([{type, changePct, message}], vide si aucune détectée) et trendCategory (GROWING, DECLINING, STABLE, VOLATILE ou UNKNOWN) : des signaux calculés automatiquement par le système, pas une opinion humaine.
  - Un type "SALES_SPIKE" ou "SALES_DROP" signale une variation brutale et récente déjà détectée par le système : ne l'ignore pas, mais reste prudent avant d'extrapoler intégralement ce mouvement — vérifie dans dailyHistory si c'est un pic ponctuel (promotion, événement) ou le début d'un vrai changement durable.
  - Un type "STOCK_INCONSISTENCY" signale un stock disponible mais aucune vente récente sur un article qui vend habituellement : cela ressemble à une rupture invisible (article mal positionné, code-barre non scanné) plutôt qu'à une vraie absence de demande — ne recommande pas quantity=0 uniquement à cause de ce silence de ventes, explique ce doute dans reasoning et privilégie une estimation basée sur le rythme habituel de l'article avant cette anomalie.
  - trendCategory="VOLATILE" signale des ventes trop irrégulières pour dégager une tendance fiable : reste modéré sur l'ampleur de tout ajustement, plutôt que de suivre le dernier chiffre observé.
  - Aucune anomalie et trendCategory renseigné (GROWING/DECLINING/STABLE) : traite normalement, c'est un signal de confirmation supplémentaire à combiner avec ton analyse de l'étape 1.

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

ÉTAPE 6 — Choisis l'action qui résume le mieux ta décision, parmi EXACTEMENT ces valeurs (jamais une autre) :
  - "ORDER_NOW" : commander la quantité indiquée, situation normale (besoin réel identifié, rien de particulier à signaler).
  - "ORDER_MORE" : la commande déjà en cours (hasRecentOrder=true) ne suffit pas, quantity est la quantité SUPPLÉMENTAIRE nécessaire (cf. étape 4).
  - "ORDER_LESS" : le calcul système (systemSuggestedQuantity) est réduit car ta propre analyse indique un besoin réel plus faible (tendance à la baisse confirmée, saisonnalité défavorable...).
  - "WAIT" : quantity=0, la commande déjà en cours ou le stock actuel suffisent largement, rien à commander maintenant.
  - "STOCK_RISK" : rupture proche ou déjà là (daysUntilStockout bas ou nul) malgré une quantité proposée — signale l'urgence en plus de la quantité.
  - "OVERSTOCK" : le stock actuel dépasse largement le besoin réel, quantity=0 même si systemSuggestedQuantity est positif.
  - "DEMAND_INCREASE" : la tendance de fond est clairement haussière et justifie une quantité au-dessus de systemSuggestedQuantity.
  - "DEMAND_DECREASE" : la tendance de fond est clairement baissière et justifie une quantité en dessous de systemSuggestedQuantity.
  - "ANOMALY" : un signal anormal (anomalies non vide, ou incohérence détectée toi-même) rend la décision incertaine — reste sur une quantité prudente et explique le doute.
  - "VERIFY_STOCK" : stock RPOS incohérent avec les ventes observées (ex: STOCK_INCONSISTENCY dans anomalies) — recommande une vérification physique plutôt qu'une décision ferme.
  - "NO_ACTION" : rien à signaler, situation stable, quantity proche de 0 par absence de besoin réel (pas par anomalie).
Une seule action par article, celle qui correspond le mieux à ta décision réelle — ne choisis jamais "ORDER_NOW" par défaut si un autre type décrit mieux la situation.

IMPORTANT — ton du champ "reasoning" (demande du 18/09/2026) : il est lu par du personnel de magasin (rayonnistes, chefs de rayon), pas par des informaticiens ou des logisticiens. Bannis tout jargon technique ou métier pointu, même s'il te semble courant : jamais "jours d'autonomie", "couverture", "stock de sécurité", "lissage", "tendance VOLATILE/STABLE", "confiance", "seasonalityDeviationPct" ou tout autre nom de champ technique. Reformule TOUJOURS en langage courant et concret, comme si tu expliquais oralement à quelqu'un sur le terrain : au lieu de "5,5 jours d'autonomie", dis "il reste du stock pour environ 5-6 jours au rythme de vente actuel" ; au lieu de "la tendance est en hausse de 33%", dis "les ventes ont augmenté ces derniers jours" ; au lieu de "confiance faible (32/100)", dis "cette estimation est incertaine, peu d'historique disponible". Une phrase compréhensible sans rien connaître du système vaut mieux qu'une phrase précise mais opaque.

Réponds UNIQUEMENT avec un tableau JSON valide, sans texte autour, au format exact :
[{"ean": "...", "quantity": 0, "action": "ORDER_NOW", "reasoning": "2-4 phrases en français COURANT (voir consigne de ton ci-dessus, jamais de jargon) : le statut d'activité du magasin s'il n'est pas ACTIVE et son influence sur la décision, la tendance observée dans l'historique, comment elle compare à systemSuggestedQuantity, l'analyse de la commande récente si hasRecentOrder=true (suffisante ou non, et pourquoi), et la décision finale"}]
Une entrée par article fourni, dans le même ordre. quantity doit être un entier positif ou nul, multiple de orderingUnit. action doit être EXACTEMENT une des valeurs listées à l'étape 6, jamais une autre chaîne.`,
  // Tous les jobs sont actifs par défaut (comportement historique, avant l'ajout de ces
  // interrupteurs) : seul un changement explicite depuis Paramètres les désactive.
  [KEYS.NIGHTLY_PROPOSAL_ENABLED]: () => 'true',
  [KEYS.RECEPTION_SYNC_ENABLED]: () => 'true',
  [KEYS.SALES_SYNC_ENABLED]: () => 'true',
  [KEYS.SALES_SYNC_SHOP_IDS]: () => '',
  [KEYS.SALES_DAILY_RECAP_ENABLED]: () => 'true',
  [KEYS.SHOPS_SYNC_ENABLED]: () => 'true',
  [KEYS.PRODUCT_EOL_SYNC_ENABLED]: () => 'true',
  [KEYS.DAILY_REVIEW_ENABLED]: () => 'true',
  [KEYS.PREDICTION_OUTCOME_ENABLED]: () => 'true',
  [KEYS.IMPROVEMENTS_ENABLED]: () => 'true',
  // Off par défaut (contrairement aux autres jobs) : impact fort sur le comportement et le coût,
  // à activer explicitement plutôt que par défaut au premier déploiement.
  [KEYS.AI_QUANTITY_ADJUSTMENT_ENABLED]: () => 'false',
  [KEYS.CHATBOT_LLM_FALLBACK_ENABLED]: () => 'false',
  [KEYS.CHATBOT_PROMPT_TEMPLATE]: () => `Tu es l'Assistant IA Store d'un magasin de grande distribution. Tu réponds aux questions du responsable magasin sur le réassort, les ventes, les stocks et les prévisions.

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
Si la question posée contient PLUSIEURS demandes distinctes (ex: "donne-moi le prix ET l'historique de rupture") et que les données ci-dessus ne couvrent qu'UNE seule de ces demandes : réponds à celle que tu peux avec ces données, PUIS indique explicitement en une phrase que l'autre partie de la question nécessite une question séparée (précise laquelle) — ne l'ignore jamais silencieusement.`,
  [KEYS.CHATBOT_SUGGESTED_QUESTIONS]: () => [
    'Quels articles risquent d\'être en rupture ?',
    'Quels articles sont en surstock ?',
    'Quels articles font 80% du chiffre d\'affaires ?',
    'Quelle est la précision de l\'IA sur ce magasin ?',
    'Comment évoluent les ventes ce mois-ci ?',
    'Quel est le CA du magasin aujourd\'hui ?',
    'Quels articles dois-je commander aujourd\'hui ?',
    'Quelles commandes ont été passées récemment ?',
  ].join('\n'),
  [KEYS.IMPROVEMENTS_PROMPT_TEMPLATE]: () => `Tu es un expert maintenance d'une plateforme de réassort (backend Node.js/Express/Prisma/Postgres, frontend HTML/Bootstrap vanilla, intégration ERP RPOS).
Fichiers réels du projet (ne cite QUE ceux-ci) : {{files}}
Constat automatique du chien de garde :
- Titre : {{title}}
- Détail : {{detail}}
- Preuves : {{evidence}}

Réponds en français, 5 lignes max, format STRICT (rien d'autre) :
EXPLOITATION: <1 action concrète côté réglages ou exploitation (nommer la clé de config ou la page Paramètres si pertinent)>
DEV: <1 correctif code avec les fichiers concernés (chemins backend/src/... ou frontend/...), ou "RAS" si le constat ne relève pas du code>
CONFIANCE: <0-100, ton niveau de confiance dans cette analyse vu les preuves fournies>`,
  // Copie exacte de l'ancien INTENT_RULES codé en dur dans chatbotService.js (migré le 16/09/2026).
  // L'ORDRE compte : la première règle dont un mot-clé matche la question gagne — reproduit ici
  // dans le même ordre que l'original pour ne rien changer au comportement existant au moment de
  // la migration. La règle Pareto générique (X% du CA, n'importe quel X) reste codée en dur dans
  // chatbotService.js (PARETO_PATTERN_REGEX, une vraie regex, pas un mot-clé exact) — hors de cette
  // liste éditable, toujours vérifiée en premier.
  [KEYS.CHATBOT_INTENT_RULES]: () => JSON.stringify([
    { keywords: ['changement de prix', 'changé de prix', 'change de prix', 'changement de prix de vente', 'historique de prix', 'historique des prix', 'évolution du prix', 'evolution du prix', 'quand a-t-il changé de prix', 'quand est-ce que le prix', 'log de prix', 'log changement', 'mis en promo', 'mise en promo', 'mis en promotion', 'depuis quand', "quand est-ce qu'il", 'quand a-t-il', 'quand il a', 'quand est-il passé', 'a quel moment'], tool: 'getPriceChangeHistory' },
    { keywords: ['pourquoi le stock', 'pourquoi son stock', 'stock a baissé', 'stock a baisse', 'stock a bougé', 'stock a bouge', 'stock a chuté', 'stock a chute', 'stock a diminué', 'stock a diminue', 'mouvement de stock', 'mouvements de stock', 'type de mouvement', 'types de mouvement', 'type de mouvements', 'quel mouvement', 'quels mouvements', 'de la casse', 'en casse', 'casse sur', 'article volé', 'article vole', 'cession de rayon', 'cession entre rayon', 'cession inter-rayon', 'retour fournisseur', 'écart de stock', 'ecart de stock', 'disparition de stock'], tool: 'getStockMoveHistory' },
    { keywords: ['où se trouve', 'ou se trouve', 'emplacement', 'où est', 'ou est', 'quel rayon', 'dans quel rayon', 'adresse rayon', 'prix actuel', 'prix de vente', 'prix promo', 'en promo', 'promotion', 'quel prix', 'combien coûte', 'combien coute', 'fiche article', 'fiche produit', 'fiche complète', 'fiche complete', "détails de l'article", 'details de larticle', 'infos article', "informations sur l'article", 'toutes les informations', 'tout savoir sur', 'caractéristiques', 'caracteristiques', 'fournisseur de'], tool: 'getArticleDetails' },
    { keywords: ['pareto', '80%', '80 %', 'part du ca', 'part de ca', 'représentent le plus de ca', 'font le plus de ca', 'articles principaux', 'gros vendeurs', 'meilleures ventes', 'top articles', 'top vente'], tool: 'getParetoArticles' },
    { keywords: ["chiffre d'affaires", 'chiffre daffaire', 'chiffre d affaire', 'le ca', 'du ca', 'au ca', 'ton ca', 'mon ca', 'quel ca', 'ca du', 'ca le', 'ca est', 'ca de', 'combien on a fait', 'combien jai fait', 'combien on a vendu en argent', 'recette du jour', 'recette de'], tool: 'getRevenue' },
    { keywords: ['rupture', 'stock critique', 'risque de rupture', 'va manquer', 'vont manquer', 'plus de stock', 'articles en manque', 'articles manquants', 'quoi va manquer'], tool: 'getStockoutRisks' },
    { keywords: ['surstock', 'trop de stock', 'sur-stock', 'excès de stock', 'exces de stock', 'trop stocké', 'trop stocke', 'articles en trop'], tool: 'getOverstockArticles' },
    { keywords: ['précision', 'fiabilité', 'accuracy', 'erreur de prévision', 'la prévision est bonne', 'fiable', 'lia se trompe', "l'ia se trompe", 'taux de reussite', 'taux de réussite'], tool: 'getPredictionAccuracy' },
    { keywords: ['commande', 'commandes récentes', "qu'est-ce qui a été commandé", 'quest ce qui a ete commande', 'quoi a ete commande', 'derniere commande', 'dernières commandes'], tool: 'getOrders' },
    { keywords: ['proposition', 'proposition en attente', "aujourd'hui", 'quoi commander', 'que dois-je commander', 'quest ce que je dois commander', 'a commander'], tool: 'getCurrentProposal' },
    { keywords: ['vente', 'ventes', 'évolution', 'combien vendu', 'combien vendus', 'combien on a vendu', 'tendance', 'ca se vend comment', 'comment ca vend'], tool: 'getSalesHistory' },
    { keywords: ['stock de', 'stock actuel', 'stock disponible', 'combien il reste', 'combien il en reste', 'reste combien', 'il reste combien'], tool: 'getArticleStock' },
    { keywords: ['dlv', 'dlc', 'date limite de vente', 'date limite de consommation', 'péremption', 'peremption', 'articles à écouler', 'articles a ecouler', 'stock à solder', 'stock a solder', 'en dlv', 'proche de la peremption', 'proche de la péremption'], tool: 'getDlvArticles' },
  ]),
};

async function getValue(key) {
  const row = await prisma.systemConfig.findUnique({ where: { key } });
  if (row) return row.value;
  const fallback = ENV_FALLBACK[key];
  return fallback ? fallback() : null;
}

async function setValue(key, value, description) {
  return prisma.systemConfig.upsert({
    where: { key },
    update: { value },
    create: { key, value, description },
  });
}

/** Toutes les valeurs, avec les clés sensibles masquées (jamais renvoyées en clair). */
async function getAll() {
  const rows = await prisma.systemConfig.findMany();
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  const result = {};
  for (const key of Object.values(KEYS)) {
    if (SENSITIVE_KEYS.has(key)) {
      // On indique seulement si une valeur est définie, jamais sa valeur réelle.
      const hasValue = byKey[key] !== undefined || !!ENV_FALLBACK[key]?.();
      result[key] = hasValue ? '••••••••' : '';
    } else {
      result[key] = byKey[key] !== undefined ? byKey[key] : ENV_FALLBACK[key]?.();
    }
  }
  return result;
}

module.exports = { KEYS, SENSITIVE_KEYS, getValue, setValue, getAll };
