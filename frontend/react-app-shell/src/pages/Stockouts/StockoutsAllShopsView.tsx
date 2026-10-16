import { useEffect, useState } from 'react';
import { apiFetch } from '../../shared/api/client';

// Vue réseau du module Ruptures (spec rupture.md §2, 16/10/2026) : une ligne-résumé par magasin
// accessible (ADMIN = tous, SUPERVISOR = son périmètre). Clic sur un magasin -> bascule l'onglet
// "Ce magasin" sur ce magasin (drill-down, étape 1 — détail article/rayon/chronologie à venir).
type ShopSummary = {
  rposShopId: string;
  shopReference: string;
  shopName: string;
  openCount: number;
  totalEpisodesCount: number;
  avgDurationHours: number;
  longEpisodesCount: number;
  noOrderCount: number;
  totalCaPerduEstime: number;
};

type AllShopsSummary = {
  found: boolean;
  shopCount: number;
  totalOpenAcrossShops: number;
  shops: ShopSummary[];
  message?: string;
};

function formatDuration(hours: number): string {
  if (hours < 24) return `${Math.round(hours)} h`;
  const days = Math.floor(hours / 24);
  const rest = Math.round(hours % 24);
  return `${days} j ${rest} h`;
}

export function StockoutsAllShopsView({ onSelectShop }: { onSelectShop: (shop: { id: string; reference: string; name: string }) => void }) {
  const [summary, setSummary] = useState<AllShopsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSummary(null);
    setError(null);
    apiFetch<AllShopsSummary>('/reassort/stockout-episodes/all-shops')
      .then((data) => { if (!cancelled) setSummary(data); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, []);

  if (error) return <div className="text-danger small">Erreur : {error}</div>;
  if (summary === null) return <div className="text-muted small">Chargement...</div>;

  const shops = summary.shops || [];

  return (
    <div className="card">
      <div className="card-body">
        <div className="row g-3 mb-4">
          <div className="col-12 col-md-6">
            <div className="text-muted small">Magasins avec au moins une rupture</div>
            <div className="fs-4 fw-semibold">{summary.shopCount}</div>
          </div>
          <div className="col-12 col-md-6">
            <div className="text-muted small">Total ruptures en cours (réseau)</div>
            <div className="fs-4 fw-semibold">{summary.totalOpenAcrossShops}</div>
          </div>
        </div>

        <div className="table-responsive">
          <table className="table align-middle mb-0 table-hover table-centered">
            <thead className="bg-light-subtle">
              <tr>
                <th>Magasin</th>
                <th>Ruptures en cours</th>
                <th>Épisodes (total)</th>
                <th>Durée moyenne</th>
                <th>Ruptures longues (≥48h)</th>
                <th>Sans commande identifiée</th>
                <th>CA perdu estimé (30j)</th>
              </tr>
            </thead>
            <tbody>
              {shops.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center text-muted py-4">
                    {summary.message || 'Aucun magasin avec une rupture détectée.'}
                  </td>
                </tr>
              ) : (
                shops.map((s) => (
                  <tr
                    key={s.rposShopId}
                    role="button"
                    onClick={() => onSelectShop({ id: s.rposShopId, reference: s.shopReference, name: s.shopName })}
                    style={{ cursor: 'pointer' }}
                  >
                    <td>{s.shopName} ({s.shopReference})</td>
                    <td>{s.openCount}</td>
                    <td>{s.totalEpisodesCount}</td>
                    <td>{formatDuration(s.avgDurationHours)}</td>
                    <td>{s.longEpisodesCount}</td>
                    <td>{s.noOrderCount}</td>
                    <td>{s.totalCaPerduEstime.toLocaleString('fr-FR')} CFA</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
