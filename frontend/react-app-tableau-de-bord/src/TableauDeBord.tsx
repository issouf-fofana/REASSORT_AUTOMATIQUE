import { useEffect, useRef, useState } from 'react';
import { apiFetch } from './api/client';
import { AllShopsView } from './AllShopsView';
import { ConformityTrendChart } from './ConformityTrendChart';
import { TodayProposalsCard } from './TodayProposalsCard';
import { TopArticlesCard } from './TopArticlesCard';
import type { ConformityRate, ForecastAccuracy, OverstockRate, PendingProposal, StockoutRate, SupplierOrder } from './types';

// Palette marine/ambre adoucie (demande du 30/09/2026), cohérente avec les classes déjà utilisées
// sur Proposition de commande (reassort-badge-soft-warning/-danger) — dupliquées ici car chaque
// app React a son propre bundle CSS, pas de partage direct entre elles.
const STATUS_BADGE: Record<string, string> = {
  'en préparation': 'reassort-badge-neutral',
  'en attente de livraison': 'reassort-badge-soft-warning',
  'livrée partiellement': 'reassort-badge-soft-info',
  'finalisée et partielle': 'reassort-badge-soft-info',
  complète: 'reassort-badge-soft-success',
  annulée: 'reassort-badge-soft-danger',
  supprimée: 'reassort-badge-soft-danger',
};

function pct(rate: number | null): string {
  return rate === null ? 'N/A' : Math.round(rate * 100) + '%';
}

