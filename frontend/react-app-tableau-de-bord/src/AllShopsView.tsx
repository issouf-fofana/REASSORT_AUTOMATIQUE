import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from './api/client';
import { Pagination } from './Pagination';
import type { AdminDashboardData, PerShopRow } from './types';

const PAGE_SIZE = 10;

// Vue "Tous les magasins" (fusion de l'ancienne page Vue globale /admin-dashboard, 30/09/2026) —
// même endpoint et même contenu que l'ancien AdminDashboard.tsx (react-app-dashboard/), adapté à la
// palette marine/ambre déjà en place sur le Tableau de bord.

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
  CRITICAL: 'reassort-badge-soft-danger',
  WARNING: 'reassort-badge-soft-warning',
  INFO: 'reassort-badge-soft-info',
};

function StatusCard({
  label,
  value,
  sub,
  isAlert,
  icon,
}: {
  label: string;
  value: string;
  sub: string;
  isAlert: boolean;
  icon: string;
}) {
  return (
    <div className="col">
      <div className={`card kpi-card h-100 mb-0${isAlert ? ' kpi-card-alert' : ''}`}>
        <div className="card-body d-flex align-items-start gap-2">
          <div className={`kpi-icon${isAlert ? '' : ' kpi-icon-neutral'}`}>
            <iconify-icon icon={icon}></iconify-icon>
          </div>
          <div>
            <p className="kpi-label">{label}</p>
            <h3 className="kpi-value">{value}</h3>
          </div>
        </div>
        <div className="kpi-footer">{sub}</div>
      </div>
    </div>
  );
}

