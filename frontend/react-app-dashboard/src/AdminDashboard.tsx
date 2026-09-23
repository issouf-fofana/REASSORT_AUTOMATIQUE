import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from './api/client';

interface PerShopRow {
  rposShopReference?: string;
  rposShopName?: string;
  rposPosId?: string;
  pendingProposals: number;
  validatedProposals: number;
  conformityRate: number | null;
  rejectionRate: number | null;
  stockoutRate: number | null;
  overstockRate: number | null;
  forecastMAE: number | null;
  lastValidatedAt: string | null;
}

interface Improvement {
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
  title: string;
  scope: string;
  status: string;
}

interface AdminDashboardData {
  totalShops: number;
  totalPendingProposals: number;
  shopsWithPendingProposal: number;
  totalValidatedProposals: number;
  stockoutAlertThreshold: number;
  globalStockoutRate: number | null;
  globalOverstockRate: number | null;
  globalConformityRate: number | null;
  globalAcceptanceRate: number | null;
  globalModificationRate: number | null;
  globalRejectionRate: number | null;
  globalForecastMAE: number | null;
  globalForecastEvaluatedCount: number;
  globalForecastBias: number | null;
  globalForecastWAPE: number | null;
  aiShadowConfidenceRate: number | null;
  aiShadowCorrectedLines: number;
  aiShadowAiRightLines: number;
  perShop: PerShopRow[];
  openImprovements: Improvement[];
}

function pct(rate: number | null | undefined): string {
  return rate === null || rate === undefined ? '—' : Math.round(rate * 100) + '%';
}

