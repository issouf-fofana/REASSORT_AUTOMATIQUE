import { useEffect, useState } from 'react';
import { apiFetch } from '../api/client';

const LEVELS = [
  { key: 'VALIDATION_HUMAINE', label: 'Validation humaine', desc: 'Chaque décision IA est validée par un humain avant application.' },
  { key: 'SUPERVISION_HUMAINE', label: 'Supervision humaine', desc: 'Un humain supervise en continu, intervient sur les cas à risque.' },
  { key: 'AUTONOMIE_CONTROLEE', label: 'Autonomie contrôlée', desc: 'Le système agit avec des garde-fous, contrôle a posteriori.' },
  { key: 'AUTONOME', label: 'Autonome', desc: 'Fonctionnement autonome, supervision minimale.' },
];

const CRITERIA = [
  { key: 'errorRateScore', label: "Taux d'erreur (inversé)" },
  { key: 'recommendationAccuracyScore', label: 'Exactitude des recommandations' },
  { key: 'stabilityScore', label: 'Stabilité des résultats' },
  { key: 'anomalyDetectionScore', label: "Détection d'anomalies" },
  { key: 'postCorrectionScore', label: 'Résultats après correction' },
  { key: 'ruleComplianceScore', label: 'Respect des règles métier' },
  { key: 'testCaseScore', label: 'Performance sur cas de test' },
] as const;

interface Readiness {
  level: string;
  levelConfirmed: boolean;
  lastConfirmedLevel: string;
  currentStreakCount: number;
  measuredCriteriaCount: number;
  [key: string]: unknown;
}

interface HistoryRow {
  computedAt: string;
  globalScore: number;
  level: string;
  currentStreakCount: number;
  measuredCriteriaCount: number;
}

function fmtDate(iso?: string | null) {
  return iso ? new Date(iso).toLocaleString('fr-FR') : '—';
}

function Ladder({ readiness }: { readiness: Readiness | null }) {
  const effectiveLevel = readiness ? (readiness.levelConfirmed ? readiness.level : readiness.lastConfirmedLevel) : 'VALIDATION_HUMAINE';
  const effectiveIndex = LEVELS.findIndex((l) => l.key === effectiveLevel);
  const pendingLevel = readiness && !readiness.levelConfirmed ? readiness.level : null;

  return (
    <div className="autonomy-ladder">
      {LEVELS.map((l, i) => {
        let cls = '';
        if (i === effectiveIndex) cls = 'active';
        else if (pendingLevel === l.key) cls = 'pending';
        return (
          <div className={`autonomy-step ${cls}`} key={l.key}>
            <div className="fw-bold">{l.label}</div>
            <div className="small text-muted">{l.desc}</div>
            {i === effectiveIndex && <div className="badge bg-success mt-2">Palier tenu</div>}
            {pendingLevel === l.key && <div className="badge bg-warning text-dark mt-2">En confirmation</div>}
          </div>
        );
      })}
    </div>
  );
}

