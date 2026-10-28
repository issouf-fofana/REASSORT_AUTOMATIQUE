/**
 * Suivi réel des exécutions de jobs planifiés (cronManager.js) — persiste chaque exécution dans la
 * table JobRun (statut 'running' au démarrage, puis 'success'/'error' à la fin, avec durée et logs),
 * au lieu de l'ancien jobHealthService qui n'écrivait qu'un seul statut "dernière exécution" par job
 * dans SystemConfig (pas d'historique, pas de "en cours", pas de durée, pas de logs). Réécrit le
 * 26/10/2026 pour l'interface d'administration des jobs demandée explicitement ("données réelles,
 * pas simulées... logs persistés pour rester consultables après la fin d'une tâche ou un redémarrage
 * du serveur").
 *
 * trackJobRun(jobName, fn) garde la même signature qu'avant (appelée telle quelle par
 * cronManager.js pour chacun des 26 jobs) — fn reçoit désormais un `logger` optionnel que les jobs
 * peuvent utiliser pour publier leur progression ; les jobs qui ne l'utilisent pas continuent de
 * fonctionner sans rien changer.
 */
const prisma = require('../utils/prisma');

// Nombre d'exécutions conservées par job — purge immédiate après chaque fin d'exécution plutôt
// qu'un job de nettoyage séparé, pour ne jamais laisser grossir job_runs indéfiniment (jobs les plus
// fréquents : toutes les 10-15 min, soit ~100-150 lignes/jour/job).
const MAX_RUNS_PER_JOB = 200;

// Au-delà de ce nombre d'échecs consécutifs (dernières exécutions, triées par date), le job est
// considéré en état dégradé — distingue un raté isolé (réseau/RPOS temporaire, déjà géré par les
// retries internes à rposClient.js) d'une vraie panne qui persiste.
const DEGRADED_THRESHOLD = 3;

/** Crée l'enregistrement 'running' et renvoie son id + un logger qui accumule des lignes dans logs. */
async function startJobRun(jobName, triggeredBy = 'cron') {
  const run = await prisma.jobRun.create({
    data: { jobName, status: 'running', triggeredBy },
    select: { id: true },
  });

  const lines = [];
  const logger = {
    log(message) {
      const line = `[${new Date().toISOString()}] ${message}`;
      lines.push(line);
      // Best-effort, jamais bloquant pour le job lui-même : un log raté ne doit jamais faire
      // échouer l'exécution métier qu'il décrit.
      prisma.jobRun
        .update({ where: { id: run.id }, data: { logs: lines.join('\n') } })
        .catch(() => {});
    },
    // shopResult (ajouté le 28/10/2026, demande explicite : "je pourrai voir quel magasin il y a eu
    // erreur lors de l'exécution de la tâche") — un job multi-magasins appelle ceci UNE FOIS PAR
    // MAGASIN dès qu'il a fini de le traiter (jamais en bloc à la fin de toute l'exécution), pour que
    // le détail reste visible même si le job plante en cours de route sur un magasin suivant.
    // Best-effort comme log() ci-dessus : un échec d'écriture du détail ne doit jamais faire échouer
    // le job lui-même.
    shopResult({ rposShopId, shopLabel, status = 'success', detail, errorMessage: shopError, startedAt, finishedAt }) {
      prisma.jobRunShopResult
        .create({
          data: {
            jobRunId: run.id,
            rposShopId: String(rposShopId),
            shopLabel: shopLabel || null,
            status,
            detail: detail || null,
            errorMessage: shopError || null,
            startedAt: startedAt || new Date(),
            finishedAt: finishedAt || new Date(),
          },
        })
        .catch(() => {});
    },
  };

  return { runId: run.id, logger };
}

