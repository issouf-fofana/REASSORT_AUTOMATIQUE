import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api/client';

const ACTION_LABELS: Record<string, string> = {
  ORDER_NOW: 'Commander maintenant',
  ORDER_MORE: 'Commander plus',
  ORDER_LESS: 'Commander moins',
  WAIT: 'Attendre',
  STOCK_RISK: 'Risque de rupture',
  OVERSTOCK: 'Surstock',
  DEMAND_INCREASE: 'Hausse de demande',
  DEMAND_DECREASE: 'Baisse de demande',
  ANOMALY: 'Anomalie',
  VERIFY_STOCK: 'Vérifier le stock',
  NO_ACTION: 'Aucune action',
};
const ACTION_BADGE_CLASS: Record<string, string> = {
  STOCK_RISK: 'bg-danger-subtle text-danger',
  ANOMALY: 'bg-danger-subtle text-danger',
  OVERSTOCK: 'bg-warning-subtle text-warning',
  ORDER_LESS: 'bg-warning-subtle text-warning',
  DEMAND_DECREASE: 'bg-warning-subtle text-warning',
  ORDER_NOW: 'bg-success-subtle text-success',
  ORDER_MORE: 'bg-success-subtle text-success',
  DEMAND_INCREASE: 'bg-info-subtle text-info',
};

function fmtDate(iso?: string | null) {
  return iso ? new Date(iso).toLocaleString('fr-FR') : '—';
}
function fmtNum(n?: number | null) {
  return n === null || n === undefined ? '—' : (Math.round(n * 10) / 10).toLocaleString('fr-FR');
}

function actionCellRenderer(params: any) {
  const action = params.value;
  if (!action) return '<span class="text-muted">—</span>';
  const cls = ACTION_BADGE_CLASS[action] || 'bg-secondary-subtle text-secondary';
  return `<span class="badge ${cls}">${ACTION_LABELS[action] || action}</span>`;
}

function correctedCellRenderer(params: any) {
  return params.value
    ? '<span class="badge bg-primary-subtle text-primary">Corrigée par l\'humain</span>'
    : '<span class="text-muted small">Suivie telle quelle</span>';
}

const gridColumnDefs = [
  { headerName: 'Générée le', field: 'generatedAt', width: 160, filter: 'agDateColumnFilter', valueFormatter: (p: any) => fmtDate(p.value) },
  { headerName: 'Article', field: 'label', flex: 1, minWidth: 200, filter: 'agTextColumnFilter', valueFormatter: (p: any) => p.value || p.data.ean },
  { headerName: 'Action IA', field: 'aiAction', width: 170, filter: 'agTextColumnFilter', cellRenderer: actionCellRenderer },
  {
    headerName: "Raisonnement de l'IA",
    field: 'aiReasoning',
    flex: 2,
    minWidth: 320,
    filter: 'agTextColumnFilter',
    autoHeight: true,
    wrapText: true,
    valueFormatter: (p: any) => p.value || '—',
  },
  { headerName: 'Calcul classique', field: 'classicQuantitySuggested', width: 130, filter: 'agNumberColumnFilter', valueFormatter: (p: any) => fmtNum(p.value) },
  { headerName: 'Proposé (IA)', field: 'quantityAiOriginal', width: 120, filter: 'agNumberColumnFilter', valueFormatter: (p: any) => fmtNum(p.value) },
  { headerName: 'Commandé', field: 'quantityValidated', width: 110, filter: 'agNumberColumnFilter', valueFormatter: (p: any) => fmtNum(p.value) },
  { headerName: 'Décision', field: 'wasCorrectedByHuman', width: 170, cellRenderer: correctedCellRenderer },
  { headerName: 'Statut commande', field: 'proposalStatus', width: 130, filter: 'agTextColumnFilter' },
];

