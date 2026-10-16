import { useEffect, useState } from 'react';
import { apiFetch } from '../../shared/api/client';

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
    apiFetch<{ success: boolean; data: StockoutSummary }>(`/reassort/stockout-episodes?${qs}`)
      .then((data) => { if (!cancelled) setSummary(data.data); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSingleShop, selectedShop?.id]);

  return (
    <div className="container-fluid py-4">
      <div className="d-flex align-items-center justify-content-between mb-3">
        <h2 className="mb-0">Ruptures de stock</h2>
        <span className="text-muted small">Sans données entrepôt (Cyrus) — diagnostic simplifié</span>
      </div>

      <div className="card">
        <div className="card-body">
          {error ? (
            <div className="text-danger small">Erreur : {error}</div>
          ) : summary === null ? (
            <div className="text-muted small">Chargement...</div>
          ) : (
            <>
              <div className="row g-3 mb-4">
                <div className="col-12 col-md-4">
                  <div className="text-muted small">Ruptures en cours</div>
                  <div className="fs-4 fw-semibold">{summary.openCount}</div>
                </div>
                <div className="col-12 col-md-4">
                  <div className="text-muted small">Durée moyenne</div>
                  <div className="fs-4 fw-semibold">{formatDuration(summary.avgDurationHours)}</div>
                </div>
                <div className="col-12 col-md-4">
                  <div className="text-muted small">CA perdu estimé (30j résolues)</div>
                  <div className="fs-4 fw-semibold">{summary.totalCaPerduEstime.toLocaleString('fr-FR')} CFA</div>
                </div>
              </div>

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
                    {summary.openEpisodes.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="text-center text-muted py-4">
                          Aucune rupture en cours.
                        </td>
                      </tr>
                    ) : (
                      summary.openEpisodes.map((e) => (
                        <tr key={e.id}>
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
        </div>
      </div>
    </div>
  );
}
