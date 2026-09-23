import { useEffect, useRef, useState } from 'react';
import { apiFetch } from './api/client';

interface Shop {
  id: string;
  posId: string;
  reference: string;
  name: string;
  posLabel?: string;
}

interface PredictionOutcome {
  actualSales: number;
  forecastError: number;
}

interface Prediction {
  ean: string;
  label: string;
  department?: string;
  predictedQuantity: number | null;
  predictedWeeklyDemand: number | null;
  confidenceScore: number | null;
  model: string;
  aiAction: string | null;
  outcome: PredictionOutcome | null;
  stockAtPrediction?: number;
  ordersAtPrediction?: number;
  reasoning?: string;
  dailyHistory: { date: string; quantity: number }[];
  classicQuantitySuggested: number | null;
  aiAdjusted: boolean;
  aiReasoningAtGeneration: string | null;
  hasRecentOrder: boolean;
  recentOrderReference: string | null;
  recentOrderDate: string | null;
  recentOrderCount: number | null;
  orderingUnit: number | null;
  avgWeeklySales: number | null;
  daysUntilStockout: number | null;
}

interface PredictionsResponse {
  proposalId: string | null;
  generatedAt: string | null;
  predictions: Prediction[];
}

interface ProposalListItem {
  id: string;
  generatedAt: string;
  status: string;
}

const AI_ACTION_LABELS: Record<string, string> = {
  ORDER_NOW: 'À commander',
  ORDER_MORE: 'Commande insuffisante',
  ORDER_LESS: 'Réduire la commande',
  WAIT: 'Attendre',
  STOCK_RISK: 'Risque de rupture',
  OVERSTOCK: 'Surstock',
  DEMAND_INCREASE: 'Demande en hausse',
  DEMAND_DECREASE: 'Demande en baisse',
  ANOMALY: 'Anomalie détectée',
  VERIFY_STOCK: 'Vérifier le stock',
  NO_ACTION: 'Rien à signaler',
};
const AI_ACTION_BADGE_CLASS: Record<string, string> = {
  ORDER_NOW: 'bg-dark',
  ORDER_MORE: 'bg-warning text-dark',
  ORDER_LESS: 'bg-secondary',
  WAIT: 'bg-light text-dark border',
  STOCK_RISK: 'bg-danger',
  OVERSTOCK: 'bg-warning text-dark',
  DEMAND_INCREASE: 'bg-success',
  DEMAND_DECREASE: 'bg-secondary',
  ANOMALY: 'bg-danger',
  VERIFY_STOCK: 'bg-danger',
  NO_ACTION: 'bg-light text-dark border',
};

function confidenceColor(score: number): string {
  if (score >= 70) return '#000000';
  if (score >= 40) return '#666666';
  return '#999999';
}

function labelCellRenderer(params: any) {
  const p = params.data as Prediction;
  const wrap = document.createElement('div');
  wrap.innerHTML = (p.label || '—') + '<div class="text-muted small">' + p.ean + '</div>';
  return wrap;
}

function gapCellRenderer(params: any) {
  const p = params.data as Prediction;
  const outcome = p.outcome;
  const span = document.createElement('span');
  if (!outcome) {
    span.className = 'text-muted';
    span.textContent = 'en attente';
    return span;
  }
  span.className = outcome.forecastError > 0 ? 'text-success' : outcome.forecastError < 0 ? 'text-danger' : '';
  span.textContent = (outcome.forecastError > 0 ? '+' : '') + Math.round(outcome.forecastError);
  return span;
}

function confidenceCellRenderer(params: any) {
  const p = params.data as Prediction;
  const score = p.confidenceScore ?? 0;
  const wrap = document.createElement('div');
  wrap.className = 'd-flex align-items-center gap-2';
  wrap.style.minWidth = '140px';
  wrap.innerHTML =
    '<div class="confidence-bar flex-grow-1"><div class="confidence-bar-fill" style="width:' +
    score +
    '%; background-color:' +
    confidenceColor(score) +
    ';"></div></div>' +
    '<span class="small fw-semibold">' +
    score +
    '%</span>';
  return wrap;
}

