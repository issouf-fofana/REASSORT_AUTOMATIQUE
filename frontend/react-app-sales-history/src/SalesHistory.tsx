import { useEffect, useRef, useState } from 'react';
import { apiFetch } from './api/client';

interface Shop {
  id: string;
  posId: string;
  reference: string;
  name: string;
  posLabel?: string;
}

interface SalesLine {
  date: string;
  ean: string;
  label: string;
  quantity: number;
  revenueExclTax: number;
  revenueInclTax: number | null;
}

interface SalesLinesResponse {
  total: number;
  page: number;
  pageSize: number;
  totalQuantity: number;
  totalRevenue: number;
  totalRevenueInclTax: number | null;
  lines: SalesLine[];
}

interface RowData {
  date: string;
  ean: string;
  label: string;
  quantity: number;
  revenueExclTax: number;
  revenueInclTax: number | null;
  department?: string;
  __groupHeader?: boolean;
  count?: number;
}

const PAGE_SIZE = 100;

function numberFormatter(params: any): string {
  return params.value === null || params.value === undefined ? '—' : params.value.toLocaleString('fr-FR');
}
function currencyFormatter(params: any): string {
  return params.value === null || params.value === undefined ? '—' : params.value.toLocaleString('fr-FR') + ' CFA';
}

const departmentColumnDef = {
  field: 'department',
  headerName: 'Rayon',
  filter: 'agTextColumnFilter',
  sortable: true,
  minWidth: 160,
};

const baseColumnDefs = [
  {
    field: 'date',
    headerName: 'Date',
    filter: 'agDateColumnFilter',
    sortable: true,
    sort: 'desc',
    minWidth: 170,
    valueFormatter: (params: any) => (params.value ? new Date(params.value).toLocaleString('fr-FR') : '—'),
    filterParams: {
      comparator: (filterLocalDateAtMidnight: Date, cellValue: string) => {
        if (!cellValue) return -1;
        const cellDate = new Date(cellValue);
        const cellDateAtMidnight = new Date(cellDate.getFullYear(), cellDate.getMonth(), cellDate.getDate());
        if (cellDateAtMidnight < filterLocalDateAtMidnight) return -1;
        if (cellDateAtMidnight > filterLocalDateAtMidnight) return 1;
        return 0;
      },
    },
  },
  { field: 'ean', headerName: 'EAN', filter: 'agTextColumnFilter', sortable: true, minWidth: 140 },
  {
    field: 'label',
    headerName: 'Article',
    filter: 'agTextColumnFilter',
    sortable: true,
    flex: 1,
    minWidth: 220,
    valueFormatter: (params: any) => params.value || '—',
  },
  { field: 'quantity', headerName: 'Quantité', filter: 'agNumberColumnFilter', sortable: true, minWidth: 130, type: 'rightAligned', valueFormatter: numberFormatter },
  { field: 'revenueExclTax', headerName: 'CA (HT)', filter: 'agNumberColumnFilter', sortable: true, minWidth: 140, type: 'rightAligned', valueFormatter: currencyFormatter },
  { field: 'revenueInclTax', headerName: 'CA (TTC)', filter: 'agNumberColumnFilter', sortable: true, minWidth: 140, type: 'rightAligned', valueFormatter: currencyFormatter },
];

function groupHeaderRow(department: string, count: number): RowData {
  return { __groupHeader: true, department: department || 'Rayon inconnu', count, date: '', ean: '', label: '', quantity: 0, revenueExclTax: 0, revenueInclTax: null };
}

