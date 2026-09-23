import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api/client';

interface ErrorReport {
  createdAt: string;
  statusCode: number;
  method?: string;
  url?: string;
  message: string;
  userEmail?: string;
  ip?: string;
}

function fmtDate(iso?: string | null) {
  return iso ? new Date(iso).toLocaleString('fr-FR') : '—';
}

function statusCellRenderer(params: any) {
  const code = params.value;
  const span = document.createElement('span');
  span.className = 'badge ' + (code >= 500 && code < 502 ? 'bg-danger-subtle text-danger' : 'bg-warning-subtle text-warning');
  span.textContent = code;
  return span;
}

function urlCellRenderer(params: any) {
  const r = params.data as ErrorReport;
  const code = document.createElement('code');
  code.className = 'small';
  code.textContent = (r.method ? r.method + ' ' : '') + (r.url || '');
  return code;
}

const gridColumnDefs = [
  {
    headerName: 'Date',
    field: 'createdAt',
    width: 170,
    filter: 'agDateColumnFilter',
    valueFormatter: (p: any) => fmtDate(p.value),
  },
  { headerName: 'Code', field: 'statusCode', width: 90, filter: 'agNumberColumnFilter', cellRenderer: statusCellRenderer },
  {
    headerName: 'URL',
    width: 260,
    filter: 'agTextColumnFilter',
    cellRenderer: urlCellRenderer,
    valueGetter: (p: any) => (p.data.method ? p.data.method + ' ' : '') + (p.data.url || ''),
  },
  { headerName: 'Message', field: 'message', flex: 2, minWidth: 300, filter: 'agTextColumnFilter', autoHeight: true, wrapText: true },
  {
    headerName: 'Utilisateur',
    field: 'userEmail',
    width: 200,
    filter: 'agTextColumnFilter',
    valueFormatter: (p: any) => p.value || '—',
  },
  { headerName: 'IP', field: 'ip', width: 140, filter: 'agTextColumnFilter', valueFormatter: (p: any) => p.value || '—' },
];

export function ErrorLogTab() {
  const gridDivRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const gridApiRef = useRef<any>(null);
  const searchTimerRef = useRef<number | null>(null);

  const [search, setSearch] = useState('');
  const [statusCode, setStatusCode] = useState('');
  const [summary, setSummary] = useState('');

  function ensureGrid() {
    if (gridApiRef.current) return gridApiRef.current;
    if (!gridDivRef.current) return null;
    gridApiRef.current = window.agGrid.createGrid(gridDivRef.current, {
      theme: (window.REASSORT_AG_GRID_THEME as any).withParams({ rowHeight: 48 }),
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

  async function loadErrors(searchValue: string, statusValue: string) {
    const api = ensureGrid();
    if (!api) return;
    try {
      const params = new URLSearchParams();
      if (searchValue) params.set('search', searchValue);
      if (statusValue) params.set('statusCode', statusValue);
      const rows = await apiFetch<ErrorReport[]>('/reassort/error-reports?' + params.toString());
      setSummary(`${rows.length} erreur(s) (100 max affichées, 30 derniers jours)`);
      api.setGridOption('rowData', rows);
    } catch (err) {
      setSummary('Erreur: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  useEffect(() => {
    loadErrors(search, statusCode);
    return () => {
      if (gridApiRef.current) {
        gridApiRef.current.destroy();
        gridApiRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleSearchChange(value: string) {
    setSearch(value);
    if (searchTimerRef.current) window.clearTimeout(searchTimerRef.current);
    searchTimerRef.current = window.setTimeout(() => loadErrors(value, statusCode), 400);
  }

  function handleStatusChange(value: string) {
    setStatusCode(value);
    loadErrors(search, value);
  }

  function handleExportCsv() {
    if (!gridApiRef.current) return;
    gridApiRef.current.exportDataAsCsv({ fileName: `journal-erreurs-${new Date().toISOString().slice(0, 10)}.csv` });
  }

  return (
    <div>
      <style>{`#err-grid { width: 100%; }`}</style>

      <div className="card mb-3">
        <div className="card-body">
          <div className="alert alert-light border small mb-0">
            <strong>À quoi ça sert :</strong> chaque erreur serveur (code 5xx) survenue sur l'API est enregistrée
            automatiquement ici, avec l'URL appelée, le message exact, la personne connectée au moment de l'erreur
            et l'horodatage — ces mêmes erreurs sont aussi écrites dans les logs du conteneur (visibles dans
            Dokploy). L'onglet Améliorations IA regroupe ces lignes en recommandations. Rétention 30 jours, plafond
            5000 lignes.
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header d-flex flex-wrap gap-2 justify-content-between align-items-center">
          <h4 className="card-title mb-0">Erreurs journalisées</h4>
          <div className="d-flex flex-wrap gap-2 align-items-center">
            <input
              type="text"
              className="form-control form-control-sm"
              placeholder="Rechercher dans l'URL ou le message..."
              style={{ maxWidth: 260 }}
              value={search}
              onChange={(e) => handleSearchChange(e.target.value)}
            />
            <select
              className="form-select form-select-sm"
              style={{ maxWidth: 150 }}
              value={statusCode}
              onChange={(e) => handleStatusChange(e.target.value)}
            >
              <option value="">Tous les codes</option>
              <option value="500">500</option>
              <option value="502">502</option>
              <option value="503">503</option>
              <option value="504">504</option>
            </select>
            <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => loadErrors(search, statusCode)}>
              Actualiser
            </button>
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
        <div className="card-body">
          <div className="small text-muted mb-2">{summary}</div>
          <div ref={gridDivRef} id="err-grid"></div>
        </div>
      </div>
    </div>
  );
}