export function TableauDeBord() {
  const [user] = useState(() => window.reassortGetUser());
  const isSingleShop = user ? window.reassortIsSingleShopRole(user.role) : true;

  // Onglets "Ce magasin" / "Tous les magasins" (fusion de l'ancienne page Vue globale, 30/09/2026) —
  // seulement pertinent pour un compte non magasin-unique, même condition que le sélecteur de
  // magasin ci-dessous.
  const [activeTab, setActiveTab] = useState<'shop' | 'all'>('shop');

  // Magasin sélectionné : pour un compte ADMIN/SUPERVISOR, repris du sélecteur GLOBAL de la topbar
  // (window.reassortGetActiveShop/reassortOnActiveShopChange, cf. global-shop-selector.js) — plus de
  // <select> local dupliqué sur cette page (demande du 30/09/2026 : "j'ai déjà un qui fonctionne en
  // haut"), même pattern que PurchaseOrder.tsx.
  const [selectedShop, setSelectedShop] = useState<{ id: string; posId?: string } | null>(null);
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
    if (isSingleShop) {
      loadDashboard();
      return;
    }
    function syncToActiveShop(shop: unknown) {
      const activeShop = shop as { id: string; posId?: string } | null;
      setSelectedShop(activeShop);
      setSelectedShopId(activeShop ? activeShop.id : '');
    }
    if (!window.reassortGetActiveShop || !window.reassortOnActiveShopChange) return;
    syncToActiveShop(window.reassortGetActiveShop());
    window.reassortOnActiveShopChange(syncToActiveShop);
    // reassortOnActiveShopChange n'a pas de désinscription (voir global-shop-selector.js) : accepté
    // ici comme sur les autres pages migrées (PurchaseOrder.tsx), la page vit tout le cycle de vie
    // de l'onglet donc l'abonnement ne s'accumule pas au-delà d'un montage par session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSingleShop]);

  useEffect(() => {
    if (!isSingleShop && !selectedShopId) return;
    loadDashboard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedShopId]);

  return (
    <div>
      <style>{`
        /* Cartes KPI blanches avec bordure + hover (01/10/2026, "trop fort" en fond marine plein —
           revenu au même esprit que les cartes de secteurs/rayons sur Proposition de commande). */
        .kpi-card { border: 1px solid #e9ecf2; border-radius: 14px; background: #ffffff; box-shadow: 0 1px 3px rgba(27, 42, 74, .05); transition: box-shadow .2s ease, border-color .2s ease, transform .2s ease; }
        .kpi-card:hover { box-shadow: 0 8px 20px rgba(27, 42, 74, .1); border-color: #c7d2e8; transform: translateY(-1px); }
        .kpi-card .card-body { padding: 1.1rem 1.2rem .85rem; }
        .kpi-icon { width: 38px; height: 38px; border-radius: 10px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; background: #EDF1F7 !important; }
        .kpi-icon iconify-icon { font-size: 20px; color: #1B2A4A !important; }
        .kpi-value { font-size: 1.6rem; font-weight: 700; line-height: 1.2; margin: .35rem 0 0; color: #1B2A4A; }
        .kpi-label { font-size: .78rem; color: #5B6B85; margin: 0; }
        .kpi-footer { padding: .55rem 1.2rem; font-size: .72rem; border-top: 1px solid #EDF1F7; color: #8a93a8; }
        .kpi-footer a { color: #1B2A4A !important; font-weight: 600; }
        .kpi-card.kpi-card-chart { background: #fff; }
        .kpi-card.kpi-card-chart:hover { transform: none; }
        /* Badges de statut de commande, palette adoucie (dupliquée depuis Proposition de commande,
           chaque app React a son propre bundle CSS). */
        .reassort-badge-neutral { background-color: #EDF1F7 !important; color: #1B2A4A !important; }
        .reassort-badge-soft-warning { background-color: #FDF1DD !important; color: #8A5A00 !important; }
        .reassort-badge-soft-danger { background-color: #F5EDEC !important; color: #7A4A45 !important; }
        .reassort-badge-soft-info { background-color: #E9EEF6 !important; color: #2E4870 !important; }
        .reassort-badge-soft-success { background-color: #E9F3EC !important; color: #2E5B3F !important; }
        .reassort-btn-navy-outline { background-color: transparent; border: 1px solid #1B2A4A; color: #1B2A4A; }
        .reassort-btn-navy-outline:hover, .reassort-btn-navy-outline:focus { background-color: #1B2A4A; color: #fff; }
        /* Onglets "Ce magasin" / "Tous les magasins" (fusion de Vue globale, 30/09/2026). */
        .reassort-tabs .nav-link { color: #5B6B85; font-weight: 600; border: none; border-bottom: 2px solid transparent; }
        .reassort-tabs .nav-link.active { color: #1B2A4A; border-bottom-color: #F5A623; background: transparent; }
      `}</style>

      {!isSingleShop && (
        <ul className="nav reassort-tabs mb-3">
          <li className="nav-item">
            <button type="button" className={`nav-link${activeTab === 'shop' ? ' active' : ''}`} onClick={() => setActiveTab('shop')}>
              Ce magasin
            </button>
          </li>
          <li className="nav-item">
            <button type="button" className={`nav-link${activeTab === 'all' ? ' active' : ''}`} onClick={() => setActiveTab('all')}>
              Tous les magasins
            </button>
          </li>
        </ul>
      )}

      {activeTab === 'all' && !isSingleShop ? (
        <AllShopsView />
      ) : (
        <>
      <div className="row row-cols-2 row-cols-md-3 row-cols-xl-6 g-3 mb-4">
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
                <p className="kpi-label" title="Parmi les articles des commandes validées, proportion qui était déjà en rupture de stock AU MOMENT de la génération de la proposition — mesure si le réassort intervient assez tôt, pas un taux de non-conformité de commande.">Taux de rupture de stock</p>
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

      </div>

      {/* "Magasins avec une proposition aujourd'hui" à côté du graphique de conformité (demande du
          30/09/2026), ADMIN uniquement — donut "Répartition des commandes par statut" retiré du
          Tableau de bord (30/09/2026, jugé peu utile ici). */}
      <div className="row g-3 mb-4">
        <div className="col-lg-7">
          <ConformityTrendChart shopQueryParam={shopQueryParam()} />
        </div>
        {!isSingleShop && (
          <div className="col-lg-5">
            <TodayProposalsCard />
          </div>
        )}
      </div>

      {/* Top articles (30/09/2026, maquette "GoodFood") — ScoreCirclesCard retiré (30/09/2026,
          doublon avec les cartes KPI Conformité/Rupture/Surstock déjà affichées plus haut). */}
      <div className="row g-3 mb-4">
        <div className="col-12">
          <TopArticlesCard shopQueryParam={shopQueryParam()} />
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
        </>
      )}
    </div>
  );
}
