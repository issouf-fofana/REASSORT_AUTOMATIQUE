import { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../../shared/api/client';
import { StockoutTrendChart } from './StockoutTrendChart';
import { StockoutCauseChart } from './StockoutCauseChart';
import { StockoutDepartmentAnalysis } from './StockoutDepartmentAnalysis';

// Détail d'un magasin pour le module Ruptures (demande explicite du 16/10/2026 : "je dois faire
// comme pour les commande, les article son classer par rayon et quand je clique je peux voir les
// article et quand je clique sur un article je peux voir les detail") — même navigation
// hiérarchique Secteur → Rayon → Articles → détail que Proposition de commande (PurchaseOrder.tsx),
// réutilisé à l'identique pour "Ce magasin" (magasin actif topbar) ET le drill-down depuis
// "Tous les magasins" — un seul composant, un seul comportement.
type StockoutEpisode = {
  id: string;
  ean: string;
  label: string | null;
  department: string | null;
  sector: string | null;
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

type GroupSummary = { group: string; openCount: number; totalEpisodesCount: number };
type ByFieldSummary = { found: boolean; groupCount: number; groups: GroupSummary[]; message?: string };

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

export function StockoutShopDetail({ shopQueryParam }: { shopQueryParam: string }) {
  const navigate = useNavigate();
  const [selectedSector, setSelectedSector] = useState<string | null>(null);
  const [selectedDepartment, setSelectedDepartment] = useState<string | null>(null);

  const [summary, setSummary] = useState<StockoutSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bySector, setBySector] = useState<ByFieldSummary | null>(null);
  const [byDepartment, setByDepartment] = useState<ByFieldSummary | null>(null);

  const mountRef = useRef(true);

  // Résumé complet (KPI, graphes, articles) : chargé une fois par magasin, le reste navigue dedans
  // côté client, sans nouvel appel API par clic.
  useEffect(() => {
    if (!shopQueryParam) return;
    let cancelled = false;
    setSummary(null);
    setError(null);
    setSelectedSector(null);
    setSelectedDepartment(null);
    mountRef.current = true;
    apiFetch<StockoutSummary>(`/reassort/stockout-episodes?${shopQueryParam}`)
      .then((data) => { if (!cancelled && mountRef.current) setSummary(data); })
      .catch((err) => { if (!cancelled && mountRef.current) setError(err instanceof Error ? err.message : String(err)); });
    return () => {
      cancelled = true;
      mountRef.current = false;
    };
  }, [shopQueryParam]);

  // Niveau Secteurs : chargé une fois par magasin.
  useEffect(() => {
    if (!shopQueryParam) return;
    let cancelled = false;
    setBySector(null);
    apiFetch<ByFieldSummary>(`/reassort/stockout-episodes/by-sector?${shopQueryParam}`)
      .then((data) => { if (!cancelled) setBySector(data); })
      .catch(() => { /* non bloquant : la liste d'articles reste consultable sans ce niveau */ });
    return () => { cancelled = true; };
  }, [shopQueryParam]);

  // Niveau Secteurs : chargé une fois par magasin.
  useEffect(() => {
    if (!shopQueryParam) return;
    let cancelled = false;
    setBySector(null);
    apiFetch<ByFieldSummary>(`/reassort/stockout-episodes/by-sector?${shopQueryParam}`)
      .then((data) => { if (!cancelled) setBySector(data); })
      .catch(() => { /* non bloquant : la liste d'articles reste consultable sans ce niveau */ });
    return () => { cancelled = true; };
  }, [shopQueryParam]);

  // Niveau Rayons : rechargé à chaque changement de secteur sélectionné.
  useEffect(() => {
    if (!shopQueryParam || !selectedSector) { setByDepartment(null); return; }
    let cancelled = false;
    setByDepartment(null);
    const sectorParam = selectedSector === 'Sans secteur' ? '__none__' : selectedSector;
    apiFetch<ByFieldSummary>(`/reassort/stockout-episodes/by-department?sector=${encodeURIComponent(sectorParam)}&${shopQueryParam}`)
      .then((data) => { if (!cancelled) setByDepartment(data); })
      .catch(() => { /* non bloquant */ });
    return () => { cancelled = true; };
  }, [shopQueryParam, selectedSector]);

  const articlesInDepartment = selectedDepartment
    ? (summary?.openEpisodes || []).filter((e) => (e.department || 'Sans rayon') === selectedDepartment)
    : [];

  const showArticleList = !!selectedSector && !!selectedDepartment;

  return (
    <div>
      {/* KPI + graphes toujours visibles en haut, quel que soit le niveau de navigation — vue
          d'ensemble du magasin, pas seulement du rayon/secteur consulté. */}
      {error ? (
        <div className="text-danger small mb-3">Erreur : {error}</div>
      ) : !mountRef.current ? null :
      summary === null ? (
        <div className="text-muted small mb-3">Chargement des données de rupture...</div>
      ) : (
        <>
          <div className="row row-cols-1 row-cols-md-3 g-3 mb-4">
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
              <StockoutTrendChart shopQueryParam={shopQueryParam} />
            </div>
            <div className="col">
              <StockoutCauseChart causeCounts={summary.causeCounts || {}} />
            </div>
          </div>

          {/* Analyse par rayon (demande du 16/10/2026 : "doit etre dans les detail quand je clique
              sur pour mag" — classement/priorisation, distinct de la navigation Secteur → Rayon →
              Articles juste en dessous, qui sert au drill-down vers les articles). */}
          <div className="mb-4">
            <StockoutDepartmentAnalysis shopQueryParam={shopQueryParam} />
          </div>
        </>
      )}

      {/* Navigation hiérarchique Secteur → Rayon → Articles, identique à PurchaseOrder.tsx. */}
      <div className="card">
        <div className="card-body">
          <div className="d-flex align-items-center gap-2 mb-3">
            {selectedSector && (
              <button
                type="button"
                className="btn btn-sm btn-outline-secondary"
                title="Retour"
                onClick={() => (selectedDepartment ? setSelectedDepartment(null) : setSelectedSector(null))}
              >
                <iconify-icon icon="solar:arrow-left-linear" className="align-middle"></iconify-icon>
              </button>
            )}
            <h5 className="mb-0">
              {showArticleList
                ? `Articles — ${selectedSector} › ${selectedDepartment}`
                : selectedSector
                  ? `Rayons — ${selectedSector}`
                  : 'Secteurs'}
            </h5>
          </div>

          {!selectedSector ? (
            // Niveau 1 : Secteurs
            bySector === null ? (
              <div className="text-muted small">Chargement...</div>
            ) : !bySector.groups || bySector.groups.length === 0 ? (
              <div className="text-muted small py-3">{bySector.message || 'Aucune rupture en cours.'}</div>
            ) : (
              <div className="row g-3">
                {bySector.groups.map((s) => (
                  <div className="col-12 col-md-4" key={s.group}>
                    <div className="card h-100" role="button" style={{ cursor: 'pointer' }} onClick={() => setSelectedSector(s.group)}>
                      <div className="card-body">
                        <h6 className="mb-1">{s.group}</h6>
                        <div className="text-muted small">{s.openCount} article(s) en rupture</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : !selectedDepartment ? (
            // Niveau 2 : Rayons du secteur sélectionné
            byDepartment === null ? (
              <div className="text-muted small">Chargement...</div>
            ) : !byDepartment.groups || byDepartment.groups.length === 0 ? (
              <div className="text-muted small py-3">{byDepartment.message || 'Aucune rupture en cours pour ce secteur.'}</div>
            ) : (
              <div className="row g-3">
                {byDepartment.groups.map((d) => (
                  <div className="col-12 col-md-4" key={d.group}>
                    <div className="card h-100" role="button" style={{ cursor: 'pointer' }} onClick={() => setSelectedDepartment(d.group)}>
                      <div className="card-body">
                        <h6 className="mb-1">{d.group}</h6>
                        <div className="text-muted small">{d.openCount} article(s) en rupture</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : (
            // Niveau 3 : Articles du rayon sélectionné
            <div className="table-responsive">
              <table className="table align-middle mb-0 table-hover table-centered">
                <thead className="bg-light-subtle">
                  <tr>
                    <th>Article</th>
                    <th>Depuis</th>
                    <th>Durée</th>
                    <th>Cause probable</th>
                    <th>Confiance</th>
                  </tr>
                </thead>
                <tbody>
                  {articlesInDepartment.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="text-center text-muted py-4">Aucune rupture en cours pour ce rayon.</td>
                    </tr>
                  ) : (
                    articlesInDepartment.map((e) => (
                      <tr key={e.id} role="button" style={{ cursor: 'pointer' }} onClick={() => navigate(`/stockouts/episode/${e.id}`)}>
                        <td>{e.label || e.ean}</td>
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
          )}
        </div>
      </div>
    </div>
  );
}
