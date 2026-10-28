import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../shared/api/client';

export interface JobRunShopResult {
  id: string;
  rposShopId: string;
  shopLabel: string | null;
  status: 'success' | 'error' | 'skipped';
  detail: string | null;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface JobRun {
  id: string;
  jobName: string;
  status: 'running' | 'success' | 'error';
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  logs: string | null;
  triggeredBy: 'cron' | 'startup' | 'manual';
  shopResults?: JobRunShopResult[];
}

export interface JobDetail {
  jobName: string;
  label: string;
  enabled: boolean;
  cronExpression: string;
  nextRunAt: string | null;
  runs: JobRun[];
  pagination: { page: number; pageSize: number; total: number };
}

const STATUS_BADGE: Record<JobRun['status'], string> = {
  running: 'bg-info-subtle text-info',
  success: 'bg-success-subtle text-success',
  error: 'bg-danger-subtle text-danger',
};

const SHOP_STATUS_BADGE: Record<JobRunShopResult['status'], string> = {
  success: 'bg-success-subtle text-success',
  error: 'bg-danger-subtle text-danger',
  skipped: 'bg-secondary-subtle text-secondary',
};
const SHOP_STATUS_LABEL: Record<JobRunShopResult['status'], string> = {
  success: 'OK',
  error: 'Erreur',
  skipped: 'Ignoré',
};

const TRIGGER_LABEL: Record<JobRun['triggeredBy'], string> = {
  cron: 'Planifié',
  startup: 'Démarrage serveur',
  manual: 'Manuel',
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
  return `${m} min ${Math.round(s % 60)}s`;
}

/** Panneau logs d'une exécution précise — poll toutes les 2s tant que le statut est 'running' pour
 * un vrai suivi en temps réel, s'arrête dès que l'exécution se termine. */
function RunLogsPanel({ runId, onFinished }: { runId: string; onFinished: () => void }) {
  const [run, setRun] = useState<JobRun | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function cancelRun() {
    setCancelling(true);
    try {
      await apiFetch(`/reassort/jobs-admin/runs/${runId}/cancel`, { method: 'POST' });
      window.reassortToast(
        'Exécution annulée dans l\'historique — le traitement déjà lancé côté serveur peut continuer jusqu\'à sa fin naturelle.',
        'info',
      );
    } catch (err) {
      window.reassortToast('Erreur : ' + (err as Error).message, 'error');
    } finally {
      setCancelling(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await apiFetch<JobRun>(`/reassort/jobs-admin/runs/${runId}`);
        if (cancelled) return;
        setRun(data);
        if (data.status !== 'running' && pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          onFinished();
        }
      } catch {
        // échec silencieux : le panneau reste sur sa dernière valeur connue plutôt que de casser l'affichage
      }
    }
    load();
    pollRef.current = setInterval(load, 2000);
    return () => {
      cancelled = true;
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  if (!run) return <div className="text-muted small">Chargement...</div>;

  return (
    <div className="card">
      <div className="card-header d-flex justify-content-between align-items-center">
        <div>
          <span className={`badge ${STATUS_BADGE[run.status]} me-2`}>
            {run.status === 'running' ? 'En cours' : run.status === 'success' ? 'Terminé' : 'Erreur'}
          </span>
          <span className="small text-muted">
            Démarré le {fmtDate(run.startedAt)} — {TRIGGER_LABEL[run.triggeredBy]}
            {run.finishedAt && ` — durée ${fmtDuration(run.durationMs)}`}
          </span>
        </div>
        {run.status === 'running' && (
          <button type="button" className="btn btn-sm btn-outline-danger" disabled={cancelling} onClick={cancelRun}>
            {cancelling ? 'Arrêt...' : 'Arrêter'}
          </button>
        )}
      </div>
      <div className="card-body">
        {run.status === 'running' && (
          <div className="alert alert-light border small mb-3">
            <strong>À quoi ça sert :</strong> le bouton "Arrêter" marque cette exécution comme annulée dans l'historique.
            Le traitement déjà lancé côté serveur (ex: appels RPOS en cours) n'est pas interrompu et continue jusqu'à sa fin naturelle — utile pour nettoyer l'affichage d'une exécution bloquée, pas pour couper un envoi en cours.
          </div>
        )}
        {run.errorMessage && <div className="alert alert-danger small">{run.errorMessage}</div>}
        <pre
          className="small bg-dark text-light p-3 rounded mb-0"
          style={{ maxHeight: 360, overflowY: 'auto', whiteSpace: 'pre-wrap' }}
        >
          {run.logs || 'Aucun log de progression pour cette exécution.'}
        </pre>
        {run.shopResults && run.shopResults.length > 0 && (
          <ShopResultsTable results={run.shopResults} />
        )}
      </div>
    </div>
  );
}

/** Détail par magasin d'une exécution (ajouté le 28/10/2026, demande explicite : "je pourrai voir
 * quel magasin il y a eu erreur lors de l'exécution de la tâche") — seuls les jobs équipés de
 * logger.shopResult() côté backend remplissent cette liste ; un job non équipé n'affiche
 * simplement rien ici (shopResults vide), sans message d'erreur ni placeholder. */
function ShopResultsTable({ results }: { results: JobRunShopResult[] }) {
  const [showErrorsOnly, setShowErrorsOnly] = useState(false);
  const errorCount = results.filter((r) => r.status === 'error').length;
  const visible = showErrorsOnly ? results.filter((r) => r.status === 'error') : results;

  return (
    <div className="mt-3">
      <div className="d-flex justify-content-between align-items-center mb-2">
        <h6 className="mb-0">Détail par magasin ({results.length})</h6>
        {errorCount > 0 && (
          <div className="form-check form-switch mb-0">
            <input
              className="form-check-input"
              type="checkbox"
              role="switch"
              id="shop-results-errors-only"
              checked={showErrorsOnly}
              onChange={(e) => setShowErrorsOnly(e.target.checked)}
            />
            <label className="form-check-label small" htmlFor="shop-results-errors-only">
              Erreurs uniquement ({errorCount})
            </label>
          </div>
        )}
      </div>
      <div className="table-responsive" style={{ maxHeight: 300, overflowY: 'auto' }}>
        <table className="table table-sm align-middle mb-0">
          <thead>
            <tr>
              <th>Magasin</th>
              <th>Statut</th>
              <th>Détail</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.id}>
                <td className="small">{r.shopLabel || r.rposShopId}</td>
                <td>
                  <span className={`badge ${SHOP_STATUS_BADGE[r.status]}`}>{SHOP_STATUS_LABEL[r.status]}</span>
                </td>
                <td className="small text-muted">{r.status === 'error' ? (r.errorMessage || '—') : (r.detail || '—')}</td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={3} className="text-center text-muted py-2 small">Aucun magasin en erreur.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Éditeur de planification (fréquence cron + actif/inactif) d'un job — demande explicite du
 * 26/10/2026 : "est-ce que je peux modifier la tâche planifier aussi ? je dois avoir la possibilité
 * de faire tout ça", regroupé ici avec la supervision plutôt que de renvoyer vers Paramètres. */
function ScheduleEditor({ jobName, cronExpression, enabled, onSaved }: { jobName: string; cronExpression: string; enabled: boolean; onSaved: () => void }) {
  const [cronDraft, setCronDraft] = useState(cronExpression);
  const [enabledDraft, setEnabledDraft] = useState(enabled);
  const [saving, setSaving] = useState(false);

  useEffect(() => { setCronDraft(cronExpression); }, [cronExpression]);
  useEffect(() => { setEnabledDraft(enabled); }, [enabled]);

  const dirty = cronDraft !== cronExpression || enabledDraft !== enabled;

  async function save() {
    setSaving(true);
    try {
      await apiFetch(`/reassort/jobs-admin/${jobName}/schedule`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cronExpression: cronDraft, enabled: enabledDraft }),
      });
      window.reassortToast('Planification mise à jour.', 'success');
      await onSaved();
    } catch (err) {
      window.reassortToast('Erreur : ' + (err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card mb-3">
      <div className="card-header d-flex justify-content-between align-items-center">
        <h4 className="card-title mb-0">Planification</h4>
        <div className="form-check form-switch mb-0">
          <input
            className="form-check-input"
            type="checkbox"
            role="switch"
            id="schedule-enabled"
            checked={enabledDraft}
            onChange={(e) => setEnabledDraft(e.target.checked)}
          />
          <label className="form-check-label small" htmlFor="schedule-enabled">Actif</label>
        </div>
      </div>
      <div className="card-body">
        <label className="form-label small fw-semibold">Expression cron</label>
        <div className="d-flex gap-2 align-items-start flex-wrap">
          <input
            type="text"
            className="form-control form-control-sm"
            style={{ maxWidth: 220 }}
            value={cronDraft}
            onChange={(e) => setCronDraft(e.target.value)}
            placeholder="0 4 * * *"
          />
          <button type="button" className="btn btn-sm btn-primary" disabled={!dirty || saving} onClick={save}>
            {saving ? 'Enregistrement...' : 'Enregistrer'}
          </button>
        </div>
        <div className="form-text">
          Format standard cron : minute, heure, jour du mois, mois, jour de la semaine (* = tous). Ex : "0 4 * * *" = tous les jours à 4h00.
        </div>
      </div>
    </div>
  );
}

/** Contenu du détail d'un job (fréquence, prochaine exécution, historique paginé, logs d'une
 * exécution) — extrait de l'ancienne JobDetailPage.tsx le 28/10/2026 (demande explicite : "pour les
 * detail fait une vue quand je clique je dois voir les detail sur une fenette") pour être réutilisé
 * à la fois dans la modale (JobDetailModal.tsx, ouverte depuis le tableau) et dans la page dédiée
 * (JobDetailPage.tsx, conservée pour un lien direct /jobs-admin/:jobName partageable/rechargeable). */
export function JobDetailContent({ jobName }: { jobName: string }) {
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  async function load() {
    try {
      const data = await apiFetch<JobDetail>(`/reassort/jobs-admin/${jobName}?page=${page}&pageSize=20`);
      setDetail(data);
      setError(null);
      // Sélectionne automatiquement l'exécution en cours (s'il y en a une) au premier chargement,
      // pour que l'utilisateur voie immédiatement le suivi temps réel sans avoir à cliquer.
      if (!selectedRunId && data.runs[0]?.status === 'running') {
        setSelectedRunId(data.runs[0].id);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobName, page]);

  async function runNow() {
    setRunning(true);
    try {
      const res = await apiFetch<{ runId: string }>(`/reassort/jobs-admin/${jobName}/run`, { method: 'POST' });
      setSelectedRunId(res.runId);
      window.reassortToast('Exécution lancée.', 'success');
      await load();
    } catch (err) {
      window.reassortToast('Erreur : ' + (err as Error).message, 'error');
    } finally {
      setRunning(false);
    }
  }

  if (error) return <div className="alert alert-danger">{error}</div>;
  if (!detail) return <div className="text-center text-muted py-4">Chargement...</div>;

  const totalPages = Math.max(1, Math.ceil(detail.pagination.total / detail.pagination.pageSize));

  return (
    <div>
      <div className="d-flex justify-content-between align-items-start mb-3 flex-wrap gap-2">
        <p className="text-muted small mb-0">
          Prochaine exécution : {fmtDate(detail.nextRunAt)}
        </p>
        <button type="button" className="btn btn-sm btn-primary" disabled={running} onClick={runNow}>
          {running ? 'Lancement...' : 'Exécuter maintenant'}
        </button>
      </div>

      <ScheduleEditor jobName={detail.jobName} cronExpression={detail.cronExpression} enabled={detail.enabled} onSaved={load} />

      {selectedRunId && (
        <div className="mb-3">
          <RunLogsPanel runId={selectedRunId} onFinished={load} />
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <h4 className="card-title mb-0">Historique des exécutions ({detail.pagination.total})</h4>
        </div>
        <div className="table-responsive">
          <table className="table table-sm align-middle mb-0">
            <thead>
              <tr>
                <th>Démarré le</th>
                <th>Statut</th>
                <th>Durée</th>
                <th>Déclenché par</th>
                <th>Erreur</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {detail.runs.map((r) => (
                <tr key={r.id} className={selectedRunId === r.id ? 'table-active' : ''}>
                  <td className="small text-muted">{fmtDate(r.startedAt)}</td>
                  <td>
                    <span className={`badge ${STATUS_BADGE[r.status]}`}>
                      {r.status === 'running' ? 'En cours' : r.status === 'success' ? 'OK' : 'Erreur'}
                    </span>
                  </td>
                  <td className="small">{fmtDuration(r.durationMs)}</td>
                  <td className="small text-muted">{TRIGGER_LABEL[r.triggeredBy]}</td>
                  <td className="small text-muted text-truncate" style={{ maxWidth: 240 }}>{r.errorMessage || '—'}</td>
                  <td className="text-end">
                    <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => setSelectedRunId(r.id)}>
                      Voir les logs
                    </button>
                  </td>
                </tr>
              ))}
              {detail.runs.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-center text-muted py-3">Aucune exécution enregistrée pour le moment.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {totalPages > 1 && (
          <div className="card-footer d-flex justify-content-between align-items-center">
            <button type="button" className="btn btn-sm btn-outline-secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Précédent
            </button>
            <span className="small text-muted">Page {page} / {totalPages}</span>
            <button type="button" className="btn btn-sm btn-outline-secondary" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
              Suivant
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export { fmtDate };
