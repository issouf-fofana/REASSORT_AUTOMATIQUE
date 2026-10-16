import { useEffect, useState } from 'react';
import { apiFetch } from '../../shared/api/client';
import { StockoutsAllShopsView } from './StockoutsAllShopsView';
import { StockoutsByDepartmentView } from './StockoutsByDepartmentView';
import { EpisodeDetailModal } from './EpisodeDetailModal';
import { StockoutTrendChart } from './StockoutTrendChart';
import { StockoutCauseChart } from './StockoutCauseChart';

// Module Ruptures (cf. rupture.md, 16/10/2026) — page séparée dans la sidebar (demande du
// 16/10/2026 : d'abord intégrée en bas du Tableau de bord, puis déplacée ici sur demande explicite
// "il doit etre une page separé"). Diagnostic SIMPLIFIÉ, sans les données Cyrus (entrepôt) : on ne
// distingue pas "stock central indisponible" / "non préparé" / "retard transport", ces 3 cas
// retombent tous sur AMONT_A_PRECISER (cf. stockoutEpisodeService.js côté backend).
type StockoutEpisode = {
  id: string;
  ean: string;
  label: string | null;
  department: string | null;
  startedAt: string;
  durationHours: number;
  causeProposee: string;
  niveauConfiance: string;
};

type StockoutSummary = {
  openCount: number;
  avgDurationHours: number;
  totalCaPerduEstime: number;
  causeCounts: Record<string, number>;
  openEpisodes: StockoutEpisode[];
};

const CAUSE_LABELS: Record<string, string> = {
  MAGASIN_REASSORT: 'Magasin / réassort',
  MAGASIN_COMMANDE_NON_VALIDEE: 'Commande non validée',
  AMONT_A_PRECISER: 'Amont — à préciser',
  ECART_STOCK_RAYON: 'Écart stock / rayon',
  INDETERMINEE: 'Indéterminée',
};

const CONFIDENCE_BADGE: Record<string, string> = {
  CONFIRMEE: 'reassort-badge-soft-success',
  PROBABLE: 'reassort-badge-soft-warning',
  INDETERMINEE: 'reassort-badge-neutral',
};

function formatDuration(hours: number): string {
  if (hours < 24) return `${Math.round(hours)} h`;
  const days = Math.floor(hours / 24);
  const rest = Math.round(hours % 24);
  return `${days} j ${rest} h`;
}

