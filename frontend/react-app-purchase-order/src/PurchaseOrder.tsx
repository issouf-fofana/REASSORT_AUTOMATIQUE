import { useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from './api/client';
import { DepartmentListView } from './DepartmentListView';
import { ProposalHeader } from './ProposalHeader';
import { GenerationFlow } from './GenerationFlow';
import { ProductAnalyticsModal } from './ProductAnalyticsModal';
import { ProposalTable, type ProposalTableHandle } from './ProposalTable';
import { ArticleDetailModal } from './ArticleDetailModal';
import { ValidationFlow } from './ValidationFlow';
import { WeeklyPlanHistoryModal } from './WeeklyPlanHistoryModal';
import type { Proposal, ProposalHistoryItem, ProposalLine, Shop } from './types';

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
  const [sendAlertModalOpen, setSendAlertModalOpen] = useState(false);
  const [sendAlertRecipients, setSendAlertRecipients] = useState<{ email: string; name: string; role: string }[] | null>(null);
  const [sendAlertError, setSendAlertError] = useState<string | null>(null);
  // Emails décochés par l'utilisateur dans la popup (demande du 25/09/2026 : "les enlever ou pas") —
  // tous cochés par défaut à l'ouverture, un Set plutôt qu'un tableau pour un togglage simple.
  const [sendAlertExcluded, setSendAlertExcluded] = useState<Set<string>>(new Set());
  const loadTokenRef = useRef(0);

  const [history, setHistory] = useState<ProposalHistoryItem[]>([]);
  const [viewingPastGeneration, setViewingPastGeneration] = useState(false);
  const [selectedGenerationId, setSelectedGenerationId] = useState('');

  const [orderTotal, setOrderTotal] = useState(0);

  // Articles non rattachés au fournisseur central RPOS (demande du 26/09/2026 : "je dois voir une
  // vue où je peux voir dans la proposition les articles qui ne son pas rattaché au fournisseur
  // central") — remplace la liste complète autrefois affichée dans le corps de l'email (devenu
  // illisible avec 26 articles, cf. buildSupplierWarningHtml côté backend), qui ne montre plus
  // qu'un résumé + lien vers cette vue.
  const [supplierIneligible, setSupplierIneligible] = useState<{ ean: string; label: string | null; currentSuppliers: string }[] | null>(null);
  const [supplierCheckLoading, setSupplierCheckLoading] = useState(false);
  const supplierCheckTokenRef = useRef(0);

  const [excludedModal, setExcludedModal] = useState<{ label: string; items: ExcludedItem[] | null; error: string | null } | null>(null);
  // Modal générique "liste d'articles + fournisseur" (29/09/2026) : les listes de commandabilité
  // fournisseur (synthèse §3 et alerte non-rattachés legacy) s'affichaient directement dans la page,
  // rendant l'écran chargé même quand tout va bien — demande explicite de les masquer derrière un
  // clic, comme les autres listes de détail (excludedModal ci-dessus, déjà sur ce même principe).
  const [supplierListModal, setSupplierListModal] = useState<{ title: string; items: { ean: string; label: string | null; currentSuppliers: string | null | undefined }[] } | null>(null);
  // Panneau de détail d'une ligne (30/09/2026) : remplace l'ancienne sufficiencyModal (texte brut de
  // orderSufficiencyReasoning seul) — réunit désormais toutes les infos autrefois en badges empilés
  // dans le tableau (commande en cours, anomalie, suffisance, saisonnalité, stock).
  const [articleDetail, setArticleDetail] = useState<ProposalLine | null>(null);
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
  // actuellement affiché. Popup de confirmation avec la liste des destinataires AVANT l'envoi réel
  // (demande du 25/09/2026 : "voir les personnes qui son assigé avant de valider l'envoi") — la
  // liste est chargée depuis une route dédiée qui ne fait que lire, jamais envoyer.
  async function handleOpenSendAlertModal() {
    setSendAlertModalOpen(true);
    setSendAlertRecipients(null);
    setSendAlertError(null);
    setSendAlertExcluded(new Set());
    try {
      const data = await apiFetch<{ email: string; name: string; role: string }[]>(`/reassort/proposal/send-alert/recipients?${shopQueryParam()}`);
      setSendAlertRecipients(data);
    } catch (err) {
      setSendAlertError(err instanceof Error ? err.message : String(err));
    }
  }

  function toggleSendAlertRecipient(email: string) {
    setSendAlertExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });
  }

  async function handleConfirmSendAlert() {
    const recipients = (sendAlertRecipients || []).map((r) => r.email).filter((e) => !sendAlertExcluded.has(e));
    setSendingAlert(true);
    try {
      const res = await window.reassortFetch(`/reassort/proposal/send-alert?${shopQueryParam()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipients }),
      });
      const json: { success: boolean; message: string } = await res.json();
      if (!json.success) throw new Error(json.message);
      window.reassortToast(json.message, 'success');
      setSendAlertModalOpen(false);
    } catch (err) {
      window.reassortToast('Erreur : ' + (err instanceof Error ? err.message : String(err)), 'error');
    } finally {
      setSendingAlert(false);
    }
  }

  // `isExplicitHistoryPick` distingue deux usages bien différents de cette fonction :
  // - true (handleGenerationSelect) : l'utilisateur choisit EXPRÈS une génération dans l'historique,
  //   potentiellement ancienne/remplacée → lecture seule si son statut n'est plus GENERATED.
  // - false (rechargements après validation d'un rayon, bouton Actualiser) : on recharge la MÊME
  //   proposition en cours de traitement — un rayon qui vient de faire passer Proposal.status à
  //   VALIDATED ne doit JAMAIS rendre les AUTRES rayons non traités inaccessibles en lecture seule
  //   (bug du 27/09/2026 : "les autres rayons disparaissent" — en réalité le bouton Valider
  //   disparaissait pour tous les rayons dès que le statut global changeait, alors qu'il restait des
  //   rayons sans ProposalOrder). Le vrai signal de "lecture seule" reste `currentDepartmentOrder`
  //   (ce rayon précis a-t-il déjà sa commande ?), pas le statut global de la proposition.
  async function loadProposalById(id: string, isExplicitHistoryPick = false) {
    setStatus('Chargement...');
    try {
      const data = await apiFetch<Proposal>(`/reassort/proposal/${id}?${shopQueryParam()}`);
      if (isExplicitHistoryPick) setViewingPastGeneration(data.status !== 'GENERATED');
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

  // Contrôle fournisseur (demande du 26/09/2026) : relancé à chaque changement de proposition
  // affichée (nouvelle génération, historique) — jamais bloquant pour l'affichage principal, un échec
  // (RPOS indisponible...) laisse simplement la section vide plutôt que de casser toute la page.
  useEffect(() => {
    if (!proposal || !proposal.lines.length) {
      setSupplierIneligible(null);
      return;
    }
    const token = ++supplierCheckTokenRef.current;
    setSupplierCheckLoading(true);
    (async () => {
      try {
        const data = await apiFetch<{ ineligible: { ean: string; label: string | null; currentSuppliers: string }[] }>(
          `/reassort/proposal/${proposal.id}/supplier-check?${shopQueryParam()}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decisions: [] }) },
        );
        if (token !== supplierCheckTokenRef.current) return;
        setSupplierIneligible(data.ineligible);
      } catch {
        if (token !== supplierCheckTokenRef.current) return;
        setSupplierIneligible(null);
      } finally {
        if (token === supplierCheckTokenRef.current) setSupplierCheckLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposal?.id]);

  function handleGenerationSelect(id: string) {
    setSelectedGenerationId(id);
    if (id) loadProposalById(id, true);
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

  // ProposalOrder déjà créée pour le rayon actuellement affiché (demande du 26/09/2026, validation
  // indépendante par rayon) — présente dès que ce rayon précis a été validé, quel que soit l'état
  // des autres rayons de la même proposition.
  const currentDepartmentOrder = useMemo(
    () => (proposal && selectedDepartment ? (proposal.orders || []).find((o) => o.department === selectedDepartment) || null : null),
    [proposal, selectedDepartment],
  );

  // Synthèse commandable/non commandable du rayon affiché (spec du 28/09/2026, §3) : calculée
  // localement depuis ProposalLine.supplierIneligible (déjà chargé avec la proposition), jamais un
  // nouvel appel réseau. Ignore les lignes exclues par l'utilisateur (wasExcluded) — la synthèse
  // porte sur ce qui SERAIT commandé, pas sur tout ce qui a été calculé au départ.
  const eligibilitySummary = useMemo(() => {
    const active = detailLines.filter((l) => !l.wasExcluded);
    const commandable = active.filter((l) => l.supplierIneligible !== true);
    const nonCommandable = active.filter((l) => l.supplierIneligible === true);
    const qty = (lines: typeof active) => lines.reduce((sum, l) => sum + (l.quantitySuggested || 0), 0);
    return {
      total: active.length,
      commandableCount: commandable.length,
      nonCommandableCount: nonCommandable.length,
      totalQty: qty(active),
      commandableQty: qty(commandable),
      nonCommandableQty: qty(nonCommandable),
      nonCommandableLines: nonCommandable,
    };
  }, [detailLines]);

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

    // Le magasin ACTIF DE LA TOPBAR gagne en général sur le `?shop=` de l'URL : un lien profond
    // partagé, un onglet resté ouvert ou un retour arrière du navigateur peut porter un `shop=`
    // périmé, et le faire quand même gagner sur le sélecteur global visible à l'écran a trompé
    // l'utilisateur le 24/09/2026 (topbar affichait 050, la page agissait sur 110 depuis une URL
    // restée sur ce magasin) — risque réel d'agir sur le mauvais magasin.
    // EXCEPTION explicite (`src=email`, demande du 26/09/2026 : "si admin est connecté il va sur
    // une commande mais dans un autre mag") : un lien fraîchement cliqué depuis un email (jamais un
    // onglet resté ouvert ni un retour arrière) porte ce marqueur — il DOIT alors l'emporter sur le
    // magasin actif mémorisé, qui peut dater d'une consultation précédente sans rapport. Sans cette
    // exception, un ADMIN qui consultait un autre magasin juste avant de cliquer sur le lien du mail
    // atterrissait sur CE magasin actif au lieu de celui visé par l'alerte.
    const urlShopId = urlParams.get('shop');
    const fromEmailLink = urlParams.get('src') === 'email';
    const activeShop = window.reassortGetActiveShop ? window.reassortGetActiveShop() : null;
    const activeMatch = activeShop ? select.querySelector(`option[value="${activeShop.id}"]`) : null;
    if (fromEmailLink && urlShopId && select.querySelector(`option[value="${urlShopId}"]`)) {
      if (select.value !== urlShopId) select.value = urlShopId;
      setSelectedShopId(select.value);
      // Aligne aussi le sélecteur global de la topbar (partagé entre toutes les pages) sur ce
      // magasin — sans ça, un simple `select.value = ...` ne déclenche pas l'event `change` qui
      // appelle normalement reassortSetActiveShop (cf. shop-picker.js), et la topbar resterait
      // visuellement désynchronisée du contenu réel de la page.
      const emailShop = shops.find((s) => s.id === urlShopId);
      if (emailShop && window.reassortSetActiveShop) {
        window.reassortSetActiveShop({ id: emailShop.id, reference: emailShop.reference, name: emailShop.name, posLabel: emailShop.posLabel });
      }
    } else if (activeShop && activeMatch) {
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
        /* Cartes secteurs : liste verticale style "agent dashboard" (maquette fournie le 01/10/2026),
           limité à CET écran — le reste de l'application garde son noir/blanc/gris strict.
           RemainderTile (carte "Reste du CA magasin", info secondaire/liste d'exclusions) reste
           neutre via .reassort-dept-row-neutral, pour ne pas mettre au même niveau visuel une vraie
           carte KPI et une liste de raisons d'exclusion. */
        /* Grille 3 colonnes (demande du 01/10/2026 : "aligné" puis "trop large, trop d'espace vide"
           en 2 colonnes) — réduit progressivement à 2 puis 1 colonne sur petits écrans pour ne
           jamais compresser les métriques internes de la carte. */
        .reassort-dept-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .85rem; }
        @media (max-width: 1399px) { .reassort-dept-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
        @media (max-width: 767px) { .reassort-dept-grid { grid-template-columns: 1fr; } }
        .reassort-dept-row {
          --row-navy: #1B2A4A;
          --row-amber: #F5A623;
          display: block;
          border: 1px solid #e9ecf2;
          border-radius: 14px;
          background: #ffffff;
          box-shadow: 0 1px 3px rgba(27, 42, 74, .05);
          transition: box-shadow .2s ease, border-color .2s ease, transform .2s ease;
          overflow: hidden;
          height: 100%;
        }
        .reassort-dept-row:hover { box-shadow: 0 8px 20px rgba(27, 42, 74, .1); border-color: #c7d2e8; transform: translateY(-1px); }
        .reassort-dept-row .card-body { padding: 1.1rem 1.3rem; }
        .row-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: .9rem; }
        .row-identity { display: flex; align-items: flex-start; gap: .85rem; min-width: 0; }
        .reassort-dept-row .tile-icon {
          width: 38px; height: 38px; border-radius: 10px;
          display: flex; align-items: center; justify-content: center;
          background: var(--row-navy);
          color: var(--row-amber);
          font-size: 1.1rem;
          flex-shrink: 0;
        }
        .reassort-dept-row .card-title { font-size: .95rem; font-weight: 600; letter-spacing: -.005em; color: #1B2A4A; margin-bottom: .2rem; }
        .reassort-dept-row .tile-count { color: #5B6B85; font-size: .78rem; margin-bottom: 0; }
        .row-metrics { display: flex; flex-wrap: wrap; gap: .75rem 1rem; align-items: center; }
        .row-metric { min-width: 70px; }
        .row-metric-label { display: flex; align-items: center; gap: .35rem; color: #8a93a8; font-size: .68rem; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; margin-bottom: .25rem; }
        .row-metric-label iconify-icon { font-size: .85rem; }
        .row-metric-value { font-size: .95rem; font-weight: 700; color: #1B2A4A; }
        .row-progress-wrap { flex: 1 1 100%; min-width: 140px; }
        .tile-progress { height: 6px; border-radius: 999px; background-color: #EDF1F7; overflow: hidden; margin-top: .4rem; }
        .tile-progress-fill { height: 100%; background-color: var(--row-amber); border-radius: 999px; transition: width .35s ease; }
        .row-status-badge {
          font-size: .68rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
          padding: .35rem .7rem; border-radius: 999px; white-space: nowrap; flex-shrink: 0;
          display: inline-flex; align-items: center; gap: .3rem;
        }
        .row-status-badge.status-done { background: #ECFDF5; color: #047857; }
        .row-status-badge.status-failed { background: #F5EDEC; color: #7A4A45; }
        .row-status-badge.status-pending { background: #EDF1F7; color: #5B6B85; }
        /* Variante neutre (RemainderTile) : icône et accents gris plutôt que marine/ambre. */
        .reassort-dept-row-neutral .tile-icon { background: #EEF1F6; color: #5B6B85; }
        .reassort-dept-row-neutral .card-title { color: #5B6B85; }
        .reassort-dept-row-neutral .tile-progress-fill { background-color: #97A3BC; }
        .reassort-dept-row-neutral .row-metric-value { color: #33415C; }
        .reassort-dept-row-neutral ul a { color: #33415C; }
        .ag-header-cell-text { text-transform: uppercase; letter-spacing: 0.02em; }
        .ag-cell { padding-left: 0.5rem; padding-right: 0.5rem; display: flex; align-items: center; }
        .ag-cell-wrapper { width: 100%; }
        #reassort-grid { width: 100%; }
        /* Scrollbar horizontale dupliquée en haut du tableau (demande du 30/09/2026) : avec
           beaucoup de colonnes, la scrollbar native ag-grid tout en bas est trop fine/difficile à
           attraper sans faire défiler la page entière pour la voir. Synchronisée en JS avec le
           scroll natif du tableau, cf. ProposalTable.tsx onGridReady/onBodyScroll. */
        .reassort-grid-top-scroll { overflow-x: auto; overflow-y: hidden; height: 14px; margin-bottom: 2px; }
        .reassort-grid-top-scroll > div { height: 1px; }
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
          display: inline-flex !important;
          align-items: center;
          gap: .3rem;
          flex: 0 0 auto;
          max-width: 100%;
          white-space: normal;
        }
        .reassort-mini-badge iconify-icon { font-size: .8rem; vertical-align: -1px; }
        /* Couleur de texte fixée explicitement (pas .text-dark/.bg-light Bootstrap) : ce thème
           redéfinit .text-dark via --bs-headings-color, qui vaut un gris quasi blanc en mode sombre
           — rendait ces badges illisibles (texte blanc sur fond clair, signalé le 30/09/2026). */
        .reassort-info-badge {
          background-color: #EDF1F7 !important;
          color: #1B2A4A !important;
          border-color: #D6DEEA !important;
        }
        /* Badge d'avertissement (couverture de données incomplète) dans la même palette marine/ambre
           que les cartes secteurs de cet écran (demande du 30/09/2026), au lieu du warning Bootstrap
           standard. */
        .reassort-warning-badge {
          background-color: #FDF1DD !important;
          color: #8A5A00 !important;
          border-color: #F5A623 !important;
        }
        /* Boutons d'action dans la palette marine/ambre de cet écran (demande du 30/09/2026). */
        .reassort-btn-navy {
          background-color: #1B2A4A; border-color: #1B2A4A; color: #fff;
        }
        .reassort-btn-navy:hover, .reassort-btn-navy:focus { background-color: #14203a; border-color: #14203a; color: #fff; }
        .reassort-btn-navy:disabled { background-color: #1B2A4A; border-color: #1B2A4A; opacity: .5; }
        .reassort-btn-navy-outline {
          background-color: transparent; border: 1px solid #1B2A4A; color: #1B2A4A;
        }
        .reassort-btn-navy-outline:hover, .reassort-btn-navy-outline:focus { background-color: #1B2A4A; color: #fff; }
        .reassort-btn-amber-outline {
          background-color: transparent; border: 1px solid #F5A623; color: #8A5A00;
        }
        .reassort-btn-amber-outline:hover, .reassort-btn-amber-outline:focus { background-color: #F5A623; color: #1B2A4A; }
        /* Palette adoucie (demande du 30/09/2026, "trop de couleur") : remplace les oranges/rouges
           Bootstrap standards (bg-warning-subtle/bg-danger-subtle) par des teintes beige/brun-gris
           désaturées, cohérentes avec le noir/blanc/gris strict du reste du projet — garde le sens
           (attention/problème) sans être agressif visuellement. */
        .reassort-badge-soft-warning { background-color: #F3F1EA !important; color: #6B5B2E !important; }
        .reassort-badge-soft-danger  { background-color: #F5EDEC !important; color: #7A4A45 !important; }
        /* Icône d'alerte discrète dans les cellules simplifiées (Article/Vente moy./Stock actuel,
           demande du 30/09/2026) : même teinte que les badges ci-dessus, mais sans fond ni bordure. */
        .reassort-alert-soft { color: #8A7A4A; }
        /* Rend visible que l'icône d'alerte/graphique dans la cellule Article est cliquable — un
           simple hover sur une icône nue restait invisible tant que la souris n'était pas dessus
           (demande du 01/10/2026, 2e retour : "toujours pas visible, fait un bouton normal"). Vrai
           bouton avec fond et bordure visibles EN PERMANENCE, pas seulement au survol, comme
           n'importe quel bouton de l'application. */
        .pa-open-btn,
        .article-detail-btn {
          height: 26px; border-radius: 6px;
          display: inline-flex; align-items: center; justify-content: center; gap: .3rem;
          padding: 0 .5rem !important;
          font-size: .72rem; font-weight: 600; white-space: nowrap;
          transition: background-color .15s ease, border-color .15s ease;
          cursor: pointer;
        }
        .pa-open-btn {
          background-color: #1B2A4A;
          border: 1px solid #1B2A4A;
          color: #ffffff;
        }
        .pa-open-btn:hover, .pa-open-btn:focus {
          background-color: #14203a;
          border-color: #14203a;
          color: #ffffff;
        }
        .article-detail-btn {
          background-color: #F5A623;
          border: 1px solid #F5A623;
          color: #1B2A4A;
        }
        .article-detail-btn:hover, .article-detail-btn:focus {
          background-color: #dd950f;
          border-color: #dd950f;
          color: #1B2A4A;
        }
        .article-detail-btn iconify-icon,
        .pa-open-btn iconify-icon { font-size: .9rem; }
        /* L'icône hérite normalement de la couleur du texte du bouton — mais articleAlertIcon()
           (ProposalTable.tsx) lui ajoute sa propre classe de couleur (ex: .reassort-alert-soft, brun
           ambré) pour l'ancien usage en icône nue, qui se fond désormais dans le fond ambre plein du
           bouton (signalé le 01/10/2026, icône invisible). Le bouton a toujours besoin d'un contraste
           fort quel que soit l'état de l'alerte, donc on l'impose ici plutôt que de dépendre de la
           classe posée par alert.cls. */
        .article-detail-btn iconify-icon { color: #1B2A4A !important; }
        .pa-open-btn iconify-icon { color: #ffffff !important; }
        /* Modals de cet écran (ArticleDetailModal, ProductAnalyticsModal, WeeklyPlanHistoryModal,
           etc.) restylées en marine/ambre (demande du 01/10/2026) pour rester cohérentes avec les
           cartes de secteurs/rayons — purement visuel, markup Bootstrap inchangé. */
        .modal-content { border: none; border-radius: 16px; overflow: hidden; box-shadow: 0 20px 48px rgba(27, 42, 74, .22); }
        .modal-header { background: #1B2A4A; border-bottom: none; padding: 1.15rem 1.5rem; }
        .modal-header .modal-title { color: #ffffff; font-weight: 600; font-size: 1.02rem; }
        .modal-header .modal-title iconify-icon { color: #F5A623 !important; }
        .modal-header .btn-close { filter: invert(1) grayscale(1) brightness(1.8); opacity: .85; }
        .modal-header .btn-close:hover { opacity: 1; }
        .modal-body { padding: 1.4rem 1.5rem; }
        .modal-body .nav-tabs { border-bottom: 1px solid #e9ecf2; }
        .modal-body .nav-tabs .nav-link { color: #5B6B85; font-size: .88rem; font-weight: 500; border: none; border-bottom: 2px solid transparent; }
        .modal-body .nav-tabs .nav-link:hover { color: #1B2A4A; border-color: #DCE3F0; }
        .modal-body .nav-tabs .nav-link.active { color: #1B2A4A; font-weight: 600; border-color: #F5A623; background: transparent; }
        .modal-body .alert-light { background-color: #F7F9FC; border-color: #e9ecf2; color: #33415C; }
        .modal-body .alert-info { background-color: #EDF1F7; border-color: #DCE3F0; color: #1B2A4A; }
        .modal-body .alert-success { background-color: #ECFDF5; border-color: #A7F3D0; color: #047857; }
        .modal-body .alert-warning { background-color: #FDF1DD; border-color: #F7DFA6; color: #8A5A00; }
        .modal-body .btn-warning { background-color: #F5A623; border-color: #F5A623; color: #1B2A4A; font-weight: 600; }
        .modal-body .btn-warning:hover { background-color: #e0951a; border-color: #e0951a; }
        .modal-body .btn-outline-primary { color: #1B2A4A; border-color: #1B2A4A; }
        .modal-body .btn-outline-primary:hover { background-color: #1B2A4A; border-color: #1B2A4A; }
        /* Transition de vue (demande du 01/10/2026 : "pas brusque" au clic secteur → rayons →
           tableau d'articles) : fondu + léger glissement vertical, rejoué à chaque navigation via la
           prop key sur .reassort-view-transition (force un remount React). */
        .reassort-view-transition { animation: reassort-view-in .28s ease; }
        @keyframes reassort-view-in {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @media (prefers-reduced-motion: reduce) {
          .reassort-view-transition { animation: none; }
        }
      `}</style>

      {proposal && <ProposalHeader proposal={proposal} />}

      {showListView ? (
        <div className="reassort-view-transition" key={`list-${selectedSector || ''}`}>
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
              {/* Recharge par ID si une proposition est déjà affichée (même bug/fix que onValidated
                  ci-dessous : /proposal/pending renvoie null dès que status passe VALIDATED,
                  effaçant tout l'écran même pour une proposition déjà entièrement traitée qu'on
                  devrait pouvoir continuer à consulter) — sinon (aucune proposition chargée), le
                  comportement d'origine reste inchangé. */}
              <button className="btn btn-sm btn-outline-secondary" disabled={refreshing} onClick={() => (proposal ? loadProposalById(proposal.id) : loadPendingProposal())}>
                Actualiser
              </button>
              {!!proposal && (
                <button
                  className="btn btn-sm btn-outline-secondary"
                  disabled={sendingAlert}
                  onClick={handleOpenSendAlertModal}
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
        <div className="row reassort-view-transition" key={`detail-${selectedSector || ''}-${selectedDepartment || ''}`}>
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
                  <button className="btn btn-sm btn-outline-secondary" disabled={refreshing} onClick={() => (proposal ? loadProposalById(proposal.id) : loadPendingProposal())}>
                    Actualiser
                  </button>
                  {!!proposal && (
                    <button
                      className="btn btn-sm btn-outline-secondary"
                      disabled={sendingAlert}
                      onClick={handleOpenSendAlertModal}
                      title="Envoie manuellement l'alerte email aux comptes rattachés à ce magasin, au cas où l'envoi automatique n'aurait pas eu lieu"
                    >
                      <iconify-icon icon="solar:letter-bold-duotone" className="align-middle"></iconify-icon>{' '}
                      {sendingAlert ? 'Envoi...' : 'Envoyer par email'}
                    </button>
                  )}
                  {/* Validation désormais INDÉPENDANTE par rayon (demande du 26/09/2026 : "si je
                      valide 1, il doit être marqué validé, et je peux toujours aller dans les
                      autres") — le bouton n'apparaît que sur la vue détail d'un rayon précis
                      (selectedDepartment défini), jamais depuis la vue Secteurs globale qui n'a
                      plus de sens comme "tout valider en bloc". Masqué si ce rayon a déjà sa
                      propre commande RPOS (currentDepartmentOrder), remplacé par un badge de
                      statut à la place (cf. plus bas dans le rendu). */}
                  {!viewingPastGeneration && proposal && selectedDepartment && !currentDepartmentOrder && (
                    <ValidationFlow
                      proposalId={proposal.id}
                      decisionsProvider={() => proposalTableRef.current?.getDecisionsForDepartment(selectedDepartment) || []}
                      departmentValidation={selectedDepartment}
                      shopName={(isSingleShop ? user?.rposShopName : selectedShop?.name) || ''}
                      shopQueryParam={shopQueryParam()}
                      onValidated={() => {
                        // Contrairement à l'ancien comportement (retour à la vue Secteurs, la
                        // proposition entière étant terminée), un seul rayon vient d'être validé —
                        // les autres restent à traiter. On reste sur cette même vue détail rayon
                        // (elle affichera désormais le badge "validé" à la place du bouton) plutôt
                        // que de renvoyer l'utilisateur ailleurs sans raison.
                        //
                        // Bug trouvé le 27/09/2026 (capture à l'appui : "les autres propositions
                        // disparaissent") : loadPendingProposal() appelle GET /proposal/pending, qui
                        // ne retourne QUE les propositions status=GENERATED (cf.
                        // proposalService.getPendingProposal) — si ce dernier rayon fait basculer
                        // Proposal.status à VALIDATED (tous les rayons avec des articles à commander
                        // ont désormais leur ProposalOrder), cet appel renvoie null et l'écran entier
                        // se vide ("Aucune proposition en attente"), empêchant même de CONSULTER les
                        // autres secteurs/rayons déjà traités. loadProposalById (GET /proposal/:id)
                        // fonctionne quel que soit le statut — la navigation reste possible, la
                        // proposition passe juste en lecture seule (viewingPastGeneration) si elle
                        // est vraiment entièrement terminée, sans jamais faire disparaître l'écran.
                        loadProposalById(proposal.id);
                      }}
                    />
                  )}
                  {currentDepartmentOrder && (
                    <span
                      className={`badge ${currentDepartmentOrder.status === 'DONE' ? 'bg-success' : currentDepartmentOrder.status === 'FAILED' ? 'bg-danger' : 'bg-secondary'}`}
                      title={currentDepartmentOrder.errorMessage || undefined}
                    >
                      <iconify-icon icon="solar:check-circle-bold-duotone" className="align-middle"></iconify-icon>{' '}
                      Rayon validé — commande {currentDepartmentOrder.rposOrderReference || currentDepartmentOrder.rposOrderId || '—'}
                      {currentDepartmentOrder.linesFailed > 0 && ` (${currentDepartmentOrder.linesFailed} article(s) refusé(s))`}
                    </span>
                  )}
                </div>
              </div>

              <div className="card-body">
                {viewingPastGeneration && (
                  <div className="alert alert-warning small mb-3">
                    Génération passée en lecture seule — ne peut pas être validée ni envoyée à RPOS.
                  </div>
                )}
                {supplierCheckLoading && (
                  <p className="small text-muted mb-2">Vérification du rattachement fournisseur...</p>
                )}
                {/* Synthèse commandable/non commandable du rayon (spec du 28/09/2026, §3) — calculée
                    localement depuis les lignes déjà chargées, jamais un appel réseau supplémentaire.
                    Masquée si aucune ligne n'a encore ce champ renseigné (proposition générée avant
                    son ajout) : dans ce cas, l'alerte legacy ci-dessous (supplierIneligible, issue de
                    l'appel /supplier-check) reste le seul repli disponible. */}
                {eligibilitySummary.total > 0 && detailLines.some((l) => l.supplierIneligible !== null && l.supplierIneligible !== undefined) && (
                  <div className={`alert small mb-3 d-flex justify-content-between align-items-center flex-wrap gap-2 ${eligibilitySummary.nonCommandableCount > 0 ? 'alert-warning' : 'alert-light border'}`}>
                    <div>
                      <strong>{eligibilitySummary.total} article(s) dans la proposition de ce rayon</strong>
                      {' — '}
                      <iconify-icon icon="solar:check-circle-bold" className="text-success align-middle"></iconify-icon>{' '}
                      {eligibilitySummary.commandableCount} commandable(s)
                      {eligibilitySummary.nonCommandableCount > 0 && (
                        <>
                          {' · '}
                          <iconify-icon icon="solar:close-circle-bold" className="text-danger align-middle"></iconify-icon>{' '}
                          {eligibilitySummary.nonCommandableCount} non commandable(s)
                        </>
                      )}
                    </div>
                    {eligibilitySummary.nonCommandableCount > 0 && (
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-dark flex-shrink-0"
                        onClick={() =>
                          setSupplierListModal({
                            title: `${eligibilitySummary.nonCommandableCount} article(s) non commandable(s) (non rattachés au fournisseur central)`,
                            items: eligibilitySummary.nonCommandableLines.map((item) => ({ ean: item.ean, label: item.label, currentSuppliers: item.currentSuppliers })),
                          })
                        }
                      >
                        Voir la liste
                      </button>
                    )}
                  </div>
                )}
                {!!supplierIneligible?.length && (
                  <div className="alert alert-warning small mb-3 d-flex justify-content-between align-items-center flex-wrap gap-2">
                    <div>
                      <iconify-icon icon="solar:danger-triangle-bold" className="align-middle me-1"></iconify-icon>
                      <strong>{supplierIneligible.length} article(s) non rattaché(s) au fournisseur central</strong> — risque qu'ils manquent à l'envoi réel de la commande.
                    </div>
                    <button
                      type="button"
                      className="btn btn-sm btn-outline-dark flex-shrink-0"
                      onClick={() =>
                        setSupplierListModal({
                          title: `${supplierIneligible.length} article(s) non rattaché(s) au fournisseur central`,
                          items: supplierIneligible.map((item) => ({ ean: item.ean, label: item.label, currentSuppliers: item.currentSuppliers })),
                        })
                      }
                    >
                      Voir la liste
                    </button>
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
                  onOpenArticleDetail={setArticleDetail}
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

      {supplierListModal && (
        <>
          <div className="modal fade show" style={{ display: 'block' }} tabIndex={-1} role="dialog">
            <div className="modal-dialog modal-dialog-centered modal-lg modal-dialog-scrollable" role="document">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">{supplierListModal.title}</h5>
                  <button type="button" className="btn-close" onClick={() => setSupplierListModal(null)}></button>
                </div>
                <div className="modal-body">
                  {supplierListModal.items.length === 0 ? (
                    <p className="text-muted text-center py-4">Aucun article dans cette catégorie.</p>
                  ) : (
                    <div className="table-responsive">
                      <table className="table table-sm table-hover">
                        <thead>
                          <tr>
                            <th>Article</th>
                            <th>EAN</th>
                            <th>Fournisseur actuel</th>
                          </tr>
                        </thead>
                        <tbody>
                          {supplierListModal.items.map((item) => (
                            <tr key={item.ean}>
                              <td>{item.label || '—'}</td>
                              <td>{item.ean}</td>
                              <td>{item.currentSuppliers || 'aucun'}</td>
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

      {articleDetail && (
        <ArticleDetailModal
          line={articleDetail}
          readOnly={viewingPastGeneration}
          onClose={() => setArticleDetail(null)}
          onUnblock={(l, quantity) => proposalTableRef.current?.unblockLine(l, quantity)}
          onOpenAnalytics={setAnalyticsArticle}
        />
      )}

      {analyticsArticle && (
        <ProductAnalyticsModal article={analyticsArticle} shopQueryParam={shopQueryParam()} onClose={() => setAnalyticsArticle(null)} />
      )}

      {weeklyPlanHistoryOpen && proposal?.weeklyPlanId && (
        <WeeklyPlanHistoryModal weeklyPlanId={proposal.weeklyPlanId} onClose={() => setWeeklyPlanHistoryOpen(false)} />
      )}

      {sendAlertModalOpen && (
        <>
          <div className="modal fade show" style={{ display: 'block' }} tabIndex={-1} role="dialog">
            <div className="modal-dialog" role="document">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">Envoyer l'alerte par email</h5>
                  <button type="button" className="btn-close" onClick={() => setSendAlertModalOpen(false)}></button>
                </div>
                <div className="modal-body">
                  {sendAlertError && <div className="alert alert-danger">{sendAlertError}</div>}
                  {!sendAlertError && sendAlertRecipients === null && <p className="text-muted text-center py-3">Chargement des destinataires...</p>}
                  {sendAlertRecipients?.length === 0 && (
                    <p className="text-muted text-center py-3">Aucun destinataire trouvé pour ce magasin.</p>
                  )}
                  {!!sendAlertRecipients?.length && (
                    <>
                      <p className="small text-muted mb-2">
                        Décochez un destinataire pour l'exclure de cet envoi ({sendAlertRecipients.length - sendAlertExcluded.size} sur{' '}
                        {sendAlertRecipients.length} sélectionné(s)) :
                      </p>
                      <ul className="list-group">
                        {sendAlertRecipients.map((r) => (
                          <li key={r.email} className="list-group-item d-flex justify-content-between align-items-center">
                            <div className="form-check">
                              <input
                                className="form-check-input"
                                type="checkbox"
                                id={`send-alert-recipient-${r.email}`}
                                checked={!sendAlertExcluded.has(r.email)}
                                onChange={() => toggleSendAlertRecipient(r.email)}
                              />
                              <label className="form-check-label" htmlFor={`send-alert-recipient-${r.email}`}>
                                <div className="fw-semibold">{r.name}</div>
                                <div className="small text-muted">{r.email}</div>
                              </label>
                            </div>
                            <span className="badge bg-secondary">{r.role}</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn btn-outline-secondary" onClick={() => setSendAlertModalOpen(false)}>
                    Annuler
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={sendingAlert || !sendAlertRecipients?.length || sendAlertExcluded.size === sendAlertRecipients.length}
                    onClick={handleConfirmSendAlert}
                  >
                    {sendingAlert ? 'Envoi...' : 'Confirmer l\'envoi'}
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show"></div>
        </>
      )}
    </div>
  );
}
