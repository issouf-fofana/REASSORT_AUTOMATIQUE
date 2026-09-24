import { useEffect, useState } from 'react';
import { apiFetch } from './api/client';
import type { MasteryDomain } from './types';

const DOMAIN_LABEL: Record<string, string> = {
  revenueShop: 'CA magasin',
  revenueArticle: 'CA article/rayon',
  articleDetails: 'Fiche article',
  stock: 'Stock',
  sales: 'Ventes',
  orders: 'Commandes',
  accuracy: 'Précision des prévisions',
  code: 'Code / technique',
};

const METHOD_LABEL: Record<string, string> = {
  ACCURACY_OUTCOME: 'Précision réelle (vérité terrain)',
  CORRECTION_VOLUME: 'Volume de corrections',
};

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString('fr-FR') : 'jamais calculé';
}

function barClass(score: number): string {
  if (score >= 80) return 'mastery-high';
  if (score >= 50) return 'mastery-mid';
  return 'mastery-low';
}

function DomainCard({ m }: { m: MasteryDomain }) {
  return (
    <div className="card mb-2">
      <div className="card-body">
        <div className="d-flex justify-content-between align-items-center flex-wrap gap-2">
          <h6 className="mb-0">{DOMAIN_LABEL[m.domain] || m.domain}</h6>
          <span className="badge bg-secondary">{METHOD_LABEL[m.method] || m.method}</span>
        </div>
        <div className="row mt-2 align-items-center">
          <div className="col-md-6">
            <div className="d-flex justify-content-between small mb-1">
              <span>Maîtrise</span>
              <span>{Math.round(m.masteryScore)} / 100</span>
            </div>
            <div className="mastery-bar">
              <div className={`mastery-bar-fill ${barClass(m.masteryScore)}`} style={{ width: `${Math.round(m.masteryScore)}%` }}></div>
            </div>
          </div>
          <div className="col-md-6">
            <div className="d-flex justify-content-between small mb-1">
              <span>Confiance (taille échantillon)</span>
              <span>{Math.round(m.confidenceScore)} / 100</span>
            </div>
            <div className="mastery-bar">
              <div className="mastery-bar-fill bg-secondary" style={{ width: `${Math.round(m.confidenceScore)}%` }}></div>
            </div>
          </div>
        </div>
        <div className="small text-muted mt-2">
          {m.totalObservations} observation(s) — {m.correctionCount} correction(s) journalisée(s) — dernier calcul : {fmtDate(m.lastEvaluatedAt)}
        </div>
        {!!m.knownIssues?.length && (
          <div className="small mt-2">
            <strong>Erreurs récurrentes :</strong>
            <ul className="mb-0">
              {m.knownIssues.map((i, idx) => (
                <li key={idx}>
                  {i.label} <span className="text-muted">(x{i.count})</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

export function AiMastery() {
  const [rows, setRows] = useState<MasteryDomain[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recomputing, setRecomputing] = useState(false);

  async function load() {
    setError(null);
    try {
      const data = await apiFetch<MasteryDomain[]>('/reassort/mastery');
      setRows(data || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function recompute() {
    setRecomputing(true);
    try {
      const data = await apiFetch<MasteryDomain[]>('/reassort/mastery/recompute', { method: 'POST' });
      setRows(data || []);
    } catch (err) {
      window.reassortToast ? window.reassortToast('Erreur : ' + (err instanceof Error ? err.message : String(err)), 'error') : alert(err);
    } finally {
      setRecomputing(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <div>
      <style>{`
        .mastery-bar { height: 10px; border-radius: 6px; background: #e9ecef; overflow: hidden; }
        .mastery-bar-fill { height: 100%; }
        .mastery-high { background-color: #198754; }
        .mastery-mid { background-color: #fd7e14; }
        .mastery-low { background-color: #dc3545; }
      `}</style>

      <div className="card mb-3">
        <div className="card-body">
          <div className="alert alert-light border small mb-0">
            <strong>À quoi ça sert :</strong> pour chaque domaine métier, ce tableau montre le niveau de maîtrise appris au fil du temps. Deux
            méthodes de calcul coexistent selon les données disponibles : <strong>Précision réelle</strong> compare directement la prédiction du
            système à la vente réellement constatée (vérité terrain fiable) — <strong>Volume de corrections</strong> se base sur le nombre et
            l'ancienneté des corrections journalisées sur ce domaine, faute de vérité terrain disponible aujourd'hui pour cette capacité (moins
            précis, mais honnête sur ce qui est réellement mesuré). Une confiance basse signale un échantillon encore trop petit pour se fier
            pleinement au score affiché.
          </div>
        </div>
      </div>

      <div className="card mb-3">
        <div className="card-body d-flex flex-wrap gap-2 align-items-center">
          <button type="button" className="btn btn-primary" disabled={recomputing} onClick={recompute}>
            {recomputing ? 'Calcul en cours...' : 'Recalculer maintenant'}
          </button>
          <span className="small text-muted ms-auto">{rows ? `${rows.length} domaine(s)` : ''}</span>
        </div>
      </div>

      {error ? (
        <div className="alert alert-danger">{error}</div>
      ) : rows === null ? (
        <div className="text-center text-muted py-4">Chargement...</div>
      ) : rows.length === 0 ? (
        <div className="text-center text-muted py-4">Aucune donnée.</div>
      ) : (
        rows.map((m) => <DomainCard m={m} key={m.domain} />)
      )}
    </div>
  );
}
