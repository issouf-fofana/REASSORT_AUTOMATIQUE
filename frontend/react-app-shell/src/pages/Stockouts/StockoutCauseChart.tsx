import { useEffect, useRef } from 'react';

// Répartition des ruptures par cause probable (demande du 16/10/2026) — reçoit causeCounts déjà
// calculé côté backend (cf. stockoutEpisodeService.js), pas de second appel API, juste la
// visualisation en camembert de données déjà chargées par le parent.
const CAUSE_LABELS: Record<string, string> = {
  MAGASIN_REASSORT: 'Magasin / réassort',
  MAGASIN_COMMANDE_NON_VALIDEE: 'Commande non validée',
  AMONT_A_PRECISER: 'Amont — à préciser',
  ECART_STOCK_RAYON: 'Écart stock / rayon',
  INDETERMINEE: 'Indéterminée',
};

const CAUSE_COLORS: Record<string, string> = {
  MAGASIN_REASSORT: '#F5A623',
  MAGASIN_COMMANDE_NON_VALIDEE: '#E0574C',
  AMONT_A_PRECISER: '#5B6B85',
  ECART_STOCK_RAYON: '#4A90D9',
  INDETERMINEE: '#A0A8B8',
};

export function StockoutCauseChart({ causeCounts }: { causeCounts: Record<string, number> }) {
  const chartRef = useRef<HTMLDivElement>(null);

  const entries = Object.entries(causeCounts || {}).filter(([, count]) => count > 0);

  useEffect(() => {
    if (!entries.length || !chartRef.current || !window.ApexCharts) return;
    const labels = entries.map(([cause]) => CAUSE_LABELS[cause] || cause);
    const values = entries.map(([, count]) => count);
    const colors = entries.map(([cause]) => CAUSE_COLORS[cause] || '#A0A8B8');

    const chart = new window.ApexCharts(chartRef.current, {
      chart: { type: 'donut', height: 280 },
      series: values,
      labels,
      colors,
      legend: { position: 'bottom', fontSize: '12px' },
      dataLabels: { enabled: true, formatter: (v: number) => `${Math.round(v)}%` },
      tooltip: { y: { formatter: (v: number) => `${v} rupture(s)` } },
    });

    chart.render();
    return () => { chart.destroy(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(causeCounts)]);

  return (
    <div className="card h-100">
      <div className="card-body">
        <h5 className="mb-3" style={{ color: '#1B2A4A', fontWeight: 600, fontSize: '.95rem' }}>
          Répartition par cause probable
        </h5>
        {entries.length === 0 ? (
          <div className="text-muted small">Aucune rupture en cours.</div>
        ) : (
          <div ref={chartRef}></div>
        )}
      </div>
    </div>
  );
}
