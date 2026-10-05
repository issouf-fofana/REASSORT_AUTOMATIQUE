import { useEffect, useRef, useState } from 'react';
import { apiFetch } from './api/client';

interface TodayProposalShop {
  id: string;
  rposShopId: string;
  rposShopReference: string;
  rposShopName: string;
  generatedAt: string;
  linesTotal: number | null;
}

// Vue multi-magasins (30/09/2026, ADMIN uniquement ; transformée en graphique à barres le
// 05/10/2026 à la demande de l'utilisateur) : quels magasins ont une proposition générée
// aujourd'hui, en attente de validation, avec le nombre d'articles par magasin visualisé en barres
// horizontales — pour comparer les magasins d'un coup d'œil plutôt qu'en lisant une liste de
// chiffres. Indépendante du sélecteur de magasin du reste du Tableau de bord.
export function TodayProposalsCard() {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartInstanceRef = useRef<any>(null);
  const [shops, setShops] = useState<TodayProposalShop[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<TodayProposalShop[]>('/reassort/admin/today-proposals')
      .then((data) => { if (!cancelled) setShops(data); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!shops || !chartRef.current || !window.ApexCharts) return;

    // Les plus gros magasins en haut (ApexCharts dessine les barres horizontales de bas en haut,
    // donc on inverse l'ordre pour que le plus gros apparaisse visuellement en premier/en haut).
    const sorted = [...shops].sort((a, b) => (a.linesTotal ?? 0) - (b.linesTotal ?? 0));
    const categories = sorted.map((s) => `${s.rposShopReference} — ${s.rposShopName}`);
    const values = sorted.map((s) => s.linesTotal ?? 0);

    const chart = new window.ApexCharts(chartRef.current, {
      chart: {
        type: 'bar',
        height: Math.max(220, sorted.length * 42),
        toolbar: { show: false },
        events: {
          // Clic sur une barre = même navigation que l'ancien lien de la liste.
          dataPointSelection: (_e: unknown, _ctx: unknown, config: { dataPointIndex: number }) => {
            const s = sorted[config.dataPointIndex];
            if (s) window.location.href = `/purchase-order?shop=${encodeURIComponent(s.rposShopId)}`;
          },
        },
      },
      series: [{ name: 'Articles proposés', data: values }],
      xaxis: { categories, labels: { style: { fontSize: '10px' } } },
      colors: ['#1B2A4A'],
      plotOptions: { bar: { horizontal: true, borderRadius: 4, barHeight: '55%' } },
      dataLabels: { enabled: true, style: { colors: ['#fff'] }, offsetX: -4 },
      tooltip: {
        y: {
          formatter: (v: number, opts: { dataPointIndex: number }) => {
            const s = sorted[opts.dataPointIndex];
            const time = s ? new Date(s.generatedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '';
            return `${v} article(s) · ${time}`;
          },
        },
      },
      grid: { borderColor: 'rgba(27, 42, 74, .08)' },
      noData: { text: "Aucun magasin n'a de proposition générée aujourd'hui" },
    });
    chart.render();
    chartInstanceRef.current = chart;
    return () => { chart.destroy(); chartInstanceRef.current = null; };
  }, [shops]);

  return (
    <div className="card kpi-card kpi-card-chart h-100 mb-0">
      <div className="card-body">
        <h5 className="mb-3" style={{ color: '#1B2A4A', fontWeight: 600, fontSize: '.95rem' }}>
          Magasins avec une proposition aujourd'hui
        </h5>
        {error ? (
          <div className="text-danger small">Erreur : {error}</div>
        ) : !shops ? (
          <div className="text-muted small">Chargement...</div>
        ) : (
          <div ref={chartRef}></div>
        )}
      </div>
    </div>
  );
}
