import { useEffect, useState } from 'react';
import { apiFetch } from '../api/client';

interface ImprovementEvent {
  action: string;
  at: string;
  actor: string;
  fromStatus?: string;
  toStatus?: string;
  note?: string;
}

interface Improvement {
  id: string;
  title: string;
  detail: string;
  severity: string;
  type: string;
  status: string;
  priority: string;
  scope: string;
  errorMessage?: string;
  devRecommendation?: string;
  metricName?: string;
  metricBefore?: number;
  metricAfter?: number;
  providerUsed?: string;
  aiError?: string;
  aiConfidence?: number;
  createdAt: string;
  detectedBy?: string;
  detectedIp?: string;
  environment?: string;
  appVersion?: string;
  appliedBy?: string;
  appliedAt?: string;
  appliedNote?: string;
  dismissedBy?: string;
  dismissedReason?: string;
  evidence?: unknown;
  aiPrompt?: string;
  events?: ImprovementEvent[];
}

const PRIORITY: Record<string, { label: string; badge: string }> = {
  CRITICAL: { label: 'Critique', badge: 'bg-danger' },
  HIGH: { label: 'Élevée', badge: 'bg-warning text-dark' },
  MEDIUM: { label: 'Moyenne', badge: 'bg-info' },
  LOW: { label: 'Faible', badge: 'bg-secondary' },
};
const STATUS_LABEL: Record<string, string> = {
  PROPOSED: 'Proposée',
  IN_PROGRESS: 'En cours',
  TO_VERIFY: 'À vérifier',
  APPLIED: 'Appliquée',
  DISMISSED: 'Ignorée',
  IMPROVED: 'Améliorée',
  NO_EFFECT: 'Sans effet',
};
const EVENT_LABEL: Record<string, string> = {
  DETECTED: 'Détection',
  ENRICHED: 'Analyse IA',
  EDITED: 'Modification',
  STATUS_CHANGED: 'Changement de statut',
  EVALUATED: 'Vérification',
};

function prio(imp: Improvement) {
  return PRIORITY[imp.priority] || PRIORITY.MEDIUM;
}

function fmtDate(iso?: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('fr-FR');
}

const NOTE_CONFIG: Record<string, { title: string; label: string; required: boolean }> = {
  APPLIED: { title: 'Marquer appliqué', label: 'Correction réellement effectuée (fichiers, réglages, commandes...)', required: false },
  DISMISSED: { title: 'Ignorer la recommandation', label: 'Motif (obligatoire)', required: true },
  IN_PROGRESS: { title: 'Passer en cours', label: 'Note (optionnel)', required: false },
  TO_VERIFY: { title: 'Passer à vérifier', label: 'Note (optionnel)', required: false },
};

function actionsForStatus(status: string): { act: string; label: string; cls: string }[] {
  if (status === 'PROPOSED') {
    return [
      { act: 'IN_PROGRESS', label: 'En cours', cls: 'btn-outline-primary' },
      { act: 'APPLIED', label: 'Marquer appliqué', cls: 'btn-success' },
      { act: 'DISMISSED', label: 'Ignorer', cls: 'btn-outline-secondary' },
    ];
  }
  if (status === 'IN_PROGRESS') {
    return [
      { act: 'TO_VERIFY', label: 'À vérifier', cls: 'btn-outline-primary' },
      { act: 'APPLIED', label: 'Marquer appliqué', cls: 'btn-success' },
      { act: 'DISMISSED', label: 'Ignorer', cls: 'btn-outline-secondary' },
    ];
  }
  if (status === 'TO_VERIFY') {
    return [
      { act: 'APPLIED', label: 'Marquer appliqué', cls: 'btn-success' },
      { act: 'DISMISSED', label: 'Ignorer', cls: 'btn-outline-secondary' },
      { act: 'IN_PROGRESS', label: 'Reprendre', cls: 'btn-outline-primary' },
    ];
  }
  if (status === 'APPLIED') {
    return [{ act: 'IN_PROGRESS', label: 'Rouvrir', cls: 'btn-outline-primary' }];
  }
  return [{ act: 'IN_PROGRESS', label: 'Rouvrir', cls: 'btn-outline-primary' }];
}

