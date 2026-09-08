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
  // Interrupteur marche/arrêt par job planifié, indépendant de son expression cron : à OFF, le job
  // ne se déclenche plus du tout jusqu'à réactivation (au lieu de devoir vider/deviner une
  // expression cron qui ne se déclenche jamais pour le "désactiver").
  NIGHTLY_PROPOSAL_ENABLED: 'NIGHTLY_PROPOSAL_ENABLED',
  RECEPTION_SYNC_ENABLED: 'RECEPTION_SYNC_ENABLED',
  SALES_SYNC_ENABLED: 'SALES_SYNC_ENABLED',
  SHOPS_SYNC_ENABLED: 'SHOPS_SYNC_ENABLED',
  DAILY_REVIEW_ENABLED: 'DAILY_REVIEW_ENABLED',
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
  // 10% par défaut (CAHIER_DES_CHARGES.md §16, exemple donné) : en dessous, le changement de
  // quantité totale proposée n'est pas jugé assez significatif pour justifier une nouvelle révision.
  [KEYS.REVISION_CHANGE_THRESHOLD]: () => '0.10',
  // Tous les jobs sont actifs par défaut (comportement historique, avant l'ajout de ces
  // interrupteurs) : seul un changement explicite depuis Paramètres les désactive.
  [KEYS.NIGHTLY_PROPOSAL_ENABLED]: () => 'true',
  [KEYS.RECEPTION_SYNC_ENABLED]: () => 'true',
  [KEYS.SALES_SYNC_ENABLED]: () => 'true',
  [KEYS.SHOPS_SYNC_ENABLED]: () => 'true',
  [KEYS.DAILY_REVIEW_ENABLED]: () => 'true',
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
