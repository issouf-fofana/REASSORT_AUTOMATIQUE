import { useEffect, useState } from 'react';
import { apiFetch } from '../../shared/api/client';

// Dashboard par rayon du module Ruptures (spec rupture.md §7, 16/10/2026) : une ligne-résumé par
// rayon du magasin sélectionné. Clic sur un rayon -> filtre la liste d'articles déjà chargée par
// le parent (onSelectDepartment), pas de second appel API : la liste complète des épisodes ouverts
// est déjà disponible côté client (summary.openEpisodes dans Stockouts.tsx).
type DepartmentSummary = {
  department: string;
  openCount: number;
  totalEpisodesCount: number;
  avgDurationHours: number;
  longEpisodesCount: number;
  noOrderCount: number;
  causeCounts: Record<string, number>;
  totalCaPerduEstime: number;
};

type ByDepartmentSummary = {
  found: boolean;
  departmentCount: number;
  totalOpenAcrossDepartments: number;
  departments: DepartmentSummary[];
  message?: string;
};

function formatDuration(hours: number): string {
  if (hours < 24) return `${Math.round(hours)} h`;
  const days = Math.floor(hours / 24);
  const rest = Math.round(hours % 24);
  return `${days} j ${rest} h`;
}

export function StockoutsByDepartmentView({ shopQueryParam, onSelectDepartment }: { shopQueryParam: string; onSelectDepartment: (department: string) => void }) {
  const [summary, setSummary] = useState<ByDepartmentSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!shopQueryParam) return;
    let cancelled = false;
    setSummary(null);
    setError(null);
    apiFetch<ByDepartmentSummary>(`/reassort/stockout-episodes/by-department?${shopQueryParam}`)
      .then((data) => { if (!cancelled) setSummary(data); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [shopQueryParam]);

  if (error) return <div className="text-danger small">Erreur : {error}</div>;
  if (summary === null) return <div className="text-muted small">Chargement...</div>;

  const departments = summary.departments || [];

  return (
    <div className="card">
      <div className="card-body">
        <div className="row g-3 mb-4">
          <div className="col-12 col-md-6">
            <div className="text-muted small">Rayons avec au moins une rupture</div>
            <div className="fs-4 fw-semibold">{summary.departmentCount}</div>
          </div>
          <div className="col-12 col-md-6">
            <div className="text-muted small">Total ruptures en cours (magasin)</div>
            <div className="fs-4 fw-semibold">{summary.totalOpenAcrossDepartments}</div>
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
                <th>Sans commande identifiée</th>
                <th>CA perdu estimé (30j)</th>
              </tr>
            </thead>
            <tbody>
              {departments.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center text-muted py-4">
                    {summary.message || 'Aucun rayon avec une rupture détectée.'}
                  </td>
                </tr>
              ) : (
                departments.map((d) => (
                  <tr key={d.department} role="button" onClick={() => onSelectDepartment(d.department)} style={{ cursor: 'pointer' }}>
                    <td>{d.department}</td>
                    <td>{d.openCount}</td>
                    <td>{d.totalEpisodesCount}</td>
                    <td>{formatDuration(d.avgDurationHours)}</td>
                    <td>{d.longEpisodesCount}</td>
                    <td>{d.noOrderCount}</td>
                    <td>{d.totalCaPerduEstime.toLocaleString('fr-FR')} CFA</td>
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
