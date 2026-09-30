import { useEffect, useRef, useState } from 'react';
import { apiFetch } from './api/client';
import type { WeeklyConformityPoint } from './types';

// Évolution hebdomadaire du taux de conformité (demande du 30/09/2026) — même définition que la
// carte KPI "Taux de conformité" (proposalService.getConformityRate), mais regroupée semaine par
// semaine via /reassort/conformity/weekly pour visualiser une tendance plutôt qu'un chiffre unique.
export function ConformityTrendChart({ shopQueryParam }: { shopQueryParam: string }) {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartInstanceRef = useRef<any>(null);
  const [points, setPoints] = useState<WeeklyConformityPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!shopQueryParam) return;
    let cancelled = false;
    setPoints(null);
    setError(null);
    apiFetch<WeeklyConformityPoint[]>(`/reassort/conformity/weekly?weeks=10&${shopQueryParam}`)
      .then((data) => { if (!cancelled) setPoints(data); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [shopQueryParam]);

  useEffect(() => {
    if (!points || !chartRef.current || !window.ApexCharts) return;
    const categories = points.map((p) => new Date(p.weekStart).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }));
    const values = points.map((p) => (p.rate !== null ? Math.round(p.rate * 100) : null));

    const chart = new window.ApexCharts(chartRef.current, {
      chart: { type: 'bar', height: 280, toolbar: { show: false } },
      series: [{ name: 'Taux de conformité', data: values }],
      xaxis: { categories, labels: { style: { fontSize: '10px' } } },
      yaxis: { min: 0, max: 100, labels: { formatter: (v: number) => `${v}%` } },
      colors: ['#F5A623'],
      plotOptions: { bar: { borderRadius: 4, columnWidth: '55%' } },
      dataLabels: { enabled: false },
      tooltip: { y: { formatter: (v: number | null) => (v === null ? 'Aucune donnée' : `${v}%`) } },
      grid: { borderColor: 'rgba(27, 42, 74, .08)' },
    });
    chart.render();
    chartInstanceRef.current = chart;
    return () => { chart.destroy(); chartInstanceRef.current = null; };
  }, [points]);

  return (
    <div className="card kpi-card kpi-card-chart h-100 mb-0">
      <div className="card-body">
        <h5 className="mb-3" style={{ color: '#1B2A4A', fontWeight: 600, fontSize: '.95rem' }}>
          Taux de conformité — 10 dernières semaines
        </h5>
        {error ? (
          <div className="text-danger small">Erreur : {error}</div>
        ) : !points ? (
          <div className="text-muted small">Chargement...</div>
        ) : (
          <div ref={chartRef}></div>
        )}
      </div>
    </div>
  );
}
