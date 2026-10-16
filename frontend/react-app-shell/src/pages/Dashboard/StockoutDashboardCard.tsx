import { useEffect, useState } from 'react';
import { apiFetch } from '../../shared/api/client';

// Module Ruptures (cf. rupture.md, 16/10/2026) — diagnostic SIMPLIFIÉ, sans les données Cyrus
// (entrepôt) : on ne distingue pas "stock central indisponible" / "non préparé" / "retard transport",
// ces 3 cas retombent tous sur AMONT_A_PRECISER (cf. stockoutEpisodeService.js côté backend).
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

export function StockoutDashboardCard({ shopQueryParam }: { shopQueryParam: string }) {
  const [summary, setSummary] = useState<StockoutSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!shopQueryParam) return;
    let cancelled = false;
    setSummary(null);
    setError(null);
    apiFetch<{ success: boolean; data: StockoutSummary }>(`/reassort/stockout-episodes?${shopQueryParam}`)
      .then((data) => { if (!cancelled) setSummary(data.data); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [shopQueryParam]);

  return (
    <div className="row mt-4">
      <div className="col-12">
        <div className="card">
          <div className="card-header d-flex align-items-center justify-content-between">
            <h4 className="card-title mb-0">Ruptures de stock</h4>
            <span className="text-muted small">Sans données entrepôt (Cyrus) — diagnostic simplifié</span>
          </div>
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
    </div>
  );
}
