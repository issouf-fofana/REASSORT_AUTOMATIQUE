// Agrège JOB_REGISTRY (jobRegistry.js) + JobRun (jobHealthService.js) + la configuration cron réelle
// (systemConfigService) pour l'interface d'administration des jobs — un seul endroit qui croise "quels
// jobs existent", "sont-ils activés et à quelle fréquence" et "qu'ont-ils fait récemment", évitant à
// chaque route de refaire ce travail. Créé le 26/10/2026.
const parser = require('cron-parser');
const prisma = require('../utils/prisma');
const systemConfig = require('../services/systemConfigService');
const { JOB_REGISTRY } = require('../jobs/jobRegistry');
const { getLatestRunsByJob, getRecentRuns, DEGRADED_THRESHOLD } = require('./jobHealthService');

/** Prochaine date d'exécution pour une expression cron, ou null si invalide. */
function computeNextRun(cronExpression) {
  try {
    const interval = parser.parseExpression(cronExpression, { tz: process.env.TZ || 'UTC' });
    return interval.next().toDate();
  } catch {
    return null;
  }
}

/** 'ok' | 'error' | 'degraded' (≥ DEGRADED_THRESHOLD échecs consécutifs les plus récents) | 'never_run'. */
async function computeHealthStatus(jobName, lastRun) {
  if (!lastRun) return 'never_run';
  if (lastRun.status === 'running') return 'running';
  if (lastRun.status === 'success') return 'ok';

  const recent = await getRecentRuns(jobName, DEGRADED_THRESHOLD);
  const allFailed = recent.length === DEGRADED_THRESHOLD && recent.every((r) => r.status === 'error');
  return allFailed ? 'degraded' : 'error';
}

/** Vue liste pour le tableau de bord : un résumé par job (statut, dernière/prochaine exécution, fréquence). */
async function listJobsOverview() {
  const latestByJob = await getLatestRunsByJob();
  const latestMap = new Map(latestByJob.map((r) => [r.job_name, r]));

  const results = [];
  for (const meta of JOB_REGISTRY) {
    const [cronExpression, enabledValue] = await Promise.all([
      systemConfig.getValue(meta.cronKey),
      systemConfig.getValue(meta.enabledKey),
    ]);
    const enabled = enabledValue !== 'false';
    const lastRunRow = latestMap.get(meta.jobName) || null;
    const lastRun = lastRunRow
      ? {
          id: lastRunRow.id,
          status: lastRunRow.status,
          startedAt: lastRunRow.started_at,
          finishedAt: lastRunRow.finished_at,
          durationMs: lastRunRow.duration_ms,
          errorMessage: lastRunRow.error_message,
          triggeredBy: lastRunRow.triggered_by,
        }
      : null;

    const healthStatus = await computeHealthStatus(meta.jobName, lastRun);

    results.push({
      jobName: meta.jobName,
      label: meta.label,
      enabled,
      cronExpression,
      nextRunAt: enabled ? computeNextRun(cronExpression) : null,
      healthStatus,
      lastRun,
    });
  }
  return results;
}

/** Détail d'un job : métadonnées + historique paginé des exécutions. */
async function getJobDetail(jobName, { page = 1, pageSize = 20 } = {}) {
  const meta = JOB_REGISTRY.find((j) => j.jobName === jobName);
  if (!meta) return null;

  const [cronExpression, enabledValue, total, runs] = await Promise.all([
    systemConfig.getValue(meta.cronKey),
    systemConfig.getValue(meta.enabledKey),
    prisma.jobRun.count({ where: { jobName } }),
    prisma.jobRun.findMany({
      where: { jobName },
      orderBy: { startedAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);
  const enabled = enabledValue !== 'false';

  return {
    jobName: meta.jobName,
    label: meta.label,
    enabled,
    cronExpression,
    nextRunAt: enabled ? computeNextRun(cronExpression) : null,
    runs,
    pagination: { page, pageSize, total },
  };
}

/** Une exécution précise, avec ses logs complets. */
async function getRunDetail(runId) {
  return prisma.jobRun.findUnique({ where: { id: runId } });
}

module.exports = { listJobsOverview, getJobDetail, getRunDetail, computeNextRun };