export function DecisionLogTab({ active }: { active: boolean }) {
  const gridDivRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const gridApiRef = useRef<any>(null);
  const loadedRef = useRef(false);

  const [ean, setEan] = useState('');
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [summary, setSummary] = useState('');

  function ensureGrid() {
    if (gridApiRef.current) return gridApiRef.current;
    if (!gridDivRef.current) return null;
    gridApiRef.current = window.agGrid.createGrid(gridDivRef.current, {
      theme: window.REASSORT_AG_GRID_THEME,
      columnDefs: gridColumnDefs,
      rowData: [],
      localeText: window.AG_GRID_LOCALE_FR,
      domLayout: 'autoHeight',
      pagination: true,
      paginationPageSize: 50,
      paginationPageSizeSelector: [25, 50, 100, 200],
      animateRows: false,
    });
    if (toolbarRef.current) {
      window.reassortAgGridToolbar(gridApiRef.current, toolbarRef.current);
    }
    return gridApiRef.current;
  }

  async function load() {
    const api = ensureGrid();
    if (!api) return;
    const shop = window.reassortGetActiveShop ? window.reassortGetActiveShop() : null;
    const user = window.reassortGetUser ? window.reassortGetUser() : null;
    const isSingleShopRole = user && window.reassortIsSingleShopRole && window.reassortIsSingleShopRole(user.role);
    if (!shop && !isSingleShopRole) {
      setSummary('Sélectionnez un magasin pour voir ce journal.');
      api.setGridOption('rowData', []);
      return;
    }

    setSummary('Chargement…');
    try {
      const params = new URLSearchParams();
      if (shop) params.set('shop', shop.id);
      if (ean.trim()) params.set('ean', ean.trim());
      if (action) params.set('action', action);
      if (from) params.set('from', from + 'T00:00:00');
      if (to) params.set('to', to + 'T23:59:59');

      const rows = await apiFetch<unknown[]>('/reassort/ai-decision-log?' + params.toString());
      setSummary(`${rows.length} décision(s) IA (200 max affichées)`);
      api.setGridOption('rowData', rows);
    } catch (err) {
      setSummary('Erreur : ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  // Chargé seulement à la première fois que l'onglet devient actif (évite un appel réseau inutile
  // si l'utilisateur ne consulte jamais ce journal) — reproduit ici via `active` (posé par le parent
  // au clic sur l'onglet), au lieu de l'event shown.bs.tab de la page HTML d'origine.
  useEffect(() => {
    if (active && !loadedRef.current) {
      loadedRef.current = true;
      load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    if (!window.reassortOnActiveShopChange) return;
    window.reassortOnActiveShopChange(() => {
      if (loadedRef.current) load();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleExportCsv() {
    if (!gridApiRef.current) return;
    gridApiRef.current.exportDataAsCsv({ fileName: `journal-decisions-ia-${new Date().toISOString().slice(0, 10)}.csv` });
  }

  return (
    <div>
      <div className="card mb-3">
        <div className="card-body">
          <div className="alert alert-light border small mb-0">
            <strong>À quoi ça sert :</strong> historique consultable de chaque décision prise par l'IA sur une
            commande (quantité proposée, raisonnement, action). Le panneau "Pourquoi ?" affiché sur chaque commande
            montre déjà ce raisonnement, mais uniquement au moment où on ouvre cette commande précise — ce journal
            permet de retrouver et filtrer les décisions passées sans rouvrir chaque commande une par une.
          </div>
        </div>
      </div>

      <div className="card mb-3">
        <div className="card-body">
          <div className="row g-2 align-items-end mb-3">
            <div className="col-auto">
              <label className="form-label small mb-1">Article (EAN)</label>
              <input type="text" className="form-control form-control-sm" style={{ width: 160 }} placeholder="EAN exact" value={ean} onChange={(e) => setEan(e.target.value)} />
            </div>
            <div className="col-auto">
              <label className="form-label small mb-1">Action IA</label>
              <select className="form-select form-select-sm" style={{ width: 200 }} value={action} onChange={(e) => setAction(e.target.value)}>
                <option value="">Toutes</option>
                <option value="ORDER_NOW">Commander maintenant</option>
                <option value="ORDER_MORE">Commander plus</option>
                <option value="ORDER_LESS">Commander moins</option>
                <option value="WAIT">Attendre</option>
                <option value="STOCK_RISK">Risque de rupture</option>
                <option value="OVERSTOCK">Surstock</option>
                <option value="DEMAND_INCREASE">Hausse de demande</option>
                <option value="DEMAND_DECREASE">Baisse de demande</option>
                <option value="ANOMALY">Anomalie</option>
                <option value="VERIFY_STOCK">Vérifier le stock</option>
                <option value="NO_ACTION">Aucune action</option>
              </select>
            </div>
            <div className="col-auto">
              <label className="form-label small mb-1">Du</label>
              <input type="date" className="form-control form-control-sm" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="col-auto">
              <label className="form-label small mb-1">Au</label>
              <input type="date" className="form-control form-control-sm" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <div className="col-auto">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => {
                  loadedRef.current = true;
                  load();
                }}
              >
                Filtrer
              </button>{' '}
              <button type="button" className="btn btn-outline-secondary btn-sm" onClick={handleExportCsv}>
                Export CSV
              </button>
              <div ref={toolbarRef} className="d-inline-flex gap-2"></div>
            </div>
          </div>
          <div className="small text-muted mb-2">{summary}</div>
          <div ref={gridDivRef} style={{ width: '100%' }}></div>
        </div>
      </div>
    </div>
  );
}
