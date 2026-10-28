import { useEffect, useRef } from 'react';

// Ventilation du CA perdu par type de commande LC (Livraison Centrale) / LD (Livraison Directe)
// (mission "Ventilation LC/LD du CA perdu — module Ruptures", 28/10/2026). Contrairement à
// StockoutCauseChart (donut du NOMBRE de ruptures par cause), ce donut porte sur le MONTANT de CA
// perdu — reçoit caPerdueLC/caPerdueLD/caPerdueTypeInconnu déjà calculés côté backend
// (stockoutEpisodeService.js), aucun second appel API.
export function StockoutDeliveryTypeChart({
  caPerdueLC,
  caPerdueLD,
  caPerdueTypeInconnu,
}: {
  caPerdueLC: number;
  caPerdueLD: number;
  caPerdueTypeInconnu: number;
}) {
  const chartRef = useRef<HTMLDivElement>(null);
  const total = caPerdueLC + caPerdueLD + caPerdueTypeInconnu;

  useEffect(() => {
    if (!total || !chartRef.current || !window.ApexCharts) return;
    const labels = ['Fournisseur central (LC)', 'Fournisseur direct (LD)', ...(caPerdueTypeInconnu > 0 ? ['Type inconnu'] : [])];
    const values = [caPerdueLC, caPerdueLD, ...(caPerdueTypeInconnu > 0 ? [caPerdueTypeInconnu] : [])];
    const colors = ['#5B6B85', '#F5A623', '#A0A8B8'];

    const chart = new window.ApexCharts(chartRef.current, {
      chart: { type: 'donut', height: 280 },
      series: values,
      labels,
      colors,
      legend: { position: 'bottom', fontSize: '12px' },
      dataLabels: { enabled: true, formatter: (v: number) => `${Math.round(v)}%` },
      tooltip: { y: { formatter: (v: number) => `${Math.round(v).toLocaleString('fr-FR')} CFA` } },
    });

    chart.render();
    return () => { chart.destroy(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caPerdueLC, caPerdueLD, caPerdueTypeInconnu]);

  return (
    <div className="card h-100">
      <div className="card-body">
        <h5 className="mb-3" style={{ color: '#1B2A4A', fontWeight: 600, fontSize: '.95rem' }}>
          CA perdu par type de commande (LC / LD)
        </h5>
        {total === 0 ? (
          <div className="text-muted small">Aucun CA perdu sur cette sélection.</div>
        ) : (
          <>
            <div ref={chartRef}></div>
            <div className="d-flex flex-wrap gap-2 mt-2">
              <div className="d-flex align-items-center gap-1" style={{ fontSize: '.78rem', color: '#2A2F45' }}>
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#5B6B85', flexShrink: 0 }}></span>
                <span>LC — {Math.round(caPerdueLC).toLocaleString('fr-FR')} CFA</span>
              </div>
              <div className="d-flex align-items-center gap-1" style={{ fontSize: '.78rem', color: '#2A2F45' }}>
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#F5A623', flexShrink: 0 }}></span>
                <span>LD — {Math.round(caPerdueLD).toLocaleString('fr-FR')} CFA</span>
              </div>
              {caPerdueTypeInconnu > 0 && (
                <div className="d-flex align-items-center gap-1" style={{ fontSize: '.78rem', color: '#2A2F45' }}>
                  <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#A0A8B8', flexShrink: 0 }}></span>
                  <span>Type inconnu — {Math.round(caPerdueTypeInconnu).toLocaleString('fr-FR')} CFA</span>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