export function Stockouts() {
  const [user] = useState(() => window.reassortGetUser());
  const isSingleShop = user ? window.reassortIsSingleShopRole(user.role) : true;
  const [selectedShop, setSelectedShop] = useState<{ id: string; posId?: string } | null>(null);
  const [selectedEpisodeId, setSelectedEpisodeId] = useState<string | null>(null);

  // Onglets "Ce magasin" / "Tous les magasins" / "Par rayon" (spec rupture.md §2 et §7, demande
  // explicite du 16/10/2026 : "tout doit etre dans le dashbord des rupture pas l'autre" — même
  // pattern que TableauDeBord.tsx, pas de page séparée pour ces vues).
  const [activeTab, setActiveTab] = useState<'shop' | 'all' | 'department'>('shop');
  // Filtre appliqué à la table "Ce magasin" après un clic dans "Par rayon" (drill-down) — purement
  // côté client, summary.openEpisodes est déjà chargé en entier, pas de second appel API.
  const [departmentFilter, setDepartmentFilter] = useState<string | null>(null);

  const [summary, setSummary] = useState<StockoutSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  function shopQueryParam(): string {
    const id = isSingleShop ? user?.rposShopId || '' : selectedShop?.id || '';
    const pos = isSingleShop ? user?.rposPosId || '' : selectedShop?.posId || '';
    if (!id) return '';
    return `shop=${encodeURIComponent(id)}${pos ? '&pos=' + encodeURIComponent(pos) : ''}`;
  }

  // Compte ADMIN/SUPERVISOR : suit le sélecteur GLOBAL de la topbar, même pattern que
  // TableauDeBord.tsx (window.reassortGetActiveShop/reassortOnActiveShopChange).
  useEffect(() => {
    if (isSingleShop) return;
    const active = window.reassortGetActiveShop ? window.reassortGetActiveShop() : null;
    if (active) setSelectedShop(active);
    if (window.reassortOnActiveShopChange) {
      window.reassortOnActiveShopChange((shop) => setSelectedShop(shop ?? null));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSingleShop]);

  useEffect(() => {
    const qs = shopQueryParam();
    if (!qs) return;
    let cancelled = false;
    setSummary(null);
    setError(null);
    apiFetch<StockoutSummary>(`/reassort/stockout-episodes?${qs}`)
      .then((data) => { if (!cancelled) setSummary(data); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSingleShop, selectedShop?.id]);

  function handleSelectShopFromNetwork(shop: { id: string; reference: string; name: string }) {
    setSelectedShop({ id: shop.id });
    setActiveTab('shop');
  }

  function handleSelectDepartment(department: string) {
    setDepartmentFilter(department);
    setActiveTab('shop');
  }

  const visibleEpisodes = departmentFilter
    ? (summary?.openEpisodes || []).filter((e) => (e.department || 'Sans rayon') === departmentFilter)
    : summary?.openEpisodes || [];

  return (
    <div className="container-fluid py-4">
      {/* Même style que TableauDeBord.tsx (reassort-tabs) — dupliqué ici car chaque page garde son
          propre scope de style, pas de feuille partagée entre pages de la SPA. */}
      <style>{`
        .reassort-tabs .nav-link { color: #5B6B85; font-weight: 600; border: none; border-bottom: 2px solid transparent; }
        .reassort-tabs .nav-link.active { color: #1B2A4A; border-bottom-color: #F5A623; background: transparent; }
      `}</style>

      <div className="d-flex align-items-center justify-content-between mb-3">
        <h2 className="mb-0">Ruptures de stock</h2>
        <span className="text-muted small">Sans données entrepôt (Cyrus) — diagnostic simplifié</span>
      </div>

      <ul className="nav reassort-tabs mb-3">
        <li className="nav-item">
          <button type="button" className={`nav-link${activeTab === 'shop' ? ' active' : ''}`} onClick={() => setActiveTab('shop')}>
            Ce magasin
          </button>
        </li>
        {!isSingleShop && (
          <li className="nav-item">
            <button type="button" className={`nav-link${activeTab === 'all' ? ' active' : ''}`} onClick={() => setActiveTab('all')}>
              Tous les magasins
            </button>
          </li>
        )}
        <li className="nav-item">
          <button type="button" className={`nav-link${activeTab === 'department' ? ' active' : ''}`} onClick={() => setActiveTab('department')}>
            Par rayon
          </button>
        </li>
      </ul>

      {activeTab === 'all' && !isSingleShop ? (
        <StockoutsAllShopsView onSelectShop={handleSelectShopFromNetwork} />
      ) : activeTab === 'department' ? (
        <StockoutsByDepartmentView shopQueryParam={shopQueryParam()} onSelectDepartment={handleSelectDepartment} />
      ) : error ? (
        <div className="text-danger small">Erreur : {error}</div>
      ) : summary === null ? (
        <div className="text-muted small">Chargement...</div>
      ) : (
        <>
          <div className="row row-cols-1 row-cols-md-3 g-3 mb-4">

            {/* Carte KPI : Ruptures en cours */}
            <div className="col">
              <div className="card kpi-card h-100">
                <div className="card-body d-flex align-items-start gap-2">
                  <div className="kpi-icon bg-warning-subtle">
                    <iconify-icon icon="solar:alert-bold-duotone" className="text-warning"></iconify-icon>
                  </div>
                  <div>
                    <p className="kpi-label">Ruptures en cours</p>
                    <h3 className="kpi-value">{summary.openCount ?? 0}</h3>
                  </div>
                </div>
                <div className="kpi-footer">Durée moyenne: {formatDuration(summary.avgDurationHours ?? 0)}</div>
              </div>
            </div>

            {/* Carte KPI : CA perdu estimé */}
            <div className="col">
              <div className="card kpi-card h-100">
                <div className="card-body d-flex align-items-start gap-2">
                  <div className="kpi-icon bg-danger-subtle">
                    <iconify-icon icon="solar:dollar-bold-duotone" className="text-danger"></iconify-icon>
                  </div>
                  <div>
                    <p className="kpi-label">CA perdu estimé</p>
                    <h3 className="kpi-value">{(summary.totalCaPerduEstime ?? 0).toLocaleString('fr-FR')} CFA</h3>
                  </div>
                </div>
                <div className="kpi-footer">Sur 30j résolues</div>
              </div>
            </div>

            {/* Carte KPI : Durée moyenne */}
            <div className="col">
              <div className="card kpi-card h-100">
                <div className="card-body d-flex align-items-start gap-2">
                  <div className="kpi-icon bg-info-subtle">
                    <iconify-icon icon="solar:clock-bold-duotone" className="text-info"></iconify-icon>
                  </div>
                  <div>
                    <p className="kpi-label">Durée moyenne</p>
                    <h3 className="kpi-value">{formatDuration(summary.avgDurationHours ?? 0)}</h3>
                  </div>
                </div>
                <div className="kpi-footer">En cours</div>
              </div>
            </div>
          </div>

          <div className="row row-cols-1 row-cols-md-2 g-3 mb-4">
            <div className="col">
              {/* Graphique évolution des ruptures */}
              <StockoutTrendChart shopQueryParam={shopQueryParam()} />
            </div>
            <div className="col">
              {/* Graphique répartition par cause */}
              <StockoutCauseChart causeCounts={summary.causeCounts || {}} />
            </div>
          </div>

          {departmentFilter && (
            <div className="alert alert-light border d-flex align-items-center justify-content-between py-2 mb-3">
              <span className="small">Filtré sur le rayon <strong>{departmentFilter}</strong></span>
              <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => setDepartmentFilter(null)}>
                Retirer le filtre
              </button>
            </div>
          )}

          <div className="table-responsive">
            <table className="table align-middle mb-0 table-hover table-centered">
              <thead className="bg-light-subtle">
                <tr>
                  <th>Article</th>
                  <th>Rayon</th>
                  <th>Depuis</th>
                  <th>Durée</th>
                  <th>Cause probable</th>
                  <th>Confiance</th>
                </tr>
              </thead>
              <tbody>
                {visibleEpisodes.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-center text-muted py-4">
                      {departmentFilter ? 'Aucune rupture en cours pour ce rayon.' : 'Aucune rupture en cours.'}
                    </td>
                  </tr>
                ) : (
                  visibleEpisodes.map((e) => (
                    <tr key={e.id} role="button" style={{ cursor: 'pointer' }} onClick={() => setSelectedEpisodeId(e.id)}>
                      <td>{e.label || e.ean}</td>
                      <td>{e.department || '—'}</td>
                      <td>{new Date(e.startedAt).toLocaleString('fr-FR')}</td>
                      <td>{formatDuration(e.durationHours)}</td>
                      <td>{CAUSE_LABELS[e.causeProposee] || e.causeProposee}</td>
                      <td>
                        <span className={`badge ${CONFIDENCE_BADGE[e.niveauConfiance] || 'reassort-badge-neutral'} py-1 px-2`}>
                          {e.niveauConfiance.toLowerCase()}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {selectedEpisodeId && (
        <EpisodeDetailModal episodeId={selectedEpisodeId} onClose={() => setSelectedEpisodeId(null)} />
      )}
    </div>
  );
}