function ImprovementCard({
  imp,
  onAction,
  onEdit,
  onDetail,
}: {
  imp: Improvement;
  onAction: (act: string, id: string) => void;
  onEdit: (id: string) => void;
  onDetail: (id: string) => void;
}) {
  const p = prio(imp);
  const canEdit = ['PROPOSED', 'IN_PROGRESS', 'TO_VERIFY'].includes(imp.status);
  return (
    <div className="card mb-3">
      <div className="card-body">
        <div className="d-flex flex-wrap gap-2 align-items-center mb-2">
          <span className={`badge ${p.badge}`}>Priorité {p.label}</span>
          <span className="badge bg-light text-dark border">{imp.severity}</span>
          <span className="badge bg-light text-dark border">{imp.type}</span>
          <span className="badge bg-secondary">{STATUS_LABEL[imp.status] || imp.status}</span>
          {imp.aiConfidence != null && <span className="badge bg-light text-dark border">Confiance IA {imp.aiConfidence}%</span>}
          <span className="small text-muted ms-auto">{fmtDate(imp.createdAt)}</span>
        </div>
        <h5 className="card-title mb-1">{imp.title}</h5>
        <div className="small imp-detail">{imp.detail}</div>
        {imp.errorMessage && (
          <div className="alert alert-danger small mt-2 mb-0">
            <strong>Erreur exacte constatée :</strong>
            <br />
            <code className="imp-detail">{imp.errorMessage}</code>
          </div>
        )}
        {imp.devRecommendation && (
          <div className="alert alert-light border small mt-2 mb-0">
            <strong>Recommandation dev :</strong>
            <br />
            <span className="imp-detail">{imp.devRecommendation}</span>
          </div>
        )}
        {imp.metricName != null && imp.metricBefore != null && (
          <div className="small text-muted mt-1">
            Métrique <code>{imp.metricName}</code> : {Math.round(imp.metricBefore * 100) / 100} →{' '}
            {imp.metricAfter == null ? '…' : Math.round(imp.metricAfter * 100) / 100}
          </div>
        )}
        {imp.providerUsed && <div className="small text-muted mt-1">Enrichi par IA ({imp.providerUsed})</div>}
        {imp.aiError && (
          <div className="alert alert-warning small mt-2 mb-0">
            <strong>Enrichissement IA échoué :</strong> {imp.aiError} — recommandation déterministe conservée.
          </div>
        )}
        <div className="mt-2 d-flex flex-wrap gap-2">
          {actionsForStatus(imp.status).map((a) => (
            <button key={a.act} type="button" className={`btn btn-sm ${a.cls}`} onClick={() => onAction(a.act, imp.id)}>
              {a.label}
            </button>
          ))}
          {canEdit && (
            <button type="button" className="btn btn-sm btn-outline-dark" onClick={() => onEdit(imp.id)}>
              Modifier
            </button>
          )}
          <button type="button" className="btn btn-sm btn-outline-dark" onClick={() => onDetail(imp.id)}>
            Détails
          </button>
        </div>
      </div>
    </div>
  );
}

function timelineHtml(events?: ImprovementEvent[]): string {
  if (!events || !events.length) return '<p class="text-muted small">Aucun événement.</p>';
  return (
    '<ul class="list-group list-group-flush">' +
    events
      .map((e) => {
        const esc = (s: string) => {
          const div = document.createElement('div');
          div.textContent = s;
          return div.innerHTML;
        };
        return (
          '<li class="list-group-item px-0">' +
          '<div class="d-flex justify-content-between"><strong>' +
          esc(EVENT_LABEL[e.action] || e.action) +
          '</strong><span class="small text-muted">' +
          fmtDate(e.at) +
          '</span></div>' +
          '<div class="small">Par ' +
          esc(e.actor) +
          (e.fromStatus || e.toStatus ? ' · ' + esc(e.fromStatus || '—') + ' → ' + esc(e.toStatus || '—') : '') +
          '</div>' +
          (e.note ? '<div class="small text-muted imp-detail">' + esc(e.note) + '</div>' : '') +
          '</li>'
        );
      })
      .join('') +
    '</ul>'
  );
}

