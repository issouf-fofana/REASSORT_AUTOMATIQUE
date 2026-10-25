import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../../shared/api/client';
import { AllShopsView } from './AllShopsView';
import { ConformityTrendChart } from './ConformityTrendChart';
import { TodayProposalsCard } from './TodayProposalsCard';
import { TopArticlesCard } from './TopArticlesCard';
import { FormulaInfoButton } from '../Stockouts/StockoutEpisodePage';
import type { ConformityRate, OverstockRate, PendingProposal, StockoutRate, SupplierOrder } from './types';

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
  const [ordersAwaitingDelivery, setOrdersAwaitingDelivery] = useState('—');
  const [conformity, setConformity] = useState<{ text: string; detail: string }>({ text: '—', detail: 'Propositions validées sans modification' });
  const [stockout, setStockout] = useState<{ text: string; detail: string }>({ text: '—', detail: 'Articles déjà en rupture' });
  const [overstock, setOverstock] = useState<{ text: string; detail: string }>({ text: '—', detail: 'Quantités au-delà du besoin' });
  const [orders, setOrders] = useState<SupplierOrder[] | null>(null);
  const [ordersError, setOrdersError] = useState<string | null>(null);
  // Tri croissant/décroissant ajouté le 25/10/2026 (audit complet des tableaux du site, demande
  // explicite : "les ajouté fait un audit de tout tab") — "Dernières commandes fournisseur" n'avait
  // aucun tri.
  const [ordersSortKey, setOrdersSortKey] = useState<'reference' | 'external_reference' | 'date' | 'status_display' | null>(null);
  const [ordersSortDir, setOrdersSortDir] = useState<'asc' | 'desc'>('desc');

  // Filtre de période (demande explicite du 23/10/2026 : "ajouter les filtre sur des periode...
  // par defaut tu peux mettre sur le jour") — ne s'applique qu'aux cartes représentant un
  // historique daté (conformité, commandes en préparation/livraison, dernières commandes
  // fournisseur) : "Articles proposés" reste toujours LA proposition en attente actuelle (jamais un
  // historique), "Taux de rupture"/"Taux de surstock" restent un état instantané du stock, non
  // bornable dans le temps. Par défaut, les deux bornes sont aujourd'hui (une seule journée).
  const [periodStart, setPeriodStart] = useState(() => new Date().toISOString().slice(0, 10));
  const [periodEnd, setPeriodEnd] = useState(() => new Date().toISOString().slice(0, 10));

  function shopQueryParam(): string {
    const id = isSingleShop ? user?.rposShopId || '' : selectedShopId;
    const pos = isSingleShop ? user?.rposPosId || '' : selectedShop?.posId || '';
    if (!id) return '';
    return `shop=${encodeURIComponent(id)}${pos ? '&pos=' + encodeURIComponent(pos) : ''}`;
  }

  // T23:59:59 sur la borne de fin (même convention que StockoutShopDetail.tsx) pour inclure toute
  // la journée choisie, pas seulement minuit.
  function periodQueryParam(): string {
    const start = new Date(periodStart).toISOString();
    const end = new Date(periodEnd + 'T23:59:59').toISOString();
    return `start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
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
      const c = await apiFetch<ConformityRate>(`/reassort/conformity?${qs}&${periodQueryParam()}`);
      if (token !== loadTokenRef.current) return;
      setConformity({
        text: pct(c.rate),
        detail: c.rate === null ? 'Pas encore de commande validée' : `${c.unchangedLines} / ${c.totalLines} lignes non modifiées`,
      });
    } catch {
      if (token === loadTokenRef.current) setConformity((s) => ({ ...s, text: '—' }));
    }

    try {
      const s = await apiFetch<StockoutRate>(`/reassort/stockout-rate?${qs}&${periodQueryParam()}`);
      if (token !== loadTokenRef.current) return;
      setStockout({
        text: pct(s.rate),
        detail: s.rate === null ? 'Pas encore de commande validée' : `${s.stockoutLines} / ${s.totalLines} article(s) déjà en rupture`,
      });
    } catch {
      if (token === loadTokenRef.current) setStockout((v) => ({ ...v, text: '—' }));
    }

    try {
      const o = await apiFetch<OverstockRate>(`/reassort/overstock-rate?${qs}&${periodQueryParam()}`);
      if (token !== loadTokenRef.current) return;
      setOverstock({
        text: pct(o.rate),
        detail: o.rate === null ? 'Pas encore de commande validée' : `${o.overstockLines} / ${o.totalLines} article(s) en surstock`,
      });
    } catch {
      if (token === loadTokenRef.current) setOverstock((v) => ({ ...v, text: '—' }));
    }

    try {
      const data = await apiFetch<{ orders: SupplierOrder[] }>(`/reassort/orders?${qs}&${periodQueryParam()}`);
      if (token !== loadTokenRef.current) return;
      // Compté sur TOUTES les commandes reçues (pas seulement les 8 affichées dans la liste
      // ci-dessous) — demande explicite du 21/10/2026 : "il faut ajouter la partie commande en
      // attente de livraion sur le dash aussi... ajout un cadre pour ca", à côté de "Commandes en
      // préparation" qui souffrait du même souci avant (count sur une liste tronquée à 8).
      setOrdersPending(String(data.orders.filter((o) => o.status_display === 'en préparation').length));
      setOrdersAwaitingDelivery(String(data.orders.filter((o) => o.status_display === 'en attente de livraison').length));
      setOrders(data.orders.slice(0, 8));
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

  // Recharge au changement de période (demande explicite du 23/10/2026) — effet séparé du
  // précédent plutôt que d'y ajouter periodStart/periodEnd : celui-ci dépend aussi de isSingleShop
  // pour couvrir le cas magasin unique (son propre useEffect plus haut ne dépend que de
  // [isSingleShop], jamais rechargé sinon quand la période change).
  useEffect(() => {
    if (!isSingleShop && !selectedShopId) return;
    loadDashboard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodStart, periodEnd]);

  return (
    <div>
      <style>{`
        /* Cartes KPI blanches avec bordure + hover (01/10/2026, "trop fort" en fond marine plein —
           revenu au même esprit que les cartes de secteurs/rayons sur Proposition de commande). */
        .kpi-card { border: 1px solid #e9ecf2; border-radius: 14px; background: #F9FAFC; box-shadow: 0 1px 3px rgba(27, 42, 74, .05); transition: box-shadow .2s ease, border-color .2s ease, transform .2s ease; }
        .kpi-card:hover { box-shadow: 0 8px 20px rgba(27, 42, 74, .1); border-color: #c7d2e8; transform: translateY(-1px); }
        .kpi-card .card-body { padding: 1.1rem 1.2rem .85rem; }
        .kpi-icon { width: 38px; height: 38px; border-radius: 10px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; background: #EDF1F7 !important; }
        .kpi-icon iconify-icon { font-size: 20px; color: #1B2A4A !important; }
        .kpi-value { font-size: 1.6rem; font-weight: 700; line-height: 1.2; margin: .35rem 0 0; color: #1B2A4A; }
        .kpi-label { font-size: .78rem; color: #5B6B85; margin: 0; }
        .kpi-footer { padding: .55rem 1.2rem; font-size: .72rem; border-top: 1px solid #EDF1F7; color: #8a93a8; }
        .kpi-footer a { color: #1B2A4A !important; font-weight: 600; }
        .kpi-card.kpi-card-chart { background: #F9FAFC; }
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
        /* Grille KPI à 7 cartes sur une seule ligne en grand écran (demande explicite du 21/10/2026 :
           "fait en sorte que les carte soit sur la meme ligne") — Bootstrap n'a pas de row-cols-xl-7
           natif (ne va que jusqu'à 6), remplacé par une grille CSS dédiée. */
        .kpi-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1rem; }
        @media (min-width: 768px) { .kpi-grid { grid-template-columns: repeat(3, 1fr); } }
        @media (min-width: 1200px) { .kpi-grid { grid-template-columns: repeat(7, 1fr); } }
        /* Filtre de période (23/10/2026) — mêmes classes/styles que StockoutShopDetail.tsx, dupliqués
           ici car chaque app React a son propre bundle CSS, pas de partage direct entre elles. */
        .stockout-period-filter-card { background: #fff; border: 1px solid rgba(27,42,74,.08); border-radius: 8px; padding: 12px 16px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 14px; }
        .stockout-period-filter-icon { width: 30px; height: 30px; border-radius: 7px; background: rgba(27,42,74,.05); display: flex; align-items: center; justify-content: center; font-size: 15px; color: #5B6B85; flex-shrink: 0; }
        .stockout-period-preset { border: 1px solid rgba(27,42,74,.12); background: #fff; color: #5B6B85; font-size: .76rem; font-weight: 600; padding: 5px 12px; border-radius: 6px; transition: background .15s, color .15s, border-color .15s; }
        .stockout-period-preset:hover { background: #F6F8FB; color: #1B2A4A; border-color: rgba(27,42,74,.2); }
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
      {/* Filtre de période (demande explicite du 23/10/2026) — même style visuel que
          StockoutShopDetail.tsx pour rester cohérent avec le reste de l'app. ÉTENDU le 23/10/2026
          (demande explicite : "Taux de rupture de stock: du jour / Taux de surstock: du jour") pour
          aussi piloter ces deux cartes, en réutilisant les mêmes fonctions que les pages Ruptures/
          Surstock elles-mêmes (getDashboardSummary/getOverstockOverPeriod) — même chiffre que ces
          pages pour la période choisie, jamais un calcul dupliqué. "Articles proposés" reste seul
          hors du filtre (toujours LA proposition en attente actuelle, jamais un historique). */}
      <div className="stockout-period-filter-card mb-3">
        <div className="d-flex align-items-center gap-2">
          <span className="stockout-period-filter-icon">
            <iconify-icon icon="solar:calendar-bold-duotone"></iconify-icon>
          </span>
          <div>
            <div className="fw-semibold" style={{ color: '#1B2A4A', fontSize: '.88rem' }}>Période affichée</div>
            <div className="text-muted" style={{ fontSize: '.74rem' }}>Pilote conformité, rupture, surstock, commandes en préparation/livraison et dernières commandes</div>
          </div>
        </div>
        <div className="d-flex align-items-center gap-2 flex-wrap">
          {[
            { label: "Aujourd'hui", days: 0 },
            { label: '7 j', days: 7 },
            { label: '30 j', days: 30 },
          ].map((preset) => (
            <button
              key={preset.label}
              type="button"
              className="stockout-period-preset"
              onClick={() => {
                const end = new Date();
                const start = new Date(end.getTime() - preset.days * 24 * 60 * 60 * 1000);
                setPeriodEnd(end.toISOString().slice(0, 10));
                setPeriodStart(start.toISOString().slice(0, 10));
              }}
            >
              {preset.label}
            </button>
          ))}
          <div className="d-flex align-items-center gap-2 flex-wrap">
            <input type="date" className="form-control form-control-sm" style={{ width: 150 }} value={periodStart} max={periodEnd} onChange={(e) => setPeriodStart(e.target.value)} />
            <span className="text-muted small">au</span>
            <input type="date" className="form-control form-control-sm" style={{ width: 150 }} value={periodEnd} min={periodStart} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setPeriodEnd(e.target.value)} />
          </div>
        </div>
      </div>

      <div className="kpi-grid mb-4">
        <div className="col">
          <div className="card kpi-card h-100 mb-0">
            <div className="card-body d-flex align-items-start gap-2">
              <div className="kpi-icon bg-primary-subtle">
                <iconify-icon icon="solar:cart-check-bold-duotone" className="text-primary"></iconify-icon>
              </div>
              <div>
                <p className="kpi-label">
                  Articles proposés
                  <FormulaInfoButton
                    title="Articles proposés"
                    steps={[
                      { label: 'Source', detail: 'Nombre d\'articles contenus dans la dernière proposition de réassort générée pour ce magasin (automatiquement chaque nuit, ou manuellement).' },
                      { label: 'Ce que ça mesure', detail: 'La taille du travail de validation qui attend le magasin — combien d\'articles ont une quantité à commander suggérée.' },
                    ]}
                  />
                </p>
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
                <p className="kpi-label">
                  Commandes en préparation
                  <FormulaInfoButton
                    title="Commandes en préparation"
                    steps={[
                      { label: 'Source', detail: 'Commandes envoyées à RPOS, mais pas encore validées côté système fournisseur (statut "en préparation").' },
                      { label: 'Ce que ça mesure', detail: 'Les commandes dont le traitement n\'est pas encore terminé — rien à vérifier côté réception pour l\'instant.' },
                    ]}
                  />
                </p>
                <h3 className="kpi-value">{ordersPending}</h3>
              </div>
            </div>
            <div className="kpi-footer">
              <Link to="/purchase-list">Voir l'historique</Link>
            </div>
          </div>
        </div>

        {/* Carte ajoutée le 21/10/2026 (demande explicite : "il faut ajouter la partie commande en
            attente de livraion sur le dash aussi... ajout un cadre pour ca") — une commande "en
            attente de livraison" est déjà validée (cf. échange du 21/10/2026 : "une commande a
            ettent de livraison est deja validé... quand il est en preparation il n'est pas validé
            si il est validé il passe en en attente de livrasion"), distincte de "en préparation" ;
            même compteur global que celui-là (toutes les commandes reçues, pas seulement les 8
            affichées dans la liste ci-dessous). */}
        <div className="col">
          <div className="card kpi-card h-100 mb-0">
            <div className="card-body d-flex align-items-start gap-2">
              <div className="kpi-icon bg-warning-subtle">
                <iconify-icon icon="solar:delivery-bold-duotone" className="text-warning"></iconify-icon>
              </div>
              <div>
                <p className="kpi-label">
                  En attente de livraison
                  <FormulaInfoButton
                    title="En attente de livraison"
                    steps={[
                      { label: 'Source', detail: 'Commandes déjà VALIDÉES côté fournisseur (RPOS), en transit, mais pas encore réceptionnées en magasin.' },
                      { label: 'Ce que ça mesure', detail: 'Les commandes à surveiller pour la réception — une commande "en préparation" n\'est pas encore validée ; une fois validée, elle passe ici.' },
                    ]}
                  />
                </p>
                <h3 className="kpi-value">{ordersAwaitingDelivery}</h3>
              </div>
            </div>
            <div className="kpi-footer">
              <Link to="/purchase-list">Voir l'historique</Link>
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
                <p className="kpi-label">
                  Taux de conformité
                  <FormulaInfoButton
                    title="Taux de conformité"
                    steps={[
                      { label: 'Périmètre', detail: 'Parmi les lignes des propositions VALIDÉES (au moins un rayon traité) pour ce magasin.' },
                      { label: 'Calcul', detail: 'Proportion de lignes où la quantité finalement validée par le magasin est EXACTEMENT égale à la quantité suggérée par le système, sans modification manuelle.' },
                      { label: 'Ce que ça mesure', detail: 'À quel point le magasin fait confiance aux suggestions automatiques — un taux bas signale soit des suggestions à améliorer, soit des ajustements terrain fréquents (ex: stock réel différent du stock RPOS).' },
                    ]}
                  />
                </p>
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
                <p className="kpi-label">
                  Taux de rupture de stock
                  <FormulaInfoButton
                    title="Taux de rupture de stock"
                    steps={[
                      { label: 'Périmètre', detail: 'Parmi les lignes des propositions VALIDÉES pour ce magasin, celles dont le délai avant rupture estimé est connu.' },
                      { label: 'Calcul', detail: 'Proportion de ces lignes où l\'article était déjà en rupture (stock à 0 ou sous le seuil) AU MOMENT de la génération de la proposition, pas après.' },
                      { label: 'Ce que ça mesure', detail: 'Si le réassort intervient assez tôt — ce n\'est PAS un taux de non-conformité de commande, mais un signal sur la réactivité du processus de réapprovisionnement.' },
                    ]}
                  />
                </p>
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
                <p className="kpi-label">
                  Taux de surstock
                  <FormulaInfoButton
                    title="Taux de surstock"
                    steps={[
                      { label: 'Périmètre', detail: 'Parmi les lignes des propositions VALIDÉES pour ce magasin, celles où la quantité validée et la vente moyenne sont connues.' },
                      { label: 'Calcul', detail: 'Proportion de ces lignes où la quantité finalement commandée (après ajustement du magasin) dépasse largement le besoin théorique (vente moyenne + stock de sécurité), au-delà d\'un seuil configurable.' },
                      { label: 'Ce que ça mesure', detail: 'Les corrections manuelles excessives à la hausse — signale un risque de surstock créé par une décision humaine, pas par le calcul automatique.' },
                    ]}
                  />
                </p>
                <h3 className="kpi-value">{overstock.text}</h3>
              </div>
            </div>
            <div className="kpi-footer">{overstock.detail}</div>
          </div>
        </div>

      </div>

      {/* "Magasins avec une proposition aujourd'hui" à côté du graphique de conformité (demande du
          30/09/2026), ADMIN uniquement — donut "Répartition des commandes par statut" retiré du
          Tableau de bord (30/09/2026, jugé peu utile ici). */}
      <div className="row g-3 mb-4">
        <div className="col-lg-7">
          {/* Monté seulement une fois un magasin effectif connu (demande du 13/10/2026, bug "Aucun
              magasin assigné à ce compte" affiché à tort pour un SUPERVISOR) : contrairement aux
              cartes KPI ci-dessus, dont le chargement est gardé par le second useEffect
              (if (!isSingleShop && !selectedShopId) return), ce composant a son propre useEffect
              interne qui se déclenchait dès le tout premier rendu, shopQueryParam() encore vide
              (selectedShopId pas encore résolu par le sélecteur de magasin global) — appel sans
              shop= envoyé, rejeté en 400 par le backend, erreur figée à l'écran même une fois le
              magasin résolu ensuite. */}
          {(isSingleShop || selectedShopId) && <ConformityTrendChart shopQueryParam={shopQueryParam()} />}
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
                      {(() => {
                        function toggleOrdersSort(k: NonNullable<typeof ordersSortKey>) {
                          if (ordersSortKey === k) setOrdersSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
                          else { setOrdersSortKey(k); setOrdersSortDir('desc'); }
                        }
                        function Th({ k, children }: { k: NonNullable<typeof ordersSortKey>; children: React.ReactNode }) {
                          const active = ordersSortKey === k;
                          return (
                            <th role="button" style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleOrdersSort(k)}>
                              {children} {active ? (ordersSortDir === 'desc' ? '▼' : '▲') : ''}
                            </th>
                          );
                        }
                        return (
                          <>
                            <Th k="reference">Référence</Th>
                            <Th k="external_reference">Libellé</Th>
                            <Th k="date">Date commande</Th>
                            <Th k="status_display">Statut</Th>
                          </>
                        );
                      })()}
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
                      (!ordersSortKey ? orders : [...orders].sort((a, b) => {
                        const dir = ordersSortDir === 'desc' ? 1 : -1;
                        const getValue = (o: SupplierOrder): number | string => {
                          if (ordersSortKey === 'date') return new Date(o.date).getTime();
                          if (ordersSortKey === 'external_reference') return (o.external_reference || '').toLowerCase();
                          if (ordersSortKey === 'status_display') return o.status_display.toLowerCase();
                          return o.reference.toLowerCase();
                        };
                        const av = getValue(a);
                        const bv = getValue(b);
                        if (typeof av === 'string' || typeof bv === 'string') return dir * String(bv).localeCompare(String(av), 'fr-FR');
                        return dir * ((bv as number) - (av as number));
                      })).map((o) => (
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
              <Link to="/purchase-list" className="fw-semibold">
                Voir tout l'historique →
              </Link>
            </div>
          </div>
        </div>
      </div>
        </>
      )}
    </div>
  );
}
