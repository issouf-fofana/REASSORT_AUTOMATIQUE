import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../../shared/api/client';

interface LastRun {
  id: string;
  status: 'running' | 'success' | 'error';
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  triggeredBy: 'cron' | 'startup' | 'manual';
}

interface JobOverview {
  jobName: string;
  label: string;
  enabled: boolean;
  cronExpression: string;
  nextRunAt: string | null;
  healthStatus: 'ok' | 'error' | 'degraded' | 'running' | 'never_run';
  lastRun: LastRun | null;
}

const STATUS_META: Record<JobOverview['healthStatus'], { label: string; badge: string; icon: string }> = {
  ok: { label: 'OK', badge: 'bg-success-subtle text-success', icon: 'solar:check-circle-bold-duotone' },
  running: { label: 'En cours', badge: 'bg-info-subtle text-info', icon: 'solar:refresh-bold-duotone' },
  error: { label: 'Erreur', badge: 'bg-warning-subtle text-warning', icon: 'solar:danger-triangle-bold-duotone' },
  degraded: { label: 'Dégradé', badge: 'bg-danger-subtle text-danger', icon: 'solar:danger-circle-bold-duotone' },
  never_run: { label: 'Jamais exécuté', badge: 'bg-secondary-subtle text-secondary', icon: 'solar:question-circle-bold-duotone' },
};

function fmtDate(iso?: string | null): string {
  return iso ? new Date(iso).toLocaleString('fr-FR') : '—';
}

function fmtDuration(ms?: number | null): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  return `${m} min ${rest}s`;
}

/** Tableau de bord global de supervision des 26 jobs planifiés (cronManager.js) — demande explicite
 * du 26/10/2026 : "une interface d'administration centralisée" avec statut, logs, suivi temps réel,
 * historique, diagnostic d'erreur et prochaine exécution, toutes données réelles (pas simulées). */
export function JobsAdminDashboard() {
  const [jobs, setJobs] = useState<JobOverview[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | JobOverview['healthStatus']>('all');
  const [search, setSearch] = useState('');
  const [runningJob, setRunningJob] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function load() {
    try {
      const data = await apiFetch<JobOverview[]>('/reassort/jobs-admin');
      setJobs(data);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    load();
    // Rafraîchissement automatique toutes les 10s pour refléter les exécutions en cours
    // (statut 'running') sans que l'utilisateur ait à cliquer "Actualiser" en boucle.
    pollRef.current = setInterval(load, 10000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  async function runNow(jobName: string) {
    setRunningJob(jobName);
    try {
      await apiFetch(`/reassort/jobs-admin/${jobName}/run`, { method: 'POST' });
      window.reassortToast('Exécution lancée.', 'success');
      await load();
    } catch (err) {
      window.reassortToast('Erreur : ' + (err as Error).message, 'error');
    } finally {
      setRunningJob(null);
    }
  }

  const filtered = (jobs || []).filter((j) => {
    if (statusFilter !== 'all' && j.healthStatus !== statusFilter) return false;
    if (search && !j.label.toLowerCase().includes(search.toLowerCase()) && !j.jobName.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const counts = {
    all: jobs?.length || 0,
    ok: jobs?.filter((j) => j.healthStatus === 'ok').length || 0,
    running: jobs?.filter((j) => j.healthStatus === 'running').length || 0,
    error: jobs?.filter((j) => j.healthStatus === 'error').length || 0,
    degraded: jobs?.filter((j) => j.healthStatus === 'degraded').length || 0,
    never_run: jobs?.filter((j) => j.healthStatus === 'never_run').length || 0,
  };

  return (
    <div>
      <div className="d-flex justify-content-between align-items-start mb-3 flex-wrap gap-2">
        <div>
          <h1 className="h3 mb-1">Supervision des tâches planifiées</h1>
          <p className="text-muted small mb-0">
            {jobs ? `${jobs.length} tâche(s) planifiée(s)` : 'Chargement...'} — données réelles issues des exécutions effectives, rafraîchi automatiquement.
          </p>
        </div>
        <button type="button" className="btn btn-sm btn-outline-secondary" onClick={load}>
          <iconify-icon icon="solar:refresh-bold-duotone" className="align-middle"></iconify-icon> Actualiser
        </button>
      </div>

      {error && <div className="alert alert-danger">{error}</div>}

      <div className="d-flex gap-2 flex-wrap mb-3">
        {(['all', 'ok', 'running', 'degraded', 'error', 'never_run'] as const).map((key) => {
          const meta = key === 'all' ? { label: 'Toutes', badge: 'bg-light text-dark' } : STATUS_META[key];
          return (
            <button
              key={key}
              type="button"
              className={`btn btn-sm ${statusFilter === key ? 'btn-primary' : 'btn-outline-secondary'}`}
              onClick={() => setStatusFilter(key)}
            >
              {meta.label} <span className="badge bg-white text-dark ms-1">{counts[key]}</span>
            </button>
          );
        })}
        <input
          type="text"
          className="form-control form-control-sm ms-auto"
          style={{ maxWidth: 260 }}
          placeholder="Rechercher une tâche..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {!jobs && !error && <div className="text-center text-muted py-4">Chargement...</div>}

      {jobs && (
        <div className="table-responsive">
          <table className="table table-sm align-middle">
            <thead>
              <tr>
                <th>Tâche</th>
                <th>Statut</th>
                <th>Dernière exécution</th>
                <th>Durée</th>
                <th>Prochaine exécution</th>
                <th>Fréquence</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((j) => {
                const meta = STATUS_META[j.healthStatus];
                return (
                  <tr key={j.jobName}>
                    <td>
                      <Link to={`/jobs-admin/${j.jobName}`} className="fw-semibold text-decoration-none">
                        {j.label}
                      </Link>
                      {!j.enabled && <span className="badge bg-secondary-subtle text-secondary ms-2">Désactivé</span>}
                    </td>
                    <td>
                      <span className={`badge ${meta.badge}`}>
                        <iconify-icon icon={meta.icon} className="align-middle me-1"></iconify-icon>
                        {meta.label}
                      </span>
                    </td>
                    <td className="small text-muted">{fmtDate(j.lastRun?.startedAt)}</td>
                    <td className="small">{fmtDuration(j.lastRun?.durationMs)}</td>
                    <td className="small text-muted">{fmtDate(j.nextRunAt)}</td>
                    <td className="small"><code>{j.cronExpression}</code></td>
                    <td className="text-end">
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-secondary"
                        disabled={runningJob === j.jobName || j.healthStatus === 'running'}
                        onClick={() => runNow(j.jobName)}
                      >
                        {runningJob === j.jobName ? '...' : 'Exécuter'}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-center text-muted py-3">Aucune tâche ne correspond à ce filtre.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
