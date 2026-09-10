const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

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
  // Réajustement quotidien continu (CAHIER_DES_CHARGES.md §15-16, étape 3) : noms alignés sur la
  // configuration recommandée §54 (DAILY_REVIEW_CRON, REVISION_CHANGE_THRESHOLD).
  DAILY_REVIEW_CRON: 'DAILY_REVIEW_CRON',
  REVISION_CHANGE_THRESHOLD: 'REVISION_CHANGE_THRESHOLD',
  // Évaluation des prédictions passées (CAHIER_DES_CHARGES.md §22, étape 5) : compare prédiction
  // et réalité une fois la période cible terminée.
  PREDICTION_OUTCOME_CRON: 'PREDICTION_OUTCOME_CRON',
  // Interrupteur marche/arrêt par job planifié, indépendant de son expression cron : à OFF, le job
  // ne se déclenche plus du tout jusqu'à réactivation (au lieu de devoir vider/deviner une
  // expression cron qui ne se déclenche jamais pour le "désactiver").
  NIGHTLY_PROPOSAL_ENABLED: 'NIGHTLY_PROPOSAL_ENABLED',
  RECEPTION_SYNC_ENABLED: 'RECEPTION_SYNC_ENABLED',
  SALES_SYNC_ENABLED: 'SALES_SYNC_ENABLED',
  SHOPS_SYNC_ENABLED: 'SHOPS_SYNC_ENABLED',
  DAILY_REVIEW_ENABLED: 'DAILY_REVIEW_ENABLED',
  PREDICTION_OUTCOME_ENABLED: 'PREDICTION_OUTCOME_ENABLED',
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
  [KEYS.AI_ANALYSIS_PROMPT_TEMPLATE]: () => `Tu es un analyste de la demande pour un magasin de grande distribution ({{shopReference}} {{shopName}}).

Pour chaque article ci-dessous, procède dans cet ordre précis — n'inverse pas les étapes :

ÉTAPE 1 — Analyse l'évolution réelle des ventes. Regarde dailyHistory ([{date, quantity}]) jour par jour, dans l'ordre chronologique. Identifie toi-même : la tendance (les derniers jours sont-ils clairement au-dessus ou en dessous de la moyenne de la période ?), l'accélération ou le ralentissement, un éventuel pic isolé à ne pas extrapoler (promotion, événement ponctuel) par opposition à une hausse ou baisse soutenue sur plusieurs jours consécutifs.

ÉTAPE 2 — À partir de cette tendance réelle, forme ta propre estimation de la demande attendue pour la période à venir (en te basant sur le rythme récent plutôt que sur la seule moyenne globale quand une tendance nette se dégage).

ÉTAPE 3 — Regarde ensuite systemSuggestedQuantity : c'est le résultat d'un calcul déterministe (vente moyenne hebdomadaire × (1 + safetyStockRatio) ramené au délai de réapprovisionnement receptionLeadTimeDays, moins stock actuel et commandes en cours) — une base de référence, PAS la réponse attendue. Compare-la à ton estimation de l'étape 2. D'autres signaux à prendre en compte pour juger de la fiabilité de cette base : seasonalityDeviationPct (écart vs l'an dernier, une hausse confirmée par la saisonnalité renforce la confiance dans une tendance haussière), forecastMethod ("flat" = moyenne plate peu fiable en cas d'historique court, "smoothed" = lissage plus robuste), systemConfidenceScore (0-100, plus il est bas moins la base est fiable et plus ton propre jugement compte).

ÉTAPE 4 — Décide de la quantité finale à commander, en tenant compte aussi de currentStock, daysUntilStockout (risque de rupture), currentOrderedQuantity (déjà en commande, à ne pas dupliquer), et revenueSharePct (les articles à forte part de CA méritent une couverture plus prudente en cas d'incertitude). Cette quantité finale doit être TA décision d'analyste, pas automatiquement systemSuggestedQuantity recopié : si l'évolution réelle des ventes montre clairement que la demande a changé par rapport à ce que la formule suppose, dis-le et ajuste en conséquence — à la hausse comme à la baisse, sans biais systématique dans un sens. Arrondis au multiple de orderingUnit le plus proche.

Articles (JSON) :
{{articles}}

Réponds UNIQUEMENT avec un tableau JSON valide, sans texte autour, au format exact :
[{"ean": "...", "quantity": 0, "reasoning": "2-3 phrases en français : la tendance observée dans l'historique, comment elle compare à systemSuggestedQuantity, et pourquoi tu confirmes ou ajustes le chiffre final"}]
Une entrée par article fourni, dans le même ordre. quantity doit être un entier positif ou nul, multiple de orderingUnit.`,
  // Tous les jobs sont actifs par défaut (comportement historique, avant l'ajout de ces
  // interrupteurs) : seul un changement explicite depuis Paramètres les désactive.
  [KEYS.NIGHTLY_PROPOSAL_ENABLED]: () => 'true',
  [KEYS.RECEPTION_SYNC_ENABLED]: () => 'true',
  [KEYS.SALES_SYNC_ENABLED]: () => 'true',
  [KEYS.SHOPS_SYNC_ENABLED]: () => 'true',
  [KEYS.DAILY_REVIEW_ENABLED]: () => 'true',
  [KEYS.PREDICTION_OUTCOME_ENABLED]: () => 'true',
  // Off par défaut (contrairement aux autres jobs) : impact fort sur le comportement et le coût,
  // à activer explicitement plutôt que par défaut au premier déploiement.
  [KEYS.AI_QUANTITY_ADJUSTMENT_ENABLED]: () => 'false',
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
