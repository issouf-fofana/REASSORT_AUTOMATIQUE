import { useEffect, useRef } from 'react';
import type { SupplierOrder } from './types';

// Répartition des dernières commandes par statut de livraison RPOS (demande du 30/09/2026) —
// calculée en mémoire à partir des commandes déjà chargées par TableauDeBord.tsx (aucun nouvel
// appel réseau), cohérent avec les libellés déjà utilisés par STATUS_BADGE.
const STATUS_COLOR: Record<string, string> = {
  'en préparation': '#8C99B5',
  'en attente de livraison': '#F5A623',
  'livrée partiellement': '#4A6FA5',
  'finalisée et partielle': '#4A6FA5',
  complète: '#1B2A4A',
  annulée: '#B0453F',
  supprimée: '#B0453F',
};
const FALLBACK_COLOR = '#8C99B5';

export function OrdersStatusDonut({ orders }: { orders: SupplierOrder[] | null }) {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartInstanceRef = useRef<any>(null);

  useEffect(() => {
    if (!orders || orders.length === 0 || !chartRef.current || !window.ApexCharts) return;

    const counts = new Map<string, number>();
    for (const o of orders) counts.set(o.status_display, (counts.get(o.status_display) || 0) + 1);
    const labels = Array.from(counts.keys());
    const series = labels.map((l) => counts.get(l)!);
    const colors = labels.map((l) => STATUS_COLOR[l] || FALLBACK_COLOR);

    const chart = new window.ApexCharts(chartRef.current, {
      chart: { type: 'donut', height: 280 },
      series,
      labels,
      colors,
      legend: { position: 'bottom', fontSize: '11px' },
      dataLabels: { enabled: true, formatter: (val: number) => `${Math.round(val)}%` },
      plotOptions: { pie: { donut: { labels: { show: true, total: { show: true, label: 'Commandes' } } } } },
    });
    chart.render();
    chartInstanceRef.current = chart;
    return () => { chart.destroy(); chartInstanceRef.current = null; };
  }, [orders]);

  return (
    <div className="card kpi-card kpi-card-chart h-100 mb-0">
      <div className="card-body">
        <h5 className="mb-3" style={{ color: '#1B2A4A', fontWeight: 600, fontSize: '.95rem' }}>
          Répartition des commandes par statut
        </h5>
        {orders === null ? (
          <div className="text-muted small">Chargement...</div>
        ) : orders.length === 0 ? (
          <div className="text-muted small">Aucune commande à afficher.</div>
        ) : (
          <div ref={chartRef}></div>
        )}
      </div>
    </div>
  );
}