function esc(s: unknown): string {
  const div = document.createElement('div');
  div.textContent = String(s ?? '');
  return div.innerHTML;
}

function detailHtml(d: Improvement): string {
  const p = prio(d);
  return (
    '<h5>' + esc(d.title) + '</h5>' +
    '<p><span class="badge ' + p.badge + '">Priorité ' + p.label + '</span> ' +
    '<span class="badge bg-secondary">' + (STATUS_LABEL[d.status] || d.status) + '</span></p>' +
    '<h6 class="mt-3">Problème détecté</h6><p class="small imp-detail">' + esc(d.detail) + '</p>' +
    (d.errorMessage ? '<h6>Erreur exacte</h6><p><code class="imp-detail">' + esc(d.errorMessage) + '</code></p>' : '') +
    (d.devRecommendation ? '<h6>Recommandation dev</h6><p class="small imp-detail">' + esc(d.devRecommendation) + '</p>' : '') +
    '<h6>Contexte de détection</h6><ul class="small">' +
    '<li>Détecté le ' + fmtDate(d.createdAt) + ' par ' + esc(d.detectedBy || '—') + (d.detectedIp ? ' (' + esc(d.detectedIp) + ')' : '') + '</li>' +
    '<li>Environnement : ' + esc(d.environment || '—') + ' · version appli : ' + esc(d.appVersion || '—') + '</li>' +
    '<li>Périmètre : ' + esc(d.scope) + '</li></ul>' +
    (d.appliedBy
      ? '<h6>Correction</h6><p class="small">Par ' + esc(d.appliedBy) + ' le ' + fmtDate(d.appliedAt) + (d.appliedNote ? '<br><span class="imp-detail">' + esc(d.appliedNote) + '</span>' : '') + '</p>'
      : '') +
    (d.dismissedBy
      ? '<h6>Ignorée</h6><p class="small">Par ' + esc(d.dismissedBy) + (d.dismissedReason ? ' — motif : <span class="imp-detail">' + esc(d.dismissedReason) + '</span>' : '') + '</p>'
      : '') +
    '<h6>Preuves</h6><pre class="border rounded p-2 small">' + esc(JSON.stringify(d.evidence || {}, null, 2)) + '</pre>' +
    (d.aiPrompt
      ? '<details class="small mt-2"><summary class="text-primary" style="cursor:pointer;">Voir le prompt envoyé à l’IA</summary><pre class="border rounded p-2 mt-1" style="white-space:pre-wrap;">' + esc(d.aiPrompt) + '</pre></details>'
      : '') +
    '<h6 class="mt-3">Timeline</h6>' + timelineHtml(d.events)
  );
}