function aiActionCellRenderer(params: any) {
  const p = params.data as Prediction;
  const action = p.aiAction;
  if (!action || !AI_ACTION_LABELS[action]) {
    const span = document.createElement('span');
    span.className = 'text-muted small';
    span.textContent = '—';
    return span;
  }
  const badge = document.createElement('span');
  badge.className = 'badge ' + AI_ACTION_BADGE_CLASS[action];
  badge.textContent = AI_ACTION_LABELS[action];
  return badge;
}

const gridColumnDefs = [
  {
    headerName: 'Rayon',
    field: 'department',
    width: 160,
    filter: 'agTextColumnFilter',
    valueGetter: (p: any) => (p.data ? p.data.department || 'Autre' : ''),
  },
  { headerName: 'Article', field: 'label', flex: 2, minWidth: 260, filter: 'agTextColumnFilter', cellRenderer: labelCellRenderer },
  {
    headerName: 'Qté à commander',
    field: 'predictedQuantity',
    type: 'numericColumn',
    filter: 'agNumberColumnFilter',
    width: 160,
    valueFormatter: (p: any) => (p.value !== null && p.value !== undefined ? String(Math.round(p.value)) : '—'),
    cellClass: 'fw-semibold',
  },
  {
    headerName: 'Vente prévue/sem.',
    field: 'predictedWeeklyDemand',
    type: 'numericColumn',
    filter: 'agNumberColumnFilter',
    width: 160,
    valueFormatter: (p: any) => (p.value !== null && p.value !== undefined ? String(Math.round(p.value)) : '—'),
  },
  {
    headerName: 'Réel',
    width: 110,
    type: 'numericColumn',
    sortable: false,
    filter: false,
    valueGetter: (p: any) => (p.data && p.data.outcome ? p.data.outcome.actualSales : null),
    valueFormatter: (p: any) => (p.value !== null && p.value !== undefined ? p.value.toLocaleString('fr-FR') : '—'),
  },
  {
    headerName: 'Écart',
    width: 110,
    sortable: false,
    filter: false,
    cellRenderer: gapCellRenderer,
    valueGetter: (p: any) => (p.data && p.data.outcome ? Math.round(p.data.outcome.forecastError) : null),
  },
  {
    headerName: 'Confiance',
    field: 'confidenceScore',
    width: 170,
    filter: 'agNumberColumnFilter',
    cellRenderer: confidenceCellRenderer,
    valueFormatter: (p: any) => (p.value !== null && p.value !== undefined ? p.value : 0) + ' %',
  },
  {
    headerName: 'Méthode',
    field: 'model',
    width: 160,
    filter: 'agTextColumnFilter',
    valueFormatter: (p: any) => (p.value === 'flat' ? 'Moyenne simple' : 'Lissage exponentiel'),
  },
  {
    headerName: 'Action IA',
    field: 'aiAction',
    width: 170,
    filter: 'agTextColumnFilter',
    cellRenderer: aiActionCellRenderer,
    valueFormatter: (p: any) => (p.value && AI_ACTION_LABELS[p.value]) || '—',
  },
];

