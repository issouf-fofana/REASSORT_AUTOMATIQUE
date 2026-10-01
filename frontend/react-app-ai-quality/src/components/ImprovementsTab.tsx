import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../api/client';
import { Pagination } from './ui/Pagination';

const PAGE_SIZE = 10;

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

// Recoloré en palette marine/ambre (01/10/2026, "applique le nouveau style") — remplace les
// couleurs Bootstrap par défaut (bg-danger/bg-warning/bg-info/bg-secondary), avec un ordre explicite
// pour le groupement par priorité juste en dessous.
const PRIORITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
const PRIORITY: Record<string, { label: string; badge: string }> = {
  CRITICAL: { label: 'Critique', badge: 'iq-badge-danger' },
  HIGH: { label: 'Élevée', badge: 'iq-badge-amber' },
  MEDIUM: { label: 'Moyenne', badge: 'iq-badge-navy' },
  LOW: { label: 'Faible', badge: 'iq-badge-neutral' },
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
      { act: 'IN_PROGRESS', label: 'En cours', cls: 'iq-btn-outline' },
      { act: 'APPLIED', label: 'Marquer appliqué', cls: 'iq-btn-success' },
      { act: 'DISMISSED', label: 'Ignorer', cls: 'iq-btn-outline' },
    ];
  }
  if (status === 'IN_PROGRESS') {
    return [
      { act: 'TO_VERIFY', label: 'À vérifier', cls: 'iq-btn-outline' },
      { act: 'APPLIED', label: 'Marquer appliqué', cls: 'iq-btn-success' },
      { act: 'DISMISSED', label: 'Ignorer', cls: 'iq-btn-outline' },
    ];
  }
  if (status === 'TO_VERIFY') {
    return [
      { act: 'APPLIED', label: 'Marquer appliqué', cls: 'iq-btn-success' },
      { act: 'DISMISSED', label: 'Ignorer', cls: 'iq-btn-outline' },
      { act: 'IN_PROGRESS', label: 'Reprendre', cls: 'iq-btn-outline' },
    ];
  }
  if (status === 'APPLIED') {
    return [{ act: 'IN_PROGRESS', label: 'Rouvrir', cls: 'iq-btn-outline' }];
  }
  return [{ act: 'IN_PROGRESS', label: 'Rouvrir', cls: 'iq-btn-outline' }];
}

