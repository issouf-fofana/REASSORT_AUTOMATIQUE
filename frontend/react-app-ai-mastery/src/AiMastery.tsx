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

const DOMAIN_ICON: Record<string, string> = {
  revenueShop: 'solar:shop-bold-duotone',
  revenueArticle: 'solar:tag-price-bold-duotone',
  articleDetails: 'solar:box-bold-duotone',
  stock: 'solar:archive-bold-duotone',
  sales: 'solar:chart-2-bold-duotone',
  orders: 'solar:cart-check-bold-duotone',
  accuracy: 'solar:target-bold-duotone',
  code: 'solar:code-bold-duotone',
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
    <div className="mastery-card">
      <div className="mastery-card-header">
        <div className="mastery-domain-icon">
          <iconify-icon icon={DOMAIN_ICON[m.domain] || 'solar:widget-2-bold-duotone'}></iconify-icon>
        </div>
        <h6 className="mastery-domain-title mb-0">{DOMAIN_LABEL[m.domain] || m.domain}</h6>
        <span className="mastery-method-badge">{METHOD_LABEL[m.method] || m.method}</span>
      </div>

      <div className="mastery-metrics">
        <div className="mastery-metric mastery-metric-primary">
          <div className="d-flex justify-content-between align-items-baseline mb-1">
            <span className="mastery-metric-label">Maîtrise</span>
            <span className={`mastery-metric-value ${barClass(m.masteryScore)}`}>{Math.round(m.masteryScore)}<span className="mastery-metric-max">/100</span></span>
          </div>
          <div className="mastery-bar">
            <div className={`mastery-bar-fill ${barClass(m.masteryScore)}`} style={{ width: `${Math.round(m.masteryScore)}%` }}></div>
          </div>
        </div>
        <div className="mastery-metric">
          <div className="d-flex justify-content-between align-items-baseline mb-1">
            <span className="mastery-metric-label">Confiance (taille échantillon)</span>
            <span className="mastery-metric-value-secondary">{Math.round(m.confidenceScore)}<span className="mastery-metric-max">/100</span></span>
          </div>
          <div className="mastery-bar">
            <div className="mastery-bar-fill mastery-bar-secondary" style={{ width: `${Math.round(m.confidenceScore)}%` }}></div>
          </div>
        </div>
      </div>

      <div className="mastery-footer">
        {m.totalObservations} observation(s) &nbsp;·&nbsp; {m.correctionCount} correction(s) journalisée(s) &nbsp;·&nbsp; dernier calcul : {fmtDate(m.lastEvaluatedAt)}
      </div>

      {!!m.knownIssues?.length && (
        <div className="mastery-issues">
          <div className="mastery-issues-label">Erreurs récurrentes</div>
          <ul className="mastery-issues-list">
            {m.knownIssues.map((i, idx) => (
              <li key={idx}>
                {i.label} <span className="mastery-issue-count">×{i.count}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
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
        /* Recoloré en marine/ambre (01/10/2026, "applique le nouveau style") — garde les couleurs
           sémantiques vert/ambre/rouge pour les niveaux de maîtrise (un vrai statut, pas une
           variation arbitraire de couleur par carte). */
        .mastery-intro {
          background: #F7F9FC;
          border: 1px solid #e9ecf2;
          border-radius: 12px;
          padding: 1.1rem 1.35rem;
          margin-bottom: 1.5rem;
          font-size: .87rem;
          color: #44516B;
          line-height: 1.6;
        }
        .mastery-intro strong { color: #1B2A4A; }

        .mastery-toolbar {
          display: flex;
          align-items: center;
          gap: 1rem;
          flex-wrap: wrap;
          margin-bottom: 1.5rem;
        }
        .mastery-toolbar-btn {
          background: #1B2A4A; border: 1px solid #1B2A4A; color: #fff;
        }
        .mastery-toolbar-btn:hover, .mastery-toolbar-btn:focus { background: #14203a; border-color: #14203a; color: #fff; }
        .mastery-toolbar-btn:disabled { opacity: .6; color: #fff; }
        .mastery-toolbar-count { color: #8a93a8; font-size: .82rem; margin-left: auto; font-weight: 600; }

        .mastery-card {
          background: #ffffff;
          border: 1px solid #e9ecf2;
          border-radius: 14px;
          padding: 1.25rem 1.5rem;
          margin-bottom: 1rem;
          box-shadow: 0 1px 3px rgba(27, 42, 74, .05);
          transition: box-shadow .2s ease, border-color .2s ease;
        }
        .mastery-card:hover { box-shadow: 0 8px 20px rgba(27, 42, 74, .1); border-color: #c7d2e8; }

        .mastery-card-header { display: flex; align-items: center; gap: .75rem; margin-bottom: 1.1rem; }
        .mastery-domain-icon {
          width: 36px; height: 36px; border-radius: 10px;
          display: flex; align-items: center; justify-content: center;
          background: #1B2A4A; color: #F5A623; font-size: 1.1rem; flex-shrink: 0;
        }
        .mastery-domain-title { font-size: 1rem; font-weight: 700; color: #1B2A4A; }
        .mastery-method-badge {
          margin-left: auto;
          font-size: .68rem; font-weight: 600; text-transform: uppercase; letter-spacing: .04em;
          color: #5B6B85; background: #EDF1F7; border-radius: 999px; padding: .3rem .7rem;
          white-space: nowrap;
        }

        .mastery-metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; margin-bottom: 1rem; }
        @media (max-width: 767px) { .mastery-metrics { grid-template-columns: 1fr; gap: 1rem; } }
        .mastery-metric-label { font-size: .78rem; color: #5B6B85; font-weight: 500; }
        .mastery-metric-value { font-size: 1.05rem; font-weight: 700; }
        .mastery-metric-value-secondary { font-size: 1.05rem; font-weight: 700; color: #5B6B85; }
        .mastery-metric-max { font-size: .72rem; font-weight: 500; color: #9aa7c2; margin-left: 1px; }
        .mastery-metric-value.mastery-high { color: #047857; }
        .mastery-metric-value.mastery-mid { color: #8A5A00; }
        .mastery-metric-value.mastery-low { color: #7A4A45; }

        .mastery-bar { height: 6px; border-radius: 999px; background: #EDF1F7; overflow: hidden; }
        .mastery-bar-fill { height: 100%; border-radius: 999px; transition: width .3s ease; }
        .mastery-bar-fill.mastery-bar-secondary { background-color: #9aa7c2; }
        .mastery-bar-fill.mastery-high { background-color: #10b981; }
        .mastery-bar-fill.mastery-mid { background-color: #F5A623; }
        .mastery-bar-fill.mastery-low { background-color: #c0392b; }

        .mastery-footer { font-size: .78rem; color: #8a93a8; padding-top: .85rem; border-top: 1px solid #EDF1F7; }

        .mastery-issues { margin-top: .85rem; padding-top: .85rem; border-top: 1px solid #EDF1F7; }
        .mastery-issues-label { font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: #8a93a8; margin-bottom: .4rem; }
        .mastery-issues-list { margin: 0; padding-left: 1.1rem; font-size: .85rem; color: #33415C; }
        .mastery-issues-list li { margin-bottom: .2rem; }
        .mastery-issue-count { color: #8a93a8; font-size: .8rem; }
      `}</style>

      <div className="mastery-intro">
        <strong>À quoi ça sert :</strong> pour chaque domaine métier, ce tableau montre le niveau de maîtrise appris au fil du temps. Deux
        méthodes de calcul coexistent selon les données disponibles : <strong>Précision réelle</strong> compare directement la prédiction du
        système à la vente réellement constatée (vérité terrain fiable) — <strong>Volume de corrections</strong> se base sur le nombre et
        l'ancienneté des corrections journalisées sur ce domaine, faute de vérité terrain disponible aujourd'hui pour cette capacité (moins
        précis, mais honnête sur ce qui est réellement mesuré). Une confiance basse signale un échantillon encore trop petit pour se fier
        pleinement au score affiché.
      </div>

      <div className="mastery-toolbar">
        <button type="button" className="btn mastery-toolbar-btn" disabled={recomputing} onClick={recompute}>
          {recomputing ? 'Calcul en cours...' : 'Recalculer maintenant'}
        </button>
        <span className="mastery-toolbar-count">{rows ? `${rows.length} domaine(s)` : ''}</span>
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
