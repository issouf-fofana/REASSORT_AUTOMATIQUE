import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../../shared/api/client';

// Analyse par rayon (demande explicite du 16/10/2026, reprise du cahier des charges rupture.md §3 :
// "Quel rayon connaît le plus de ruptures ? Combien d'articles sont en rupture dans chaque rayon ?
// Quelle est la durée moyenne des ruptures par rayon ? Quel rayon enregistre les pertes de CA les
// plus importantes ? Quels rayons nécessitent une intervention prioritaire ?") — classement trié et
// triable, distinct de la navigation Secteur→Rayon→Articles (StockoutShopDetail.tsx), qui ne montre
// les rayons qu'une fois un secteur choisi et sert à drill-down vers les articles, pas à comparer.
type DepartmentRow = {
  group: string;
  openCount: number;
  totalEpisodesCount: number;
  avgDurationHours: number;
  longEpisodesCount: number;
  noOrderCount: number;
  totalCaPerduEstime: number;
};

type ByFieldSummary = { found: boolean; groupCount: number; groups: DepartmentRow[]; message?: string };

type SortKey = 'openCount' | 'avgDurationHours' | 'totalCaPerduEstime' | 'longEpisodesCount';

function formatDuration(hours: number): string {
  if (hours < 24) return `${Math.round(hours)} h`;
  const days = Math.floor(hours / 24);
  const rest = Math.round(hours % 24);
  return `${days} j ${rest} h`;
}

// Priorité d'intervention : combine durée longue ET coût — un rayon avec beaucoup de ruptures
// longues ET un CA perdu élevé mérite une action avant un rayon avec juste beaucoup de petites
// ruptures récentes. Seuils pragmatiques, pas de configuration dédiée pour l'instant.
function priorityLevel(row: DepartmentRow): { label: string; badge: string } {
  if (row.longEpisodesCount >= 3 || row.totalCaPerduEstime >= 50000) {
    return { label: 'Prioritaire', badge: 'reassort-badge-soft-danger' };
  }
  if (row.longEpisodesCount >= 1 || row.openCount >= 10) {
    return { label: 'À surveiller', badge: 'reassort-badge-soft-warning' };
  }
  return { label: 'Normal', badge: 'reassort-badge-neutral' };
}

export function StockoutDepartmentAnalysis({ shopQueryParam }: { shopQueryParam: string }) {
  const [data, setData] = useState<ByFieldSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('openCount');

  useEffect(() => {
    if (!shopQueryParam) return;
    let cancelled = false;
    setData(null);
    setError(null);
    apiFetch<ByFieldSummary>(`/reassort/stockout-episodes/by-department?${shopQueryParam}`)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [shopQueryParam]);

  const rows = useMemo(() => {
    const list = data?.groups || [];
    return [...list].sort((a, b) => b[sortKey] - a[sortKey]);
  }, [data, sortKey]);

  const priorityCount = rows.filter((r) => priorityLevel(r).label === 'Prioritaire').length;
  const topCaPerdu = rows.length ? Math.max(...rows.map((r) => r.totalCaPerduEstime)) : 0;
  const topCaRow = rows.find((r) => r.totalCaPerduEstime === topCaPerdu && topCaPerdu > 0);

  function SortButton({ k, label }: { k: SortKey; label: string }) {
    return (
      <button
        type="button"
        className={`btn btn-sm ${sortKey === k ? 'btn-primary' : 'btn-outline-secondary'}`}
        onClick={() => setSortKey(k)}
      >
        {label}
      </button>
    );
  }

  return (
    <div className="card">
      <div className="card-body">
        <div className="d-flex align-items-center justify-content-between flex-wrap gap-2 mb-3">
          <h5 className="mb-0" style={{ color: '#1B2A4A', fontWeight: 600 }}>Analyse par rayon</h5>
          <div className="d-flex gap-2">
            <span className="small text-muted align-self-center me-1">Trier par :</span>
            <SortButton k="openCount" label="Ruptures" />
            <SortButton k="avgDurationHours" label="Durée" />
            <SortButton k="totalCaPerduEstime" label="CA perdu" />
            <SortButton k="longEpisodesCount" label="Ruptures longues" />
          </div>
        </div>

        {error ? (
          <div className="text-danger small">Erreur : {error}</div>
        ) : data === null ? (
          <div className="text-muted small">Chargement...</div>
        ) : rows.length === 0 ? (
          <div className="text-muted small py-3">{data.message || 'Aucune rupture en cours.'}</div>
        ) : (
          <>
            <div className="row g-3 mb-4">
              <div className="col-12 col-md-4">
                <div className="text-muted small">Rayon le plus touché</div>
                <div className="fs-5 fw-semibold">{rows[0]?.group || '—'}</div>
                <div className="text-muted small">{rows[0]?.openCount || 0} rupture(s) en cours</div>
              </div>
              <div className="col-12 col-md-4">
                <div className="text-muted small">Rayon le plus coûteux (30j résolues)</div>
                <div className="fs-5 fw-semibold">{topCaRow?.group || '—'}</div>
                <div className="text-muted small">{topCaPerdu.toLocaleString('fr-FR')} CFA perdu(s)</div>
              </div>
              <div className="col-12 col-md-4">
                <div className="text-muted small">Rayons nécessitant une intervention prioritaire</div>
                <div className="fs-5 fw-semibold">{priorityCount}</div>
                <div className="text-muted small">sur {rows.length} rayon(s) en rupture</div>
              </div>
            </div>

            <div className="table-responsive">
              <table className="table align-middle mb-0 table-hover table-centered">
                <thead className="bg-light-subtle">
                  <tr>
                    <th>Rayon</th>
                    <th>Ruptures en cours</th>
                    <th>Épisodes (total)</th>
                    <th>Durée moyenne</th>
                    <th>Ruptures longues (≥48h)</th>
                    <th>Sans commande</th>
                    <th>CA perdu estimé</th>
                    <th>Priorité</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const priority = priorityLevel(r);
                    return (
                      <tr key={r.group}>
                        <td className="fw-semibold">{r.group}</td>
                        <td>{r.openCount}</td>
                        <td>{r.totalEpisodesCount}</td>
                        <td>{formatDuration(r.avgDurationHours)}</td>
                        <td>{r.longEpisodesCount}</td>
                        <td>{r.noOrderCount}</td>
                        <td>{r.totalCaPerduEstime.toLocaleString('fr-FR')} CFA</td>
                        <td>
                          <span className={`badge ${priority.badge} py-1 px-2`}>{priority.label}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