export function ImprovementsTab() {
  const [rows, setRows] = useState<Improvement[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [sort, setSort] = useState('priority');
  const [summary, setSummary] = useState('');
  const [generating, setGenerating] = useState(false);

  const [detailBody, setDetailBody] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const [editState, setEditState] = useState<{ id: string; detail: string; dev: string; priority: string; error: string } | null>(null);
  const [editSaving, setEditSaving] = useState(false);

  const [noteState, setNoteState] = useState<{ act: string; id: string; title: string; label: string; required: boolean; text: string; error: string } | null>(
    null,
  );
  const [noteSaving, setNoteSaving] = useState(false);

  async function loadList() {
    setRows(null);
    setError(null);
    try {
      const q = [];
      if (statusFilter) q.push('status=' + statusFilter);
      if (priorityFilter) q.push('priority=' + priorityFilter);
      q.push('sort=' + sort);
      const data = await apiFetch<Improvement[]>('/reassort/improvements' + (q.length ? '?' + q.join('&') : ''));
      setRows(data);
      setSummary(`${data.length} recommandation(s)`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, priorityFilter, sort]);

  async function handleGenerate() {
    setGenerating(true);
    try {
      const d = await apiFetch<{ findings: number; created: number; enriched: number; evaluation: { improved: number } }>(
        '/reassort/improvements/generate',
        { method: 'POST' },
      );
      setSummary(`${d.findings} constat(s), ${d.created} nouvelle(s), ${d.enriched} enrichie(s) par IA, ${d.evaluation.improved} améliorée(s) constatée(s).`);
      loadList();
    } catch (err) {
      alert('Erreur: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setGenerating(false);
    }
  }

  async function handleDetail(id: string) {
    setDetailOpen(true);
    setDetailBody('<p class="text-muted">Chargement...</p>');
    try {
      const d = await apiFetch<Improvement>(`/reassort/improvements/${id}`);
      setDetailBody(detailHtml(d));
    } catch (err) {
      setDetailBody(`<div class="alert alert-danger">Erreur: ${esc(err instanceof Error ? err.message : String(err))}</div>`);
    }
  }

  async function handleEdit(id: string) {
    try {
      const d = await apiFetch<Improvement>(`/reassort/improvements/${id}`);
      setEditState({ id: d.id, detail: d.detail || '', dev: d.devRecommendation || '', priority: d.priority || 'MEDIUM', error: '' });
    } catch (err) {
      alert('Erreur: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  async function saveEdit() {
    if (!editState) return;
    setEditSaving(true);
    try {
      await apiFetch(`/reassort/improvements/${editState.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          detail: editState.detail,
          devRecommendation: editState.dev || null,
          priority: editState.priority,
        }),
      });
      setEditState(null);
      loadList();
    } catch (err) {
      setEditState((prev) => (prev ? { ...prev, error: 'Erreur: ' + (err instanceof Error ? err.message : String(err)) } : prev));
    } finally {
      setEditSaving(false);
    }
  }

  function handleAction(act: string, id: string) {
    const cfg = NOTE_CONFIG[act] || { title: 'Changer de statut', label: 'Note (optionnel)', required: false };
    setNoteState({ act, id, title: cfg.title, label: cfg.label, required: cfg.required, text: '', error: '' });
  }

  async function confirmNote() {
    if (!noteState) return;
    const note = noteState.text.trim();
    if (noteState.required && !note) {
      setNoteState({ ...noteState, error: 'Motif requis pour ignorer une recommandation.' });
      return;
    }
    setNoteSaving(true);
    try {
      await apiFetch(`/reassort/improvements/${noteState.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: noteState.act, note: note || null }),
      });
      setNoteState(null);
      loadList();
    } catch (err) {
      setNoteState((prev) => (prev ? { ...prev, error: 'Erreur: ' + (err instanceof Error ? err.message : String(err)) } : prev));
    } finally {
      setNoteSaving(false);
    }
  }

  return (
    <div>
      <style>{`.imp-detail { white-space: pre-line; }`}</style>

      <div className="card mb-3">
        <div className="card-body">
          <div className="alert alert-light border small mb-0">
            <strong>À quoi ça sert :</strong> le chien de garde surveille en continu les anomalies{' '}
            <em>silencieuses</em> (prédictions jamais évaluables, jobs en échec, biais de précision par magasin,
            synchro en retard, questions chatbot sans réponse...), propose un correctif (réglage + reco dev, enrichi
            par l'IA pour les priorités), puis <strong>vérifie après coup</strong> si le correctif appliqué a
            vraiment amélioré la métrique (IMPROVED) ou non (NO_EFFECT). Vous restez décisionnaire : rien n'est
            appliqué automatiquement.
          </div>
        </div>
      </div>

      <div className="card mb-3">
        <div className="card-body d-flex flex-wrap gap-2 align-items-center">
          <button type="button" className="btn btn-primary" disabled={generating} onClick={handleGenerate}>
            {generating ? 'Analyse en cours...' : 'Analyser maintenant'}
          </button>
          <select className="form-select" style={{ maxWidth: 200 }} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">Tous statuts</option>
            <option value="PROPOSED">Proposées</option>
            <option value="IN_PROGRESS">En cours</option>
            <option value="TO_VERIFY">À vérifier</option>
            <option value="APPLIED">Appliquées</option>
            <option value="IMPROVED">Améliorées</option>
            <option value="NO_EFFECT">Sans effet</option>
            <option value="DISMISSED">Ignorées</option>
          </select>
          <select className="form-select" style={{ maxWidth: 180 }} value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value)}>
            <option value="">Toutes priorités</option>
            <option value="CRITICAL">Critique</option>
            <option value="HIGH">Élevée</option>
            <option value="MEDIUM">Moyenne</option>
            <option value="LOW">Faible</option>
          </select>
          <select className="form-select" style={{ maxWidth: 180 }} value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="priority">Tri : priorité</option>
            <option value="recent">Tri : récent</option>
          </select>
          <span className="small text-muted ms-auto">{summary}</span>
        </div>
      </div>

      <div>
        {error && <div className="alert alert-danger">Erreur: {error}</div>}
        {!rows && !error && <div className="text-center text-muted py-4">Chargement...</div>}
        {rows && rows.length === 0 && (
          <div className="alert alert-light border">Aucune recommandation pour ce filtre. Lancez "Analyser maintenant".</div>
        )}
        {rows?.map((imp) => (
          <ImprovementCard key={imp.id} imp={imp} onAction={handleAction} onEdit={handleEdit} onDetail={handleDetail} />
        ))}
      </div>

      {detailOpen && (
        <>
          <div className="modal fade show" style={{ display: 'block' }} tabIndex={-1} role="dialog">
            <div className="modal-dialog modal-xl modal-dialog-scrollable" role="document">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">Détail de la recommandation</h5>
                  <button type="button" className="btn-close" onClick={() => setDetailOpen(false)}></button>
                </div>
                <div className="modal-body" dangerouslySetInnerHTML={{ __html: detailBody || '' }} />
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show"></div>
        </>
      )}

      {editState && (
        <>
          <div className="modal fade show" style={{ display: 'block' }} tabIndex={-1} role="dialog">
            <div className="modal-dialog modal-lg" role="document">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">Modifier la proposition IA</h5>
                  <button type="button" className="btn-close" onClick={() => setEditState(null)}></button>
                </div>
                <div className="modal-body">
                  <label className="form-label fw-semibold">Recommandation</label>
                  <textarea
                    className="form-control mb-3"
                    rows={4}
                    value={editState.detail}
                    onChange={(e) => setEditState({ ...editState, detail: e.target.value })}
                  />
                  <label className="form-label fw-semibold">Recommandation dev</label>
                  <textarea
                    className="form-control mb-3"
                    rows={3}
                    placeholder="Vide = aucune"
                    value={editState.dev}
                    onChange={(e) => setEditState({ ...editState, dev: e.target.value })}
                  />
                  <label className="form-label fw-semibold">Priorité</label>
                  <select
                    className="form-select"
                    style={{ maxWidth: 220 }}
                    value={editState.priority}
                    onChange={(e) => setEditState({ ...editState, priority: e.target.value })}
                  >
                    <option value="CRITICAL">Critique</option>
                    <option value="HIGH">Élevée</option>
                    <option value="MEDIUM">Moyenne</option>
                    <option value="LOW">Faible</option>
                  </select>
                  {editState.error && <div className="alert alert-danger mt-3">{editState.error}</div>}
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn btn-outline-secondary" onClick={() => setEditState(null)}>
                    Annuler
                  </button>
                  <button type="button" className="btn btn-primary" disabled={editSaving} onClick={saveEdit}>
                    Enregistrer
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show"></div>
        </>
      )}

      {noteState && (
        <>
          <div className="modal fade show" style={{ display: 'block' }} tabIndex={-1} role="dialog">
            <div className="modal-dialog" role="document">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">{noteState.title}</h5>
                  <button type="button" className="btn-close" onClick={() => setNoteState(null)}></button>
                </div>
                <div className="modal-body">
                  <label className="form-label fw-semibold">{noteState.label}</label>
                  <textarea
                    className="form-control"
                    rows={3}
                    value={noteState.text}
                    onChange={(e) => setNoteState({ ...noteState, text: e.target.value })}
                  />
                  {noteState.error && <div className="alert alert-danger mt-2">{noteState.error}</div>}
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn btn-outline-secondary" onClick={() => setNoteState(null)}>
                    Annuler
                  </button>
                  <button type="button" className="btn btn-primary" disabled={noteSaving} onClick={confirmNote}>
                    Confirmer
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show"></div>
        </>
      )}
    </div>
  );
}
