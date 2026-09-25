import { useEffect, useRef, useState } from 'react';
import { apiFetch } from './api/client';

interface Shop {
  id: string;
  posId: string;
  reference: string;
  name: string;
  posLabel?: string;
}

interface OrderSupplier {
  code: string;
  name: string;
}

interface Order {
  id: string;
  reference: string;
  external_reference: string;
  date: string;
  delivery_date: string | null;
  status_display: string;
  supplier: OrderSupplier | null;
  created_by: string | null;
  deletedOnRpos: boolean;
}

interface OrdersResponse {
  orders: Order[];
  count: number;
  nextPage: number | null;
}

interface ProposalLine {
  ean: string;
  label: string;
  quantitySuggested: number;
  quantityValidated: number | null;
  sellingPrice: number | null;
}

interface OrderDetail {
  lines: ProposalLine[];
}

const STATUS_BADGE: Record<string, string> = {
  'en préparation': 'bg-secondary-subtle text-secondary',
  'en attente de livraison': 'bg-warning-subtle text-warning',
  'livrée partiellement': 'bg-info-subtle text-info',
  'finalisée et partielle': 'bg-info-subtle text-info',
  complète: 'bg-success-subtle text-success',
  annulée: 'bg-danger-subtle text-danger',
};

function formatDate(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('fr-FR') + (iso.includes('T') && !iso.endsWith('T00:00:00') ? ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '');
}

// Le rayon n'est pas un champ structuré côté RPOS (une commande fournisseur = un rayon, mais l'API
// supplier_order ne renvoie que external_reference en texte libre) : on l'extrait de ce libellé
// ("Proposition réassort IA — LIQUIDES" -> "LIQUIDES"), même logique que la page HTML d'origine.
function extractDepartment(externalReference?: string | null): string {
  if (!externalReference) return 'Sans rayon identifié';
  const marker = ' — ';
  const idx = externalReference.indexOf(marker);
  return idx === -1 ? externalReference : externalReference.slice(idx + marker.length);
}

function statusCellRenderer(params: any) {
  const badgeClass = STATUS_BADGE[params.value] || 'bg-secondary-subtle text-secondary';
  const span = document.createElement('span');
  span.className = `badge ${badgeClass} py-1 px-2`;
  span.textContent = params.value;
  return span;
}

