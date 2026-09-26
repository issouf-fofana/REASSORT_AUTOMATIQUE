import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from './api/client';

interface FeatureRequestUser {
  name: string;
  email: string;
  role: string;
  rposShopReference: string | null;
  rposShopName: string | null;
  assignedDepartment: string | null;
}

interface FeatureRequestNote {
  id: string;
  content: string;
  createdAt: string;
  user: FeatureRequestUser | null;
}

function formatUserBadge(user: FeatureRequestUser): string {
  const parts = [user.role];
  if (user.rposShopReference || user.rposShopName) {
    parts.push([user.rposShopReference, user.rposShopName].filter(Boolean).join(' — '));
  }
  if (user.assignedDepartment) parts.push(user.assignedDepartment);
  return parts.join(' · ');
}

interface FeatureRequest {
  id: string;
  title: string;
  problem: string;
  expectedBehavior: string | null;
  context: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  notes: FeatureRequestNote[];
}

const STATUS_LABELS: Record<string, string> = {
  new: 'Nouvelle',
  needs_information: "Infos manquantes",
  pending: 'En attente',
  in_progress: 'En cours',
  resolved: 'Résolue',
  closed: 'Clôturée',
};

const STATUS_BADGE_CLASS: Record<string, string> = {
  new: 'bg-primary',
  needs_information: 'bg-warning text-dark',
  pending: 'bg-secondary',
  in_progress: 'bg-info text-dark',
  resolved: 'bg-success',
  closed: 'bg-dark',
};

const ALL_STATUSES = Object.keys(STATUS_LABELS);

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function FeatureRequests() {
  const [requests, setRequests] = useState<FeatureRequest[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [savingStatus, setSavingStatus] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const path = statusFilter ? `/reassort/feature-requests?status=${encodeURIComponent(statusFilter)}` : '/reassort/feature-requests';
      const data = await apiFetch<FeatureRequest[]>(path);
      setRequests(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const selected = requests.find((r) => r.id === selectedId) || null;

  async function changeStatus(id: string, status: string) {
    setSavingStatus(true);
    try {
      await window.reassortFetch(`/reassort/feature-requests/${id}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      window.reassortToast('Statut mis à jour.', 'success');
      await load();
    } catch (err) {
      window.reassortToast(err instanceof Error ? err.message : 'Erreur lors de la mise à jour.', 'error');
    } finally {
      setSavingStatus(false);
    }
  }

  return (
    <div className="row">
      <div className="col-12 mb-4">
        <div className="d-flex justify-content-between align-items-center flex-wrap gap-2">
          <div>
            <h2 className="h4 mb-1">Demandes d'évolution</h2>
            <p className="text-muted mb-0">
              Besoins remontés par l'Assistant IA quand un utilisateur demande une fonctionnalité qui n'existe pas encore.
            </p>
          </div>
          <select
            className="form-select w-auto"
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setSelectedId(null); }}
          >
            <option value="">Tous les statuts</option>
            {ALL_STATUSES.map((s) => (
              <option key={s} value={s}>{STATUS_LABELS[s]}</option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <div className="col-12">
          <div className="alert alert-danger">{error}</div>
        </div>
      )}

      <div className="col-lg-5">
        <div className="card">
          <div className="card-body p-0">
            {loading ? (
              <div className="p-4 text-center text-muted">Chargement...</div>
            ) : requests.length === 0 ? (
              <div className="p-4 text-center text-muted">Aucune demande pour ce filtre.</div>
            ) : (
              <div className="list-group list-group-flush">
                {requests.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className={`list-group-item list-group-item-action ${selectedId === r.id ? 'active' : ''}`}
                    onClick={() => setSelectedId(r.id)}
                  >
                    <div className="d-flex justify-content-between align-items-start gap-2">
                      <span className="fw-semibold">{r.title}</span>
                      <span className={`badge ${STATUS_BADGE_CLASS[r.status] || 'bg-secondary'}`}>{STATUS_LABELS[r.status] || r.status}</span>
                    </div>
                    <div className="small text-muted mt-1">
                      {r.notes.length} contribution(s) — mise à jour {formatDate(r.updatedAt)}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="col-lg-7">
        {!selected ? (
          <div className="card">
            <div className="card-body text-center text-muted py-5">Sélectionnez une demande pour voir le détail.</div>
          </div>
        ) : (
          <div className="card">
            <div className="card-body">
              <div className="d-flex justify-content-between align-items-start gap-2 mb-3">
                <h3 className="h5 mb-0">{selected.title}</h3>
                <select
                  className="form-select form-select-sm w-auto"
                  value={selected.status}
                  disabled={savingStatus}
                  onChange={(e) => changeStatus(selected.id, e.target.value)}
                >
                  {ALL_STATUSES.map((s) => (
                    <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                  ))}
                </select>
              </div>

              <dl className="row small mb-3">
                <dt className="col-4 col-sm-3 text-muted">Créée le</dt>
                <dd className="col-8 col-sm-9">{formatDate(selected.createdAt)}</dd>
                <dt className="col-4 col-sm-3 text-muted">Problème</dt>
                <dd className="col-8 col-sm-9">{selected.problem}</dd>
                {selected.expectedBehavior && (
                  <>
                    <dt className="col-4 col-sm-3 text-muted">Comportement attendu</dt>
                    <dd className="col-8 col-sm-9">{selected.expectedBehavior}</dd>
                  </>
                )}
                {selected.context && (
                  <>
                    <dt className="col-4 col-sm-3 text-muted">Contexte</dt>
                    <dd className="col-8 col-sm-9">{selected.context}</dd>
                  </>
                )}
              </dl>

              <h4 className="h6">Contributions ({selected.notes.length})</h4>
              <ul className="list-group list-group-flush">
                {selected.notes.map((n) => (
                  <li key={n.id} className="list-group-item px-0">
                    <div className="small text-muted">
                      {n.user ? `${n.user.name} (${n.user.email})` : 'Utilisateur inconnu'} — {formatDate(n.createdAt)}
                      {n.user && <div className="fst-italic">{formatUserBadge(n.user)}</div>}
                    </div>
                    <div>{n.content}</div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
