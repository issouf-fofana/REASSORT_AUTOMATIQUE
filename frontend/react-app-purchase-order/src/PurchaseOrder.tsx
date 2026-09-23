import { useEffect, useRef, useState } from 'react';
import { apiFetch } from './api/client';
import { DepartmentListView } from './DepartmentListView';
import { ProposalTable } from './ProposalTable';
import type { Proposal, ProposalHistoryItem, Shop } from './types';

interface ExcludedItem {
  ean: string;
  label: string | null;
  revenueSharePct: number | null;
}

export function PurchaseOrder() {
  const [user] = useState(() => window.reassortGetUser());
  const isSingleShop = user ? window.reassortIsSingleShopRole(user.role) : true;

  const shopSelectRef = useRef<HTMLSelectElement>(null);
  const listShopSelectRef = useRef<HTMLSelectElement>(null);
  const [shops, setShops] = useState<Shop[]>([]);
  const [shopsError, setShopsError] = useState<string | null>(null);
  const [selectedShopId, setSelectedShopId] = useState('');

  const urlParams = new URLSearchParams(window.location.search);
  const [selectedSector, setSelectedSector] = useState<string | null>(urlParams.get('sector'));
  const [selectedDepartment, setSelectedDepartment] = useState<string | null>(urlParams.get('dept'));

  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [status, setStatus] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const loadTokenRef = useRef(0);

  const [history, setHistory] = useState<ProposalHistoryItem[]>([]);
  const [viewingPastGeneration, setViewingPastGeneration] = useState(false);
  const [selectedGenerationId, setSelectedGenerationId] = useState('');

  const [orderTotal, setOrderTotal] = useState(0);

  const [excludedModal, setExcludedModal] = useState<{ label: string; items: ExcludedItem[] | null; error: string | null } | null>(null);
  const [sufficiencyModal, setSufficiencyModal] = useState<string | null>(null);

  function selectedPosId(): string {
    if (isSingleShop) return user?.rposPosId || '';
    const opt = shopSelectRef.current?.selectedOptions[0] as HTMLOptionElement | undefined;
    return opt?.dataset.posId || '';
  }

  function shopQueryParam(): string {
    const id = isSingleShop ? user?.rposShopId || '' : selectedShopId;
    const pos = selectedPosId();
    if (!id) return '';
    return `shop=${encodeURIComponent(id)}${pos ? '&pos=' + encodeURIComponent(pos) : ''}`;
  }

  function buildNavUrl(sectorName: string | null, deptName: string | null): string {
    const params = new URLSearchParams();
    if (sectorName) params.set('sector', sectorName);
    if (deptName) params.set('dept', deptName);
    const shopId = isSingleShop ? '' : selectedShopId;
    const posId = isSingleShop ? '' : selectedPosId();
    if (shopId) params.set('shop', shopId);
    if (posId) params.set('pos', posId);
    const qs = params.toString();
    return '/purchase-order' + (qs ? '?' + qs : '');
  }

  function pageTitle(): string {
    let shopName = user?.rposShopName;
    let shopRef = user?.rposShopReference;
    if (!isSingleShop) {
      const opt = shopSelectRef.current?.selectedOptions[0] as HTMLOptionElement | undefined;
      if (opt) {
        shopName = opt.dataset.name;
        shopRef = opt.dataset.reference;
      }
    }
    if (!selectedSector && !selectedDepartment) {
      return 'Proposition de réassort' + (shopName ? ` — ${shopRef} (${shopName})` : '');
    }
    const deptSuffix = selectedDepartment ? ` — ${selectedSector ? selectedSector + ' › ' : ''}${selectedDepartment}` : '';
    return 'Proposition de réassort' + (shopName ? ` — ${shopRef} (${shopName})` : '') + deptSuffix;
  }

  async function loadHistory(id: string) {
    if (!id) {
      setHistory([]);
      return;
    }
    try {
      const data = await apiFetch<ProposalHistoryItem[]>(`/reassort/proposal/history?${shopQueryParam()}`);
      setHistory(data);
    } catch {
      setHistory([]);
    }
  }

  async function loadPendingProposal() {
    const shopId = isSingleShop ? user?.rposShopId : selectedShopId;
    if (!shopId) {
      setStatus('Sélectionnez un magasin.');
      return;
    }
    const token = ++loadTokenRef.current;
    setStatus('Chargement...');
    setRefreshing(true);
    setViewingPastGeneration(false);
    try {
      const data = await apiFetch<Proposal | null>(`/reassort/proposal/pending?${shopQueryParam()}`);
      if (token !== loadTokenRef.current) return;
      setProposal(data);
      setSelectedGenerationId(data?.id || '');
      setStatus(data ? `${data.lines.length} article(s) proposé(s)` : 'Aucune proposition');
    } catch (err) {
      if (token !== loadTokenRef.current) return;
      setStatus('Erreur: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      if (token === loadTokenRef.current) setRefreshing(false);
    }
    if (token === loadTokenRef.current) loadHistory(shopId || '');
  }

  async function loadProposalById(id: string) {
    setStatus('Chargement...');
    try {
      const data = await apiFetch<Proposal>(`/reassort/proposal/${id}?${shopQueryParam()}`);
      setViewingPastGeneration(data.status !== 'GENERATED');
      setProposal(data);
      setSelectedGenerationId(id);
      setStatus(`${data.lines.length} article(s) — ${data.status}`);
    } catch (err) {
      setStatus('Erreur: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  useEffect(() => {
    (async () => {
      if (!isSingleShop) {
        try {
          const data = await apiFetch<Shop[]>('/reassort/shops');
          setShops(data);
          const urlShopId = urlParams.get('shop');
          if (urlShopId && data.some((s) => s.id === urlShopId)) {
            setSelectedShopId(urlShopId);
          }
        } catch (err) {
          setShopsError(err instanceof Error ? err.message : String(err));
          return;
        }
      } else {
        loadPendingProposal();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (isSingleShop || shops.length === 0) return;
    const select = shopSelectRef.current;
    const listSelect = listShopSelectRef.current;
    if (!select) return;

    function handleChange() {
      const val = select!.value;
      setSelectedShopId(val);
      if (listSelect) listSelect.value = val;
    }
    select.addEventListener('change', handleChange);
    if (listSelect) {
      listSelect.addEventListener('change', () => {
        select!.value = listSelect.value;
        handleChange();
      });
    }
    if (urlParams.get('shop') && select.querySelector(`option[value="${urlParams.get('shop')}"]`)) {
      select.value = urlParams.get('shop')!;
      select.dataset.preselected = '1';
      if (listSelect) {
        listSelect.value = urlParams.get('shop')!;
        listSelect.dataset.preselected = '1';
      }
    }
    if (window.reassortMakeShopPickerSearchable) {
      window.reassortMakeShopPickerSearchable(select);
      if (listSelect) window.reassortMakeShopPickerSearchable(listSelect);
    }
    return () => select.removeEventListener('change', handleChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shops]);

  useEffect(() => {
    if (!isSingleShop && !selectedShopId) return;
    loadPendingProposal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedShopId]);

  function handleGenerationSelect(id: string) {
    setSelectedGenerationId(id);
    if (id) loadProposalById(id);
  }

  function handleBackToLatest() {
    setViewingPastGeneration(false);
    loadPendingProposal();
  }

  async function handleOpenExcluded(proposalId: string, reason: string, label: string) {
    setExcludedModal({ label, items: null, error: null });
    try {
      const items = await apiFetch<ExcludedItem[]>(`/reassort/proposal/${proposalId}/excluded?reason=${reason}`);
      setExcludedModal({ label, items, error: null });
    } catch (err) {
      setExcludedModal({ label, items: null, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const byPos: Record<string, Shop[]> = {};
  shops.forEach((s) => (byPos[s.posId] ||= []).push(s));
  const sortedPosIds = Object.keys(byPos).sort((a, b) => parseInt(a.replace(/\D/g, ''), 10) - parseInt(b.replace(/\D/g, ''), 10));

  const showListView = !selectedSector || !selectedDepartment;
  const detailLines = proposal ? proposal.lines.filter((l) => (l.department || 'Sans rayon') === selectedDepartment) : [];

  function navigateTo(url: string) {
    window.history.pushState({}, '', url);
    const params = new URLSearchParams(url.split('?')[1] || '');
    setSelectedSector(params.get('sector'));
    setSelectedDepartment(params.get('dept'));
  }

  useEffect(() => {
    function onPopState() {
      const params = new URLSearchParams(window.location.search);
      setSelectedSector(params.get('sector'));
      setSelectedDepartment(params.get('dept'));
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  function ShopOptions() {
    return (
      <>
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
      </>
    );
  }

  return (
    <div>
      <style>{`
        .reassort-unblock-btn { font-size: .72rem; padding: .15rem .5rem; line-height: 1.3; }
        .reassort-dept-tile { border: 1px solid #eef0f2; border-top: 3px solid var(--tile-accent, #444444); border-radius: 10px; transition: box-shadow .2s ease, border-color .2s ease; }
        .reassort-dept-tile:hover { box-shadow: 0 4px 16px rgba(20, 20, 20, .06); border-color: #e2e4e7; }
        .reassort-dept-tile .card-title { font-size: .95rem; font-weight: 600; letter-spacing: .01em; }
        .reassort-dept-tile .tile-pct { font-size: 1.85rem; font-weight: 600; line-height: 1.1; color: #1a1a1a; letter-spacing: -.01em; }
        .reassort-dept-tile .tile-progress { height: 4px; border-radius: 2px; background-color: #f0f1f3; overflow: hidden; margin: .65rem 0 .9rem; }
        .reassort-dept-tile .tile-progress-fill { height: 100%; background-color: var(--tile-accent, #444444); border-radius: 2px; opacity: .75; transition: width .3s ease; }
        .reassort-dept-tile .tile-revenue { font-weight: 500; color: #3a3a3a; font-size: .92rem; }
        .reassort-dept-tile .tile-proposed { color: #a8adb3; font-size: .78rem; margin-top: .1rem; }
        .ag-header-cell-text { text-transform: uppercase; letter-spacing: 0.02em; }
        .ag-cell { padding-left: 0.5rem; padding-right: 0.5rem; display: flex; align-items: center; }
        .ag-cell-wrapper { width: 100%; }
        #reassort-grid { width: 100%; }
      `}</style>

      {showListView ? (
        <div>
          <div className="d-flex justify-content-between align-items-center mb-3 flex-wrap gap-2">
            <div>
              <div className="d-flex align-items-center gap-2">
                {selectedSector && (
                  <a
                    href="#"
                    className="btn btn-sm btn-outline-secondary"
                    title="Retour aux secteurs"
                    onClick={(e) => {
                      e.preventDefault();
                      navigateTo(buildNavUrl(null, null));
                    }}
                  >
                    <iconify-icon icon="solar:arrow-left-linear" className="align-middle"></iconify-icon>
                  </a>
                )}
                <h4 className="mb-0">{selectedSector ? `Rayons — ${selectedSector}` : 'Secteurs'}</h4>
              </div>
              {isSingleShop && user && <div className="text-muted small">{user.rposShopReference} — {user.rposShopName}</div>}
              {!isSingleShop && (
                <select className="form-select form-select-sm mt-1" style={{ minWidth: 260 }} ref={listShopSelectRef} defaultValue="">
                  <ShopOptions />
                </select>
              )}
            </div>
            <div className="d-flex gap-2 align-items-center">
              <label className="small text-muted mb-0">Génération</label>
              <select
                className="form-select form-select-sm"
                style={{ minWidth: 260 }}
                disabled={history.length === 0}
                value={selectedGenerationId}
                onChange={(e) => handleGenerationSelect(e.target.value)}
              >
                {history.length === 0 ? (
                  <option value="">—</option>
                ) : (
                  history.map((p, i) => (
                    <option value={p.id} key={p.id}>
                      {new Date(p.generatedAt).toLocaleString('fr-FR')} ({p.status})
                      {i === 0 ? ' — dernière' : ''}
                    </option>
                  ))
                )}
              </select>
              <button className="btn btn-sm btn-outline-secondary" disabled={refreshing} onClick={loadPendingProposal}>
                Actualiser
              </button>
            </div>
          </div>

          {viewingPastGeneration && (
            <div className="alert alert-warning small mb-3">
              Vous consultez une génération passée (non active) — lecture seule, ne peut pas être validée ni envoyée à
              RPOS.
              <button type="button" className="btn btn-sm btn-outline-dark ms-2" onClick={handleBackToLatest}>
                Revenir à la proposition active
              </button>
            </div>
          )}

          <DepartmentListView proposal={proposal} selectedSector={selectedSector} buildNavUrl={buildNavUrl} onOpenExcluded={handleOpenExcluded} />
        </div>
      ) : (
        <div className="row">
          <div className="col-xl-12">
            <div className="card">
              <div className="d-flex card-header justify-content-between align-items-center">
                <a
                  href="#"
                  className="btn btn-sm btn-outline-secondary me-2"
                  title="Retour aux rayons"
                  onClick={(e) => {
                    e.preventDefault();
                    navigateTo(buildNavUrl(selectedSector, null));
                  }}
                >
                  <iconify-icon icon="solar:arrow-left-linear" className="align-middle"></iconify-icon>
                </a>
                <div>
                  <h4 className="card-title">{pageTitle()}</h4>
                </div>
                <div className="d-flex gap-2 align-items-center">
                  <span className="text-muted small">{status}</span>
                  <button className="btn btn-sm btn-outline-secondary" disabled={refreshing} onClick={loadPendingProposal}>
                    Actualiser
                  </button>
                  <button className="btn btn-sm btn-success" disabled title="Envoi à RPOS pas encore migré — utilisez /purchase-order.old.html en attendant">
                    Valider et envoyer à RPOS
                  </button>
                </div>
              </div>

              <div className="card-body">
                <div className="alert alert-info small mb-3">
                  Étape 1 de la migration React de cette page : consultation en lecture seule. L'envoi vers RPOS et la
                  génération d'une nouvelle proposition restent à faire — utilisez{' '}
                  <a href="/purchase-order.old.html">l'ancienne page</a> pour ces actions en attendant.
                </div>
                {orderTotal > 0 && <p className="fw-semibold">Total commande : {orderTotal.toLocaleString('fr-FR')} CFA</p>}
                <ProposalTable
                  proposal={proposal}
                  lines={detailLines}
                  shopId={isSingleShop ? user?.rposShopId || '' : selectedShopId}
                  readOnly
                  onOpenAnalytics={() => {}}
                  onTotalChange={setOrderTotal}
                  onOpenSufficiency={setSufficiencyModal}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {excludedModal && (
        <>
          <div className="modal fade show" style={{ display: 'block' }} tabIndex={-1} role="dialog">
            <div className="modal-dialog modal-dialog-centered modal-lg modal-dialog-scrollable" role="document">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">{excludedModal.label}</h5>
                  <button type="button" className="btn-close" onClick={() => setExcludedModal(null)}></button>
                </div>
                <div className="modal-body">
                  {excludedModal.error && <div className="alert alert-danger">Erreur: {excludedModal.error}</div>}
                  {!excludedModal.error && excludedModal.items === null && <p className="text-muted text-center py-4">Chargement...</p>}
                  {excludedModal.items?.length === 0 && <p className="text-muted text-center py-4">Aucun article dans cette catégorie.</p>}
                  {!!excludedModal.items?.length && (
                    <div className="table-responsive">
                      <table className="table table-sm table-hover">
                        <thead>
                          <tr>
                            <th>EAN</th>
                            <th>Article</th>
                            <th className="text-end">% CA magasin</th>
                          </tr>
                        </thead>
                        <tbody>
                          {excludedModal.items.map((it) => (
                            <tr key={it.ean}>
                              <td>{it.ean}</td>
                              <td>{it.label || '—'}</td>
                              <td className="text-end">{it.revenueSharePct !== null && it.revenueSharePct !== undefined ? it.revenueSharePct.toFixed(2) + ' %' : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show"></div>
        </>
      )}

      {sufficiencyModal !== null && (
        <>
          <div className="modal fade show" style={{ display: 'block' }} tabIndex={-1} role="dialog">
            <div className="modal-dialog modal-dialog-centered" role="document">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">Suffisance de la commande</h5>
                  <button type="button" className="btn-close" onClick={() => setSufficiencyModal(null)}></button>
                </div>
                <div className="modal-body">{sufficiencyModal}</div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show"></div>
        </>
      )}
    </div>
  );
}