// Carte compactée (01/10/2026, "cartes plus compactes et scannables") : le détail complet (erreur
// exacte, recommandation dev, métrique, provider IA, échec d'enrichissement) n'est plus affiché en
// permanence sur chaque carte — déplacé dans le modal "Détails" déjà existant (detailHtml ci-dessous)
// pour qu'une liste de 10+ recommandations reste scannable d'un coup d'œil (titre + résumé court +
// badges + actions), au lieu d'empiler plusieurs paragraphes/alertes par carte.
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
  const hasExtra = !!(imp.errorMessage || imp.devRecommendation || (imp.metricName && imp.metricBefore != null) || imp.aiError);
  return (
    <div className="iq-card">
      <div className="d-flex flex-wrap gap-2 align-items-center mb-2">
        <span className={`iq-badge ${p.badge}`}>{p.label}</span>
        <span className={`iq-badge iq-badge-status-${imp.status}`}>{STATUS_LABEL[imp.status] || imp.status}</span>
        {imp.aiConfidence != null && <span className="iq-badge iq-badge-ghost">IA {imp.aiConfidence}%</span>}
        <span className="small text-muted ms-auto">{fmtDate(imp.createdAt)}</span>
      </div>
      <h5 className="iq-card-title">{imp.title}</h5>
      <div className="small iq-card-summary imp-detail">{imp.detail}</div>
      {hasExtra && (
        <button type="button" className="btn btn-link btn-sm p-0 mt-1" onClick={() => onDetail(imp.id)}>
          Voir le détail complet →
        </button>
      )}
      <div className="mt-2 d-flex flex-wrap gap-2">
        {actionsForStatus(imp.status).map((a) => (
          <button key={a.act} type="button" className={`btn btn-sm ${a.cls}`} onClick={() => onAction(a.act, imp.id)}>
            {a.label}
          </button>
        ))}
        {canEdit && (
          <button type="button" className="btn btn-sm iq-btn-outline" onClick={() => onEdit(imp.id)}>
            Modifier
          </button>
        )}
        <button type="button" className="btn btn-sm iq-btn-outline" onClick={() => onDetail(imp.id)}>
          Détails
        </button>
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
    '<p><span class="iq-badge ' + p.badge + '">' + p.label + '</span> ' +
    '<span class="iq-badge iq-badge-status-' + d.status + '">' + (STATUS_LABEL[d.status] || d.status) + '</span></p>' +
    '<h6 class="mt-3">Problème détecté</h6><p class="small imp-detail">' + esc(d.detail) + '</p>' +
    (d.errorMessage ? '<h6>Erreur exacte</h6><p><code class="imp-detail">' + esc(d.errorMessage) + '</code></p>' : '') +
    (d.devRecommendation ? '<h6>Recommandation dev</h6><p class="small imp-detail">' + esc(d.devRecommendation) + '</p>' : '') +
    (d.metricName != null && d.metricBefore != null
      ? '<h6>Métrique</h6><p class="small"><code>' + esc(d.metricName) + '</code> : ' + Math.round(d.metricBefore * 100) / 100 + ' → ' +
        (d.metricAfter == null ? '…' : Math.round(d.metricAfter * 100) / 100) + '</p>'
      : '') +
    (d.providerUsed ? '<p class="small text-muted">Enrichi par IA (' + esc(d.providerUsed) + ')</p>' : '') +
    (d.aiError
      ? '<div class="alert alert-warning small"><strong>Enrichissement IA échoué :</strong> ' + esc(d.aiError) + ' — recommandation déterministe conservée.</div>'
      : '') +
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
  const [page, setPage] = useState(1);

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
    setPage(1); // un changement de filtre repart toujours de la première page, jamais une page
    // devenue vide/incohérente si le nouveau résultat a moins de pages que l'ancien.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, priorityFilter, sort]);

  const pageCount = rows ? Math.max(1, Math.ceil(rows.length / PAGE_SIZE)) : 1;
  const pagedRows = useMemo(() => {
    if (!rows) return null;
    return rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  }, [rows, page]);

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

  // Groupement par priorité (01/10/2026, "regrouper visuellement par priorité") — uniquement quand
  // le tri est "priorité" (sinon "récent" perdrait son sens si on le découpait aussi par groupe) et
  // qu'aucun filtre de priorité précis n'est actif (un seul groupe serait redondant avec le filtre).
  const groupedByPriority = useMemo(() => {
    if (!pagedRows || sort !== 'priority' || priorityFilter) return null;
    const groups = new Map<string, Improvement[]>();
    for (const key of PRIORITY_ORDER) groups.set(key, []);
    for (const imp of pagedRows) {
      const key = PRIORITY[imp.priority] ? imp.priority : 'MEDIUM';
      groups.get(key)!.push(imp);
    }
    return PRIORITY_ORDER.map((key) => [key, groups.get(key)!] as const).filter(([, list]) => list.length > 0);
  }, [pagedRows, sort, priorityFilter]);

  return (
    <div>
      <style>{`
        .imp-detail { white-space: pre-line; }
        .iq-card { background: #ffffff; border: 1px solid #e9ecf2; border-radius: 12px; padding: 1rem 1.25rem; margin-bottom: .75rem; box-shadow: 0 1px 3px rgba(27,42,74,.05); }
        .iq-card-title { font-size: .95rem; font-weight: 600; color: #1B2A4A; margin-bottom: .3rem; }
        .iq-card-summary { color: #44516B; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        .iq-badge { display: inline-flex; align-items: center; font-size: .68rem; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; padding: .28rem .65rem; border-radius: 999px; }
        .iq-badge-danger { background: #F5EDEC; color: #7A4A45; }
        .iq-badge-amber { background: #FDF1DD; color: #8A5A00; }
        .iq-badge-navy { background: #EDF1F7; color: #1B2A4A; }
        .iq-badge-neutral { background: #F1F3F5; color: #5B6B85; }
        .iq-badge-ghost { background: transparent; border: 1px solid #DCE3F0; color: #5B6B85; }
        .iq-badge-status-PROPOSED, .iq-badge-status-IN_PROGRESS, .iq-badge-status-TO_VERIFY { background: #EDF1F7; color: #1B2A4A; }
        .iq-badge-status-APPLIED, .iq-badge-status-IMPROVED { background: #ECFDF5; color: #047857; }
        .iq-badge-status-DISMISSED, .iq-badge-status-NO_EFFECT { background: #F1F3F5; color: #5B6B85; }
        .iq-btn-outline { background: transparent; border: 1px solid #DCE3F0; color: #1B2A4A; }
        .iq-btn-outline:hover { background: #1B2A4A; border-color: #1B2A4A; color: #fff; }
        .iq-btn-success { background: #1B2A4A; border: 1px solid #1B2A4A; color: #fff; }
        .iq-btn-success:hover { background: #14203a; border-color: #14203a; color: #fff; }
        .iq-group-heading { display: flex; align-items: center; gap: .5rem; margin: 1.25rem 0 .6rem; font-size: .78rem; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: #8a93a8; }
        .iq-group-heading:first-child { margin-top: 0; }
      `}</style>

      <div className="iq-card mb-3" style={{ background: '#F7F9FC' }}>
        <div className="small" style={{ color: '#44516B' }}>
          <strong style={{ color: '#1B2A4A' }}>À quoi ça sert :</strong> le chien de garde surveille en continu les
          anomalies <em>silencieuses</em> (prédictions jamais évaluables, jobs en échec, biais de précision par
          magasin, synchro en retard, questions chatbot sans réponse...), propose un correctif (réglage + reco dev,
          enrichi par l'IA pour les priorités), puis <strong>vérifie après coup</strong> si le correctif appliqué a
          vraiment amélioré la métrique (IMPROVED) ou non (NO_EFFECT). Vous restez décisionnaire : rien n'est
          appliqué automatiquement.
        </div>
      </div>

      <div className="d-flex flex-wrap gap-2 align-items-center mb-3">
        <button type="button" className="btn iq-btn-success" disabled={generating} onClick={handleGenerate}>
          {generating ? 'Analyse en cours...' : 'Analyser maintenant'}
        </button>
        <select className="form-select form-select-sm" style={{ maxWidth: 170 }} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">Tous statuts</option>
          <option value="PROPOSED">Proposées</option>
          <option value="IN_PROGRESS">En cours</option>
          <option value="TO_VERIFY">À vérifier</option>
          <option value="APPLIED">Appliquées</option>
          <option value="IMPROVED">Améliorées</option>
          <option value="NO_EFFECT">Sans effet</option>
          <option value="DISMISSED">Ignorées</option>
        </select>
        <select className="form-select form-select-sm" style={{ maxWidth: 150 }} value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value)}>
          <option value="">Toutes priorités</option>
          <option value="CRITICAL">Critique</option>
          <option value="HIGH">Élevée</option>
          <option value="MEDIUM">Moyenne</option>
          <option value="LOW">Faible</option>
        </select>
        <select className="form-select form-select-sm" style={{ maxWidth: 150 }} value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="priority">Tri : priorité</option>
          <option value="recent">Tri : récent</option>
        </select>
        <span className="small fw-semibold ms-auto" style={{ color: '#1B2A4A' }}>{summary}</span>
      </div>

      <div>
        {error && <div className="alert alert-danger">Erreur: {error}</div>}
        {!rows && !error && <div className="text-center text-muted py-4">Chargement...</div>}
        {rows && rows.length === 0 && (
          <div className="alert alert-light border">Aucune recommandation pour ce filtre. Lancez "Analyser maintenant".</div>
        )}
        {groupedByPriority
          ? groupedByPriority.map(([key, list]) => (
              <div key={key}>
                <div className="iq-group-heading">
                  <span className={`iq-badge ${PRIORITY[key].badge}`}>{PRIORITY[key].label}</span>
                  <span>{list.length} recommandation(s)</span>
                </div>
                {list.map((imp) => (
                  <ImprovementCard key={imp.id} imp={imp} onAction={handleAction} onEdit={handleEdit} onDetail={handleDetail} />
                ))}
              </div>
            ))
          : pagedRows?.map((imp) => (
              <ImprovementCard key={imp.id} imp={imp} onAction={handleAction} onEdit={handleEdit} onDetail={handleDetail} />
            ))}
      </div>
      <Pagination page={page} pageCount={pageCount} onChange={setPage} />

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
                  <button type="button" className="btn iq-btn-outline" onClick={() => setEditState(null)}>
                    Annuler
                  </button>
                  <button type="button" className="btn iq-btn-success" disabled={editSaving} onClick={saveEdit}>
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
                  <button type="button" className="btn iq-btn-outline" onClick={() => setNoteState(null)}>
                    Annuler
                  </button>
                  <button type="button" className="btn iq-btn-success" disabled={noteSaving} onClick={confirmNote}>
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
