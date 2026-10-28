import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../shared/api/client';
import { JobDetailModal } from './JobDetailModal';

interface LastRun {
  id: string;
  status: 'running' | 'success' | 'error';
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  triggeredBy: 'cron' | 'startup' | 'manual';
}

interface SparklinePoint {
  durationMs: number;
  status: 'running' | 'success' | 'error';
  startedAt: string;
}

interface JobOverview {
  jobName: string;
  label: string;
  enabled: boolean;
  cronExpression: string;
  nextRunAt: string | null;
  healthStatus: 'ok' | 'error' | 'degraded' | 'running' | 'never_run';
  lastRun: LastRun | null;
  durationSparkline: SparklinePoint[];
}

// Palette du projet (marine/ambre, cf. theme-override.css : --bs-primary #1B2A4A, accent #F5A623) —
// réutilisée ici en dur plutôt que via les classes Bootstrap génériques bg-*-subtle pour obtenir le
// style "vraie supervision" demandé le 28/10/2026 (pastilles de statut, densité façon dashboard pro,
// graphiques temporels), sans introduire de couleurs étrangères à l'identité visuelle existante.
const NAVY = '#1B2A4A';
const AMBER = '#F5A623';
const GREEN = '#2E7D4F';
const RED = '#B8302C';
const GREY = '#8591A0';

const STATUS_META: Record<JobOverview['healthStatus'], { label: string; dot: string; text: string }> = {
  ok: { label: 'OK', dot: GREEN, text: GREEN },
  running: { label: 'En cours', dot: AMBER, text: AMBER },
  error: { label: 'Erreur', dot: '#D08A2A', text: '#8A5A00' },
  degraded: { label: 'Dégradé', dot: RED, text: RED },
  never_run: { label: 'Jamais exécuté', dot: GREY, text: GREY },
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

/** Pastille de statut compacte façon grille de supervision (Centreon et équivalents) — un petit
 * carré coloré plutôt qu'un badge texte, pour une vue d'ensemble scannable d'un coup d'œil sur
 * beaucoup de lignes à la fois. Le badge texte reste affiché à côté pour l'accessibilité et la
 * clarté (jamais la couleur seule comme unique porteur de sens). */
function StatusDot({ status, pulse = false }: { status: JobOverview['healthStatus']; pulse?: boolean }) {
  const meta = STATUS_META[status];
  return (
    <span
      title={meta.label}
      style={{
        display: 'inline-block',
        width: 10,
        height: 10,
        borderRadius: 2,
        backgroundColor: meta.dot,
        boxShadow: pulse ? `0 0 0 3px ${meta.dot}33` : undefined,
      }}
    />
  );
}

/** Sparkline SVG de la durée des dernières exécutions d'un job — axe temporel implicite (gauche =
 * plus ancien, droite = plus récent), chaque point coloré selon le statut de cette exécution
 * précise (vert=succès, rouge=erreur), pour repérer en un coup d'œil une dérive de durée ou une
 * série d'échecs sans ouvrir le détail. Aucune bibliothèque de graphique : un job planifié affiche
 * au plus SPARKLINE_RUNS points côté backend (12), un tracé SVG à la main suffit largement et évite
 * une dépendance supplémentaire pour un graphique aussi simple. */
function DurationSparkline({ points }: { points: SparklinePoint[] }) {
  if (points.length < 2) {
    return <span className="small text-muted">—</span>;
  }
  const W = 120;
  const H = 28;
  const PAD = 3;
  const maxDuration = Math.max(...points.map((p) => p.durationMs), 1);
  const stepX = (W - PAD * 2) / (points.length - 1);
  const coords = points.map((p, i) => {
    const x = PAD + i * stepX;
    const y = H - PAD - (p.durationMs / maxDuration) * (H - PAD * 2);
    return { x, y, status: p.status, durationMs: p.durationMs, startedAt: p.startedAt };
  });
  const path = coords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(' ');
  const dotColor = (s: SparklinePoint['status']) => (s === 'error' ? RED : s === 'running' ? AMBER : GREEN);

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Évolution de la durée des dernières exécutions">
      <path d={path} fill="none" stroke={NAVY} strokeWidth={1.3} strokeOpacity={0.35} />
      {coords.map((c, i) => (
        <circle key={i} cx={c.x} cy={c.y} r={i === coords.length - 1 ? 2.2 : 1.4} fill={dotColor(c.status)}>
          <title>{`${fmtDuration(c.durationMs)} — ${fmtDate(c.startedAt)}`}</title>
        </circle>
      ))}
    </svg>
  );
}

/** Tableau de bord global de supervision des 26 jobs planifiés (cronManager.js) — demande explicite
 * du 26/10/2026 : "une interface d'administration centralisée" avec statut, logs, suivi temps réel,
 * historique, diagnostic d'erreur et prochaine exécution, toutes données réelles (pas simulées).
 * Relooké le 28/10/2026 (demande explicite : "un vrai style de supervision... grille de pastilles
 * colorées, graphiques temporels, densité d'information") en gardant la palette marine/ambre déjà
 * utilisée partout ailleurs dans le projet plutôt que celle d'un outil de référence externe. */
