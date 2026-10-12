const prisma = require('../utils/prisma');
const { FALLBACK_INTENT_RULES } = require('./chatbotIntentRulesDefault');


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
  // Seuils de détection d'anomalie de COMMANDE (orderAnomalyService.js, amelioration.md §5-9,
  // exposés en Paramètres le 05/10/2026 à la demande de l'utilisateur) : auparavant en dur dans le
  // code, maintenant réglables pour s'adapter à des magasins à comportement différent (rotation
  // lente, historique court...) sans toucher au code.
  ORDER_ANOMALY_MIN_SAMPLE_SIZE: 'ORDER_ANOMALY_MIN_SAMPLE_SIZE',
  ORDER_ANOMALY_THRESHOLD: 'ORDER_ANOMALY_THRESHOLD',
  // Seuils de tendance de vente (anomalyService.js, utilisés aussi par orderAnomalyService pour
  // contextualiser une anomalie de commande, cf. buildTrendContext) — mêmes raisons, même date.
  ANOMALY_SALES_SPIKE_THRESHOLD_PCT: 'ANOMALY_SALES_SPIKE_THRESHOLD_PCT',
  ANOMALY_SALES_DROP_THRESHOLD_PCT: 'ANOMALY_SALES_DROP_THRESHOLD_PCT',
  ANOMALY_TREND_GROWING_THRESHOLD_PCT: 'ANOMALY_TREND_GROWING_THRESHOLD_PCT',
  ANOMALY_TREND_DECLINING_THRESHOLD_PCT: 'ANOMALY_TREND_DECLINING_THRESHOLD_PCT',
  ANOMALY_VOLATILE_CV_THRESHOLD: 'ANOMALY_VOLATILE_CV_THRESHOLD',
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
  // Signature/logo ajoutés en pied de page de CHAQUE email envoyé par outlookMailService.sendMail()
  // (demande du 25/09/2026, Paramètres > Comptes mail) — texte simple multi-lignes (jamais de HTML
  // brut accepté, pour ne jamais risquer de casser l'affichage du mail avec une balise mal fermée).
  MAIL_SIGNATURE_TEXT: 'MAIL_SIGNATURE_TEXT',
  // Logo encodé en base64 (avec son content-type), stocké en base plutôt que sur disque : envoyé en
  // pièce jointe inline (Content-ID) à chaque email, jamais servi par une URL publique — évite
  // d'exposer un nouvel endpoint de fichiers statiques juste pour cette image.
  MAIL_LOGO_BASE64: 'MAIL_LOGO_BASE64',
  MAIL_LOGO_CONTENT_TYPE: 'MAIL_LOGO_CONTENT_TYPE',
  // Logo/favicon du SITE (demande du 28/09/2026 : "donne la possibilité de modifier le logo,
  // favicon sur mon ui") — distinct du logo email ci-dessus. Un seul fichier statique
  // (frontend/assets/images/logo-reassort.png) servait à la fois de logo (sidebar) ET de favicon sur
  // les ~30 pages du site. Séparés en deux réglages indépendants le 09/10/2026 (demande explicite :
  // "je veux mettre deux logo different") — logo (sidebar/widgets) et favicon (onglet navigateur)
  // sont maintenant deux images distinctes, chacune avec son propre upload. Frontend et backend sont
  // deux conteneurs Docker séparés sans volume partagé : impossible d'écrire directement ces
  // fichiers statiques depuis une route backend. Stockés ici en base64 comme le logo email, servis
  // dynamiquement par des routes backend que nginx proxifie (frontend/nginx.conf, location =
  // /assets/images/logo-reassort.png et /assets/images/favicon-reassort.png) — si vide, chaque route
  // retombe sur son fichier statique d'origine (fallback), donc rien ne casse tant qu'aucune image
  // personnalisée n'a jamais été uploadée.
  SITE_LOGO_BASE64: 'SITE_LOGO_BASE64',
  SITE_LOGO_CONTENT_TYPE: 'SITE_LOGO_CONTENT_TYPE',
  SITE_FAVICON_BASE64: 'SITE_FAVICON_BASE64',
  SITE_FAVICON_CONTENT_TYPE: 'SITE_FAVICON_CONTENT_TYPE',
  // Relance des propositions encore en attente (demande du 25/09/2026 : l'entrepôt ne reçoit plus
  // les commandes après 13h, une relance en matinée laisse le temps de valider avant cette limite).
  PROPOSAL_REMINDER_CRON: 'PROPOSAL_REMINDER_CRON',
  // Récap de fin de journée pour les ADMIN (demande du 26/09/2026 : "en fin de journée aussi il
  // dois me dire pour chaque mag qui on validé les commande") — 16h30 par défaut, juste après la
  // fermeture de la fenêtre entrepôt (13h) pour voir immédiatement qui n'a pas validé aujourd'hui.
  END_OF_DAY_VALIDATION_RECAP_CRON: 'END_OF_DAY_VALIDATION_RECAP_CRON',
  END_OF_DAY_VALIDATION_RECAP_ENABLED: 'END_OF_DAY_VALIDATION_RECAP_ENABLED',
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
  PROPOSAL_REMINDER_ENABLED: 'PROPOSAL_REMINDER_ENABLED',
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
  // Suivi des demandes d'évolution produit (chatbotService.js maybeTrackFeatureRequest, demande du
  // 25/09/2026) : quand aucun outil de données n'a pu répondre à une question, un second appel LLM
  // juge si la conversation révèle un vrai besoin fonctionnel et l'enregistre (ou l'enrichit s'il
  // existe déjà). Off par défaut, même raison que CHATBOT_LLM_FALLBACK_ENABLED : coût et latence d'un
  // appel LLM supplémentaire à chaque question hors périmètre, à activer explicitement.
  CHATBOT_FEATURE_TRACKING_ENABLED: 'CHATBOT_FEATURE_TRACKING_ENABLED',
  // Alerte de dépassement de consommation de tokens IA (demande du 12/10/2026, suite à un pic réel
  // de 36,9M tokens en une seule journée découvert seulement après coup sur la page Consommation de
  // tokens) : job quotidien qui compare le total des dernières 24h à TOKEN_USAGE_ALERT_THRESHOLD_TOKENS
  // et alerte les ADMIN par email en cas de dépassement — cf. tokenUsageWatchdogJob.js.
  TOKEN_USAGE_ALERT_ENABLED: 'TOKEN_USAGE_ALERT_ENABLED',
  TOKEN_USAGE_ALERT_CRON: 'TOKEN_USAGE_ALERT_CRON',
  TOKEN_USAGE_ALERT_THRESHOLD_TOKENS: 'TOKEN_USAGE_ALERT_THRESHOLD_TOKENS',
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
  // Passé de 1x/jour (7h) à toutes les heures le 22/09/2026 (demande explicite : "on doit voir ça
  // à tout moment, pas un cron chaque jour à 7h") — dès qu'une vente réelle a lieu, le résultat
  // affiché sur Vue Globale (précision IA, confiance IA) se met à jour dans l'heure qui suit, sans
  // attendre le lendemain matin.
  [KEYS.PREDICTION_OUTCOME_CRON]: () => process.env.PREDICTION_OUTCOME_CRON || '0 * * * *',
  // 10h par défaut : fenêtre 9h-11h demandée, avant la limite de 13h de l'entrepôt.
  [KEYS.PROPOSAL_REMINDER_CRON]: () => process.env.PROPOSAL_REMINDER_CRON || '0 10 * * *',
  // 16h30 par défaut (demande du 26/09/2026).
  [KEYS.END_OF_DAY_VALIDATION_RECAP_CRON]: () => process.env.END_OF_DAY_VALIDATION_RECAP_CRON || '30 16 * * *',
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
  [KEYS.ORDER_ANOMALY_MIN_SAMPLE_SIZE]: () => '3',
  [KEYS.ORDER_ANOMALY_THRESHOLD]: () => '2',
  [KEYS.ANOMALY_SALES_SPIKE_THRESHOLD_PCT]: () => '80',
  [KEYS.ANOMALY_SALES_DROP_THRESHOLD_PCT]: () => '-60',
  [KEYS.ANOMALY_TREND_GROWING_THRESHOLD_PCT]: () => '15',
  [KEYS.ANOMALY_TREND_DECLINING_THRESHOLD_PCT]: () => '-15',
  [KEYS.ANOMALY_VOLATILE_CV_THRESHOLD]: () => '1.2',
  [KEYS.AI_ANALYSIS_PROMPT_TEMPLATE]: () => `Tu es un analyste de la demande pour un magasin de grande distribution ({{shopReference}} {{shopName}}).

Pour chaque article ci-dessous, procède dans cet ordre précis — n'inverse pas les étapes :

ÉTAPE 0 — Statut du MAGASIN (shopActivityStatus, shopMonthsSinceLastActivity, shopHadActivityBeyondSampleWindow), calculé pareil pour tous les magasins :
  - "ACTIVE" : magasin a vendu ce mois-ci ou le mois dernier. Analyse normalement (étapes 1-5) — une absence de vente sur CET article dans un magasin actif veut dire demande nulle/faible pour cet article, pas magasin arrêté.
  - "RESUMED" : reprise récente après une période sans AUCUNE vente (tous articles). Ignore l'historique d'avant la reprise pour projeter une quantité ; base-toi sur les ventes depuis la reprise même si courtes, reste prudent tant que non confirmé sur plusieurs semaines.
  - "INACTIVE" : aucune vente (tous articles) depuis shopMonthsSinceLastActivity mois. Un historique ancien ne reflète pas la demande actuelle : quantity=0 (sauf ventes réelles récentes contradictoires dans dailyHistory, à signaler), reasoning doit dire que le magasin semble à l'arrêt — pas que l'article ne se vend pas.
  - "NEVER_ACTIVE" : aucune vente sur 24 mois échantillonnés — traite comme INACTIVE (quantity=0).
  - "UNKNOWN" ou null (échec de vérification, ex. RPOS injoignable) : NE JAMAIS conclure à l'inactivité — analyse l'article normalement sur les seules données disponibles. "On ne sait pas" ≠ "inactif" ; jamais quantity=0 pour ce seul motif.
Ne confonds jamais "cet article ne se vend pas" (info sur l'article) avec "le magasin ne vend pas" (info sur le magasin) — seul ce statut permet de trancher.

ÉTAPE 0bis — anomalies ([{type, changePct, message}], vide si aucune) et trendCategory (GROWING/DECLINING/STABLE/VOLATILE/UNKNOWN), calculés automatiquement :
  - "SALES_SPIKE"/"SALES_DROP" : variation brutale récente détectée. Ne l'ignore pas, mais vérifie dans dailyHistory si c'est ponctuel (promo, événement) ou un vrai changement durable avant d'extrapoler.
  - "STOCK_INCONSISTENCY" : stock dispo mais aucune vente récente sur un article qui vend habituellement — ressemble à une rupture invisible (mauvais positionnement, code-barre non scanné), pas une vraie absence de demande. Ne mets pas quantity=0 pour ce seul silence ; explique le doute et estime sur le rythme habituel d'avant l'anomalie.
  - trendCategory="VOLATILE" : ventes trop irrégulières pour une tendance fiable — reste modéré sur l'ajustement.
  - Sinon (pas d'anomalie, trend renseigné) : signal de confirmation à combiner avec l'étape 1.

ÉTAPE 1 — Analyse dailyHistory ([{date, quantity}]) jour par jour, chronologiquement : tendance (derniers jours au-dessus/en dessous de la moyenne ?), accélération/ralentissement, pic isolé (promo, événement) à ne pas extrapoler vs hausse/baisse soutenue sur plusieurs jours. Évalue le RECUL disponible : une hausse sur seulement 2-3 jours d'un historique court est un signal fragile (pic, erreur de caisse) — ajustement modéré seulement, dis-le dans reasoning, plutôt que de projeter le dernier rythme comme acquis. Une tendance sur longue période, ou confirmée par seasonalityDeviationPct, mérite plus de confiance qu'une hausse des tout derniers jours seuls.

ÉTAPE 2 — Forme ta propre estimation de la demande à venir, en te basant sur le rythme récent plutôt que la seule moyenne globale quand une tendance nette se dégage.

ÉTAPE 3 — systemSuggestedQuantity = calcul déterministe (vente moy. hebdo × (1+safetyStockRatio), ramené à receptionLeadTimeDays, moins stock actuel et commandes en cours) : une base de référence, PAS la réponse attendue. Compare à ton estimation (étape 2). Autres signaux de fiabilité : seasonalityDeviationPct (écart vs l'an dernier — une hausse confirmée par la saisonnalité renforce la confiance), forecastMethod ("flat"=moyenne plate peu fiable sur historique court, "smoothed"=plus robuste), systemConfidenceScore (0-100, bas = base peu fiable, ton jugement compte plus).

ÉTAPE 4 — Si hasRecentOrder=true : une commande fournisseur a déjà été passée (≤7j), hors de cette analyse (recentOrderReference, recentOrderDate, recentOrderCount). Elle a déjà fait tomber systemSuggestedQuantity à 0 ou proche — CE N'EST PAS UNE DÉCISION FINALE. Détermine toi-même si elle suffit, en comparant : quantité déjà commandée, ancienneté (recentOrderDate vs aujourd'hui), ventes réalisées depuis dans dailyHistory, stock actuel, et ton estimation (étape 2) :
  - Si elle suffit : quantity=0, explique pourquoi (quantité déjà en route cohérente avec les ventes récentes).
  - Si elle ne suffit pas (ventes plus fortes que prévu, tendance haussière, stock qui s'épuise plus vite que l'arrivée) : quantity = le SUPPLÉMENT nécessaire (pas le besoin total — quantityIfIgnoringRecentOrder donne le besoin brut pour comparaison). Sois prudent : une commande supplémentaire s'ajoute à une déjà en route — vérifie que la hausse est établie sur plusieurs jours consécutifs (pas seulement les tout derniers), sous peine de faire commander en double une demande qui pourrait retomber.
Si hasRecentOrder=false, ignore cette étape.

ÉTAPE 5 — Quantité finale, en tenant compte aussi de currentStock, daysUntilStockout (risque de rupture), currentOrderedQuantity (déjà en commande, à ne pas dupliquer), et revenueSharePct (forte part de CA = couverture plus prudente en cas d'incertitude). Ta décision d'analyste, pas un recopiage automatique de systemSuggestedQuantity : ajuste à la hausse comme à la baisse si la demande réelle diverge de la formule, sans biais systématique. Arrondis au multiple de orderingUnit le plus proche.

Articles (JSON) :
{{articles}}

ÉTAPE 6 — Choisis l'action qui résume le mieux ta décision, EXACTEMENT une de ces valeurs :
  - "ORDER_NOW" : commander la quantité indiquée, situation normale.
  - "ORDER_MORE" : commande en cours (hasRecentOrder=true) insuffisante, quantity = le SUPPLÉMENT (étape 4).
  - "ORDER_LESS" : systemSuggestedQuantity réduit car ton analyse indique un besoin réel plus faible (baisse confirmée, saisonnalité défavorable...).
  - "WAIT" : quantity=0, commande en cours ou stock actuel suffisent largement.
  - "STOCK_RISK" : rupture proche ou déjà là (daysUntilStockout bas/nul) malgré la quantité proposée.
  - "OVERSTOCK" : stock actuel dépasse largement le besoin réel, quantity=0 même si systemSuggestedQuantity est positif.
  - "DEMAND_INCREASE" : tendance de fond haussière, justifie une quantité au-dessus de systemSuggestedQuantity.
  - "DEMAND_DECREASE" : tendance de fond baissière, justifie une quantité en dessous de systemSuggestedQuantity.
  - "ANOMALY" : signal anormal (anomalies non vide, ou incohérence identifiée) rend la décision incertaine — quantité prudente, explique le doute.
  - "VERIFY_STOCK" : stock RPOS incohérent avec les ventes observées (ex: STOCK_INCONSISTENCY) — recommande une vérification physique plutôt qu'une décision ferme.
  - "NO_ACTION" : rien à signaler, situation stable, quantity proche de 0 par absence de besoin réel (pas par anomalie).
Une seule action par article, celle qui correspond réellement à ta décision — jamais "ORDER_NOW" par défaut si un autre type décrit mieux la situation.

IMPORTANT — ton du champ "reasoning" : lu par du personnel de magasin (rayonnistes, chefs de rayon), jamais par des informaticiens. Bannis tout jargon ("jours d'autonomie", "couverture", "stock de sécurité", "lissage", "tendance VOLATILE/STABLE", "confiance", "seasonalityDeviationPct", ou tout nom de champ technique) — reformule en langage courant et concret : "5,5 jours d'autonomie" → "il reste du stock pour environ 5-6 jours au rythme actuel" ; "tendance en hausse de 33%" → "les ventes ont augmenté ces derniers jours" ; "confiance faible (32/100)" → "cette estimation est incertaine, peu d'historique disponible". Compréhensible sans rien connaître du système vaut mieux que précis mais opaque.

Réponds UNIQUEMENT avec un tableau JSON valide, sans texte autour, au format exact :
[{"ean": "...", "quantity": 0, "action": "ORDER_NOW", "reasoning": "2-4 phrases en français courant (voir consigne de ton ci-dessus) : statut du magasin s'il n'est pas ACTIVE et son influence, tendance observée, comparaison à systemSuggestedQuantity, analyse de la commande récente si hasRecentOrder=true, décision finale"}]
Une entrée par article fourni, dans le même ordre. quantity entier positif ou nul, multiple de orderingUnit. action EXACTEMENT une des valeurs listées à l'étape 6, jamais une autre chaîne.`,
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
  [KEYS.PROPOSAL_REMINDER_ENABLED]: () => 'true',
  [KEYS.END_OF_DAY_VALIDATION_RECAP_ENABLED]: () => 'true',
  [KEYS.IMPROVEMENTS_ENABLED]: () => 'true',
  // Actif par défaut (coût nul en soi, juste une lecture d'AiUsageLog + email si dépassement) —
  // contrairement à AI_QUANTITY_ADJUSTMENT_ENABLED ci-dessous, ce job ne consomme pas de tokens.
  [KEYS.TOKEN_USAGE_ALERT_ENABLED]: () => 'true',
  // 7h10, juste après l'évaluation des prédictions (7h) et avant le chien de garde améliorations IA
  // (7h30) — assez tôt pour alerter sur la conso de la veille avant le début d'activité du jour.
  [KEYS.TOKEN_USAGE_ALERT_CRON]: () => process.env.TOKEN_USAGE_ALERT_CRON || '10 7 * * *',
  // Seuil arbitraire de départ (demande du 12/10/2026, suite à un pic réel de 36,9M tokens/jour) :
  // largement au-dessus d'une journée normale observée (quelques centaines de milliers de tokens),
  // mais bien en dessous d'un pic comme celui du 25/09 — à ajuster depuis Paramètres selon l'usage
  // réel mesuré une fois ai-forecast-batch repassé à son coût normal.
  [KEYS.TOKEN_USAGE_ALERT_THRESHOLD_TOKENS]: () => '2000000',
  // Off par défaut (contrairement aux autres jobs) : impact fort sur le comportement et le coût,
  // à activer explicitement plutôt que par défaut au premier déploiement.
  [KEYS.AI_QUANTITY_ADJUSTMENT_ENABLED]: () => 'false',
  [KEYS.CHATBOT_LLM_FALLBACK_ENABLED]: () => 'false',
  [KEYS.CHATBOT_FEATURE_TRACKING_ENABLED]: () => 'false',
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
  // Gardée volontairement courte (boutons cliquables affichés en flex-wrap dans l'Assistant IA,
  // cf. AiAssistant.tsx — une trop longue liste rendrait cette zone illisible) mais élargie le
  // 27/09/2026 pour représenter au moins un exemple de chaque grande famille de questions (CA,
  // rayons, stock, DLV, fiche article, commandes, IA) plutôt que de sur-représenter certaines
  // familles (ruptures/surstock) au détriment d'autres jamais suggérées (fiche article, DLV, rayon).
  [KEYS.CHATBOT_SUGGESTED_QUESTIONS]: () => [
    'Quel est le CA du magasin aujourd\'hui ?',
    'Quels articles risquent d\'être en rupture ?',
    'Quels articles sont en surstock ?',
    'Quel rayon vend le mieux ?',
    'Quel est le prix de cet article ?',
    'Quels articles sont en DLV ?',
    'Quoi commander aujourd\'hui ?',
    'Quelle est la précision de l\'IA sur ce magasin ?',
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
  // Source unique : chatbotIntentRulesDefault.js (cf. son en-tête — fusionné le 06/10/2026, cette
  // liste dupliquait auparavant FALLBACK_INTENT_RULES de chatbotService.js sans jamais être
  // synchronisée, ce qui rendait silencieusement inopérant tout mot-clé ajouté seulement là-bas).
  [KEYS.CHATBOT_INTENT_RULES]: () => JSON.stringify(FALLBACK_INTENT_RULES),
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

/**
 * Supprime la ligne en base pour `key` : getValue() retombe alors automatiquement sur
 * ENV_FALLBACK[key] (la valeur par défaut à jour, codée en dur) au lieu d'une valeur figée au
 * moment où elle avait été enregistrée. Ajouté le 06/10/2026 pour un vrai bouton "Réinitialiser"
 * — avant, "réinitialiser" réenregistrait une COPIE séparée et obsolète du frontend
 * (AiPromptCards.tsx, DEFAULT_INTENT_RULES), elle-même désynchronisée du code backend (bug
 * constaté en prod : "quel rayon vend le mieux ?" répondait sur le dernier article consulté car
 * cette copie frontend plaçait encore getArticleDetails avant getParetoArticles, un ordre corrigé
 * côté backend depuis le 27/09/2026 mais jamais répercuté côté UI). Ne fait rien si la ligne
 * n'existe pas déjà (idempotent).
 */
async function resetToDefault(key) {
  await prisma.systemConfig.deleteMany({ where: { key } });
}

module.exports = { KEYS, SENSITIVE_KEYS, getValue, setValue, getAll, resetToDefault };