async function finishJobRun(runId, status, errorMessage) {
  const run = await prisma.jobRun.findUnique({ where: { id: runId }, select: { startedAt: true } });
  const finishedAt = new Date();
  const durationMs = run ? finishedAt.getTime() - run.startedAt.getTime() : null;

  await prisma.jobRun.update({
    where: { id: runId },
    data: { status, finishedAt, durationMs, errorMessage: errorMessage || null },
  });
}

/** Supprime les exécutions les plus anciennes au-delà de MAX_RUNS_PER_JOB pour ce job. */
async function pruneOldRuns(jobName) {
  const toKeep = await prisma.jobRun.findMany({
    where: { jobName },
    orderBy: { startedAt: 'desc' },
    skip: MAX_RUNS_PER_JOB,
    select: { id: true },
    take: 500, // borne défensive, jamais censé dépasser en pratique vu la cadence des jobs
  });
  if (toKeep.length === 0) return;
  await prisma.jobRun.deleteMany({ where: { id: { in: toKeep.map((r) => r.id) } } });
}

/** Enveloppe un job planifié : enregistre une exécution complète (running → success/error) avec
 * durée, erreur et logs de progression. `fn` est appelée avec un logger optionnel (fn(logger)). */
async function trackJobRun(jobName, fn, triggeredBy = 'cron') {
  const { runId, logger } = await startJobRun(jobName, triggeredBy);
  try {
    await fn(logger);
    await finishJobRun(runId, 'success');
  } catch (err) {
    await finishJobRun(runId, 'error', err.message);
    throw err;
  } finally {
    pruneOldRuns(jobName).catch(() => {});
  }
}

/** Dernière exécution connue de chaque job ayant au moins une entrée en base, groupées par jobName. */
async function getLatestRunsByJob() {
  const rows = await prisma.$queryRaw`
    SELECT DISTINCT ON (job_name) job_name, id, status, started_at, finished_at, duration_ms, error_message, triggered_by
    FROM job_runs
    ORDER BY job_name, started_at DESC
  `;
  return rows;
}

/** Dernières exécutions d'un job (les plus récentes en premier), pour calculer l'état dégradé et
 * afficher un historique rapide sans paginer. */
async function getRecentRuns(jobName, limit = DEGRADED_THRESHOLD) {
  return prisma.jobRun.findMany({
    where: { jobName },
    orderBy: { startedAt: 'desc' },
    take: limit,
    select: { status: true },
  });
}

/** Compat improvementService.js (détecteur JOB_HEALTH) : une ligne par job connu avec son dernier
 * statut + nombre d'échecs consécutifs les plus récents, même forme que l'ancien jobHealthService
 * (SystemConfig) avant sa réécriture sur JobRun le 26/10/2026. */
async function getJobsHealth() {
  const { JOB_REGISTRY } = require('../jobs/jobRegistry');
  const latestByJob = await getLatestRunsByJob();
  const latestMap = new Map(latestByJob.map((r) => [r.job_name, r]));

  const results = [];
  for (const meta of JOB_REGISTRY) {
    const last = latestMap.get(meta.jobName);
    if (!last) continue; // jamais exécuté : rien à signaler ici (cohérent avec l'ancien comportement, pas de ligne tant qu'aucune exécution n'a eu lieu)

    const recent = await getRecentRuns(meta.jobName, DEGRADED_THRESHOLD);
    const consecutiveFailures = recent.every((r) => r.status === 'error')
      ? recent.filter((r) => r.status === 'error').length
      : 0;
    const status = last.status === 'running' ? 'ok' : last.status === 'success' ? 'ok' : consecutiveFailures >= DEGRADED_THRESHOLD ? 'degraded' : 'error';

    results.push({
      jobName: meta.jobName,
      status,
      lastRunAt: last.started_at,
      consecutiveFailures,
      lastError: last.error_message,
    });
  }
  return results;
}

module.exports = {
  trackJobRun,
  startJobRun,
  finishJobRun,
  getLatestRunsByJob,
  getRecentRuns,
  getJobsHealth,
  DEGRADED_THRESHOLD,
};
