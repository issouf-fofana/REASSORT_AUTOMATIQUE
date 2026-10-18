import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../shared/api/client';

// Évolution du nombre de ruptures en cours sur 30 jours (demande du 16/10/2026 : même niveau de
// détail visuel que ConformityTrendChart.tsx sur le Tableau de bord). Même pattern : window.ApexCharts
// chargé globalement (assets/vendor/apexcharts), pas un import npm.
type TrendPoint = { date: string; openCount: number };

// startDate/endDate ajoutés le 18/10/2026 (demande explicite : "le filtre doit etre pour tout a
// emme temps... ne donne pas un filtre par detaut qui n'est pas modifialbe comme Ruptures en cours
// — 30 derniers jours") — la fenêtre fixe de 30 jours est remplacée par la période choisie dans le
// sélecteur unique du parent (StockoutShopDetail), qui pilote aussi l'analyse des pertes.
export function StockoutTrendChart({ shopQueryParam, startDate, endDate }: { shopQueryParam: string; startDate: string; endDate: string }) {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartInstanceRef = useRef<any>(null);
  const [points, setPoints] = useState<TrendPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!shopQueryParam) return;
    let cancelled = false;
    setPoints(null);
    setError(null);
    const start = encodeURIComponent(new Date(startDate).toISOString());
    const end = encodeURIComponent(new Date(endDate + 'T23:59:59').toISOString());
    apiFetch<{ points: TrendPoint[] }>(`/reassort/stockout-episodes/trend?start=${start}&end=${end}&${shopQueryParam}`)
      .then((data) => { if (!cancelled) setPoints(data.points); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [shopQueryParam, startDate, endDate]);

  useEffect(() => {
    if (!points || !chartRef.current || !window.ApexCharts) return;
    const categories = points.map((p) => new Date(p.date).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }));
    const values = points.map((p) => p.openCount);

    const chart = new window.ApexCharts(chartRef.current, {
      chart: { type: 'area', height: 280, toolbar: { show: false } },
      series: [{ name: 'Ruptures en cours', data: values }],
      xaxis: { categories, labels: { style: { fontSize: '10px' } } },
      yaxis: { min: 0, labels: { formatter: (v: number) => String(Math.round(v)) } },
      colors: ['#E0574C'],
      stroke: { curve: 'smooth', width: 2 },
      fill: { type: 'gradient', gradient: { opacityFrom: 0.35, opacityTo: 0.05 } },
      markers: { size: 3, colors: ['#E0574C'], strokeColors: '#fff', strokeWidth: 2 },
      dataLabels: { enabled: false },
      tooltip: { y: { formatter: (v: number) => `${v} rupture(s)` } },
      grid: { borderColor: 'rgba(27, 42, 74, .08)' },
    });

    chart.render();
    chartInstanceRef.current = chart;
    return () => { chart.destroy(); };
  }, [points]);

  return (
    <div className="card h-100">
      <div className="card-body">
        <h5 className="mb-3" style={{ color: '#1B2A4A', fontWeight: 600, fontSize: '.95rem' }}>
          Ruptures en cours — {new Date(startDate).toLocaleDateString('fr-FR')} au {new Date(endDate).toLocaleDateString('fr-FR')}
        </h5>
        {error ? (
          <div className="text-danger small">Erreur : {error}</div>
        ) : points === null ? (
          <div className="text-muted small">Chargement...</div>
        ) : (
          <div ref={chartRef}></div>
        )}
      </div>
    </div>
  );
}