export function AllShopsView() {
  const [data, setData] = useState<AdminDashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await apiFetch<AdminDashboardData>('/reassort/admin/dashboard');
      setData(d);
      setPage(1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const stockoutAlertThreshold = data?.stockoutAlertThreshold;

  // Magasins avec de l'activité réelle (propositions en attente ou validées) en premier, plutôt que
  // l'ordre brut renvoyé par le backend — sur 53 magasins, la plupart n'ont rien de récent et
  // noyaient les lignes utiles en fin de tableau interminable (signalé le 30/09/2026).
  const sortedPerShop: PerShopRow[] = data
    ? [...data.perShop].sort((a, b) => (b.pendingProposals + b.validatedProposals) - (a.pendingProposals + a.validatedProposals))
    : [];
  const pageCount = Math.max(1, Math.ceil(sortedPerShop.length / PAGE_SIZE));
  const pagedPerShop = sortedPerShop.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div>
      <style>{`
        /* Cartes claires avec bordure (01/10/2026, "trop fort" en fond marine plein — revenu au
           style blanc/bordure cohérent avec le reste du site). Icône neutre par défaut (30/09/2026,
           "pas pro" : toutes les icônes ressortaient en ambre même hors alerte) — seule une carte
           réellement EN ALERTE (isAlert) prend l'accent ambre ; les autres restent sur un badge
           bleu-gris neutre. */
        .kpi-icon.kpi-icon-neutral { background: #EDF1F7 !important; }
        .kpi-icon.kpi-icon-neutral iconify-icon { color: #5B6B85 !important; }
        .kpi-card-alert { border-color: #F5A623; }
        .kpi-card-alert .kpi-value { color: #8A5A00; }
        .metric-row { display: flex; flex-wrap: wrap; }
        .metric-row-item { flex: 1 1 180px; padding: 1rem 1.2rem 1rem 0; border-right: 1px solid #EDF1F7; }
        .metric-row-item:last-child { border-right: none; }
        .metric-value { font-size: 1.4rem; font-weight: 700; line-height: 1.15; margin: 0; color: #1B2A4A; }
        /* Valeur en alerte : fond ambre clair + texte marine (même logique que
           .reassort-badge-soft-warning). */
        .metric-value.is-bad { display: inline-block; background: #FDF1DD; color: #8A5A00; padding: .1rem .5rem; border-radius: 6px; }
        @media (max-width: 767px) { .metric-row-item { border-right: none; border-bottom: 1px solid #EDF1F7; } }
      `}</style>

      <div className="d-flex justify-content-between align-items-center mb-3">
        <div className="text-muted small">
          {data ? (
            <>
              <strong>{data.totalShops}</strong> magasin(s) actif(s) · <strong>{data.totalPendingProposals}</strong> proposition(s) en attente
              ({data.shopsWithPendingProposal} magasin(s)) · <strong>{data.totalValidatedProposals}</strong> commande(s) validée(s)
            </>
          ) : null}
        </div>
        <button className="btn btn-sm reassort-btn-navy-outline" disabled={loading} onClick={load}>
          <iconify-icon icon="solar:refresh-bold-duotone" className="align-middle"></iconify-icon> Actualiser
        </button>
      </div>

      {error && <div className="alert alert-danger">Erreur : {error}</div>}

      {data && (
        <>
          <div className="row row-cols-1 row-cols-md-3 g-3 mb-3">
            <StatusCard
              icon="solar:danger-triangle-bold-duotone"
              label="Rupture globale"
              value={pct(data.globalStockoutRate)}
              sub="articles déjà en rupture à la génération"
              isAlert={data.globalStockoutRate !== null && stockoutAlertThreshold !== undefined && data.globalStockoutRate > stockoutAlertThreshold}
            />
            <StatusCard
              icon="solar:box-bold-duotone"
              label="Surstock global"
              value={pct(data.globalOverstockRate)}
              sub="quantité validée bien au-delà du besoin théorique"
              isAlert={data.globalOverstockRate !== null && data.globalOverstockRate > 0.1}
            />
            <StatusCard
              icon="solar:double-check-bold-duotone"
              label="Conformité globale"
              value={pct(data.globalConformityRate)}
              sub="propositions validées sans modification"
              isAlert={data.globalConformityRate !== null && data.globalConformityRate < 0.6}
            />
          </div>

          <div className="card kpi-card mb-3">
            <div className="card-body">
              <h5 className="mb-3" style={{ color: '#1B2A4A', fontWeight: 600, fontSize: '.95rem' }}>Précision des prévisions IA</h5>
              <div className="metric-row">
                <div className="metric-row-item">
                  <p className="kpi-label">Taux d'acceptation</p>
                  <p className="metric-value">{pct(data.globalAcceptanceRate)}</p>
                </div>
                <div className="metric-row-item">
                  <p className="kpi-label">Taux de modification</p>
                  <p className="metric-value">{pct(data.globalModificationRate)}</p>
                </div>
                <div className="metric-row-item">
                  <p className="kpi-label">Taux de rejet</p>
                  <p className={`metric-value${data.globalRejectionRate !== null && data.globalRejectionRate > 0.3 ? ' is-bad' : ''}`}>
                    {pct(data.globalRejectionRate)}
                  </p>
                </div>
                <div className="metric-row-item">
                  <p className="kpi-label">Erreur moy. (MAE)</p>
                  <p className="metric-value">{num(data.globalForecastMAE, 1)}</p>
                </div>
                <div className="metric-row-item">
                  <p className="kpi-label">Biais / WAPE</p>
                  <p className="metric-value">{num(data.globalForecastBias, 1)}</p>
                  <p className="text-muted small mb-0" style={{ color: '#8a93a8' }}>
                    {data.globalForecastWAPE !== null ? `${pct(data.globalForecastWAPE)} WAPE` : 'WAPE non mesurable'}
                  </p>
                </div>
                <div className="metric-row-item">
                  <p className="kpi-label">Confiance IA</p>
                  <p className="metric-value">{pct(data.aiShadowConfidenceRate)}</p>
                </div>
              </div>
            </div>
          </div>

          <div className="card kpi-card kpi-card-chart mb-3">
            <div className="card-body">
              <div className="d-flex justify-content-between align-items-center mb-2">
                <h5 className="mb-0" style={{ color: '#1B2A4A', fontWeight: 600, fontSize: '.95rem' }}>Constats à traiter</h5>
                <a href="/ai-quality#tab-corrections" className="small">Voir tout →</a>
              </div>
              {!data.openImprovements.length ? (
                <div className="text-muted small py-2">Aucun constat ouvert.</div>
              ) : (
                <div className="list-group list-group-flush">
                  {data.openImprovements.map((imp, i) => (
                    <div key={i} className="list-group-item d-flex align-items-center justify-content-between gap-2">
                      <div>
                        <span className={`badge ${SEVERITY_BADGE[imp.severity] || 'reassort-badge-neutral'} me-2`}>{imp.severity}</span>
                        <span>{imp.title}</span>
                        <span className="text-muted small ms-2">{imp.scope === 'global' ? 'Global' : imp.scope}</span>
                      </div>
                      <span className="badge reassort-badge-neutral border">{imp.status}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="card kpi-card-chart">
            <div className="card-header bg-transparent">
              <h5 className="mb-0" style={{ color: '#1B2A4A', fontWeight: 600, fontSize: '.95rem' }}>Performance par magasin</h5>
              <p className="text-muted small mb-0 mt-1">
                Un magasin par ligne : propositions en attente/validées, taux de conformité/rejet/rupture/surstock et précision des
                prévisions (MAE), calculés sur ses propositions validées. Les magasins avec de l'activité récente apparaissent en premier.
              </p>
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
                    {!sortedPerShop.length ? (
                      <tr><td colSpan={10} className="text-center text-muted py-4">Aucun magasin avec un compte actif pour le moment.</td></tr>
                    ) : (
                      pagedPerShop.map((s, i) => {
                        const isStockoutAlert = s.stockoutRate !== null && stockoutAlertThreshold !== undefined && s.stockoutRate > stockoutAlertThreshold;
                        return (
                          <tr key={i}>
                            <td><strong>{s.rposShopReference || '—'}</strong> — {s.rposShopName || ''}</td>
                            <td>{s.rposPosId || '—'}</td>
                            <td className="text-end">{s.pendingProposals}</td>
                            <td className="text-end">{s.validatedProposals}</td>
                            <td className="text-end">{pct(s.conformityRate)}</td>
                            <td className="text-end">{pct(s.rejectionRate)}</td>
                            <td className={`text-end${isStockoutAlert ? ' text-danger fw-semibold' : ''}`}>{pct(s.stockoutRate)}</td>
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
              <Pagination page={page} pageCount={pageCount} onChange={setPage} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