function num(value: number | null | undefined, decimals = 1): string {
  return value === null || value === undefined ? '—' : value.toFixed(decimals);
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('fr-FR') + ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

const SEVERITY_BADGE: Record<string, string> = {
  CRITICAL: 'bg-danger',
  WARNING: 'bg-warning text-dark',
  INFO: 'bg-info-subtle text-info',
};

function StatusCard({
  label,
  value,
  sub,
  isAlert,
}: {
  label: string;
  value: string;
  sub: string;
  isAlert: boolean;
}) {
  return (
    <div className={`status-card${isAlert ? ' is-alert' : ''}`}>
      <p className="status-metric-label">{label}</p>
      <div className="status-metric-value">{value}</div>
      <p className="status-metric-sub">{sub}</p>
    </div>
  );
}

export function AdminDashboard() {
  const [data, setData] = useState<AdminDashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await apiFetch<AdminDashboardData>('/reassort/admin/dashboard');
      setData(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const stockoutAlertThreshold = data?.stockoutAlertThreshold;

  return (
    <div>
      <style>{`
        .status-cards { display: flex; flex-wrap: wrap; gap: 1rem; }
        .status-card {
          flex: 1 1 220px;
          background-color: #ffffff;
          border: 1px solid #e5e5e5;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06), 0 1px 2px rgba(0, 0, 0, 0.08);
          padding: 1.25rem 1.5rem;
        }
        .status-card.is-alert { background-color: #FEF2F2; border-color: #F5C2C2; }
        .status-metric-label { font-size: .8125rem; color: var(--bs-secondary-color, #6c757d); margin: 0 0 .35rem; }
        .status-metric-value {
          font-size: 2.25rem; font-weight: 700; line-height: 1;
          font-variant-numeric: tabular-nums; letter-spacing: -.01em; color: #111111;
        }
        .status-card.is-alert .status-metric-value { color: var(--accent-off, #B91C1C); }
        .status-metric-sub { font-size: .75rem; color: var(--bs-secondary-color, #6c757d); margin-top: .35rem; }
        .status-strip-context { font-size: .8125rem; color: var(--bs-secondary-color, #6c757d); margin-bottom: .85rem; }
        .metric-row { display: flex; flex-wrap: wrap; }
        .metric-row-item { flex: 1 1 180px; padding: 1rem 1.5rem 1rem 0; border-right: 1px solid var(--bs-border-color, #dee2e6); }
        .metric-row-item:last-child { border-right: none; }
        .metric-label { font-size: .8125rem; color: var(--bs-secondary-color, #6c757d); margin: 0 0 .35rem; }
        .metric-value { font-size: 1.5rem; font-weight: 600; line-height: 1.15; font-variant-numeric: tabular-nums; margin: 0; }
        .metric-value.is-bad { color: #B91C1C; }
        .metric-sub { font-size: .75rem; color: var(--bs-secondary-color, #6c757d); margin-top: .25rem; }
        @media (max-width: 767px) {
          .metric-row-item { border-right: none; border-bottom: 1px solid var(--bs-border-color, #dee2e6); }
        }
      `}</style>

      <div className="d-flex justify-content-between align-items-center mb-3">
        <h4 className="mb-0">Vue globale — tous les magasins</h4>
        <button className="btn btn-sm btn-outline-secondary" disabled={loading} onClick={load}>
          <iconify-icon icon="solar:refresh-bold-duotone" className="align-middle"></iconify-icon>
          Actualiser
        </button>
      </div>

      {error && (
        <div className="alert alert-danger">Erreur: {error}</div>
      )}

      {data && (
        <>
          <p className="status-strip-context">
            <span>{data.totalShops}</span> magasin(s) actif(s) &nbsp;·&nbsp;{' '}
            <span>{data.totalPendingProposals}</span> proposition(s) en attente (
            <span>{data.shopsWithPendingProposal} magasin(s) concerné(s)</span>) &nbsp;·&nbsp;{' '}
            <span>{data.totalValidatedProposals}</span> commande(s) validée(s) &nbsp;·&nbsp;{' '}
            <span>{data.shopsWithPendingProposal}</span> magasin(s) avec proposition
          </p>

          <div className="status-cards mb-3">
            <StatusCard
              label="Rupture globale"
              value={pct(data.globalStockoutRate)}
              sub="articles déjà en rupture à la génération"
              isAlert={
                data.globalStockoutRate !== null &&
                data.globalStockoutRate !== undefined &&
                stockoutAlertThreshold !== undefined &&
                data.globalStockoutRate > stockoutAlertThreshold
              }
            />
            <StatusCard
              label="Surstock global"
              value={pct(data.globalOverstockRate)}
              sub="quantité validée bien au-delà du besoin théorique"
              isAlert={data.globalOverstockRate !== null && data.globalOverstockRate !== undefined && data.globalOverstockRate > 0.1}
            />
            <StatusCard
              label="Conformité globale"
              value={pct(data.globalConformityRate)}
              sub="propositions validées sans modification"
              isAlert={data.globalConformityRate !== null && data.globalConformityRate !== undefined && data.globalConformityRate < 0.6}
            />
          </div>

          <div className="card mb-3">
            <div className="card-header">
              <h4 className="card-title mb-0">
                Précision des prévisions IA <span className="text-muted small fw-normal">(§23)</span>
              </h4>
            </div>
            <div className="card-body py-2">
              <div className="metric-row">
                <div className="metric-row-item">
                  <p className="metric-label">Taux d'acceptation</p>
                  <p className="metric-value">{pct(data.globalAcceptanceRate)}</p>
                  <p className="metric-sub">acceptée telle quelle par l'utilisateur</p>
                </div>
                <div className="metric-row-item">
                  <p className="metric-label">Taux de modification</p>
                  <p className="metric-value">{pct(data.globalModificationRate)}</p>
                  <p className="metric-sub">quantité changée par l'utilisateur</p>
                </div>
                <div className="metric-row-item">
                  <p className="metric-label">Taux de rejet</p>
                  <p
                    className={`metric-value${data.globalRejectionRate !== null && data.globalRejectionRate > 0.3 ? ' is-bad' : ''}`}
                  >
                    {pct(data.globalRejectionRate)}
                  </p>
                  <p className="metric-sub">article décoché par l'utilisateur</p>
                </div>
                <div className="metric-row-item">
                  <p className="metric-label">Erreur moy. (MAE)</p>
                  <p className="metric-value">{num(data.globalForecastMAE, 1)}</p>
                  <p className="metric-sub">
                    {data.globalForecastEvaluatedCount
                      ? `écart absolu moyen (${data.globalForecastEvaluatedCount} prévisions évaluées)`
                      : 'aucune prévision évaluée sur la période'}
                  </p>
                </div>
                <div className="metric-row-item">
                  <p className="metric-label">Biais / WAPE</p>
                  <p className="metric-value">{num(data.globalForecastBias, 1)}</p>
                  <p className="metric-sub">{pct(data.globalForecastWAPE)} WAPE — biais &gt; 0 : sur-prévision</p>
                </div>
                <div className="metric-row-item">
                  <p className="metric-label">
                    Confiance IA{' '}
                    <a href="/ai-autonomy" className="text-muted" title="Voir le détail (Mode Simulation)">
                      <iconify-icon icon="solar:square-top-down-bold-duotone"></iconify-icon>
                    </a>
                  </p>
                  <p className="metric-value">{pct(data.aiShadowConfidenceRate)}</p>
                  <p className="metric-sub">
                    {data.aiShadowCorrectedLines
                      ? `l'IA avait raison sur ${data.aiShadowAiRightLines}/${data.aiShadowCorrectedLines} corrections humaines`
                      : 'aucune correction humaine mesurable sur la période'}
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="row">
            <div className="col-12">
              <div className="card">
                <div className="card-header d-flex justify-content-between align-items-center">
                  <h4 className="card-title mb-0">Constats à traiter (Conseiller d'amélioration IA)</h4>
                  <a href="/ai-improvements" className="small">
                    Voir tout &rarr;
                  </a>
                </div>
                <div className="card-body p-0">
                  {!data.openImprovements.length ? (
                    <div className="text-center text-muted py-3 small">
                      Aucun constat ouvert — le système ne détecte aucun problème silencieux pour le moment.
                    </div>
                  ) : (
                    <div className="list-group list-group-flush">
                      {data.openImprovements.map((imp, i) => (
                        <div key={i} className="list-group-item d-flex align-items-center justify-content-between gap-2">
                          <div>
                            <span className={`badge ${SEVERITY_BADGE[imp.severity] || 'bg-secondary'} me-2`}>
                              {imp.severity}
                            </span>
                            <span>{imp.title}</span>
                            <span className="text-muted small ms-2">{imp.scope === 'global' ? 'Global' : imp.scope}</span>
                          </div>
                          <span className="badge bg-light text-dark border">{imp.status}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="row">
            <div className="col-12">
              <div className="card">
                <div className="card-header d-flex justify-content-between align-items-center">
                  <h4 className="card-title mb-0">Performance par magasin</h4>
                  <span className="text-muted small">{loading ? 'Chargement...' : ''}</span>
                </div>
                <div className="card-body p-0">
                  <div className="table-responsive">
                    <table className="table align-middle mb-0 table-hover table-centered">
                      <thead className="bg-light-subtle">
                        <tr>
                          <th>Magasin</th>
                          <th>Serveur</th>
                          <th className="text-end">En attente</th>
                          <th className="text-end">Validées</th>
                          <th className="text-end">Conformité</th>
                          <th className="text-end">Rejet</th>
                          <th className="text-end">Rupture</th>
                          <th className="text-end">Surstock</th>
                          <th className="text-end">MAE</th>
                          <th>Dernière validation</th>
                        </tr>
                      </thead>
                      <tbody>
                        {!data.perShop.length ? (
                          <tr>
                            <td colSpan={10} className="text-center text-muted py-4">
                              Aucun magasin avec un compte actif pour le moment.
                            </td>
                          </tr>
                        ) : (
                          data.perShop.map((s, i) => {
                            const isStockoutAlert =
                              s.stockoutRate !== null && stockoutAlertThreshold !== undefined && s.stockoutRate > stockoutAlertThreshold;
                            return (
                              <tr key={i}>
                                <td>
                                  <strong>{s.rposShopReference || '—'}</strong> — {s.rposShopName || ''}
                                </td>
                                <td>{s.rposPosId || '—'}</td>
                                <td className="text-end">{s.pendingProposals}</td>
                                <td className="text-end">{s.validatedProposals}</td>
                                <td className="text-end">{pct(s.conformityRate)}</td>
                                <td className="text-end">{pct(s.rejectionRate)}</td>
                                <td className={`text-end${isStockoutAlert ? ' text-danger fw-semibold' : ''}`}>
                                  {pct(s.stockoutRate)}
                                </td>
                                <td className="text-end">{pct(s.overstockRate)}</td>
                                <td className="text-end">{num(s.forecastMAE, 1)}</td>
                                <td>{formatDate(s.lastValidatedAt)}</td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
