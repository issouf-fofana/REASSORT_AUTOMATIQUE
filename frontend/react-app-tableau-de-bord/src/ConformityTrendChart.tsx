import { useEffect, useRef, useState } from 'react';
import { apiFetch } from './api/client';
import type { WeeklyConformityPoint } from './types';

// Évolution hebdomadaire du taux de conformité (demande du 30/09/2026) — même définition que la
// carte KPI "Taux de conformité" (proposalService.getConformityRate), mais regroupée semaine par
// semaine via /reassort/conformity/weekly pour visualiser une tendance plutôt qu'un chiffre unique.
//
// endpoint/title optionnels (demande du 05/10/2026 : courbe agrégée "Tous les magasins" dans
// AllShopsView.tsx, via /reassort/admin/conformity/weekly) — par défaut, comportement d'origine
// inchangé (un seul magasin, via shopQueryParam).
export function ConformityTrendChart({
  shopQueryParam,
  endpoint = '/reassort/conformity/weekly',
  title = 'Taux de conformité — 10 dernières semaines',
}: {
  shopQueryParam: string;
  endpoint?: string;
  title?: string;
}) {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartInstanceRef = useRef<any>(null);
  const [points, setPoints] = useState<WeeklyConformityPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPoints(null);
    setError(null);
    const qs = shopQueryParam ? `weeks=10&${shopQueryParam}` : 'weeks=10';
    apiFetch<WeeklyConformityPoint[]>(`${endpoint}?${qs}`)
      .then((data) => { if (!cancelled) setPoints(data); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [shopQueryParam, endpoint]);

  useEffect(() => {
    if (!points || !chartRef.current || !window.ApexCharts) return;
    const categories = points.map((p) => new Date(p.weekStart).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }));
    // Le graphique s'affiche TOUJOURS, même sans aucune commande validée (demande du 05/10/2026) :
    // une semaine sans donnée vaut 0 ici (barre à hauteur nulle, visuellement vide), distinguée
    // d'un vrai 0% uniquement via le tooltip ("Aucune donnée" vs "0%") — jamais de null transmis à
    // ApexCharts, qui ne rendait parfois ni axes ni cadre avec une série 100% null (bug constaté).
    const values = points.map((p) => (p.rate !== null ? Math.round(p.rate * 100) : 0));
    const hasData = points.map((p) => p.rate !== null);

    // Courbe d'évolution plutôt qu'un histogramme (demande du 05/10/2026) : une tendance dans le
    // temps se lit mieux comme une ligne continue que comme des barres indépendantes semaine par
    // semaine.
    const chart = new window.ApexCharts(chartRef.current, {
      chart: { type: 'line', height: 280, toolbar: { show: false } },
      series: [{ name: 'Taux de conformité', data: values }],
      xaxis: { categories, labels: { style: { fontSize: '10px' } } },
      yaxis: { min: 0, max: 100, labels: { formatter: (v: number) => `${v}%` } },
      colors: ['#F5A623'],
      stroke: { curve: 'smooth', width: 3 },
      markers: { size: 4, colors: ['#F5A623'], strokeColors: '#fff', strokeWidth: 2 },
      dataLabels: { enabled: false },
      tooltip: { y: { formatter: (v: number, opts: { dataPointIndex: number }) => (hasData[opts.dataPointIndex] ? `${v}%` : 'Aucune donnée') } },
      grid: { borderColor: 'rgba(27, 42, 74, .08)' },
      noData: { text: 'Aucune commande validée sur cette période' },
    });
    chart.render();
    chartInstanceRef.current = chart;
    return () => { chart.destroy(); chartInstanceRef.current = null; };
  }, [points]);

  return (
    <div className="card kpi-card kpi-card-chart h-100 mb-0">
      <div className="card-body">
        <h5 className="mb-3" style={{ color: '#1B2A4A', fontWeight: 600, fontSize: '.95rem' }}>
          {title}
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
