import { useEffect, useRef, useState } from 'react';
import { apiFetch } from './api/client';

interface StockMoveType {
  typeLabel: string;
  count: number;
  totalQuantity: number;
  lastDate: string;
  isScrap?: boolean;
}

interface StockMoves {
  totalMoves: number;
  byType: StockMoveType[];
  scrapQuantity: number;
  truncated?: boolean;
}

interface OrderSufficiencyReasoning {
  sufficient: boolean;
  message: string;
}

interface AnalyticsData {
  stats: {
    totalQuantity: number;
    totalRevenue: number;
    avgWeeklySales: number;
    trend: 'hausse' | 'baisse' | 'stable';
    minBucketQuantity: number;
    maxBucketQuantity: number;
    orderCount: number;
    avgOrderedQuantity: number | null;
    avgDaysBetweenOrders: number | null;
  };
  prediction: {
    predictedQuantity: number;
    nextOrderInDays: number | null;
    avgWeeklySales: number;
    safetyStock: number;
    currentStock: number;
    currentOrderedQuantity: number;
    orderSufficiencyReasoning: OrderSufficiencyReasoning | null;
  };
  series: { date: string; quantity: number }[];
  stockSeries: (number | null)[];
  purchaseHistory: { date: string; quantity: number }[];
  granularity: 'hour' | 'day' | 'week' | 'month';
  stockMoves: StockMoves | null;
}

interface ProposalHistoryEntry {
  generatedAt: string;
  status: string;
  quantitySuggested: number;
  quantityValidated: number | null;
  quantitySoldSincePrevious: number | null;
  aiAdjusted?: boolean;
}

function paFormatBucketLabel(dateStr: string, granularity: string): string {
  const d = new Date(dateStr.length <= 7 ? dateStr + '-01' : dateStr);
  if (granularity === 'hour') return d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  if (granularity === 'day') return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
  if (granularity === 'week') return 'Sem. du ' + d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
  return d.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
}