function withDepartmentGroupHeaders(rows: RowData[]): RowData[] {
  const sorted = [...rows].sort((a, b) => {
    const da = a.department || 'Rayon inconnu';
    const db = b.department || 'Rayon inconnu';
    if (da !== db) return da.localeCompare(db);
    return new Date(b.date).getTime() - new Date(a.date).getTime();
  });
  const out: RowData[] = [];
  let currentDept: string | null = null;
  sorted.forEach((row) => {
    const dept = row.department || 'Rayon inconnu';
    if (dept !== currentDept) {
      currentDept = dept;
      out.push(groupHeaderRow(dept, 0));
    }
    out.push(row);
  });
  let i = 0;
  while (i < out.length) {
    if (out[i].__groupHeader) {
      let count = 0;
      let j = i + 1;
      while (j < out.length && !out[j].__groupHeader) {
        count++;
        j++;
      }
      out[i].count = count;
      i = j;
    } else {
      i++;
    }
  }
  return out;
}

function toRowData(l: SalesLine): RowData {
  return {
    date: l.date,
    ean: l.ean,
    label: l.label,
    quantity: l.quantity,
    revenueExclTax: l.revenueExclTax,
    revenueInclTax: l.revenueInclTax ?? null,
  };
}

export function SalesHistory() {
  const shopSelectRef = useRef<HTMLSelectElement>(null);
  const gridDivRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const gridApiRef = useRef<any>(null);
  const searchTokenRef = useRef(0);
  const lastLoadedLinesRef = useRef<SalesLine[]>([]);

  const [shops, setShops] = useState<Shop[]>([]);
  const [shopsError, setShopsError] = useState<string | null>(null);
  const [dateStart, setDateStart] = useState('');
  const [dateEnd, setDateEnd] = useState('');
  const [ean, setEan] = useState('');
  const [groupByDepartment, setGroupByDepartment] = useState(false);

  const [coverageText, setCoverageText] = useState('');
  const [statCount, setStatCount] = useState('—');
  const [statQty, setStatQty] = useState('—');
  const [statRevenue, setStatRevenue] = useState('—');
  const [statRevenueTtc, setStatRevenueTtc] = useState('—');

  const [emptyMessage, setEmptyMessageState] = useState('Sélectionnez un magasin pour afficher ses ventes.');
  const [showGridState, setShowGridState] = useState(false);

  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  function setEmptyMessage(msg: string) {
    setShowGridState(false);
    setEmptyMessageState(msg);
  }
  function showGrid() {
    setShowGridState(true);
  }

  function destroyGrid() {
    if (gridApiRef.current) {
      gridApiRef.current.destroy();
      gridApiRef.current = null;
    }
  }

  function buildGridOptions(withDepartment: boolean) {
    const dateColDef = withDepartment ? { ...baseColumnDefs[0], sort: null } : baseColumnDefs[0];
    const columnDefs = withDepartment ? [departmentColumnDef, dateColDef, ...baseColumnDefs.slice(1)] : [...baseColumnDefs];
    return {
      theme: window.REASSORT_AG_GRID_THEME_SOFT,
      columnDefs,
      localeText: window.AG_GRID_LOCALE_FR,
      domLayout: 'autoHeight',
      pagination: false,
      rowData: [],
      defaultColDef: { resizable: true, sortable: true },
      isFullWidthRow: withDepartment ? (params: any) => !!params.rowNode.data.__groupHeader : undefined,
      fullWidthCellRenderer: withDepartment
        ? (params: any) => {
            const div = document.createElement('div');
            div.className = 'sh-group-header-row';
            div.textContent = params.data.department + ' (' + params.data.count + ' article(s))';
            return div;
          }
        : undefined,
      getRowHeight: withDepartment ? (params: any) => (params.data && params.data.__groupHeader ? 38 : undefined) : undefined,
    };
  }

  function createGrid(withDepartment: boolean) {
    destroyGrid();
    if (!gridDivRef.current) return;
    gridDivRef.current.innerHTML = '';
    const options = buildGridOptions(withDepartment);
    gridApiRef.current = window.agGrid.createGrid(gridDivRef.current, options);
    if (toolbarRef.current) {
      toolbarRef.current.innerHTML = '';
      window.reassortAgGridToolbar(gridApiRef.current, toolbarRef.current);
    }
  }

  async function renderGroupedByDepartment(lines: SalesLine[]) {
    const shopId = shopSelectRef.current?.value;
    const posId = shopSelectRef.current?.selectedOptions[0]?.dataset.posId;
    const eans = [...new Set(lines.map((l) => l.ean))];

    setEmptyMessage(`Résolution des rayons (${eans.length} article(s) distinct(s))...`);
    let departmentByEan: Record<string, { sector: string; department: string }> = {};
    try {
      departmentByEan = await apiFetch(
        `/reassort/sales-lines/departments?shopId=${encodeURIComponent(shopId || '')}&posId=${encodeURIComponent(posId || '')}&eans=${encodeURIComponent(eans.join(','))}`,
      );
    } catch (err) {
      setEmptyMessage('Erreur lors de la résolution des rayons: ' + (err instanceof Error ? err.message : String(err)));
      return;
    }

    const rows = lines.map((l) => {
      const row = toRowData(l);
      row.department = departmentByEan[l.ean]?.department || 'Rayon inconnu';
      return row;
    });

    createGrid(true);
    gridApiRef.current.setGridOption('rowData', withDepartmentGroupHeaders(rows));
    showGrid();
  }

  async function renderCurrentLines(grouped: boolean) {
    if (!lastLoadedLinesRef.current.length) {
      setEmptyMessage('Aucune vente trouvée pour ces filtres.');
    } else if (grouped) {
      await renderGroupedByDepartment(lastLoadedLinesRef.current);
    } else {
      createGrid(false);
      gridApiRef.current.setGridOption('rowData', lastLoadedLinesRef.current.map(toRowData));
      showGrid();
    }
  }

  async function search(page: number) {
    const shopId = shopSelectRef.current?.value;
    if (!shopId) {
      setEmptyMessage('Sélectionnez un magasin pour afficher ses ventes.');
      return;
    }
    const token = ++searchTokenRef.current;
    const pageToLoad = page || 1;

    const params = new URLSearchParams({ shopId, page: String(pageToLoad), pageSize: String(PAGE_SIZE) });
    if (dateStart) params.set('dateStart', dateStart);
    if (dateEnd) params.set('dateEnd', dateEnd + 'T23:59:59');
    if (ean.trim()) params.set('ean', ean.trim());

    setEmptyMessage('Chargement...');
    try {
      const d = await apiFetch<SalesLinesResponse>('/reassort/sales-lines?' + params.toString());
      if (token !== searchTokenRef.current) return;

      setStatCount(d.total.toLocaleString('fr-FR'));
      setStatQty(d.totalQuantity.toLocaleString('fr-FR'));
      setStatRevenue(d.totalRevenue.toLocaleString('fr-FR') + ' CFA');
      setStatRevenueTtc(
        d.totalRevenueInclTax !== null && d.totalRevenueInclTax !== undefined
          ? d.totalRevenueInclTax.toLocaleString('fr-FR') + ' CFA'
          : "— (données antérieures à l'ajout du TTC)",
      );

      lastLoadedLinesRef.current = d.lines;
      await renderCurrentLines(groupByDepartment);
      if (token !== searchTokenRef.current) return;

      setCurrentPage(pageToLoad);
      setTotalPages(Math.max(1, Math.ceil(d.total / PAGE_SIZE)));
    } catch (err) {
      if (token !== searchTokenRef.current) return;
      setEmptyMessage('Erreur: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  async function loadCoverage(shopId: string) {
    if (!shopId) {
      setCoverageText('');
      return;
    }
    try {
      const d = await apiFetch<{ count: number; oldestDate: string; newestDate: string }>(
        `/reassort/sales-lines/coverage?shopId=${encodeURIComponent(shopId)}`,
      );
      setCoverageText(
        d.count > 0
          ? `Période couverte : ${new Date(d.oldestDate).toLocaleDateString('fr-FR')} → ${new Date(d.newestDate).toLocaleDateString('fr-FR')} (${d.count.toLocaleString('fr-FR')} ligne(s) au total)`
          : 'Aucune vente synchronisée pour ce magasin. Utilisez Paramètres → Synchronisation des ventes pour lancer une récupération.',
      );
    } catch {
      setCoverageText('');
    }
  }

  // Charge la liste des magasins, crée la grille initiale, puis synchronise avec le magasin actif
  // global de la topbar (reassortMakeShopPickerSearchable) — même comportement que
  // sales-history.old.html.
  useEffect(() => {
    createGrid(false);
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

        // reassortMakeShopPickerSearchable a besoin du <select> déjà peuplé dans le DOM (options
        // réelles, pas juste l'état React) — appelé après le prochain rendu via un micro-délai,
        // le temps que React commette les <option>.
        setTimeout(() => {
          const select = shopSelectRef.current;
          if (!select) return;

          // Écouteur natif plutôt qu'un onChange React contrôlé : shop-picker.js synchronise ce
          // <select> en manipulant le DOM directement (selectEl.value = ...; dispatchEvent('change'))
          // depuis 3 sources indépendantes — le clic dans sa propre modale, reassortOnActiveShopChange
          // (déclenché par le bouton global de la topbar OU par un autre picker sur la même page), et
          // applyGlobalShopIfAny() au montage (le magasin par défaut peut résoudre APRÈS ce montage,
          // de façon asynchrone). Un <select> contrôlé par React (value=state) réécrit sa valeur DOM à
          // chaque rendu et entre en conflit avec ces écritures externes — un select non contrôlé +
          // un vrai event listener natif reproduit exactement le comportement de la page HTML
          // d'origine, où ce <select> n'a jamais été piloté par un framework.
          let changeFiredByPicker = false;
          select.addEventListener('change', () => {
            changeFiredByPicker = true;
            loadCoverage(select.value);
            search(1);
          });

          if (window.reassortMakeShopPickerSearchable) {
            window.reassortMakeShopPickerSearchable(select);
          }
          // reassortMakeShopPickerSearchable déclenche lui-même un dispatchEvent('change') sur ce
          // <select>, SYNCHRONE, s'il applique un magasin global déjà connu (applyGlobalShopIfAny) —
          // déjà capté par le listener ci-dessus (changeFiredByPicker passe à true avant qu'on arrive
          // ici). Sans magasin global correspondant, aucun event n'est déclenché : dans ce cas
          // seulement, on lance nous-mêmes une recherche initiale sur la première option du <select>
          // (comportement de repli, pas de magasin actif choisi mais au moins un existe).
          if (select.value && !changeFiredByPicker) {
            loadCoverage(select.value);
            search(1);
          }
        }, 0);
      } catch (err) {
        setShopsError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => destroyGrid();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleGroupToggle(e: React.ChangeEvent<HTMLInputElement>) {
    const next = e.target.checked;
    setGroupByDepartment(next);
    renderCurrentLines(next);
  }

  function handleExportCsv() {
    if (!gridApiRef.current) return;
    gridApiRef.current.exportDataAsCsv({ fileName: 'ventes-synchronisees.csv' });
  }

  return (
    <div>
      <style>{`
        #sh-grid { width: 100%; }
        .sh-group-header-row {
          display: flex; align-items: center; height: 100%; padding: 0 12px;
          background-color: #f1f3f5; font-weight: 600; color: #1a1a1a; border-bottom: 1px solid #dee2e6;
        }
        .sh-metric-row { display: flex; flex-wrap: wrap; }
        .sh-metric-row-item { flex: 1 1 180px; padding: 1rem 1.5rem 1rem 0; border-right: 1px solid var(--bs-border-color, #dee2e6); }
        .sh-metric-row-item:last-child { border-right: none; }
        .sh-metric-label { font-size: .8125rem; color: var(--bs-secondary-color, #6c757d); margin: 0 0 .35rem; }
        .sh-metric-value { font-size: 1.5rem; font-weight: 600; line-height: 1.15; font-variant-numeric: tabular-nums; margin: 0; }
        @media (max-width: 767px) {
          .sh-metric-row-item { border-right: none; border-bottom: 1px solid var(--bs-border-color, #dee2e6); }
        }
      `}</style>

      <div className="row mb-3">
        <div className="col-12">
          <div className="card">
            <div className="card-body">
              <div className="row g-2 align-items-end">
                <div className="col-md-4">
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
                <div className="col-md-2">
                  <label className="form-label small">Date de début</label>
                  <input type="date" className="form-control" value={dateStart} onChange={(e) => setDateStart(e.target.value)} />
                </div>
                <div className="col-md-2">
                  <label className="form-label small">Date de fin</label>
                  <input type="date" className="form-control" value={dateEnd} onChange={(e) => setDateEnd(e.target.value)} />
                </div>
                <div className="col-md-2">
                  <label className="form-label small">Article (EAN)</label>
                  <input type="text" className="form-control" placeholder="Optionnel" value={ean} onChange={(e) => setEan(e.target.value)} />
                </div>
                <div className="col-md-2">
                  <button type="button" className="btn btn-primary w-100" onClick={() => search(1)}>
                    Rechercher
                  </button>
                </div>
              </div>
              <div className="small text-muted mt-2">{coverageText}</div>
              <div className="form-check form-switch mt-2">
                <input
                  className="form-check-input"
                  type="checkbox"
                  role="switch"
                  id="sh-group-by-department"
                  checked={groupByDepartment}
                  onChange={handleGroupToggle}
                />
                <label className="form-check-label small" htmlFor="sh-group-by-department">
                  Grouper par rayon (résolu depuis RPOS, peut prendre quelques secondes sur la première page)
                </label>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="card mb-3">
        <div className="card-body py-2">
          <div className="sh-metric-row">
            <div className="sh-metric-row-item">
              <p className="sh-metric-label">Lignes trouvées</p>
              <p className="sh-metric-value">{statCount}</p>
            </div>
            <div className="sh-metric-row-item">
              <p className="sh-metric-label">Quantité totale</p>
              <p className="sh-metric-value">{statQty}</p>
            </div>
            <div className="sh-metric-row-item">
              <p className="sh-metric-label">Chiffre d'affaires (HT)</p>
              <p className="sh-metric-value">{statRevenue}</p>
            </div>
            <div className="sh-metric-row-item">
              <p className="sh-metric-label">Chiffre d'affaires (TTC)</p>
              <p className="sh-metric-value">{statRevenueTtc}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header d-flex justify-content-between align-items-center">
          <h4 className="card-title mb-0">Ventes synchronisées</h4>
          <div className="d-flex align-items-center gap-2">
            <button type="button" className="btn btn-sm btn-outline-dark" title="Export CSV, ouvrable directement dans Excel" onClick={handleExportCsv}>
              <iconify-icon icon="solar:file-download-bold-duotone" className="align-middle"></iconify-icon> Exporter (CSV)
            </button>
            <button type="button" className="btn btn-sm btn-outline-secondary" disabled={currentPage <= 1} onClick={() => search(currentPage - 1)}>
              &laquo; Précédent
            </button>
            <span className="small text-muted">
              Page {currentPage} / {totalPages}
            </span>
            <button type="button" className="btn btn-sm btn-outline-secondary" disabled={currentPage >= totalPages} onClick={() => search(currentPage + 1)}>
              Suivant &raquo;
            </button>
            <div ref={toolbarRef} className="d-flex gap-2"></div>
          </div>
        </div>
        <div className="card-body p-0">
          {!showGridState && <div className="text-center text-muted py-4">{emptyMessage}</div>}
          <div ref={gridDivRef} style={{ display: showGridState ? '' : 'none' }}></div>
        </div>
      </div>
    </div>
  );
}