export function PurchaseList() {
  const [user, setUser] = useState(() => window.reassortGetUser());
  const isSingleShop = user ? window.reassortIsSingleShopRole(user.role) : true;

  const shopSelectRef = useRef<HTMLSelectElement>(null);
  const gridDivRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const gridApiRef = useRef<any>(null);
  const loadTokenRef = useRef(0);

  const [shops, setShops] = useState<Shop[]>([]);
  const [shopsError, setShopsError] = useState<string | null>(null);
  const [pageTitle, setPageTitle] = useState('Historique des commandes fournisseur');
  const [status, setStatus] = useState('');
  const [orders, setOrders] = useState<Order[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const [detailOpen, setDetailOpen] = useState(false);
  const [detailTitle, setDetailTitle] = useState('');
  const [detailBody, setDetailBody] = useState<React.ReactNode>('Chargement...');
  const [canCancel, setCanCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const currentOrderRef = useRef<{ id: string; reference: string; statusDisplay: string } | null>(null);
  const detailGridDivRef = useRef<HTMLDivElement>(null);
  const detailGridApiRef = useRef<any>(null);

  useEffect(() => {
    setUser(window.reassortGetUser());
  }, []);

  function selectedShopId(): string {
    if (!user) return '';
    if (isSingleShop) return user.rposShopId || '';
    return shopSelectRef.current?.value || '';
  }

  function selectedPosId(): string {
    if (!user) return '';
    if (isSingleShop) return user.rposPosId || '';
    const opt = shopSelectRef.current?.selectedOptions[0] as HTMLOptionElement | undefined;
    return opt?.dataset.posId || '';
  }

  function updateTitle() {
    let shopName = user?.rposShopName;
    let shopRef = user?.rposShopReference;
    if (!isSingleShop) {
      const opt = shopSelectRef.current?.selectedOptions[0] as HTMLOptionElement | undefined;
      if (opt) {
        shopName = opt.dataset.name;
        shopRef = opt.dataset.reference;
      }
    }
    setPageTitle('Historique des commandes fournisseur' + (shopName ? ` — ${shopRef} (${shopName})` : ''));
  }

  function ensureGrid() {
    if (gridApiRef.current) return gridApiRef.current;
    if (!gridDivRef.current) return null;
    gridApiRef.current = window.agGrid.createGrid(gridDivRef.current, {
      theme: window.REASSORT_AG_GRID_THEME_SOFT,
      columnDefs: [
        { headerName: 'Rayon', field: '_department', rowGroup: true, hide: true, filter: 'agTextColumnFilter' },
        {
          headerName: 'Référence',
          field: 'reference',
          filter: 'agTextColumnFilter',
          width: 150,
          cellRenderer: (params: any) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn btn-sm btn-link p-0 fw-semibold';
            btn.textContent = params.value;
            btn.addEventListener('click', () => showOrderDetail(params.data.id, params.data.reference, params.data.status_display));
            return btn;
          },
        },
        {
          headerName: 'Libellé',
          field: 'external_reference',
          flex: 1.5,
          minWidth: 220,
          filter: 'agTextColumnFilter',
          valueFormatter: (p: any) => p.value || '—',
        },
        { headerName: 'Fournisseur', field: '_supplierLabel', flex: 1, minWidth: 180, filter: 'agTextColumnFilter' },
        { headerName: 'Date commande', field: 'date', filter: 'agDateColumnFilter', width: 160, valueFormatter: (p: any) => formatDate(p.value) },
        { headerName: 'Date livraison', field: 'delivery_date', filter: 'agDateColumnFilter', width: 160, valueFormatter: (p: any) => formatDate(p.value) },
        { headerName: 'Statut', field: 'status_display', filter: 'agTextColumnFilter', width: 170, cellRenderer: statusCellRenderer },
        { headerName: 'Créée par', field: 'created_by', filter: 'agTextColumnFilter', width: 150, valueFormatter: (p: any) => p.value || '—' },
        {
          headerName: 'PDF',
          width: 80,
          sortable: false,
          filter: false,
          valueGetter: () => '',
          cellRenderer: (params: any) => {
            if (params.data?.deletedOnRpos) return '';
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn btn-sm btn-outline-dark';
            btn.title = 'Télécharger le bon de commande PDF';
            btn.innerHTML = '<iconify-icon icon="solar:file-pdf-bold-duotone"></iconify-icon>';
            btn.addEventListener('click', (e) => {
              e.stopPropagation();
              handleDownloadPdf(params.data.id);
            });
            return btn;
          },
        },
      ],
      rowData: [],
      localeText: window.AG_GRID_LOCALE_FR,
      domLayout: 'autoHeight',
      animateRows: false,
      suppressCellFocus: true,
      groupDisplayType: 'groupRows',
      groupDefaultExpanded: 0,
      groupRowRendererParams: {
        innerRenderer: (params: any) => {
          const count = params.node.allChildrenCount;
          return `<strong>${params.value}</strong> <span class="text-muted small">(${count} commande(s))</span>`;
        },
      },
      getRowId: (params: any) => params.data.id,
      onRowDoubleClicked: (e: any) => {
        if (!e.data) return;
        showOrderDetail(e.data.id, e.data.reference, e.data.status_display);
      },
    });
    if (toolbarRef.current) {
      window.reassortAgGridToolbar(gridApiRef.current, toolbarRef.current);
    }
    return gridApiRef.current;
  }

  function renderRows(ordersList: Order[]) {
    const api = ensureGrid();
    if (!api) return;
    const rows = ordersList.map((o) => ({
      ...o,
      _department: extractDepartment(o.external_reference),
      _supplierLabel: o.supplier ? `${o.supplier.code} / ${o.supplier.name}` : '—',
    }));
    api.setGridOption('rowData', rows);
  }

  async function loadOrders() {
    updateTitle();
    const shopId = selectedShopId();
    if (!shopId) {
      ensureGrid();
      gridApiRef.current?.setGridOption('rowData', []);
      setOrders([]);
      setStatus('Sélectionnez un magasin.');
      return;
    }
    const token = ++loadTokenRef.current;
    setStatus('Chargement...');
    setRefreshing(true);
    try {
      const posId = selectedPosId();
      const data = await apiFetch<OrdersResponse>(`/reassort/orders?shop=${encodeURIComponent(shopId)}${posId ? '&pos=' + encodeURIComponent(posId) : ''}`);
      if (token !== loadTokenRef.current) return;
      setOrders(data.orders);
      renderRows(data.orders);
      setStatus(`${data.count} commande(s) au total`);
    } catch (err) {
      if (token !== loadTokenRef.current) return;
      ensureGrid();
      gridApiRef.current?.setGridOption('rowData', []);
      setOrders([]);
      setStatus('Erreur: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      if (token === loadTokenRef.current) setRefreshing(false);
    }
  }

  useEffect(() => {
    if (!user) return;
    (async () => {
      if (!isSingleShop) {
        try {
          const data = await apiFetch<Shop[]>('/reassort/shops');
          setShops(data);
        } catch (err) {
          setShopsError(err instanceof Error ? err.message : String(err));
          return;
        }
      }
      updateTitle();
      loadOrders();
    })();
    return () => {
      if (gridApiRef.current) {
        gridApiRef.current.destroy();
        gridApiRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  useEffect(() => {
    if (isSingleShop || shops.length === 0) return;
    const select = shopSelectRef.current;
    if (!select) return;
    select.addEventListener('change', loadOrders);
    if (window.reassortMakeShopPickerSearchable) {
      window.reassortMakeShopPickerSearchable(select);
    }
    return () => select.removeEventListener('change', loadOrders);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shops]);

  function handleExportCsv() {
    if (!gridApiRef.current) return;
    const shopRef = user?.rposShopReference || 'magasin';
    gridApiRef.current.exportDataAsCsv({ fileName: `commandes-fournisseur-${shopRef}-${new Date().toISOString().slice(0, 10)}.csv` });
  }

  // Bon de commande PDF (demande du 25/09/2026) : simple proxy binaire côté backend vers RPOS
  // (endpoint confirmé par inspection réseau côté interface RPOS elle-même), ouvert dans un nouvel
  // onglet — window.reassortFetch (pas un <a href> direct) car la route est protégée par Bearer,
  // qu'un lien classique ne peut pas porter.
  async function handleDownloadPdf(orderId: string) {
    try {
      const shopId = selectedShopId();
      const posId = selectedPosId();
      const res = await window.reassortFetch(
        `/reassort/orders/${encodeURIComponent(orderId)}/pdf?shop=${encodeURIComponent(shopId)}&pos=${encodeURIComponent(posId)}`,
      );
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        throw new Error(json?.message || `Échec du téléchargement (HTTP ${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      // L'onglet garde sa propre référence au blob une fois ouvert : révoquer immédiatement après
      // (plutôt que jamais) évite une fuite mémoire si l'utilisateur enchaîne plusieurs PDF.
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err) {
      window.reassortToast('Erreur : ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
  }

  async function handleCancelOrder() {
    const target = currentOrderRef.current;
    if (!target || !user) return;
    const confirmed = window.reassortConfirm
      ? await window.reassortConfirm(`Annuler définitivement la commande ${target.reference} sur RPOS ? Cette action est irréversible.`, { danger: true })
      : confirm(`Annuler définitivement la commande ${target.reference} sur RPOS ? Cette action est irréversible.`);
    if (!confirmed) return;
    setCancelling(true);
    setCancelError(null);
    try {
      const shopId = selectedShopId();
      const posId = selectedPosId();
      await apiFetch(`/reassort/orders/${encodeURIComponent(target.id)}/cancel?shop=${encodeURIComponent(shopId)}&pos=${encodeURIComponent(posId)}`, {
        method: 'POST',
      });
      setDetailOpen(false);
      loadOrders();
    } catch (err) {
      setCancelError('Erreur: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setCancelling(false);
    }
  }

  async function showOrderDetail(orderId: string, reference: string, statusDisplay: string) {
    currentOrderRef.current = { id: orderId, reference, statusDisplay };
    setDetailTitle(`Détail de la commande ${reference}`);
    setDetailBody('Chargement...');
    setCancelError(null);
    setCanCancel(!!user && user.role === 'ADMIN' && statusDisplay !== 'annulée' && statusDisplay !== 'supprimée');
    setDetailOpen(true);

    try {
      const shopId = selectedShopId();
      const proposal = await apiFetch<OrderDetail>(`/reassort/orders/${encodeURIComponent(orderId)}/detail?shop=${encodeURIComponent(shopId)}`);
      const lines = proposal.lines || [];
      if (!lines.length) {
        setDetailBody(<p className="text-muted mb-0">Aucun article trouvé pour cette commande.</p>);
        return;
      }
      const total = lines.reduce((sum, l) => sum + (l.sellingPrice || 0) * (l.quantityValidated ?? l.quantitySuggested), 0);
      setDetailBody(
        <div>
          <div ref={detailGridDivRef} className="mb-2"></div>
          <p className="text-end fw-semibold mb-0 mt-2">Total envoyé : {total.toLocaleString('fr-FR')} CFA</p>
        </div>,
      );
      // Le conteneur ne sera dans le DOM qu'au prochain rendu React (setDetailBody ci-dessus) :
      // la grille est créée au tick suivant, une fois le ref réellement attaché.
      setTimeout(() => {
        if (!detailGridDivRef.current) return;
        if (detailGridApiRef.current) {
          detailGridApiRef.current.destroy();
          detailGridApiRef.current = null;
        }
        const detailRows = lines.map((l) => {
          const qtySent = l.quantityValidated ?? l.quantitySuggested;
          return {
            ean: l.ean,
            label: l.label,
            quantitySuggested: l.quantitySuggested,
            qtySent,
            sellingPrice: l.sellingPrice || 0,
            value: (l.sellingPrice || 0) * qtySent,
          };
        });
        detailGridApiRef.current = window.agGrid.createGrid(detailGridDivRef.current, {
          theme: window.REASSORT_AG_GRID_THEME_SOFT,
          columnDefs: [
            { headerName: 'EAN', field: 'ean', filter: 'agTextColumnFilter', width: 130 },
            { headerName: 'Article', field: 'label', flex: 1, minWidth: 200, filter: 'agTextColumnFilter' },
            { headerName: 'Qté proposée', field: 'quantitySuggested', type: 'numericColumn', filter: 'agNumberColumnFilter', width: 130 },
            { headerName: 'Qté envoyée', field: 'qtySent', type: 'numericColumn', filter: 'agNumberColumnFilter', width: 130, cellClass: 'fw-semibold' },
            {
              headerName: 'Prix vente',
              field: 'sellingPrice',
              type: 'numericColumn',
              filter: 'agNumberColumnFilter',
              width: 130,
              valueFormatter: (p: any) => (p.value ? p.value.toLocaleString('fr-FR') + ' CFA' : '—'),
            },
            {
              headerName: 'Valeur',
              field: 'value',
              type: 'numericColumn',
              filter: 'agNumberColumnFilter',
              width: 130,
              valueFormatter: (p: any) => p.value.toLocaleString('fr-FR') + ' CFA',
            },
          ],
          rowData: detailRows,
          localeText: window.AG_GRID_LOCALE_FR,
          domLayout: 'autoHeight',
          animateRows: false,
          suppressCellFocus: true,
        });
      }, 0);
    } catch (err) {
      setDetailBody(<div className="alert alert-warning mb-0">{err instanceof Error ? err.message : String(err)}</div>);
    }
  }

  const total = orders.length;
  const complete = orders.filter((o) => o.status_display === 'complète' || o.status_display === 'finalisée et partielle').length;
  const pending = orders.filter((o) => o.status_display === 'en attente de livraison' || o.status_display === 'livrée partiellement').length;
  const cancelled = orders.filter((o) => o.status_display === 'annulée').length;
  const cancelledAlert = total > 0 && cancelled / total > 0.15;

  const byPos: Record<string, Shop[]> = {};
  shops.forEach((s) => (byPos[s.posId] ||= []).push(s));
  const sortedPosIds = Object.keys(byPos).sort((a, b) => parseInt(a.replace(/\D/g, ''), 10) - parseInt(b.replace(/\D/g, ''), 10));

  return (
    <div>
      <style>{`
        #orders-grid, #order-detail-grid { width: 100%; }
        .po-metric-row { display: flex; flex-wrap: wrap; border-bottom: 1px solid var(--bs-border-color, #dee2e6); }
        .po-metric-row-item { flex: 1 1 160px; padding: 1rem 1.5rem 1rem 1.5rem; border-right: 1px solid var(--bs-border-color, #dee2e6); }
        .po-metric-row-item:last-child { border-right: none; }
        .po-metric-label { font-size: .8125rem; color: var(--bs-secondary-color, #6c757d); margin: 0 0 .35rem; }
        .po-metric-value { font-size: 1.5rem; font-weight: 600; line-height: 1.15; font-variant-numeric: tabular-nums; margin: 0; }
        .po-metric-value.is-alert { color: #B91C1C; }
        @media (max-width: 767px) {
          .po-metric-row-item { border-right: none; border-bottom: 1px solid var(--bs-border-color, #dee2e6); }
        }
      `}</style>

      <div className="row">
        <div className="col-xl-12">
          <div className="card">
            <div className="d-flex card-header justify-content-between align-items-center">
              <div>
                <h4 className="card-title">{pageTitle}</h4>
              </div>
              <div className="d-flex gap-2 align-items-center">
                {!isSingleShop && (
                  <select className="form-select form-select-sm" style={{ width: 'auto' }} ref={shopSelectRef} defaultValue="">
                    {shopsError ? (
                      <option value="">Erreur: {shopsError}</option>
                    ) : shops.length === 0 ? (
                      <option value="">Chargement...</option>
                    ) : (
                      sortedPosIds.map((posId) => (
                        <optgroup label={byPos[posId][0]?.posLabel || posId} key={posId}>
                          {byPos[posId]
                            .slice()
                            .sort((a, b) => (a.reference || '').localeCompare(b.reference || ''))
                            .map((s) => (
                              <option value={s.id} key={s.id} data-pos-id={s.posId} data-reference={s.reference} data-name={s.name}>
                                {s.reference} - {s.name}
                              </option>
                            ))}
                        </optgroup>
                      ))
                    )}
                  </select>
                )}
                <span className="text-muted small">{status}</span>
                <button className="btn btn-sm btn-outline-dark" title="Export CSV, ouvrable directement dans Excel" onClick={handleExportCsv}>
                  <iconify-icon icon="solar:file-download-bold-duotone" className="align-middle"></iconify-icon> Exporter (CSV)
                </button>
                <button className="btn btn-sm btn-outline-primary" disabled={refreshing} onClick={loadOrders}>
                  Actualiser
                </button>
                <div ref={toolbarRef} className="d-flex gap-2"></div>
              </div>
            </div>
            {orders.length > 0 && (
              <div className="po-metric-row">
                <div className="po-metric-row-item">
                  <p className="po-metric-label">Commandes affichées</p>
                  <p className="po-metric-value">{total}</p>
                </div>
                <div className="po-metric-row-item">
                  <p className="po-metric-label">Complètes</p>
                  <p className="po-metric-value">{complete}</p>
                </div>
                <div className="po-metric-row-item">
                  <p className="po-metric-label">En attente de livraison</p>
                  <p className="po-metric-value">{pending}</p>
                </div>
                <div className="po-metric-row-item">
                  <p className="po-metric-label">Annulées</p>
                  <p className={`po-metric-value${cancelledAlert ? ' is-alert' : ''}`}>{cancelled}</p>
                </div>
              </div>
            )}
            <div className="card-body p-0">
              <div ref={gridDivRef} id="orders-grid" className="m-3"></div>
            </div>

            {detailOpen && (
              <>
                <div className="modal fade show" style={{ display: 'block' }} tabIndex={-1} role="dialog">
                  <div className="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable" role="document">
                    <div className="modal-content">
                      <div className="modal-header">
                        <h5 className="modal-title">{detailTitle}</h5>
                        <button type="button" className="btn-close" onClick={() => setDetailOpen(false)}></button>
                      </div>
                      <div className="modal-body">{detailBody}</div>
                      <div className="modal-footer">
                        {cancelError && <div className="alert alert-danger py-2 px-3 mb-0 me-auto small">{cancelError}</div>}
                        {currentOrderRef.current && (
                          <button
                            type="button"
                            className="btn btn-outline-dark btn-sm"
                            onClick={() => currentOrderRef.current && handleDownloadPdf(currentOrderRef.current.id)}
                          >
                            <iconify-icon icon="solar:file-pdf-bold-duotone" className="align-middle"></iconify-icon> Télécharger le PDF
                          </button>
                        )}
                        {canCancel && (
                          <button type="button" className="btn btn-outline-danger btn-sm" disabled={cancelling} onClick={handleCancelOrder}>
                            {cancelling ? 'Annulation en cours...' : 'Annuler cette commande sur RPOS'}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
                <div className="modal-backdrop fade show"></div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