function StockMovesSection({ stockMoves }: { stockMoves: StockMoves | null }) {
  if (!stockMoves || !stockMoves.totalMoves) return null;
  const notable = (stockMoves.byType || []).filter((t) => t.typeLabel !== 'Vente' && t.typeLabel !== 'Arrivage');
  if (!notable.length) return null;

  return (
    <div className="border rounded p-3 mt-3 bg-light-subtle">
      <div className="fw-semibold small mb-2">Mouvements de stock hors ventes/réceptions</div>
      {stockMoves.scrapQuantity > 0 && (
        <p className="text-danger small mb-2">
          <strong>{stockMoves.scrapQuantity.toLocaleString('fr-FR')}</strong> unité(s) perdues (casse) sur la période — à considérer avant
          d'ajuster la quantité proposée : une baisse de stock due à la casse n'est pas de la demande client.
        </p>
      )}
      <div className="table-responsive">
        <table className="table table-sm mb-0">
          <thead>
            <tr>
              <th>Type</th>
              <th className="text-center">Nb</th>
              <th className="text-end">Quantité cumulée</th>
              <th>Dernier mouvement</th>
            </tr>
          </thead>
          <tbody>
            {notable.map((t) => (
              <tr key={t.typeLabel}>
                <td>
                  {t.typeLabel}
                  {t.isScrap && <span className="badge bg-danger-subtle text-danger ms-1">perte</span>}
                </td>
                <td className="text-center">{t.count}</td>
                <td className="text-end">
                  {t.totalQuantity > 0 ? '+' : ''}
                  {t.totalQuantity.toLocaleString('fr-FR')}
                </td>
                <td className="text-muted small">{new Date(t.lastDate).toLocaleString('fr-FR')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {stockMoves.truncated && <p className="text-muted small mt-2 mb-0">Liste limitée aux mouvements les plus récents.</p>}
    </div>
  );
}

function AnalyticsOverview({ data }: { data: AnalyticsData }) {
  const chartRef = useRef<HTMLDivElement>(null);
  const s = data.stats;
  const p = data.prediction;

  const trendBadge =
    s.trend === 'hausse' ? (
      <span className="badge bg-success-subtle text-success">▲ En hausse</span>
    ) : s.trend === 'baisse' ? (
      <span className="badge bg-danger-subtle text-danger">▼ En baisse</span>
    ) : (
      <span className="badge bg-secondary-subtle text-secondary">Stable</span>
    );

  useEffect(() => {
    if (!chartRef.current) return;
    const categories = data.series.map((b) => paFormatBucketLabel(b.date, data.granularity));
    const salesData = data.series.map((b) => b.quantity);
    const stockData = (data.stockSeries || []).map((v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10));

    const orderedByBucket = new Map<string, number>();
    data.purchaseHistory.forEach((o) => {
      const key = paFormatBucketLabel(o.date, data.granularity);
      orderedByBucket.set(key, (orderedByBucket.get(key) || 0) + o.quantity);
    });
    const orderedData = categories.map((label) => orderedByBucket.get(label) || 0);

    const orderAnnotations = data.purchaseHistory
      .map((o) => ({
        x: paFormatBucketLabel(o.date, data.granularity),
        borderColor: '#f5a623',
        label: { text: 'Commande ' + o.quantity, style: { fontSize: '10px' } },
      }))
      .slice(0, 30);

    const chart = new window.ApexCharts(chartRef.current, {
      chart: { type: 'line', height: 320, toolbar: { show: false } },
      series: [
        { name: 'Quantité vendue', type: 'area', data: salesData },
        { name: 'Quantité commandée', type: 'column', data: orderedData },
        { name: 'Stock estimé', type: 'line', data: stockData },
      ],
      xaxis: { categories, labels: { rotate: -45, style: { fontSize: '10px' } } },
      yaxis: [
        { seriesName: 'Quantité vendue', title: { text: 'Ventes / commandes' } },
        { seriesName: 'Quantité commandée', show: false },
        { seriesName: 'Stock estimé', opposite: true, title: { text: 'Stock estimé' } },
      ],
      colors: ['#000000', '#999999', '#4d4d4d'],
      stroke: { curve: 'smooth', width: [2, 0, 2], dashArray: [0, 0, 4] },
      fill: { type: ['gradient', 'solid', 'solid'], gradient: { opacityFrom: 0.35, opacityTo: 0.05 }, opacity: [1, 0.7, 1] },
      dataLabels: { enabled: false },
      annotations: { xaxis: orderAnnotations },
      legend: { show: true },
      tooltip: { shared: true, intersect: false },
    });
    chart.render();
    return () => chart.destroy();
  }, [data]);

  return (
    <div>
      <div className="row g-3 mb-3">
        <div className="col-6 col-md-3">
          <div className="border rounded p-2 text-center">
            <div className="text-muted small">Quantité vendue</div>
            <div className="fw-bold fs-18">{s.totalQuantity.toLocaleString('fr-FR')}</div>
          </div>
        </div>
        <div className="col-6 col-md-3">
          <div className="border rounded p-2 text-center">
            <div className="text-muted small">Chiffre d'affaires</div>
            <div className="fw-bold fs-18">{Math.round(s.totalRevenue).toLocaleString('fr-FR')} CFA</div>
          </div>
        </div>
        <div className="col-6 col-md-3">
          <div className="border rounded p-2 text-center">
            <div className="text-muted small">Vente moy./sem.</div>
            <div className="fw-bold fs-18">{s.avgWeeklySales.toFixed(1)}</div>
          </div>
        </div>
        <div className="col-6 col-md-3">
          <div className="border rounded p-2 text-center">
            <div className="text-muted small">Tendance</div>
            <div className="fw-bold fs-18">{trendBadge}</div>
          </div>
        </div>
      </div>
      <div className="row g-3 mb-3">
        <div className="col-6 col-md-3">
          <div className="border rounded p-2 text-center">
            <div className="text-muted small">Min / période</div>
            <div className="fw-bold">{s.minBucketQuantity}</div>
          </div>
        </div>
        <div className="col-6 col-md-3">
          <div className="border rounded p-2 text-center">
            <div className="text-muted small">Max / période</div>
            <div className="fw-bold">{s.maxBucketQuantity}</div>
          </div>
        </div>
        <div className="col-6 col-md-3">
          <div className="border rounded p-2 text-center">
            <div className="text-muted small">Nb commandes</div>
            <div className="fw-bold">{s.orderCount}</div>
          </div>
        </div>
        <div className="col-6 col-md-3">
          <div className="border rounded p-2 text-center">
            <div className="text-muted small">Qté moy. commandée</div>
            <div className="fw-bold">{s.avgOrderedQuantity !== null ? s.avgOrderedQuantity.toFixed(0) : '—'}</div>
          </div>
        </div>
      </div>
      <div ref={chartRef} className="mb-1"></div>
      <p className="text-muted small mb-3">
        Stock estimé : reconstitué à partir du stock actuel et de l'historique ventes/commandes (RPOS ne conserve pas l'historique de stock
        réel) — à lire comme une tendance, pas une valeur exacte.
      </p>
      <div className="alert alert-info mb-0">
        <strong>Prochaine commande estimée :</strong> {p.predictedQuantity} unité(s)
        {p.nextOrderInDays !== null &&
          ` — dans environ ${p.nextOrderInDays} jour(s), sur la base de ${s.orderCount} commande(s) passée(s) (intervalle moyen : ${
            s.avgDaysBetweenOrders ? s.avgDaysBetweenOrders.toFixed(1) : '—'
          } j)`}
      </div>
      {p.orderSufficiencyReasoning && (
        <div className={`alert ${p.orderSufficiencyReasoning.sufficient ? 'alert-success' : 'alert-warning'} mt-2 mb-0`}>
          <strong>
            {p.orderSufficiencyReasoning.sufficient ? (
              <>
                <iconify-icon icon="solar:check-circle-bold-duotone"></iconify-icon> Commande suffisante
              </>
            ) : (
              <>
                <iconify-icon icon="solar:danger-triangle-bold-duotone"></iconify-icon> Commande insuffisante
              </>
            )}
            {' :'}
          </strong>{' '}
          {p.orderSufficiencyReasoning.message}
        </div>
      )}
      <div className="border rounded p-3 mt-2 bg-light-subtle">
        <div className="fw-semibold small mb-2">Formule de calcul</div>
        <div className="d-flex flex-wrap align-items-center gap-2 small">
          <span className="border rounded px-2 py-1 bg-white">
            Vente moyenne/sem.
            <br />
            <strong>{p.avgWeeklySales.toFixed(1)}</strong>
          </span>
          <span className="fw-bold">+</span>
          <span className="border rounded px-2 py-1 bg-white">
            Stock de sécurité
            <br />
            <strong>{p.safetyStock.toFixed(1)}</strong>
          </span>
          <span className="fw-bold">−</span>
          <span className="border rounded px-2 py-1 bg-white">
            Stock actuel
            <br />
            <strong>{p.currentStock}</strong>
          </span>
          <span className="fw-bold">−</span>
          <span className="border rounded px-2 py-1 bg-white">
            Déjà en commande
            <br />
            <strong>{p.currentOrderedQuantity}</strong>
          </span>
          <span className="fw-bold">=</span>
          <span className="border rounded px-2 py-1 bg-success-subtle text-success">
            Qté à commander
            <br />
            <strong>{p.predictedQuantity}</strong>
          </span>
        </div>
      </div>
      <StockMovesSection stockMoves={data.stockMoves} />
    </div>
  );
}

function statusBadgeClass(status: string): string {
  if (status === 'VALIDATED') return 'success';
  if (status === 'REJECTED') return 'secondary';
  return 'warning';
}

function ProposalHistoryTab({ ean, productId, shopQueryParam }: { ean: string; productId: string; shopQueryParam: string }) {
  const [entries, setEntries] = useState<ProposalHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(null);
    (async () => {
      try {
        const params = new URLSearchParams({ ean });
        new URLSearchParams(shopQueryParam).forEach((v, k) => params.set(k, v));
        const data = await apiFetch<ProposalHistoryEntry[]>(`/reassort/product/${encodeURIComponent(productId)}/proposal-history?${params.toString()}`);
        if (!cancelled) setEntries(data.slice().reverse());
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ean, productId, shopQueryParam]);

  if (error) return <div className="alert alert-danger">Erreur: {error}</div>;
  if (!entries) return <p className="text-muted text-center py-4">Chargement...</p>;
  if (!entries.length) return <p className="text-muted text-center py-4">Aucune génération n'a encore inclus cet article.</p>;

  return (
    <div className="table-responsive">
      <table className="table table-sm table-hover">
        <thead>
          <tr>
            <th>Date / heure</th>
            <th>Statut</th>
            <th className="text-end">Qté proposée</th>
            <th className="text-end">Qté validée</th>
            <th className="text-end">Vendu depuis la génération précédente</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((it, i) => (
            <tr key={i}>
              <td>
                {new Date(it.generatedAt).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                {it.aiAdjusted && (
                  <span className="badge bg-dark-subtle text-dark ms-1" title="Ajusté par IA">
                    IA
                  </span>
                )}
              </td>
              <td>
                <span className={`badge bg-${statusBadgeClass(it.status)}-subtle text-${statusBadgeClass(it.status)}`}>{it.status}</span>
              </td>
              <td className="text-end fw-semibold">{it.quantitySuggested}</td>
              <td className="text-end">{it.quantityValidated !== null && it.quantityValidated !== undefined ? it.quantityValidated : '—'}</td>
              <td className="text-end">{it.quantitySoldSincePrevious !== null ? it.quantitySoldSincePrevious : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ProductAnalyticsModal({
  article,
  shopQueryParam,
  onClose,
}: {
  article: { ean: string; productId: string; label: string };
  shopQueryParam: string;
  onClose: () => void;
}) {
  const [preset, setPreset] = useState('30');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'overview' | 'history'>('overview');

  function periodRange(): { dateStart: string | null; dateEnd: string | null } {
    if (preset === 'CUSTOM') {
      return { dateStart: customStart ? customStart + 'T00:00:00' : null, dateEnd: customEnd ? customEnd + 'T23:59:59' : null };
    }
    const days = parseInt(preset, 10);
    const end = new Date();
    const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
    return { dateStart: start.toISOString().slice(0, 19), dateEnd: end.toISOString().slice(0, 19) };
  }

  async function load() {
    const { dateStart, dateEnd } = periodRange();
    if (!dateStart || !dateEnd) {
      setError('Sélectionnez une période valide.');
      setData(null);
      return;
    }
    setError(null);
    setData(null);
    try {
      const params = new URLSearchParams({ ean: article.ean, dateStart, dateEnd });
      new URLSearchParams(shopQueryParam).forEach((v, k) => params.set(k, v));
      const result = await apiFetch<AnalyticsData>(`/reassort/product/${encodeURIComponent(article.productId)}/analytics?${params.toString()}`);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [article]);

  return (
    <>
      <div className="modal fade show" style={{ display: 'block' }} tabIndex={-1} role="dialog">
        <div className="modal-dialog modal-dialog-centered modal-xl modal-dialog-scrollable" role="document">
          <div className="modal-content">
            <div className="modal-header">
              <h5 className="modal-title d-flex align-items-center gap-2">
                <iconify-icon icon="solar:chart-2-bold-duotone" className="text-primary fs-24"></iconify-icon>
                <span>Évolution de l'article — {article.label}</span>
              </h5>
              <button type="button" className="btn-close" onClick={onClose}></button>
            </div>
            <div className="modal-body">
              <div className="row g-2 align-items-end mb-3">
                <div className="col-auto">
                  <label className="form-label small mb-1">Période</label>
                  <select className="form-select form-select-sm" value={preset} onChange={(e) => setPreset(e.target.value)}>
                    <option value="7">7 derniers jours</option>
                    <option value="30">30 derniers jours</option>
                    <option value="90">3 derniers mois</option>
                    <option value="365">12 derniers mois</option>
                    <option value="CUSTOM">Période personnalisée</option>
                  </select>
                </div>
                {preset === 'CUSTOM' && (
                  <>
                    <div className="col-auto">
                      <label className="form-label small mb-1">Du</label>
                      <input type="date" className="form-control form-control-sm" value={customStart} onChange={(e) => setCustomStart(e.target.value)} />
                    </div>
                    <div className="col-auto">
                      <label className="form-label small mb-1">Au</label>
                      <input type="date" className="form-control form-control-sm" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} />
                    </div>
                  </>
                )}
                <div className="col-auto">
                  <button type="button" className="btn btn-sm btn-outline-primary" onClick={load}>
                    Actualiser
                  </button>
                </div>
              </div>

              <ul className="nav nav-tabs mb-3" role="tablist">
                <li className="nav-item" role="presentation">
                  <button className={`nav-link ${activeTab === 'overview' ? 'active' : ''}`} type="button" onClick={() => setActiveTab('overview')}>
                    Vue d'ensemble
                  </button>
                </li>
                <li className="nav-item" role="presentation">
                  <button className={`nav-link ${activeTab === 'history' ? 'active' : ''}`} type="button" onClick={() => setActiveTab('history')}>
                    Historique des propositions
                  </button>
                </li>
              </ul>
              <div className="tab-content">
                <div className={`tab-pane fade ${activeTab === 'overview' ? 'show active' : ''}`}>
                  {error && <div className="alert alert-danger">Erreur: {error}</div>}
                  {!error && !data && <p className="text-muted text-center py-4">Chargement...</p>}
                  {data && <AnalyticsOverview data={data} />}
                </div>
                <div className={`tab-pane fade ${activeTab === 'history' ? 'show active' : ''}`}>
                  {activeTab === 'history' && <ProposalHistoryTab ean={article.ean} productId={article.productId} shopQueryParam={shopQueryParam} />}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="modal-backdrop fade show"></div>
    </>
  );
}