function Criteria({ readiness }: { readiness: Readiness | null }) {
  if (!readiness) return <p className="text-muted">Aucune évaluation disponible pour le moment.</p>;
  return (
    <div>
      <div className="small text-muted mb-3">
        {readiness.measuredCriteriaCount} / 7 critères mesurables aujourd'hui (les autres n'ont pas encore de source
        de données fiable).
      </div>
      {CRITERIA.map((c) => {
        const value = readiness[c.key] as number | null | undefined;
        const measurable = value !== null && value !== undefined;
        return (
          <div className="mb-2" key={c.key}>
            <div className="d-flex justify-content-between small mb-1">
              <span>{c.label}</span>
              <span>{measurable ? `${Math.round(value as number)} / 100` : <span className="text-muted">non mesurable</span>}</span>
            </div>
            <div className="criteria-bar">
              <div
                className="criteria-bar-fill"
                style={{ width: `${measurable ? Math.round(value as number) : 0}%`, background: measurable ? undefined : '#dee2e6' }}
              ></div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function History({ rows }: { rows: HistoryRow[] }) {
  if (!rows.length) return <p className="text-muted">Aucun historique.</p>;
  return (
    <table className="table table-sm">
      <thead>
        <tr>
          <th>Date</th>
          <th>Score global</th>
          <th>Palier</th>
          <th>Continuité</th>
          <th>Critères mesurés</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <td>{fmtDate(r.computedAt)}</td>
            <td>{Math.round(r.globalScore)} / 100</td>
            <td>{LEVELS.find((l) => l.key === r.level)?.label || r.level}</td>
            <td>{r.currentStreakCount}</td>
            <td>{r.measuredCriteriaCount} / 7</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function AutonomyTab() {
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [recomputing, setRecomputing] = useState(false);

  async function load() {
    try {
      const [readinessData, historyData] = await Promise.all([
        apiFetch<Readiness | null>('/reassort/autonomy-readiness'),
        apiFetch<HistoryRow[]>('/reassort/autonomy-readiness/history'),
      ]);
      setReadiness(readinessData);
      setHistory(historyData || []);
      setLoaded(true);
    } catch (err) {
      window.reassortToast
        ? window.reassortToast('Erreur : ' + (err instanceof Error ? err.message : String(err)), 'error')
        : alert(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function recompute() {
    setRecomputing(true);
    try {
      await window.reassortFetch('/reassort/autonomy-readiness/recompute', { method: 'POST' });
      await load();
    } catch (err) {
      window.reassortToast
        ? window.reassortToast('Erreur : ' + (err instanceof Error ? err.message : String(err)), 'error')
        : alert(err instanceof Error ? err.message : String(err));
    } finally {
      setRecomputing(false);
    }
  }

  const streakNote = readiness
    ? readiness.levelConfirmed
      ? `Palier "${LEVELS.find((l) => l.key === readiness.level)?.label}" confirmé (tenu sur ${readiness.currentStreakCount} évaluations consécutives).`
      : `En cours de confirmation (${readiness.currentStreakCount} évaluation(s) consécutive(s) sur le seuil requis) — le palier affiché comme "tenu" reste le dernier confirmé.`
    : loaded
      ? 'Aucune évaluation calculée pour le moment.'
      : '';

  return (
    <div>
      <style>{`
        .autonomy-ladder { display: flex; gap: 8px; flex-wrap: wrap; }
        .autonomy-step { flex: 1; min-width: 180px; border: 2px solid #dee2e6; border-radius: 8px; padding: 12px; text-align: center; }
        .autonomy-step.active { border-color: #198754; background: #d1e7dd; }
        .autonomy-step.pending { border-color: #fd7e14; background: #fff3cd; }
        .criteria-bar { height: 8px; border-radius: 5px; background: #e9ecef; overflow: hidden; }
        .criteria-bar-fill { height: 100%; background: #0d6efd; }
      `}</style>

      <div className="card mb-3">
        <div className="card-body">
          <div className="alert alert-light border small mb-0">
            <strong>À quoi ça sert :</strong> indicateur <strong>purement consultatif</strong> — il ne déclenche
            jamais lui-même un changement de comportement du système. Il mesure, à partir de critères réels (taux
            d'erreur, exactitude, stabilité, détection d'anomalies, résultats après correction), si l'IA progresse
            vers moins de supervision humaine. Un palier n'est affiché comme <strong>atteint</strong> que s'il se
            maintient sur plusieurs évaluations consécutives — jamais sur un seul bon résultat ponctuel — et
            redescend immédiatement si la performance se dégrade. À vous de décider, en vous appuyant sur cet
            indicateur, d'activer ou non davantage d'automatisation (ex: Paramètres &gt; IA &gt; Ajustement IA à la
            génération).
          </div>
        </div>
      </div>

      <div className="card mb-3">
        <div className="card-body">
          <div className="d-flex justify-content-between align-items-center mb-3">
            <h5 className="mb-0">Échelle de supervision</h5>
            <button type="button" className="btn btn-primary btn-sm" disabled={recomputing} onClick={recompute}>
              {recomputing ? 'Calcul en cours...' : 'Recalculer maintenant'}
            </button>
          </div>
          <Ladder readiness={readiness} />
          <div className="small text-muted mt-2">{streakNote}</div>
        </div>
      </div>

      <div className="card mb-3">
        <div className="card-body">
          <h5 className="mb-3">Critères mesurables</h5>
          <Criteria readiness={readiness} />
        </div>
      </div>

      <div className="card mb-3">
        <div className="card-body">
          <h5 className="mb-3">Historique des évaluations</h5>
          <div className="table-responsive">
            <History rows={history} />
          </div>
        </div>
      </div>
    </div>
  );
}
