import { useEffect, useMemo, useRef, useState } from 'react';
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

// Palette du site (navy/ambre/gris-bleu, cf. TableauDeBord.tsx) déclinée pour les visuels de cette
// carte — pas de nouvelle palette inventée, demande explicite du 17/10/2026 : "prend mes couleur
// actuel du site".
const DONUT_COLORS = ['#F5A623', '#4A90D9', '#5B6B85', '#0E5964', '#E0574C'];
const ITEM_CARD_COLORS = ['rgba(224,87,76,.22)', 'rgba(14,89,100,.4)', 'rgba(91,107,133,.35)'];

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
  const totalOpen = rows.reduce((s, r) => s + r.openCount, 0);
  const top5 = rows.slice(0, 5);

  const donutRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!top5.length || !donutRef.current || !window.ApexCharts) return;
    const chart = new window.ApexCharts(donutRef.current, {
      chart: { type: 'donut', height: 190, sparkline: { enabled: false } },
      series: top5.map((r) => r.openCount),
      labels: top5.map((r) => r.group),
      colors: DONUT_COLORS,
      legend: { show: false },
      dataLabels: { enabled: false },
      stroke: { width: 2, colors: ['#15213A'] },
      tooltip: { y: { formatter: (v: number) => `${v} rupture(s)` } },
      plotOptions: { pie: { donut: { size: '68%', labels: { show: true, total: { show: true, label: 'Rayons', color: '#C9D2E3', formatter: () => String(totalOpen) }, value: { color: '#fff', fontSize: '20px', fontWeight: 700 } } } } },
    });
    chart.render();
    return () => { chart.destroy(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(top5.map((r) => [r.group, r.openCount]))]);

  function SortButton({ k, label }: { k: SortKey; label: string }) {
    return (
      <button
        type="button"
        className={`stockout-sort-btn${sortKey === k ? ' active' : ''}`}
        onClick={() => setSortKey(k)}
      >
        {label}
      </button>
    );
  }

  return (
    <div className="stockout-rayon-panel">
      <style>{`
        .stockout-rayon-panel { background: #15213A; border-radius: 14px; padding: 20px 22px 24px; color: #fff; }
        .stockout-rayon-crumb { font-size: .78rem; color: #8B98B8; margin-bottom: 4px; }
        .stockout-rayon-crumb strong { color: #fff; font-weight: 600; }
        .stockout-sort-btn { background: transparent; border: 1px solid rgba(255,255,255,.14); color: #C9D2E3; font-size: .74rem; padding: 4px 10px; border-radius: 999px; }
        .stockout-sort-btn.active { background: #F5A623; border-color: #F5A623; color: #15213A; font-weight: 600; }
        .stockout-kpi-tile { border-radius: 12px; padding: 16px 18px; height: 100%; display: flex; flex-direction: column; gap: 6px; }
        .stockout-kpi-tile .label { font-size: .72rem; text-transform: uppercase; letter-spacing: .04em; opacity: .85; }
        .stockout-kpi-tile .value { font-size: 1.6rem; font-weight: 700; line-height: 1.1; }
        .stockout-kpi-tile .sub { font-size: .74rem; opacity: .8; }
        .stockout-tile-navy { background: #1B2A4A; }
        .stockout-tile-amber { background: #F5A623; color: #15213A; }
        .stockout-tile-amber .label, .stockout-tile-amber .sub { opacity: .75; }
        .stockout-tile-teal { background: #0E5964; }
        .stockout-mini-stat { display: flex; align-items: center; gap: 8px; background: rgba(255,255,255,.04); border-radius: 10px; padding: 8px 10px; }
        .stockout-mini-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
        .stockout-mini-stat .val { font-weight: 700; font-size: .92rem; }
        .stockout-mini-stat .lbl { font-size: .68rem; color: #8B98B8; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; }
        .stockout-item-card { display: flex; align-items: center; gap: 10px; border-radius: 10px; padding: 10px 14px; font-size: .82rem; font-weight: 600; }
        .stockout-item-card .icon { width: 30px; height: 30px; border-radius: 8px; background: rgba(255,255,255,.18); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .stockout-item-card .count { margin-left: auto; font-weight: 700; }
        .stockout-rayon-table { width: 100%; font-size: .8rem; color: #C9D2E3; }
        .stockout-rayon-table th { text-align: left; font-size: .68rem; text-transform: uppercase; letter-spacing: .04em; color: #8B98B8; font-weight: 600; padding: 6px 10px; border-bottom: 1px solid rgba(255,255,255,.08); }
        .stockout-rayon-table td { padding: 9px 10px; border-bottom: 1px solid rgba(255,255,255,.06); color: #fff; }
        .stockout-rayon-table tr:last-child td { border-bottom: none; }
      `}</style>

      <div className="d-flex align-items-center justify-content-between flex-wrap gap-2 mb-3">
        <div className="stockout-rayon-crumb">Ruptures de stock <iconify-icon icon="solar:alt-arrow-right-linear" style={{ verticalAlign: '-2px', fontSize: '11px' }}></iconify-icon> <strong>Analyse par rayon</strong></div>
        <div className="d-flex gap-2">
          <SortButton k="openCount" label="Ruptures" />
          <SortButton k="avgDurationHours" label="Durée" />
          <SortButton k="totalCaPerduEstime" label="CA perdu" />
          <SortButton k="longEpisodesCount" label="Longues" />
        </div>
      </div>

      {error ? (
        <div className="text-danger small">Erreur : {error}</div>
      ) : data === null ? (
        <div className="small" style={{ color: '#8B98B8' }}>Chargement...</div>
      ) : rows.length === 0 ? (
        <div className="small py-3" style={{ color: '#8B98B8' }}>{data.message || 'Aucune rupture en cours.'}</div>
      ) : (
        <>
          {/* 3 cartes KPI contrastées, comme les tuiles "Weekly Sale / Product Share / Average Graph". */}
          <div className="row g-3 mb-3">
            <div className="col-12 col-md-4">
              <div className="stockout-kpi-tile stockout-tile-navy">
                <span className="label">Rayon le plus touché</span>
                <span className="value">{rows[0]?.openCount || 0}</span>
                <span className="sub">{rows[0]?.group || '—'}</span>
              </div>
            </div>
            <div className="col-12 col-md-4">
              <div className="stockout-kpi-tile stockout-tile-amber">
                <span className="label">Rayon le plus coûteux (30j)</span>
                <span className="value">{topCaPerdu.toLocaleString('fr-FR')} <span style={{ fontSize: '.85rem' }}>CFA</span></span>
                <span className="sub">{topCaRow?.group || '—'}</span>
              </div>
            </div>
            <div className="col-12 col-md-4">
              <div className="stockout-kpi-tile stockout-tile-teal">
                <span className="label">Intervention prioritaire</span>
                <span className="value">{priorityCount}</span>
                <span className="sub">sur {rows.length} rayon(s) en rupture</span>
              </div>
            </div>
          </div>

          <div className="row g-3 mb-3">
            {/* Donut top 5 rayons, comme "Product Share". */}
            <div className="col-12 col-md-5">
              <div style={{ background: 'rgba(255,255,255,.04)', borderRadius: 12, padding: '14px 16px', height: '100%' }}>
                <div className="small mb-2" style={{ color: '#C9D2E3', fontWeight: 600 }}>Top 5 rayons touchés</div>
                <div ref={donutRef}></div>
                <div className="d-flex flex-column gap-1 mt-2">
                  {top5.map((r, i) => (
                    <div key={r.group} className="d-flex align-items-center gap-2" style={{ fontSize: '.72rem', color: '#C9D2E3' }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: DONUT_COLORS[i % DONUT_COLORS.length], flexShrink: 0 }}></span>
                      <span className="text-truncate">{r.group}</span>
                      <span className="ms-auto fw-semibold text-white">{r.openCount}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Mini-stats par rayon (durée / sans commande / CA perdu), comme les pastilles 3.2 / 4.4 / 9.6. */}
            <div className="col-12 col-md-7">
              <div style={{ background: 'rgba(255,255,255,.04)', borderRadius: 12, padding: '14px 16px', height: '100%' }}>
                <div className="small mb-2" style={{ color: '#C9D2E3', fontWeight: 600 }}>Indicateurs par rayon</div>
                <div className="row g-2">
                  {top5.map((r) => (
                    <div className="col-12 col-sm-6" key={r.group}>
                      <div className="stockout-mini-stat">
                        <span className="stockout-mini-dot" style={{ background: priorityLevel(r).label === 'Prioritaire' ? '#E0574C' : priorityLevel(r).label === 'À surveiller' ? '#F5A623' : '#4CAF82' }}></span>
                        <div className="flex-grow-1" style={{ minWidth: 0 }}>
                          <div className="val">{formatDuration(r.avgDurationHours)}</div>
                          <div className="lbl">{r.group}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Cartes "Item Name Here" — les 3 rayons les plus prioritaires. */}
          <div className="row g-2 mb-3">
            {rows.filter((r) => priorityLevel(r).label === 'Prioritaire').slice(0, 3).map((r, i) => (
              <div className="col-12 col-md-4" key={r.group}>
                <div className="stockout-item-card" style={{ background: ITEM_CARD_COLORS[i % ITEM_CARD_COLORS.length] }}>
                  <span className="icon"><iconify-icon icon="solar:danger-triangle-bold-duotone"></iconify-icon></span>
                  {r.group}
                  <span className="count">{r.openCount}</span>
                </div>
              </div>
            ))}
            {rows.filter((r) => priorityLevel(r).label === 'Prioritaire').length === 0 && (
              <div className="col-12">
                <div className="stockout-item-card" style={{ background: 'rgba(76,175,130,.18)', color: '#C9D2E3' }}>
                  <span className="icon"><iconify-icon icon="solar:check-circle-bold-duotone"></iconify-icon></span>
                  Aucun rayon en intervention prioritaire pour le moment
                </div>
              </div>
            )}
          </div>

          <div className="table-responsive">
            <table className="stockout-rayon-table">
              <thead>
                <tr>
                  <th>Rayon</th>
                  <th>En cours</th>
                  <th>Durée moy.</th>
                  <th>Longues (≥48h)</th>
                  <th>Sans commande</th>
                  <th>CA perdu</th>
                  <th>Priorité</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const priority = priorityLevel(r);
                  return (
                    <tr key={r.group}>
                      <td style={{ fontWeight: 600 }}>{r.group}</td>
                      <td>{r.openCount}</td>
                      <td>{formatDuration(r.avgDurationHours)}</td>
                      <td>{r.longEpisodesCount}</td>
                      <td>{r.noOrderCount}</td>
                      <td>{r.totalCaPerduEstime.toLocaleString('fr-FR')} CFA</td>
                      <td>
                        <span className="badge" style={{
                          background: priority.label === 'Prioritaire' ? 'rgba(224,87,76,.18)' : priority.label === 'À surveiller' ? 'rgba(245,166,35,.18)' : 'rgba(255,255,255,.08)',
                          color: priority.label === 'Prioritaire' ? '#FF8A80' : priority.label === 'À surveiller' ? '#F5A623' : '#C9D2E3',
                        }}>{priority.label}</span>
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
  );
}