export function JobsAdminDashboard() {
  const [jobs, setJobs] = useState<JobOverview[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | JobOverview['healthStatus']>('all');
  const [search, setSearch] = useState('');
  const [runningJob, setRunningJob] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [selectedJob, setSelectedJob] = useState<{ jobName: string; label: string } | null>(null);

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
    pollRef.current = setInterval(load, 10000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // Ouvre directement la modale sur les logs en direct dès le lancement (demande explicite du
  // 28/10/2026 : "quand c'est lancé je dois ouvrir le modal et voir les logs en temps réel") — avant
  // ce correctif, "Exécuter" ne faisait que lancer le job en arrière-plan, sans jamais afficher la
  // progression tant que l'utilisateur ne cliquait pas une seconde fois sur le nom de la tâche.
  async function runNow(jobName: string, label: string) {
    setRunningJob(jobName);
    try {
      await apiFetch(`/reassort/jobs-admin/${jobName}/run`, { method: 'POST' });
      setSelectedJob({ jobName, label });
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
      <style>{`
        .jadm-grid-row { border-bottom: 1px solid rgba(27,42,74,.06); transition: background .1s; }
        .jadm-grid-row:hover { background: #F7F9FC; }
        .jadm-grid-row:last-child { border-bottom: none; }
        .jadm-name-btn { color: ${NAVY}; }
        .jadm-name-btn:hover { text-decoration: underline !important; }
        .jadm-filter-btn.active { background-color: ${NAVY}; border-color: ${NAVY}; color: #fff; }
        .jadm-filter-btn.active .jadm-count { background: rgba(255,255,255,.22); color: #fff; }
        .jadm-count { background: #EDF1F7; color: ${NAVY}; border-radius: 10px; font-size: .7rem; padding: 1px 6px; font-weight: 700; }
        .jadm-cron-chip { background: #EDF1F7; color: ${NAVY}; border-radius: 5px; padding: 2px 6px; font-size: .74rem; font-family: ui-monospace, monospace; }
      `}</style>

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

      {/* Grille de pastilles d'ensemble (demande explicite : "grille de statuts en pastilles
          colorées... vue d'ensemble d'un coup d'œil") — une pastille par tâche, regroupées par
          statut, avant même le tableau détaillé, pour voir immédiatement la répartition globale. */}
      {jobs && (
        <div className="d-flex flex-wrap gap-1 mb-3 p-2" style={{ background: '#fff', border: '1px solid rgba(27,42,74,.06)', borderRadius: 10 }}>
          {jobs.map((j) => (
            <span
              key={j.jobName}
              role="button"
              onClick={() => setSelectedJob({ jobName: j.jobName, label: j.label })}
              title={`${j.label} — ${STATUS_META[j.healthStatus].label}`}
              style={{
                width: 14, height: 14, borderRadius: 3, cursor: 'pointer',
                backgroundColor: STATUS_META[j.healthStatus].dot,
              }}
            />
          ))}
        </div>
      )}

      <div className="d-flex gap-2 flex-wrap mb-3">
        {(['all', 'ok', 'running', 'degraded', 'error', 'never_run'] as const).map((key) => {
          const meta = key === 'all' ? { label: 'Toutes' } : STATUS_META[key];
          return (
            <button
              key={key}
              type="button"
              className={`btn btn-sm jadm-filter-btn ${statusFilter === key ? 'active' : 'btn-outline-secondary'}`}
              onClick={() => setStatusFilter(key)}
            >
              {key !== 'all' && <StatusDot status={key} />} <span className="ms-1">{meta.label}</span>{' '}
              <span className="jadm-count">{counts[key]}</span>
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
        <div style={{ background: '#fff', border: '1px solid rgba(27,42,74,.06)', borderRadius: 10, overflow: 'hidden' }}>
          <div className="table-responsive">
            <table className="table table-sm align-middle mb-0" style={{ fontSize: '.84rem' }}>
              <thead>
                <tr style={{ background: '#F7F9FC' }}>
                  <th className="ps-3">Tâche</th>
                  <th>Statut</th>
                  <th>Dernière exécution</th>
                  <th>Durée</th>
                  <th>Tendance</th>
                  <th>Prochaine exécution</th>
                  <th>Fréquence</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((j) => {
                  const meta = STATUS_META[j.healthStatus];
                  return (
                    <tr key={j.jobName} className="jadm-grid-row">
                      <td className="ps-3 py-2">
                        <button
                          type="button"
                          className="btn btn-link p-0 fw-semibold text-decoration-none jadm-name-btn"
                          onClick={() => setSelectedJob({ jobName: j.jobName, label: j.label })}
                        >
                          {j.label}
                        </button>
                        {!j.enabled && <span className="badge bg-secondary-subtle text-secondary ms-2">Désactivé</span>}
                      </td>
                      <td className="py-2">
                        <StatusDot status={j.healthStatus} pulse={j.healthStatus === 'running'} />
                        <span className="ms-2 fw-semibold" style={{ color: meta.text, fontSize: '.78rem' }}>{meta.label}</span>
                      </td>
                      <td className="small text-muted py-2">{fmtDate(j.lastRun?.startedAt)}</td>
                      <td className="small py-2" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtDuration(j.lastRun?.durationMs)}</td>
                      <td className="py-2">
                        <DurationSparkline points={j.durationSparkline} />
                      </td>
                      <td className="small text-muted py-2">{fmtDate(j.nextRunAt)}</td>
                      <td className="py-2"><span className="jadm-cron-chip">{j.cronExpression}</span></td>
                      <td className="text-end py-2 pe-3">
                        <button
                          type="button"
                          className="btn btn-sm btn-outline-secondary"
                          disabled={runningJob === j.jobName || j.healthStatus === 'running'}
                          onClick={() => runNow(j.jobName, j.label)}
                        >
                          {runningJob === j.jobName ? '...' : 'Exécuter'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={8} className="text-center text-muted py-3">Aucune tâche ne correspond à ce filtre.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {selectedJob && (
        <JobDetailModal
          jobName={selectedJob.jobName}
          label={selectedJob.label}
          onClose={() => { setSelectedJob(null); load(); }}
        />
      )}
    </div>
  );
}
