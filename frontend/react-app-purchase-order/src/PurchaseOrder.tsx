import { useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from './api/client';
import { DepartmentListView } from './DepartmentListView';
import { GenerationFlow } from './GenerationFlow';
import { ProductAnalyticsModal } from './ProductAnalyticsModal';
import { ProposalTable, type ProposalTableHandle } from './ProposalTable';
import { ValidationFlow } from './ValidationFlow';
import { WeeklyPlanHistoryModal } from './WeeklyPlanHistoryModal';
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
  const [shops, setShops] = useState<Shop[]>([]);
  const [shopsError, setShopsError] = useState<string | null>(null);
  const [selectedShopId, setSelectedShopId] = useState('');

  const urlParams = new URLSearchParams(window.location.search);
  const [selectedSector, setSelectedSector] = useState<string | null>(urlParams.get('sector'));
  const [selectedDepartment, setSelectedDepartment] = useState<string | null>(urlParams.get('dept'));

  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [status, setStatus] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [sendingAlert, setSendingAlert] = useState(false);
  const loadTokenRef = useRef(0);

  const [history, setHistory] = useState<ProposalHistoryItem[]>([]);
  const [viewingPastGeneration, setViewingPastGeneration] = useState(false);
  const [selectedGenerationId, setSelectedGenerationId] = useState('');

  const [orderTotal, setOrderTotal] = useState(0);

  const [excludedModal, setExcludedModal] = useState<{ label: string; items: ExcludedItem[] | null; error: string | null } | null>(null);
  const [sufficiencyModal, setSufficiencyModal] = useState<string | null>(null);
  const [analyticsArticle, setAnalyticsArticle] = useState<{ ean: string; productId: string; label: string } | null>(null);
  const [weeklyPlanHistoryOpen, setWeeklyPlanHistoryOpen] = useState(false);
  const proposalTableRef = useRef<ProposalTableHandle>(null);

  const selectedShop = isSingleShop ? null : shops.find((s) => s.id === selectedShopId) || null;

  function selectedPosId(): string {
    if (isSingleShop) return user?.rposPosId || '';
    return selectedShop?.posId || '';
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
    // Utilise le chemin courant (/purchase-order-preview pendant les tests, /purchase-order une
    // fois la bascule faite) plutôt qu'un chemin figé — évite de renvoyer vers l'ancienne page HTML
    // encore active sur /purchase-order tant que cette page React n'a pas remplacé la route finale.
    return window.location.pathname + (qs ? '?' + qs : '');
  }

  function pageTitle(): string {
    const shopName = isSingleShop ? user?.rposShopName : selectedShop?.name;
    const shopRef = isSingleShop ? user?.rposShopReference : selectedShop?.reference;
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

  // Envoi manuel de l'alerte email (demande du 25/09/2026 : "au cas où le auto n'a pas passé") —
  // même contenu/destinataires que le job automatique, déclenchable à la demande pour le magasin
  // actuellement affiché.
  async function handleSendAlert() {
    setSendingAlert(true);
    try {
      const res = await window.reassortFetch(`/reassort/proposal/send-alert?${shopQueryParam()}`, { method: 'POST' });
      const json: { success: boolean; message: string } = await res.json();
      if (!json.success) throw new Error(json.message);
      window.reassortToast(json.message, 'success');
    } catch (err) {
      window.reassortToast('Erreur : ' + (err instanceof Error ? err.message : String(err)), 'error');
    } finally {
      setSendingAlert(false);
    }
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
  // useMemo (pas un simple .filter() à chaque rendu) : ProposalTable détruit et recrée
  // ENTIÈREMENT la grille AG Grid quand sa prop `lines` change de référence (useEffect([lines])) —
  // sans ceci, une nouvelle référence de tableau était produite à CHAQUE rendu de ce composant (y
  // compris ceux déclenchés par la saisie d'une quantité via onTotalChange), détruisant la grille en
  // plein milieu de la frappe et effaçant la quantité tout juste saisie, en dupliquant au passage la
  // barre d'outils Colonnes/Filtres (reassortAgGridToolbar réinjectée dans le même conteneur sans
  // avoir été nettoyée) — bug constaté le 24/09/2026.
  const detailLines = useMemo(
    () => (proposal ? proposal.lines.filter((l) => (l.department || 'Sans rayon') === selectedDepartment) : []),
    [proposal, selectedDepartment],
  );

  // Câble le picker + synchronise avec le magasin actif global de la topbar, comme sur les autres
  // pages migrées (cf. SalesHistory.tsx) : select NON contrôlé par React (value=state réécrirait le
  // DOM à chaque rendu et entrerait en conflit avec shop-picker.js/global-shop-selector.js, qui
  // manipulent ce <select> directement : selectEl.value = ...; dispatchEvent('change')). Dépend de
  // `shops` et `showListView` (pas un setTimeout(0) fragile) pour re-câbler à chaque fois que ce
  // <select> précis est (dé)monté (il n'existe que dans la vue Secteurs, pas dans le détail rayon).
  useEffect(() => {
    if (isSingleShop) return;
    const select = shopSelectRef.current;
    if (!select || shops.length === 0) return;

    function handleNativeChange() {
      setSelectedShopId(select!.value);
    }
    select.addEventListener('change', handleNativeChange);

    if (window.reassortMakeShopPickerSearchable) {
      window.reassortMakeShopPickerSearchable(select);
    }

    // Le magasin ACTIF DE LA TOPBAR gagne toujours sur le `?shop=` de l'URL : un lien profond
    // partagé, un onglet resté ouvert ou un retour arrière du navigateur peut porter un `shop=`
    // périmé, et le faire quand même gagner sur le sélecteur global visible à l'écran a trompé
    // l'utilisateur le 24/09/2026 (topbar affichait 050, la page agissait sur 110 depuis une URL
    // restée sur ce magasin) — risque réel d'agir sur le mauvais magasin. Le `?shop=` de l'URL ne
    // sert donc plus qu'en tout dernier recours (aucun magasin actif connu du tout).
    const urlShopId = urlParams.get('shop');
    const activeShop = window.reassortGetActiveShop ? window.reassortGetActiveShop() : null;
    const activeMatch = activeShop ? select.querySelector(`option[value="${activeShop.id}"]`) : null;
    if (activeShop && activeMatch) {
      if (select.value !== activeShop.id) select.value = activeShop.id;
      setSelectedShopId(select.value);
    } else if (urlShopId && select.querySelector(`option[value="${urlShopId}"]`)) {
      if (select.value !== urlShopId) select.value = urlShopId;
      setSelectedShopId(select.value);
    } else if (select.value) {
      // Aucun magasin global connu : repli sur la première option du <select> (comportement de
      // secours, comme la page HTML d'origine sans sélection explicite).
      setSelectedShopId(select.value);
    }

    return () => select.removeEventListener('change', handleNativeChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSingleShop, shops, showListView]);

  // Écoute GLOBALE du changement de magasin actif dans la topbar (reassortOnActiveShopChange),
  // active quelle que soit la vue affichée — contrairement à l'effet ci-dessus, qui ne peut réagir
  // que lorsque le <select> de la vue Secteurs est monté. Sans ceci, changer de magasin depuis la
  // topbar PENDANT qu'on consulte le détail d'un rayon laissait la page sur l'ancien magasin (bug
  // constaté le 24/09/2026 : topbar affichait 050 mais la modale de validation RPOS montrait encore
  // les 480 articles de 110, avec l'ID de 110 dans l'URL) — risque réel d'envoyer une commande sur le
  // mauvais magasin. Revient à la vue Secteurs du nouveau magasin plutôt que de rester sur un rayon
  // qui n'a plus de sens pour lui.
  const selectedShopIdRef = useRef(selectedShopId);
  selectedShopIdRef.current = selectedShopId;

  const hasSyncedInitialShopRef = useRef(false);

  useEffect(() => {
    if (isSingleShop) return;
    function syncToActiveShop(shop: unknown) {
      const activeShop = shop as { id: string } | null;
      if (!activeShop) return;
      // Lit la valeur COURANTE via la ref, jamais `selectedShopId` capturé par la closure au moment
      // du montage de cet effet (qui ne se relance jamais, cf. deps `[isSingleShop]` ci-dessous) :
      // sinon la comparaison reste figée sur '' pour toujours, et ce correctif se redéclenchait à
      // chaque broadcast du sélecteur global, réinitialisant sector/dept en pleine navigation dans
      // un rayon — bug constaté le 24/09/2026 juste après le correctif précédent (cliquer sur un
      // secteur ne menait jamais nulle part, ramené aussitôt à la vue Secteurs).
      if (activeShop.id === selectedShopIdRef.current) return;

      // Au tout premier appel (montage), `selectedShopIdRef.current` vaut encore '' même quand le
      // `?shop=` de l'URL correspond DÉJÀ au magasin actif (cas normal d'un lien profond valide,
      // ex: retour depuis l'historique d'une génération) : comparer au `?shop=` de l'URL plutôt qu'à
      // l'état React pas encore initialisé évite de réinitialiser sector/dept à tort dans ce cas —
      // bug constaté le 24/09/2026 juste après le correctif "topbar prioritaire" (arriver sur un lien
      // profond valide ramenait quand même à la vue Secteurs).
      const isFirstSync = !hasSyncedInitialShopRef.current;
      hasSyncedInitialShopRef.current = true;
      const urlShopId = urlParams.get('shop');
      const urlAlreadyMatches = isFirstSync && urlShopId === activeShop.id;

      setSelectedShopId(activeShop.id);
      if (!urlAlreadyMatches) {
        setSelectedSector(null);
        setSelectedDepartment(null);
        window.history.pushState({}, '', window.location.pathname);
      }
    }
    if (!window.reassortGetActiveShop || !window.reassortOnActiveShopChange) return;
    // Vérifie aussi IMMÉDIATEMENT au montage (pas seulement sur un futur changement) : le
    // désaccord entre l'URL et le magasin actif peut déjà exister à l'arrivée sur la page (lien
    // profond périmé, retour arrière du navigateur), avant même qu'un événement de changement soit
    // déclenché — c'est exactement le scénario qui a trompé l'utilisateur le 24/09/2026.
    syncToActiveShop(window.reassortGetActiveShop());
    window.reassortOnActiveShopChange(syncToActiveShop);
    // reassortOnActiveShopChange n'a pas de désinscription (voir global-shop-selector.js) : accepté
    // ici comme sur les autres pages migrées (ex: AiAssistant.tsx), la page vit tout le cycle de vie
    // de l'onglet donc l'abonnement ne s'accumule pas au-delà d'un montage par session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSingleShop]);

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
        .reassort-dept-tile {
          border: 1px solid #ececec;
          border-radius: 12px;
          box-shadow: 0 1px 2px rgba(20, 20, 20, .04);
          transition: box-shadow .2s ease, border-color .2s ease, transform .2s ease;
          overflow: hidden;
          position: relative;
        }
        .reassort-dept-tile::before {
          content: '';
          position: absolute;
          top: 0; left: 0; right: 0;
          height: 3px;
          background: var(--tile-accent, #444444);
        }
        .reassort-dept-tile:hover { box-shadow: 0 6px 18px rgba(20, 20, 20, .08); border-color: #dcdfe3; transform: translateY(-1px); }
        .reassort-dept-tile .card-body { padding: .9rem 1.05rem; }
        .reassort-dept-tile .tile-icon {
          width: 28px; height: 28px; border-radius: 8px;
          display: flex; align-items: center; justify-content: center;
          background: color-mix(in srgb, var(--tile-accent, #444444) 12%, white);
          color: var(--tile-accent, #444444);
          font-size: .9rem;
          margin-bottom: .5rem;
        }
        .reassort-dept-tile .card-title { font-size: .85rem; font-weight: 700; letter-spacing: .01em; color: #17181a; }
        .reassort-dept-tile .tile-count { color: #9198a1; font-size: .72rem; margin-bottom: .4rem; }
        .reassort-dept-tile .tile-pct { font-size: 1.4rem; font-weight: 700; line-height: 1.1; color: #17181a; letter-spacing: -.02em; }
        .reassort-dept-tile .tile-pct .fs-14 { font-size: .7rem !important; }
        .reassort-dept-tile .tile-progress { height: 4px; border-radius: 999px; background-color: #f1f2f4; overflow: hidden; margin: .5rem 0 .6rem; }
        .reassort-dept-tile .tile-progress-fill { height: 100%; background-color: var(--tile-accent, #444444); border-radius: 999px; transition: width .35s ease; }
        .reassort-dept-tile .tile-revenue { font-weight: 600; color: #2c2d30; font-size: .78rem; padding-top: .5rem; border-top: 1px solid #f2f3f4; }
        .reassort-dept-tile .tile-proposed { color: #b1b6bc; font-size: .72rem; margin-top: .1rem; }
        .ag-header-cell-text { text-transform: uppercase; letter-spacing: 0.02em; }
        .ag-cell { padding-left: 0.5rem; padding-right: 0.5rem; display: flex; align-items: center; }
        .ag-cell-wrapper { width: 100%; }
        #reassort-grid { width: 100%; }
        /* Badges compacts pour le tableau de proposition (demande du 24/09/2026, "trop gros, style
           plus pro") : les badges Bootstrap standards (icône + texte, padding par défaut) empilés
           dans une cellule autoHeight (Article/Vente moy./Stock) gonflaient chaque ligne bien au-delà
           du rowHeight réduit posé sur cette grille — ce style les ramène à une taille de puce
           d'information plutôt que de bouton. */
        .reassort-mini-badge {
          font-size: .68rem !important;
          font-weight: 600;
          padding: .18rem .5rem !important;
          line-height: 1.3;
          border-radius: 999px;
        }
        .reassort-mini-badge iconify-icon { font-size: .8rem; vertical-align: -1px; }
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
                <select className="form-select form-select-sm mt-1" style={{ minWidth: 260 }} ref={shopSelectRef} defaultValue="">
                  <ShopOptions />
                </select>
              )}
            </div>
            <div className="d-flex gap-2 align-items-center flex-wrap">
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
              {proposal?.weeklyPlanId && (
                <button className="btn btn-sm btn-outline-secondary" onClick={() => setWeeklyPlanHistoryOpen(true)}>
                  <iconify-icon icon="solar:history-bold-duotone" className="align-middle"></iconify-icon> Historique de la semaine
                </button>
              )}
              <button className="btn btn-sm btn-outline-secondary" disabled={refreshing} onClick={loadPendingProposal}>
                Actualiser
              </button>
              {!!proposal && (
                <button
                  className="btn btn-sm btn-outline-secondary"
                  disabled={sendingAlert}
                  onClick={handleSendAlert}
                  title="Envoie manuellement l'alerte email aux comptes rattachés à ce magasin, au cas où l'envoi automatique n'aurait pas eu lieu"
                >
                  <iconify-icon icon="solar:letter-bold-duotone" className="align-middle"></iconify-icon>{' '}
                  {sendingAlert ? 'Envoi...' : 'Envoyer par email'}
                </button>
              )}
              <GenerationFlow
                shopId={isSingleShop ? user?.rposShopId || '' : selectedShopId}
                shopReference={(isSingleShop ? user?.rposShopReference : selectedShop?.reference) || ''}
                shopName={(isSingleShop ? user?.rposShopName : selectedShop?.name) || ''}
                shopQueryParam={shopQueryParam()}
                hasPendingProposal={!!proposal}
                onDone={loadPendingProposal}
              />
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

          <DepartmentListView proposal={proposal} selectedSector={selectedSector} buildNavUrl={buildNavUrl} onNavigate={navigateTo} onOpenExcluded={handleOpenExcluded} />
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
                <div className="d-flex gap-2 align-items-center flex-wrap">
                  <span className="text-muted small">{status}</span>
                  <button className="btn btn-sm btn-outline-secondary" disabled={refreshing} onClick={loadPendingProposal}>
                    Actualiser
                  </button>
                  {!!proposal && (
                    <button
                      className="btn btn-sm btn-outline-secondary"
                      disabled={sendingAlert}
                      onClick={handleSendAlert}
                      title="Envoie manuellement l'alerte email aux comptes rattachés à ce magasin, au cas où l'envoi automatique n'aurait pas eu lieu"
                    >
                      <iconify-icon icon="solar:letter-bold-duotone" className="align-middle"></iconify-icon>{' '}
                      {sendingAlert ? 'Envoi...' : 'Envoyer par email'}
                    </button>
                  )}
                  {!viewingPastGeneration && proposal && (
                    <ValidationFlow
                      proposalId={proposal.id}
                      decisionsProvider={() => proposalTableRef.current?.getDecisions() || []}
                      selectedDepartment={selectedDepartment}
                      totalLines={proposal.lines.length}
                      shopName={(isSingleShop ? user?.rposShopName : selectedShop?.name) || ''}
                      shopQueryParam={shopQueryParam()}
                      onValidated={() => {
                        // Une fois validée, la proposition n'est plus "en attente" : rester sur la
                        // vue détail d'un rayon qui n'a plus rien à afficher laissait l'utilisateur
                        // devant un tableau vide sans explication (bug constaté le 24/09/2026).
                        // Retour à la vue Secteurs (qui affichera "Aucune proposition en attente"
                        // avec un message clair) plutôt que de rester sur un rayon désormais orphelin.
                        navigateTo(buildNavUrl(selectedSector, null));
                        loadPendingProposal();
                      }}
                    />
                  )}
                </div>
              </div>

              <div className="card-body">
                {viewingPastGeneration && (
                  <div className="alert alert-warning small mb-3">
                    Génération passée en lecture seule — ne peut pas être validée ni envoyée à RPOS.
                  </div>
                )}
                <div className="d-flex justify-content-between align-items-center mb-2 flex-wrap gap-2">
                  {orderTotal > 0 && <p className="fw-semibold mb-0">Total commande : {orderTotal.toLocaleString('fr-FR')} CFA</p>}
                  <div className="d-flex gap-2 ms-auto">
                    <button className="btn btn-sm btn-outline-secondary" onClick={() => proposalTableRef.current?.selectAllToggle()}>
                      Tout cocher/décocher
                    </button>
                    <button
                      className="btn btn-sm btn-outline-secondary"
                      onClick={() =>
                        proposalTableRef.current?.exportCsv(
                          (isSingleShop ? user?.rposShopReference : selectedShop?.reference) || 'magasin',
                        )
                      }
                    >
                      Exporter (CSV)
                    </button>
                  </div>
                </div>
                <ProposalTable
                  ref={proposalTableRef}
                  proposal={proposal}
                  lines={detailLines}
                  shopId={isSingleShop ? user?.rposShopId || '' : selectedShopId}
                  shopQueryParam={shopQueryParam()}
                  readOnly={viewingPastGeneration}
                  onOpenAnalytics={setAnalyticsArticle}
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

      {analyticsArticle && (
        <ProductAnalyticsModal article={analyticsArticle} shopQueryParam={shopQueryParam()} onClose={() => setAnalyticsArticle(null)} />
      )}

      {weeklyPlanHistoryOpen && proposal?.weeklyPlanId && (
        <WeeklyPlanHistoryModal weeklyPlanId={proposal.weeklyPlanId} onClose={() => setWeeklyPlanHistoryOpen(false)} />
      )}
    </div>
  );
}
