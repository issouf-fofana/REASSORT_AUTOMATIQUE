/**
 * Suivi léger de la santé des jobs planifiés (readme production-readiness : les échecs de cron
 * n'étaient auparavant que loggés en console, sans aucune visibilité ni alerte si un job échoue
 * plusieurs fois de suite). Persiste dans SystemConfig (clé-valeur générique déjà existant) le
 * dernier statut et le nombre d'échecs consécutifs par job, exposé via une route admin
 * (GET /api/reassort/system-config/jobs-health) pour un contrôle visuel sans creuser les logs.
 *
 * Pas d'envoi d'alerte externe (email/Slack) pour l'instant, faute de service déjà configuré dans
 * ce projet — le compteur d'échecs consécutifs est la donnée qu'un futur webhook consommerait.
 */
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const JOB_HEALTH_KEY_PREFIX = 'JOB_HEALTH_';

// Au-delà de ce nombre d'échecs consécutifs, le job est considéré en état dégradé (visible dans
// le statut renvoyé par getJobsHealth), pour distinguer un raté isolé (réseau/RPOS temporaire,
// déjà géré par les retries internes à rposClient.js) d'une vraie panne qui persiste.
const DEGRADED_THRESHOLD = 3;

async function recordJobSuccess(jobName) {
  await prisma.systemConfig.upsert({
    where: { key: JOB_HEALTH_KEY_PREFIX + jobName },
    update: { value: JSON.stringify({ status: 'ok', lastRunAt: new Date().toISOString(), consecutiveFailures: 0 }) },
    create: { key: JOB_HEALTH_KEY_PREFIX + jobName, value: JSON.stringify({ status: 'ok', lastRunAt: new Date().toISOString(), consecutiveFailures: 0 }) },
  });
}

async function recordJobFailure(jobName, errorMessage) {
  const existing = await prisma.systemConfig.findUnique({ where: { key: JOB_HEALTH_KEY_PREFIX + jobName } });
  const previous = existing ? JSON.parse(existing.value) : { consecutiveFailures: 0 };
  const consecutiveFailures = (previous.consecutiveFailures || 0) + 1;

  const data = {
    status: consecutiveFailures >= DEGRADED_THRESHOLD ? 'degraded' : 'error',
    lastRunAt: new Date().toISOString(),
    consecutiveFailures,
    lastError: errorMessage,
  };

  await prisma.systemConfig.upsert({
    where: { key: JOB_HEALTH_KEY_PREFIX + jobName },
    update: { value: JSON.stringify(data) },
    create: { key: JOB_HEALTH_KEY_PREFIX + jobName, value: JSON.stringify(data) },
  });

  if (consecutiveFailures >= DEGRADED_THRESHOLD) {
    console.error(`[jobHealthService] ⚠️ Job "${jobName}" en échec ${consecutiveFailures} fois de suite — vérification manuelle recommandée.`);
  }
}

/** Enveloppe un job planifié : enregistre succès/échec sans changer son comportement (relance déjà gérée par cronManager). */
async function trackJobRun(jobName, fn) {
  try {
    await fn();
    await recordJobSuccess(jobName);
  } catch (err) {
    await recordJobFailure(jobName, err.message);
    throw err;
  }
}

async function getJobsHealth() {
  const rows = await prisma.systemConfig.findMany({
    where: { key: { startsWith: JOB_HEALTH_KEY_PREFIX } },
  });
  return rows.map((row) => ({
    jobName: row.key.slice(JOB_HEALTH_KEY_PREFIX.length),
    ...JSON.parse(row.value),
  }));
}

module.exports = { trackJobRun, getJobsHealth, DEGRADED_THRESHOLD };
