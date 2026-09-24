import { useEffect, useRef, useState } from 'react';
import { apiFetch } from './api/client';
import type { ConformityRate, ForecastAccuracy, OverstockRate, PendingProposal, Shop, StockoutRate, SupplierOrder } from './types';

const STATUS_BADGE: Record<string, string> = {
  'en préparation': 'bg-secondary-subtle text-secondary',
  'en attente de livraison': 'bg-warning-subtle text-warning',
  'livrée partiellement': 'bg-info-subtle text-info',
  'finalisée et partielle': 'bg-info-subtle text-info',
  complète: 'bg-success-subtle text-success',
  annulée: 'bg-danger-subtle text-danger',
};

function pct(rate: number | null): string {
  return rate === null ? 'N/A' : Math.round(rate * 100) + '%';
}

export function TableauDeBord() {
  const [user] = useState(() => window.reassortGetUser());
  const isSingleShop = user ? window.reassortIsSingleShopRole(user.role) : true;

  const shopSelectRef = useRef<HTMLSelectElement>(null);
  const [shops, setShops] = useState<Shop[]>([]);
  const [shopsError, setShopsError] = useState<string | null>(null);
  const [selectedShopId, setSelectedShopId] = useState('');

  const [proposalCount, setProposalCount] = useState('—');
  const [proposalStatus, setProposalStatus] = useState('Proposition du jour');
  const [ordersPending, setOrdersPending] = useState('—');
  const [conformity, setConformity] = useState<{ text: string; detail: string }>({ text: '—', detail: 'Propositions validées sans modification' });
  const [stockout, setStockout] = useState<{ text: string; detail: string }>({ text: '—', detail: 'Articles déjà en rupture' });
  const [overstock, setOverstock] = useState<{ text: string; detail: string }>({ text: '—', detail: 'Quantités au-delà du besoin' });
  const [forecastAccuracy, setForecastAccuracy] = useState<{ text: string; detail: string }>({ text: '—', detail: 'Quantité prévue vs réellement vendue' });
  const [orders, setOrders] = useState<SupplierOrder[] | null>(null);
  const [ordersError, setOrdersError] = useState<string | null>(null);

  const selectedShop = isSingleShop ? null : shops.find((s) => s.id === selectedShopId) || null;

  function shopQueryParam(): string {
    const id = isSingleShop ? user?.rposShopId || '' : selectedShopId;
    const pos = isSingleShop ? user?.rposPosId || '' : selectedShop?.posId || '';
    if (!id) return '';
    return `shop=${encodeURIComponent(id)}${pos ? '&pos=' + encodeURIComponent(pos) : ''}`;
  }

  const loadTokenRef = useRef(0);

  // Jeton de requête : un changement rapide de magasin peut faire partir plusieurs appels
  // séquentiels dont les réponses (surtout les plus lentes, en fin de fonction) reviennent après
  // qu'un nouvel appel loadDashboard() pour un autre magasin ait déjà mis à jour l'affichage — sans
  // ce garde-fou, la réponse tardive du magasin quitté écrasait après coup les chiffres du nouveau
  // magasin (même bug que sales-history.html, corrigé le 15/09/2026).
  async function loadDashboard() {
    const shopId = isSingleShop ? user?.rposShopId : selectedShopId;
    if (!shopId) return;
    const token = ++loadTokenRef.current;
    const qs = shopQueryParam();

    try {
      const p = await apiFetch<PendingProposal | null>(`/reassort/proposal/pending?${qs}`);
      if (token !== loadTokenRef.current) return;
      setProposalCount(p ? String(p.lines.length) : '0');
      setProposalStatus(p ? `Générée le ${new Date(p.generatedAt).toLocaleString('fr-FR')}` : 'Aucune proposition en attente');
    } catch {
      if (token === loadTokenRef.current) setProposalCount('—');
    }

    try {
      const c = await apiFetch<ConformityRate>(`/reassort/conformity?${qs}`);
      if (token !== loadTokenRef.current) return;
      setConformity({
        text: pct(c.rate),
        detail: c.rate === null ? 'Pas encore de commande validée' : `${c.unchangedLines} / ${c.totalLines} lignes non modifiées`,
      });
    } catch {
      if (token === loadTokenRef.current) setConformity((s) => ({ ...s, text: '—' }));
    }

    try {
      const s = await apiFetch<StockoutRate>(`/reassort/stockout-rate?${qs}`);
      if (token !== loadTokenRef.current) return;
      setStockout({
        text: pct(s.rate),
        detail: s.rate === null ? 'Pas encore de commande validée' : `${s.stockoutLines} / ${s.totalLines} article(s) déjà en rupture`,
      });
    } catch {
      if (token === loadTokenRef.current) setStockout((v) => ({ ...v, text: '—' }));
    }

    try {
      const o = await apiFetch<OverstockRate>(`/reassort/overstock-rate?${qs}`);
      if (token !== loadTokenRef.current) return;
      setOverstock({
        text: pct(o.rate),
        detail: o.rate === null ? 'Pas encore de commande validée' : `${o.overstockLines} / ${o.totalLines} article(s) en surstock`,
      });
    } catch {
      if (token === loadTokenRef.current) setOverstock((v) => ({ ...v, text: '—' }));
    }

    try {
      const f = await apiFetch<ForecastAccuracy>(`/reassort/forecast-accuracy?${qs}`);
      if (token !== loadTokenRef.current) return;
      setForecastAccuracy({
        text: pct(f.rate),
        detail:
          f.rate === null
            ? `Pas encore de ligne mesurable (fenêtre de ${f.windowDays} j après validation)`
            : `${f.accurateLines} / ${f.evaluatedLines} article(s) précis (±${f.thresholdPct}%)`,
      });
    } catch {
      if (token === loadTokenRef.current) setForecastAccuracy((v) => ({ ...v, text: '—' }));
    }

    try {
      const data = await apiFetch<{ orders: SupplierOrder[] }>(`/reassort/orders?${qs}`);
      if (token !== loadTokenRef.current) return;
      const list = data.orders.slice(0, 8);
      setOrdersPending(String(list.filter((o) => o.status_display === 'en préparation').length));
      setOrders(list);
      setOrdersError(null);
    } catch (err) {
      if (token !== loadTokenRef.current) return;
      setOrders([]);
      setOrdersError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    (async () => {
      if (!isSingleShop) {
        try {
          const data = await apiFetch<Shop[]>('/reassort/shops');
          setShops(data);
        } catch (err) {
          setShopsError(err instanceof Error ? err.message : String(err));
        }
      } else {
        loadDashboard();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (isSingleShop || shops.length === 0) return;
    const select = shopSelectRef.current;
    if (!select) return;

    function handleChange() {
      setSelectedShopId(select!.value);
    }
    select.addEventListener('change', handleChange);
    if (window.reassortMakeShopPickerSearchable) {
      window.reassortMakeShopPickerSearchable(select);
    }
    if (select.value) setSelectedShopId(select.value);

    return () => select.removeEventListener('change', handleChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSingleShop, shops]);

  useEffect(() => {
    if (!isSingleShop && !selectedShopId) return;
    loadDashboard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedShopId]);

  const byPos: Record<string, Shop[]> = {};
  shops.forEach((s) => (byPos[s.posId] ||= []).push(s));
  const sortedPosIds = Object.keys(byPos).sort((a, b) => parseInt(a.replace(/\D/g, ''), 10) - parseInt(b.replace(/\D/g, ''), 10));

  const shopRefLabel = isSingleShop ? user?.rposShopReference || '—' : selectedShop?.reference || '—';
  const shopNameLabel = isSingleShop ? user?.rposShopName || '—' : selectedShop?.name || '—';

  return (
    <div>
      <style>{`
        .kpi-card { border: none; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
        .kpi-card .card-body { padding: 1rem 1.1rem .75rem; }
        .kpi-icon { width: 40px; height: 40px; border-radius: 10px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .kpi-icon iconify-icon { font-size: 22px; }
        .kpi-value { font-size: 1.5rem; font-weight: 600; line-height: 1.2; margin: .35rem 0 0; }
        .kpi-label { font-size: .78rem; color: var(--bs-secondary-color, #6c757d); margin: 0; }
        .kpi-footer { padding: .5rem 1.1rem; font-size: .72rem; border-top: 1px solid var(--bs-border-color-translucent, rgba(0,0,0,.06)); color: var(--bs-secondary-color, #6c757d); }
        .kpi-footer a { color: inherit; font-weight: 600; }
      `}</style>

      {!isSingleShop && (
        <div className="row mb-3">
          <div className="col-md-4">
            <label className="form-label">Magasin</label>
            <select className="form-select" ref={shopSelectRef} defaultValue="">
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
                        <option value={s.id} key={s.id}>
                          {s.reference} - {s.name}
                        </option>
                      ))}
                  </optgroup>
                ))
              )}
            </select>
          </div>
        </div>
      )}

      <div className="row row-cols-2 row-cols-md-3 row-cols-xl-6 g-3 mb-1">
        <div className="col">
          <div className="card kpi-card h-100 mb-0">
            <div className="card-body d-flex align-items-start gap-2">
              <div className="kpi-icon bg-primary-subtle">
                <iconify-icon icon="solar:cart-check-bold-duotone" className="text-primary"></iconify-icon>
              </div>
              <div>
                <p className="kpi-label">Articles proposés</p>
                <h3 className="kpi-value">{proposalCount}</h3>
              </div>
            </div>
            <div className="kpi-footer">{proposalStatus}</div>
          </div>
        </div>

        <div className="col">
          <div className="card kpi-card h-100 mb-0">
            <div className="card-body d-flex align-items-start gap-2">
              <div className="kpi-icon bg-primary-subtle">
                <iconify-icon icon="solar:box-minimalistic-bold-duotone" className="text-primary"></iconify-icon>
              </div>
              <div>
                <p className="kpi-label">Commandes en préparation</p>
                <h3 className="kpi-value">{ordersPending}</h3>
              </div>
            </div>
            <div className="kpi-footer">
              <a href="/purchase-list">Voir l'historique</a>
            </div>
          </div>
        </div>

        <div className="col">
          <div className="card kpi-card h-100 mb-0">
            <div className="card-body d-flex align-items-start gap-2">
              <div className="kpi-icon bg-success-subtle">
                <iconify-icon icon="solar:double-check-bold-duotone" className="text-success"></iconify-icon>
              </div>
              <div>
                <p className="kpi-label">Taux de conformité</p>
                <h3 className="kpi-value">{conformity.text}</h3>
              </div>
            </div>
            <div className="kpi-footer">{conformity.detail}</div>
          </div>
        </div>

        <div className="col">
          <div className="card kpi-card h-100 mb-0">
            <div className="card-body d-flex align-items-start gap-2">
              <div className="kpi-icon bg-danger-subtle">
                <iconify-icon icon="solar:danger-triangle-bold-duotone" className="text-danger"></iconify-icon>
              </div>
              <div>
                <p className="kpi-label">Taux de rupture</p>
                <h3 className="kpi-value">{stockout.text}</h3>
              </div>
            </div>
            <div className="kpi-footer">{stockout.detail}</div>
          </div>
        </div>

        <div className="col">
          <div className="card kpi-card h-100 mb-0">
            <div className="card-body d-flex align-items-start gap-2">
              <div className="kpi-icon bg-danger-subtle">
                <iconify-icon icon="solar:box-bold-duotone" className="text-danger"></iconify-icon>
              </div>
              <div>
                <p className="kpi-label">Taux de surstock</p>
                <h3 className="kpi-value">{overstock.text}</h3>
              </div>
            </div>
            <div className="kpi-footer">{overstock.detail}</div>
          </div>
        </div>

        <div className="col">
          <div className="card kpi-card h-100 mb-0">
            <div className="card-body d-flex align-items-start gap-2">
              <div className="kpi-icon bg-info-subtle">
                <iconify-icon icon="solar:target-bold-duotone" className="text-info"></iconify-icon>
              </div>
              <div>
                <p className="kpi-label">Précision des prévisions</p>
                <h3 className="kpi-value">{forecastAccuracy.text}</h3>
              </div>
            </div>
            <div className="kpi-footer">{forecastAccuracy.detail}</div>
          </div>
        </div>

        <div className="col">
          <div className="card kpi-card h-100 mb-0">
            <div className="card-body d-flex align-items-start gap-2">
              <div className="kpi-icon bg-primary-subtle">
                <iconify-icon icon="solar:shop-bold-duotone" className="text-primary"></iconify-icon>
              </div>
              <div>
                <p className="kpi-label">Magasin</p>
                <h3 className="kpi-value" style={{ fontSize: '1.15rem' }}>
                  {shopRefLabel}
                </h3>
              </div>
            </div>
            <div className="kpi-footer">{shopNameLabel}</div>
          </div>
        </div>
      </div>

      <div className="row">
        <div className="col-12">
          <div className="card">
            <div className="card-header">
              <h4 className="card-title">Dernières commandes fournisseur</h4>
            </div>
            <div className="card-body p-0">
              <div className="table-responsive">
                <table className="table align-middle mb-0 table-hover table-centered">
                  <thead className="bg-light-subtle">
                    <tr>
                      <th>Référence</th>
                      <th>Libellé</th>
                      <th>Date commande</th>
                      <th>Statut</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders === null ? (
                      <tr>
                        <td colSpan={4} className="text-center text-muted py-4">
                          Chargement...
                        </td>
                      </tr>
                    ) : ordersError ? (
                      <tr>
                        <td colSpan={4} className="text-center text-danger py-4">
                          Erreur: {ordersError}
                        </td>
                      </tr>
                    ) : orders.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="text-center text-muted py-4">
                          Aucune commande.
                        </td>
                      </tr>
                    ) : (
                      orders.map((o) => (
                        <tr key={o.reference}>
                          <td>
                            <strong>{o.reference}</strong>
                          </td>
                          <td>{o.external_reference || '—'}</td>
                          <td>{new Date(o.date).toLocaleDateString('fr-FR')}</td>
                          <td>
                            <span className={`badge ${STATUS_BADGE[o.status_display] || 'bg-secondary-subtle text-secondary'} py-1 px-2`}>
                              {o.status_display}
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="card-footer text-end">
              <a href="/purchase-list" className="fw-semibold">
                Voir tout l'historique →
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