export function AiPredictions() {
  const shopSelectRef = useRef<HTMLSelectElement>(null);
  const proposalSelectRef = useRef<HTMLSelectElement>(null);
  const gridDivRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const gridApiRef = useRef<any>(null);
  const loadTokenRef = useRef(0);
  const allPredictionsRef = useRef<Prediction[]>([]);
  const currentProposalIdRef = useRef<string | null>(null);

  const [shops, setShops] = useState<Shop[]>([]);
  const [shopsError, setShopsError] = useState<string | null>(null);
  const [proposals, setProposals] = useState<ProposalListItem[]>([]);
  const [proposalSelectDisabled, setProposalSelectDisabled] = useState(true);
  const [infoText, setInfoText] = useState('');
  const [pageLabel, setPageLabel] = useState('—');
  const [emptyMessage, setEmptyMessage] = useState('Sélectionnez un magasin pour afficher ses prédictions.');
  const [showGridState, setShowGridState] = useState(false);

  function destroyGrid() {
    if (gridApiRef.current) {
      gridApiRef.current.destroy();
      gridApiRef.current = null;
    }
  }

  function updatePageLabel() {
    if (!gridApiRef.current) return;
    const totalArticles = allPredictionsRef.current.length;
    const deptCount = new Set(allPredictionsRef.current.map((p) => p.department || 'Autre')).size;
    const totalPages = gridApiRef.current.paginationGetTotalPages() || 1;
    const currentPage = gridApiRef.current.paginationGetCurrentPage() + 1;
    setPageLabel(`Page ${currentPage} / ${totalPages} (${deptCount} rayon(s), ${totalArticles} article(s))`);
  }

  function openPanelForRow(prediction: Prediction) {
    if (!prediction || !window.openAiRecommendationPanel) return;
    window.openAiRecommendationPanel({
      proposalId: currentProposalIdRef.current,
      shopId: shopSelectRef.current?.value,
      ean: prediction.ean,
      label: prediction.label,
      predictedQuantity: prediction.predictedQuantity,
      predictedWeeklyDemand: prediction.predictedWeeklyDemand,
      stockAtPrediction: prediction.stockAtPrediction,
      ordersAtPrediction: prediction.ordersAtPrediction,
      confidenceScore: prediction.confidenceScore,
      reasoning: prediction.reasoning,
      dailyHistory: prediction.dailyHistory,
      outcome: prediction.outcome,
      classicQuantitySuggested: prediction.classicQuantitySuggested,
      generationAiAdjusted: prediction.aiAdjusted,
      generationAiReasoning: prediction.aiReasoningAtGeneration,
      generationAiAction: prediction.aiAction,
      hasRecentOrder: prediction.hasRecentOrder,
      recentOrderReference: prediction.recentOrderReference,
      recentOrderDate: prediction.recentOrderDate,
      recentOrderCount: prediction.recentOrderCount,
      orderingUnit: prediction.orderingUnit,
      avgWeeklySales: prediction.avgWeeklySales,
      daysUntilStockout: prediction.daysUntilStockout,
    });
  }

  function ensureGrid() {
    if (gridApiRef.current) return gridApiRef.current;
    if (!gridDivRef.current) return null;
    gridApiRef.current = window.agGrid.createGrid(gridDivRef.current, {
      theme: window.REASSORT_AG_GRID_THEME_SOFT,
      columnDefs: gridColumnDefs,
      rowData: [],
      localeText: window.AG_GRID_LOCALE_FR,
      domLayout: 'autoHeight',
      pagination: true,
      paginationPageSize: 50,
      paginationPageSizeSelector: [25, 50, 100, 200],
      animateRows: false,
      suppressCellFocus: true,
      getRowId: (params: any) => params.data.ean,
      onGridReady: () => {
        gridApiRef.current.applyColumnState({
          state: [
            { colId: 'department', sort: 'asc', sortIndex: 0 },
            { colId: 'confidenceScore', sort: 'asc', sortIndex: 1 },
          ],
        });
      },
      onCellClicked: (e: any) => openPanelForRow(e.data),
      onPaginationChanged: () => updatePageLabel(),
      onModelUpdated: () => updatePageLabel(),
    });
    if (toolbarRef.current) {
      window.reassortAgGridToolbar(gridApiRef.current, toolbarRef.current);
    }
    return gridApiRef.current;
  }

  function showEmpty(msg: string) {
    setShowGridState(false);
    setEmptyMessage(msg);
    setPageLabel('—');
  }

  function showGrid() {
    setShowGridState(true);
  }

  function renderGrid() {
    showGrid();
    const api = ensureGrid();
    if (!api) return;
    api.setGridOption('rowData', allPredictionsRef.current);
    updatePageLabel();
  }

  async function loadPredictions() {
    const shopId = shopSelectRef.current?.value;
    if (!shopId) {
      showEmpty('Sélectionnez un magasin pour afficher ses prédictions.');
      setInfoText('');
      return;
    }
    const token = ++loadTokenRef.current;
    showEmpty('Chargement...');
    try {
      const proposalId = proposalSelectRef.current?.value;
      const url = `/reassort/predictions?shop=${encodeURIComponent(shopId)}${proposalId ? '&proposalId=' + encodeURIComponent(proposalId) : ''}`;
      const d = await apiFetch<PredictionsResponse>(url);
      if (token !== loadTokenRef.current) return;

      if (!d.proposalId || !d.predictions.length) {
        showEmpty('Aucune prédiction enregistrée pour ce magasin. Générez une proposition pour en créer.');
        setInfoText('');
        return;
      }

      if (proposalSelectRef.current && proposalSelectRef.current.value !== d.proposalId) {
        proposalSelectRef.current.value = d.proposalId;
      }
      currentProposalIdRef.current = d.proposalId;

      setInfoText(`${d.predictions.length} article(s) — génération du ${new Date(d.generatedAt!).toLocaleString('fr-FR')}.`);

      allPredictionsRef.current = d.predictions;
      renderGrid();
    } catch (err) {
      if (token !== loadTokenRef.current) return;
      showEmpty('Erreur: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  function warmShopActivity(shopId: string) {
    const opt = shopSelectRef.current?.querySelector(`option[value="${shopId}"]`) as HTMLOptionElement | null;
    const posId = opt?.dataset.posId;
    if (!shopId || !posId) return;
    window.reassortFetch(`/reassort/shop-activity/warm?shop=${encodeURIComponent(shopId)}&pos=${encodeURIComponent(posId)}`, {
      method: 'POST',
    }).catch(() => {});
  }

  async function loadProposalList() {
    const shopId = shopSelectRef.current?.value;
    const token = ++loadTokenRef.current;
    setProposals([]);
    setProposalSelectDisabled(true);
    if (!shopId) return;
    warmShopActivity(shopId);
    try {
      const data = await apiFetch<ProposalListItem[]>(`/reassort/predictions/proposals?shop=${encodeURIComponent(shopId)}`);
      if (token !== loadTokenRef.current) return;
      if (!data.length) {
        showEmpty('Aucune prédiction enregistrée pour ce magasin. Générez une proposition pour en créer.');
        setInfoText('');
        return;
      }
      setProposals(data);
      setProposalSelectDisabled(false);
      // setProposals ne peuple les <option> qu'au prochain rendu : loadPredictions (qui lit
      // proposalSelectRef.current.value) doit attendre ce commit, cf. useEffect ci-dessous.
    } catch (err) {
      if (token !== loadTokenRef.current) return;
      showEmpty('Erreur: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  // Charge la liste des magasins. La grille AG Grid elle-même est créée à la demande (ensureGrid,
  // appelée par renderGrid) : contrairement à Ventes synchronisées, rien ne doit s'afficher tant
  // qu'aucune prédiction n'est chargée (même comportement que ai-predictions.js d'origine).
  useEffect(() => {
    (async () => {
      try {
        const data = await apiFetch<Shop[]>('/reassort/shops');
        const byPos: Record<string, Shop[]> = {};
        data.forEach((s) => {
          if (!byPos[s.posId]) byPos[s.posId] = [];
          byPos[s.posId].push(s);
        });
        const sortedShops = Object.keys(byPos)
          .sort()
          .flatMap((posId) => byPos[posId].slice().sort((a, b) => (a.reference || '').localeCompare(b.reference || '')));
        setShops(sortedShops);
      } catch (err) {
        setShopsError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => destroyGrid();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Câble le picker de magasin + synchronise avec le magasin actif global de la topbar, UNE FOIS
  // que `shops` a été committé dans le DOM (voir le même bug corrigé sur Ventes synchronisées :
  // un setTimeout(0) ne garantit pas que React ait déjà rendu les <option>).
  useEffect(() => {
    const select = shopSelectRef.current;
    if (!select || shops.length === 0) return;

    function handleNativeChange() {
      loadProposalList();
    }
    select.addEventListener('change', handleNativeChange);

    if (window.reassortMakeShopPickerSearchable) {
      window.reassortMakeShopPickerSearchable(select);
    }

    const activeShop = window.reassortGetActiveShop ? window.reassortGetActiveShop() : null;
    const matchFound = activeShop ? select.querySelector(`option[value="${activeShop.id}"]`) : null;
    if (activeShop && matchFound) {
      if (select.value !== activeShop.id) select.value = activeShop.id;
      loadProposalList();
    } else if (select.value) {
      loadProposalList();
    }

    return () => select.removeEventListener('change', handleNativeChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shops]);

  // Une fois que `proposals` a été committé (les <option> du sélecteur de génération existent
  // réellement), charge les prédictions de la génération la plus récente — même raison que
  // l'effet ci-dessus : ne peut pas se fier à un accès DOM synchrone juste après setProposals().
  useEffect(() => {
    if (proposals.length === 0) return;
    loadPredictions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposals]);

  function handleProposalChange() {
    loadPredictions();
  }

  function handleExportCsv() {
    if (!gridApiRef.current) return;
    const shopRef = shopSelectRef.current?.selectedOptions[0]?.textContent || 'magasin';
    gridApiRef.current.exportDataAsCsv({
      fileName: `predictions-ia-${shopRef.replace(/[^a-z0-9]+/gi, '-')}-${new Date().toISOString().slice(0, 10)}.csv`,
    });
  }

  return (
    <div>
      <style>{`
        .confidence-bar { height: 6px; border-radius: 0; background-color: #e5e5e5; overflow: hidden; }
        .confidence-bar-fill { height: 100%; background-color: #000000; }
        #aip-grid { width: 100%; }
      `}</style>

      <div className="row mb-3">
        <div className="col-12">
          <div className="card">
            <div className="card-body">
              <div className="row g-2 align-items-end">
                <div className="col-md-5">
                  <label className="form-label small">Magasin</label>
                  <select className="form-select" ref={shopSelectRef} defaultValue="">
                    {shopsError ? (
                      <option value="">Erreur: {shopsError}</option>
                    ) : shops.length === 0 ? (
                      <option value="">Chargement...</option>
                    ) : (
                      Object.entries(
                        shops.reduce<Record<string, Shop[]>>((acc, s) => {
                          (acc[s.posId] ||= []).push(s);
                          return acc;
                        }, {}),
                      ).map(([posId, group]) => (
                        <optgroup key={posId} label={group[0].posLabel || posId}>
                          {group.map((s) => (
                            <option key={s.id} value={s.id} data-pos-id={s.posId}>
                              {s.reference} - {s.name}
                            </option>
                          ))}
                        </optgroup>
                      ))
                    )}
                  </select>
                </div>
                <div className="col-md-4">
                  <label className="form-label small">Génération</label>
                  <select
                    className="form-select"
                    ref={proposalSelectRef}
                    disabled={proposalSelectDisabled}
                    onChange={handleProposalChange}
                    defaultValue=""
                  >
                    {proposals.length === 0 ? (
                      <option value="">—</option>
                    ) : (
                      proposals.map((p, i) => (
                        <option key={p.id} value={p.id}>
                          {new Date(p.generatedAt).toLocaleString('fr-FR')} ({p.status})
                          {i === 0 ? ' — dernière' : ''}
                        </option>
                      ))
                    )}
                  </select>
                </div>
                <div className="col-md-3">
                  <button type="button" className="btn btn-primary w-100" onClick={loadPredictions}>
                    Actualiser
                  </button>
                </div>
              </div>
              <div className="small text-muted mt-2">{infoText}</div>
            </div>
          </div>
        </div>
      </div>

      <div className="card mb-3">
        <div className="card-body">
          <div className="alert alert-light border small mb-0">
            <strong>À quoi ça sert :</strong> pour chaque article de la génération sélectionnée, cliquez
            sur une ligne pour demander à l'IA une recommandation de quantité à commander, avec son
            explication détaillée. Triés par confiance croissante (donnée interne) : les articles les
            moins fiables d'abord.
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header d-flex justify-content-between align-items-center">
          <h4 className="card-title mb-0">Prédictions</h4>
          <div className="d-flex align-items-center gap-2">
            <span className="small text-muted">{pageLabel}</span>
            <button
              type="button"
              className="btn btn-sm btn-outline-dark"
              title="Export CSV, ouvrable directement dans Excel"
              onClick={handleExportCsv}
            >
              <iconify-icon icon="solar:file-download-bold-duotone" className="align-middle"></iconify-icon> Exporter (CSV)
            </button>
            <div ref={toolbarRef} className="d-flex gap-2"></div>
          </div>
        </div>
        <div className="card-body p-0">
          {!showGridState && <div className="text-center text-muted py-4">{emptyMessage}</div>}
          <div ref={gridDivRef} className="m-3" style={{ display: showGridState ? '' : 'none' }}></div>
        </div>
      </div>
    </div>
  );
}
