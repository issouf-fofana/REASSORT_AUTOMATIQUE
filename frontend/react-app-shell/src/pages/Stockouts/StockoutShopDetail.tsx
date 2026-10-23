import { useEffect, useState, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { apiFetch } from '../../shared/api/client';
import { StockoutTrendChart } from './StockoutTrendChart';
import { StockoutCauseChart } from './StockoutCauseChart';
import { StockoutDepartmentAnalysis } from './StockoutDepartmentAnalysis';
import { StockoutPeriodAnalysis } from './StockoutPeriodAnalysis';
import { FormulaInfoButton } from './StockoutEpisodePage';

// Détail d'un magasin pour le module Ruptures (demande explicite du 16/10/2026 : "je dois faire
// comme pour les commande, les article son classer par rayon et quand je clique je peux voir les
// article et quand je clique sur un article je peux voir les detail") — même navigation
// hiérarchique Secteur → Rayon → Articles → détail que Proposition de commande (PurchaseOrder.tsx),
// réutilisé à l'identique pour "Ce magasin" (magasin actif topbar) ET le drill-down depuis
// "Tous les magasins" — un seul composant, un seul comportement.
type ReactionStatusLight = 'EN_ATTENTE' | 'RETARD' | 'MAGASIN_NA_PAS_REAGI' | 'REAGI';
type DeliveryStatus = 'SANS_COMMANDE' | 'EN_ATTENTE_LIVRAISON' | 'LIVREE' | 'LIVRAISON_DOUTEUSE' | 'EN_RETARD';

type StockoutEpisode = {
  id: string;
  ean: string;
  label: string | null;
  department: string | null;
  sector: string | null;
  startedAt: string;
  durationHours: number;
  causeProposee: string;
  niveauConfiance: string;
  hasOrder: boolean;
  reactionStatus: ReactionStatusLight;
  caPerdueEstime: number | null;
  qtyPerdueEstimee: number | null;
  sellingPrice: number | null;
  deliveryStatus: DeliveryStatus;
  actualReceptionDate: string | null;
  // Statut brut EN_COURS/RESOLUE (demande explicite du 22/10/2026 : filtre global par statut) —
  // Prisma le renvoie déjà sur chaque épisode (pas de `select` restrictif côté serveur), simplement
  // jamais exposé dans ce type avant.
  status: 'EN_COURS' | 'RESOLUE';
};

type StockoutSummary = {
  openCount: number;
  avgDurationHours: number;
  totalCaPerduEstime: number;
  // CA perdu reventilé par situation de commande (demande explicite du 22/10/2026) — calculés côté
  // serveur sur le même ensemble d'épisodes que totalCaPerduEstime (cf. getDashboardSummary).
  caPerdueSansCommande: number;
  caPerdueNonLivree: number;
  causeCounts: Record<string, number>;
  openEpisodes: StockoutEpisode[];
  totalOrderableArticles: number;
  ruptureRatioPct: number | null;
};

type GroupSummary = { group: string; openCount: number; totalEpisodesCount: number };
type ByFieldSummary = { found: boolean; groupCount: number; groups: GroupSummary[]; message?: string };

// AMONT_FOURNISSEUR_CENTRAL / AMONT_FOURNISSEUR_EXTERNE ajoutés le 21/10/2026 (demande explicite :
// "Amont — ca viens de founisseur central ou du fournisseur externe") — distinguent désormais la
// commande en attente de réception selon ProposalOrder.deliveryType ('LC' = livraison centrale,
// 'LD' = livraison directe/fournisseur externe). AMONT_A_PRECISER reste le repli pour les
// commandes sans deliveryType connu (créées avant ce champ).
const CAUSE_LABELS: Record<string, string> = {
  MAGASIN_REASSORT: 'Magasin / réassort',
  MAGASIN_COMMANDE_NON_VALIDEE: 'Commande non validée',
  AMONT_FOURNISSEUR_CENTRAL: 'Amont — fournisseur central',
  AMONT_FOURNISSEUR_EXTERNE: 'Amont — fournisseur externe',
  AMONT_A_PRECISER: 'Amont — à préciser',
  ECART_STOCK_RAYON: 'Écart stock / rayon',
  INDETERMINEE: 'Indéterminée',
};

// Libellés simplifiés pour le filtre global "Cause" (demande explicite du 22/10/2026 : "ici aussi
// fait les terme simple pour un mag ou dg") — CAUSE_LABELS ci-dessus reste technique/précis pour le
// tableau "Détail par article" (lecteur déjà dans le contexte d'un article précis), mais un DG/
// manager de magasin parcourant juste la liste du filtre ne sait pas ce que "Écart stock / rayon" ou
// "Amont — à préciser" veulent dire concrètement. CAUSE_FILTER_HINTS donne, au survol (title), le
// libellé technique d'origine pour qui en a besoin, sans l'imposer à tout le monde.
const CAUSE_FILTER_LABELS: Record<string, string> = {
  MAGASIN_REASSORT: "Le magasin n'a pas encore commandé",
  MAGASIN_COMMANDE_NON_VALIDEE: 'Commande préparée mais pas validée',
  AMONT_FOURNISSEUR_CENTRAL: 'Livraison en retard — entrepôt central',
  AMONT_FOURNISSEUR_EXTERNE: 'Livraison en retard — fournisseur externe',
  AMONT_A_PRECISER: 'Livraison en retard — origine à préciser',
  ECART_STOCK_RAYON: 'Stock informatique faux (produit en rayon ou pas)',
  INDETERMINEE: 'Cause non déterminée',
};

// Colonne "Réaction" + filtre (demande explicite du 17/10/2026 : "on doit voir... qui son en
// rupture et qui on une commande qui a ete passe dessu et ceux qui son en rupture et il ya pas de
// commande dessu") — version légère de REACTION_STATUS_META (StockoutEpisodePage.tsx), sans
// STOCK_PEUT_ETRE_PAS_A_JOUR (nécessite les ventes pendant l'épisode, pas calculé en masse ici).
const REACTION_LIGHT_META: Record<ReactionStatusLight, { label: string; badge: string }> = {
  REAGI: { label: 'Commande passée', badge: 'reassort-badge-soft-success' },
  EN_ATTENTE: { label: 'En attente (< 24h)', badge: 'reassort-badge-neutral' },
  RETARD: { label: 'Retard (24-48h)', badge: 'reassort-badge-soft-warning' },
  MAGASIN_NA_PAS_REAGI: { label: 'Sans commande (> 48h)', badge: 'reassort-badge-soft-danger' },
};

// Statut de livraison (demande explicite du 17/10/2026 : "l'autre ou ya commande mais pas encore
// livré ou il ya pas encore arrivage sur rpos pour metre a jour le stock") — distinct de
// reactionStatus (qui ne dit que "une commande a-t-elle été passée ?"), ce statut-ci suit la vie de
// la commande jusqu'à sa réception (RECUE_ESTIMEE côté RPOS — une estimation, jamais une
// confirmation certaine, cf. ProposalOrder.receptionStatus dans schema.prisma).
//
// "Livrée" renommé en "Livraison estimée" + LIVRAISON_DOUTEUSE ajouté le 18/10/2026 (bug signalé
// avec capture : badge "Livrée" affiché alors que la fiche détail montre "compteur toujours actif"
// et aucun mouvement de réception — "il me dis les quantité livré or si je vais dessu le temps de
// rupture continue de compté"). "Livrée" affirmait une certitude que RECUE_ESTIMEE ne garantit
// jamais ; LIVRAISON_DOUTEUSE signale explicitement quand la date de réception estimée est déjà
// passée alors que l'épisode est toujours ouvert (calculé côté serveur, cf. stockoutEpisodeService.js).
// EN_RETARD ajouté le 18/10/2026 (demande explicite : "si non pas recu soit ca peux etre le 12 donc
// 2j ca peux etre expliqué mais 3j il faut avoir des explication donc on doit nous dire que la
// livrasion est en retart") — commande passée, receptionStatus pas encore RECUE_ESTIMEE, et la date
// de livraison ATTENDUE (règle 14h/week-end, cf. computeExpectedReceptionDate côté serveur) est
// dépassée d'au moins 2 jours : un simple "pas encore livré" ne suffit plus, l'écart n'est plus
// explicable par un aléa logistique normal.
const DELIVERY_STATUS_META: Record<DeliveryStatus, { label: string; badge: string }> = {
  SANS_COMMANDE: { label: 'Sans commande', badge: 'reassort-badge-neutral' },
  EN_ATTENTE_LIVRAISON: { label: 'Commandé, pas livré', badge: 'reassort-badge-soft-warning' },
  EN_RETARD: { label: 'Livraison en retard', badge: 'reassort-badge-soft-danger' },
  LIVREE: { label: 'Livraison estimée', badge: 'reassort-badge-soft-success' },
  LIVRAISON_DOUTEUSE: { label: 'Livraison douteuse', badge: 'reassort-badge-soft-danger' },
};

// Même table que DELIVERY_STATUS_TO_CAUSE côté serveur (stockoutEpisodeService.js) — BUG CORRIGÉ
// le 23/10/2026 (signalé avec capture : donut "Ruptures avec ou sans commande" affichait 100%
// "Sans commande" alors que le filtre global actif était justement "Avec commande en cours") :
// displayedCauseCounts groupait par e.causeProposee, un champ STOCKÉ au moment de la détection de
// la rupture et jamais réévalué — un épisode EN_COURS ayant reçu une commande APRÈS sa détection
// reste étiqueté MAGASIN_REASSORT pour toujours côté causeProposee, désynchronisé du vrai
// hasOrder/deliveryStatus (recalculés dynamiquement à chaque lecture). Pour un épisode RESOLUE, où
// plus rien ne peut changer, causeProposee reste un instantané historique valide.
const DELIVERY_STATUS_TO_CAUSE: Record<DeliveryStatus, string> = {
  SANS_COMMANDE: 'MAGASIN_REASSORT',
  EN_ATTENTE_LIVRAISON: 'AMONT_A_PRECISER',
  EN_RETARD: 'AMONT_A_PRECISER',
  LIVREE: 'ECART_STOCK_RAYON',
  LIVRAISON_DOUTEUSE: 'ECART_STOCK_RAYON',
};

type OrderFilter = 'all' | 'with-order' | 'without-order' | 'delivered';

// Tous les filtres possibles sur la liste d'articles d'un rayon (demande explicite du 21/10/2026 :
// "sur rupture il faut affiché tout les filtre possible... ajoute tout ce qui est filtrable") —
// en plus du filtre commande déjà présent, ajoute recherche texte, cause, réaction, livraison, et
// des plages min/max sur durée/prix/quantité perdue/CA perdu. Même pattern que OverstockReport.tsx
// (rangeFilters + panneau "Filtres avancés" dépliable) pour rester cohérent avec le reste de l'app.
// Tout filtré côté client sur articlesInDepartmentAll déjà chargé, pas de nouvel appel réseau.
type RangeFilterKey = 'durationHours' | 'sellingPrice' | 'qtyPerdueEstimee' | 'caPerdueEstime';

function formatDuration(hours: number): string {
  if (hours < 24) return `${Math.round(hours)} h`;
  const days = Math.floor(hours / 24);
  const rest = Math.round(hours % 24);
  return `${days} j ${rest} h`;
}

// Durée live depuis startedAt plutôt que le durationHours figé renvoyé au chargement — avec
// setMinuteTick en dépendance de rendu, cette valeur se recalcule à chaque tick (demande explicite
// du 17/10/2026 : "le user doit voir compté").
function liveDurationHours(startedAt: string): number {
  return (Date.now() - new Date(startedAt).getTime()) / (60 * 60 * 1000);
}

// Dropdown à cases à cocher pour les filtres globaux (demande explicite du 22/10/2026 : "les
// filtres il me donne posibilté de choisir plusieur ou 1 tu vois ?") — composant maison plutôt
// qu'un <select multiple> natif, dont l'UI (liste figée sans scroll contrôlé, sélection au
// ctrl+clic non découvrable) est peu praticable sur un formulaire de filtres. Un click en dehors du
// menu le referme (évite qu'il reste ouvert indéfiniment en changeant de filtre ou en scrollant).
function MultiSelectFilter({
  icon,
  placeholder,
  options,
  selected,
  onChange,
  title,
}: {
  icon: string;
  placeholder: string;
  options: { value: string; label: string; title?: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  function toggleValue(value: string) {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  }

  // 1-2 valeurs cochées : leurs libellés tiennent dans le bouton sans le faire déborder. Au-delà,
  // un compteur reste plus lisible qu'une liste qui s'allonge indéfiniment ("5 sélectionnés").
  const buttonLabel = selected.length === 0
    ? placeholder
    : selected.length <= 2
      ? selected.map((v) => options.find((o) => o.value === v)?.label || v).join(', ')
      : `${selected.length} sélectionné(s)`;

  return (
    <div className={`sof-global-filter-group sof-ms-root${selected.length ? ' active' : ''}`} ref={rootRef} title={title}>
      <iconify-icon icon={icon}></iconify-icon>
      <button type="button" className="sof-global-filter sof-ms-trigger" onClick={() => setOpen((v) => !v)}>
        {buttonLabel}
        <iconify-icon icon={open ? 'solar:alt-arrow-up-linear' : 'solar:alt-arrow-down-linear'} style={{ fontSize: 12, marginLeft: 6 }}></iconify-icon>
      </button>
      {open && (
        <div className="sof-ms-menu">
          {options.map((opt) => (
            <label key={opt.value} className="sof-ms-option" title={opt.title}>
              <input type="checkbox" checked={selected.includes(opt.value)} onChange={() => toggleValue(opt.value)} />
              {opt.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export function StockoutShopDetail({ shopQueryParam }: { shopQueryParam: string }) {
  const navigate = useNavigate();
  // Secteur/rayon sélectionnés reflétés dans l'URL (?sector=&dept=), pas seulement en state local —
  // demande explicite du 17/10/2026 : "quand je fait un retour [depuis la fiche d'une rupture] il
  // m'nevoi sur les Secteurs au debut or il doit m'envoyer dans les rayon" — le bouton Retour de
  // StockoutEpisodePage.tsx pointe vers cette URL précise (via ?from=), donc l'état de navigation
  // doit survivre à un remontage du composant, ce qu'un simple useState ne permet pas.
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedSector, setSelectedSectorState] = useState<string | null>(() => searchParams.get('sector'));
  const [selectedDepartment, setSelectedDepartmentState] = useState<string | null>(() => searchParams.get('dept'));

  function setSelectedSector(sector: string | null) {
    setSelectedSectorState(sector);
    setSelectedDepartmentState(null);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (sector) next.set('sector', sector); else next.delete('sector');
      next.delete('dept');
      return next;
    }, { replace: true });
  }

  function setSelectedDepartment(dept: string | null) {
    setSelectedDepartmentState(dept);
    setOrderFilter('all');
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (dept) next.set('dept', dept); else next.delete('dept');
      return next;
    }, { replace: true });
  }

  const [summary, setSummary] = useState<StockoutSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bySector, setBySector] = useState<ByFieldSummary | null>(null);
  const [byDepartment, setByDepartment] = useState<ByFieldSummary | null>(null);
  // Graphes affichés par défaut (demande explicite du 18/10/2026 : "affiche le graph par defaut et
  // donne la possibilité de masque") — inversé depuis la version précédente, repliée par défaut.
  const [showCharts, setShowCharts] = useState(true);
  // Période unique pilotant à la fois le graphe de tendance et l'analyse des pertes (demande
  // explicite du 18/10/2026 : "le filtre il faut aiffché en haut et le filtre doit etre pour tout
  // a emme temps... ne donne pas un filtre par detaut qui n'est pas modifialbe") — remplace les
  // deux systèmes de dates séparés et incohérents qui existaient avant (graphe figé à 30 jours,
  // sélecteur propre à StockoutPeriodAnalysis plus bas sur la page).
  const [periodStart, setPeriodStart] = useState(() => new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  const [periodEnd, setPeriodEnd] = useState(() => new Date().toISOString().slice(0, 10));
  // Filtres GLOBAUX (demande explicite du 22/10/2026 : "ajoute plusieur type de filtre en fonction
  // des donner" — Statut, Rayon/Secteur, Avec/Sans commande, Cause) appliqués à toute la page
  // "Situation actuelle" (KPI + donut causes), AVANT le drill-down Secteur → Rayon → Articles. Jamais
  // de nouvel appel réseau : filtrent côté client sur summary.openEpisodes déjà chargé en mémoire
  // (même principe que orderFilter/causeFilter ci-dessous, qui eux ne s'appliquent qu'UNE FOIS entré
  // dans un rayon précis — ces filtres globaux agissent un cran plus haut).
  // Multi-sélection (demande explicite du 22/10/2026 : "les filtres il me donne posibilté de
  // choisir plusieur ou 1") — tableau vide = aucune restriction ("tous"), comme le '' précédent.
  const [globalStatusFilter, setGlobalStatusFilter] = useState<string[]>([]);
  const [globalSectorFilter, setGlobalSectorFilter] = useState<string[]>([]);
  const [globalDepartmentFilter, setGlobalDepartmentFilter] = useState<string[]>([]);
  const [globalOrderFilter, setGlobalOrderFilter] = useState<string[]>([]);
  const [globalCauseFilter, setGlobalCauseFilter] = useState<string[]>([]);
  const activeGlobalFilterCount =
    (globalStatusFilter.length ? 1 : 0) + (globalSectorFilter.length ? 1 : 0) + (globalDepartmentFilter.length ? 1 : 0) +
    (globalOrderFilter.length ? 1 : 0) + (globalCauseFilter.length ? 1 : 0);
  function clearGlobalFilters() {
    setGlobalStatusFilter([]);
    setGlobalSectorFilter([]);
    setGlobalDepartmentFilter([]);
    setGlobalOrderFilter([]);
    setGlobalCauseFilter([]);
  }
  const [orderFilter, setOrderFilter] = useState<OrderFilter>('all');
  const [articleSearch, setArticleSearch] = useState('');
  const [causeFilter, setCauseFilter] = useState<string>('');
  const [reactionFilter, setReactionFilter] = useState<string>('');
  const [deliveryFilter, setDeliveryFilter] = useState<string>('');
  const [rangeFiltersOpen, setRangeFiltersOpen] = useState(false);
  const [rangeFilters, setRangeFilters] = useState<Record<RangeFilterKey, { min: string; max: string }>>({
    durationHours: { min: '', max: '' },
    sellingPrice: { min: '', max: '' },
    qtyPerdueEstimee: { min: '', max: '' },
    caPerdueEstime: { min: '', max: '' },
  });
  function setRangeFilter(key: RangeFilterKey, side: 'min' | 'max', value: string) {
    setRangeFilters((prev) => ({ ...prev, [key]: { ...prev[key], [side]: value } }));
  }
  function clearAllArticleFilters() {
    setOrderFilter('all');
    setArticleSearch('');
    setCauseFilter('');
    setReactionFilter('');
    setDeliveryFilter('');
    setRangeFilters({
      durationHours: { min: '', max: '' },
      sellingPrice: { min: '', max: '' },
      qtyPerdueEstimee: { min: '', max: '' },
      caPerdueEstime: { min: '', max: '' },
    });
  }
  const activeRangeFilterCount = Object.values(rangeFilters).filter((r) => r.min !== '' || r.max !== '').length;
  const activeExtraFilterCount = activeRangeFilterCount + (causeFilter ? 1 : 0) + (reactionFilter ? 1 : 0) + (deliveryFilter ? 1 : 0) + (articleSearch.trim() ? 1 : 0);
  // Tri croissant/décroissant du tableau "Détail par article" (demande explicite du 21/10/2026 :
  // "sur tout les tableau il faut ajouter la possibilité de filtrer par croissant ou decroissant").
  const [articleSortField, setArticleSortField] = useState<'label' | 'startedAt' | 'duration' | 'sellingPrice' | 'qtyPerdueEstimee' | 'caPerdueEstime' | null>(null);
  const [articleSortDir, setArticleSortDir] = useState<'asc' | 'desc'>('desc');
  function toggleArticleSort(field: typeof articleSortField) {
    if (articleSortField === field) setArticleSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setArticleSortField(field); setArticleSortDir('desc'); }
  }
  function articleSortIcon(field: typeof articleSortField) {
    if (articleSortField !== field) return null;
    return <iconify-icon icon={articleSortDir === 'desc' ? 'solar:alt-arrow-down-linear' : 'solar:alt-arrow-up-linear'} style={{ fontSize: '11px', marginLeft: 4 }}></iconify-icon>;
  }
  // Rafraîchit la colonne Durée affichée en live (demande explicite du 17/10/2026 : "le user doit
  // voir compté") — toutes les minutes plutôt que chaque seconde comme sur la fiche détail : des
  // centaines de lignes potentielles ici, un tick seconde serait un gaspillage de rendu sans valeur
  // perceptible (la colonne n'affiche jamais les secondes).
  const [, setMinuteTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setMinuteTick((v) => v + 1), 60000);
    return () => clearInterval(interval);
  }, []);

  const mountRef = useRef(true);
  // Détecte un vrai CHANGEMENT de magasin (sélecteur topbar) par opposition au premier montage —
  // dans ce cas seulement, la sélection secteur/rayon restaurée depuis l'URL doit être réinitialisée
  // (un rayon de l'ancien magasin n'a pas de sens pour le nouveau).
  const prevShopQueryParamRef = useRef(shopQueryParam);

  // Résumé complet (KPI, graphes, articles) : chargé une fois par magasin, le reste navigue dedans
  // côté client, sans nouvel appel API par clic.
  useEffect(() => {
    if (!shopQueryParam) return;
    let cancelled = false;
    setSummary(null);
    setError(null);
    if (prevShopQueryParamRef.current && prevShopQueryParamRef.current !== shopQueryParam) {
      setSelectedSector(null);
      setSelectedDepartment(null);
    }
    prevShopQueryParamRef.current = shopQueryParam;
    mountRef.current = true;
    // start/end ajoutés le 20/10/2026 (demande explicite : "quand je fait un filtre il doit etre
    // appliqué sur tout") — avant ce correctif, ce KPI restait figé sur l'état courant peu importe
    // la période choisie en haut de page, incohérent avec le graphe de tendance et l'analyse des
    // pertes qui, eux, suivaient déjà periodStart/periodEnd. Même format ISO que
    // StockoutTrendChart/StockoutPeriodAnalysis (fin de journée incluse via T23:59:59).
    const periodParams = `start=${encodeURIComponent(new Date(periodStart).toISOString())}&end=${encodeURIComponent(new Date(periodEnd + 'T23:59:59').toISOString())}`;
    apiFetch<StockoutSummary>(`/reassort/stockout-episodes?${periodParams}&${shopQueryParam}`)
      .then((data) => { if (!cancelled && mountRef.current) setSummary(data); })
      .catch((err) => { if (!cancelled && mountRef.current) setError(err instanceof Error ? err.message : String(err)); });
    return () => {
      cancelled = true;
      mountRef.current = false;
    };
  }, [shopQueryParam, periodStart, periodEnd]);

  // Niveau Secteurs : chargé une fois par magasin, et rechargé à chaque changement de période
  // (même correctif que ci-dessus — demande explicite du 20/10/2026).
  // (bug corrigé le 18/10/2026 : ce useEffect était dupliqué deux fois à l'identique, doublant
  // inutilement l'appel réseau vers /by-sector à chaque chargement de la page.)
  useEffect(() => {
    if (!shopQueryParam) return;
    let cancelled = false;
    setBySector(null);
    const periodParams = `start=${encodeURIComponent(new Date(periodStart).toISOString())}&end=${encodeURIComponent(new Date(periodEnd + 'T23:59:59').toISOString())}`;
    apiFetch<ByFieldSummary>(`/reassort/stockout-episodes/by-sector?${periodParams}&${shopQueryParam}`)
      .then((data) => { if (!cancelled) setBySector(data); })
      .catch(() => { /* non bloquant : la liste d'articles reste consultable sans ce niveau */ });
    return () => { cancelled = true; };
  }, [shopQueryParam, periodStart, periodEnd]);

  // Niveau Rayons : rechargé à chaque changement de secteur sélectionné OU de période.
  useEffect(() => {
    if (!shopQueryParam || !selectedSector) { setByDepartment(null); return; }
    let cancelled = false;
    setByDepartment(null);
    const sectorParam = selectedSector === 'Sans secteur' ? '__none__' : selectedSector;
    const periodParams = `start=${encodeURIComponent(new Date(periodStart).toISOString())}&end=${encodeURIComponent(new Date(periodEnd + 'T23:59:59').toISOString())}`;
    apiFetch<ByFieldSummary>(`/reassort/stockout-episodes/by-department?sector=${encodeURIComponent(sectorParam)}&${periodParams}&${shopQueryParam}`)
      .then((data) => { if (!cancelled) setByDepartment(data); })
      .catch(() => { /* non bloquant */ });
    return () => { cancelled = true; };
  }, [shopQueryParam, selectedSector, periodStart, periodEnd]);

  // Filtres globaux appliqués sur l'ensemble des épisodes chargés (demande explicite du 22/10/2026)
  // — source commune pour les KPI "Situation actuelle" ET le drill-down Secteur → Rayon → Articles
  // juste en dessous, pour qu'un filtre actif (ex: "Sans commande") se reflète partout sur la page,
  // pas seulement sur les cartes du haut.
  const globallyFilteredEpisodes = (summary?.openEpisodes || []).filter((e) => {
    if (globalStatusFilter.length && !globalStatusFilter.includes(e.status)) return false;
    if (globalSectorFilter.length && !globalSectorFilter.includes(e.sector || 'Sans secteur')) return false;
    if (globalDepartmentFilter.length && !globalDepartmentFilter.includes(e.department || 'Sans rayon')) return false;
    if (globalOrderFilter.length) {
      const orderKey = e.hasOrder ? 'with-order' : 'without-order';
      if (!globalOrderFilter.includes(orderKey)) return false;
    }
    if (globalCauseFilter.length && !globalCauseFilter.includes(e.causeProposee)) return false;
    return true;
  });
  // Liste des rayons/secteurs distincts pour peupler les <select> des filtres globaux — dérivée de
  // summary.openEpisodes (pas filtrée par globallyFilteredEpisodes elle-même, sinon un filtre actif
  // ferait disparaître sa propre option de la liste déroulante).
  const allSectorsForFilter = Array.from(new Set((summary?.openEpisodes || []).map((e) => e.sector || 'Sans secteur'))).sort((a, b) => a.localeCompare(b, 'fr-FR'));
  const allDepartmentsForFilter = Array.from(new Set((summary?.openEpisodes || []).map((e) => e.department || 'Sans rayon'))).sort((a, b) => a.localeCompare(b, 'fr-FR'));
  // Recalcul des KPI "Situation actuelle" sur l'ensemble filtré quand au moins un filtre global est
  // actif — sinon on garde les valeurs déjà précalculées côté serveur (summary.openCount etc.),
  // identiques à celles qu'on obtiendrait en filtrant ici sans rien exclure, mais sans refaire le
  // travail pour rien dans le cas (le plus fréquent) où aucun filtre global n'est utilisé.
  const displayedOpenCount = activeGlobalFilterCount > 0 ? globallyFilteredEpisodes.length : (summary?.openCount ?? 0);
  const displayedTotalCaPerdu = activeGlobalFilterCount > 0
    ? globallyFilteredEpisodes.reduce((sum, e) => sum + (e.caPerdueEstime || 0), 0)
    : (summary?.totalCaPerduEstime ?? 0);
  const displayedCaPerdueSansCommande = activeGlobalFilterCount > 0
    ? globallyFilteredEpisodes.filter((e) => e.deliveryStatus === 'SANS_COMMANDE').reduce((sum, e) => sum + (e.caPerdueEstime || 0), 0)
    : (summary?.caPerdueSansCommande ?? 0);
  const displayedCaPerdueNonLivree = activeGlobalFilterCount > 0
    ? globallyFilteredEpisodes.filter((e) => ['EN_ATTENTE_LIVRAISON', 'EN_RETARD', 'LIVRAISON_DOUTEUSE'].includes(e.deliveryStatus)).reduce((sum, e) => sum + (e.caPerdueEstime || 0), 0)
    : (summary?.caPerdueNonLivree ?? 0);
  const displayedCauseCounts = activeGlobalFilterCount > 0
    ? globallyFilteredEpisodes.reduce((acc: Record<string, number>, e) => {
        const cause = e.status === 'RESOLUE' ? e.causeProposee : (DELIVERY_STATUS_TO_CAUSE[e.deliveryStatus] || 'INDETERMINEE');
        acc[cause] = (acc[cause] || 0) + 1;
        return acc;
      }, {})
    : (summary?.causeCounts ?? {});
  // BUG CORRIGÉ le 22/10/2026 (signalé : "Durée moyenne ne change pas" quand un filtre global est
  // actif) — oublié lors de l'ajout des filtres globaux : seuls openCount/totalCaPerdu/causeCounts
  // avaient leur variante "displayed", pas avgDurationHours, qui restait donc toujours la moyenne
  // calculée côté serveur sur TOUS les épisodes de la période, peu importe le filtre choisi.
  const displayedAvgDurationHours = activeGlobalFilterCount > 0
    ? (globallyFilteredEpisodes.length
        ? globallyFilteredEpisodes.reduce((sum, e) => sum + e.durationHours, 0) / globallyFilteredEpisodes.length
        : 0)
    : (summary?.avgDurationHours ?? 0);

  // BUG CORRIGÉ le 18/10/2026 (signalé avec capture : "sans rayon affiche mais ya rien mais dans
  // le clique il ya contenu" — en réalité l'inverse : la tuile "0 article(s)" était correcte, la
  // liste qui s'affichait au clic (77 articles) était FAUSSE) : ce filtre ne tenait compte QUE du
  // rayon sélectionné, jamais du secteur — un clic sur "EPICERIE SUCREE" sous "Sans secteur"
  // affichait donc TOUS les articles EPICERIE SUCREE du magasin, y compris ceux ayant un vrai
  // secteur connu, au lieu des seuls articles réellement "Sans secteur" de ce rayon (0 ici).
  // Part désormais de globallyFilteredEpisodes (22/10/2026) au lieu de summary.openEpisodes brut,
  // pour que les filtres globaux du haut de page s'appliquent aussi au drill-down.
  const articlesInDepartmentAll = selectedDepartment
    ? globallyFilteredEpisodes.filter((e) =>
        (e.department || 'Sans rayon') === selectedDepartment &&
        (e.sector || 'Sans secteur') === (selectedSector || 'Sans secteur')
      )
    : [];
  const articlesInDepartment = articlesInDepartmentAll.filter((e) => {
    if (orderFilter === 'with-order' && !e.hasOrder) return false;
    if (orderFilter === 'without-order' && e.hasOrder) return false;
    if (orderFilter === 'delivered' && e.deliveryStatus !== 'LIVREE') return false;
    if (causeFilter && e.causeProposee !== causeFilter) return false;
    if (reactionFilter && e.reactionStatus !== reactionFilter) return false;
    if (deliveryFilter && e.deliveryStatus !== deliveryFilter) return false;
    const q = articleSearch.trim().toLowerCase();
    if (q && !(e.label || '').toLowerCase().includes(q) && !e.ean.includes(q)) return false;
    const checks: [number | null, { min: string; max: string }][] = [
      [liveDurationHours(e.startedAt), rangeFilters.durationHours],
      [e.sellingPrice, rangeFilters.sellingPrice],
      [e.qtyPerdueEstimee, rangeFilters.qtyPerdueEstimee],
      [e.caPerdueEstime, rangeFilters.caPerdueEstime],
    ];
    for (const [value, range] of checks) {
      if (range.min !== '' && (value === null || value < Number(range.min))) return false;
      if (range.max !== '' && (value === null || value > Number(range.max))) return false;
    }
    return true;
  });
  const sortedArticlesInDepartment = (() => {
    if (!articleSortField) return articlesInDepartment;
    const dir = articleSortDir === 'desc' ? 1 : -1;
    const getValue = (e: typeof articlesInDepartment[number]): number | string => {
      switch (articleSortField) {
        case 'label': return (e.label || e.ean).toLowerCase();
        case 'startedAt': return new Date(e.startedAt).getTime();
        case 'duration': return liveDurationHours(e.startedAt);
        case 'sellingPrice': return e.sellingPrice ?? -Infinity;
        case 'qtyPerdueEstimee': return e.qtyPerdueEstimee ?? -Infinity;
        case 'caPerdueEstime': return e.caPerdueEstime ?? -Infinity;
      }
    };
    return [...articlesInDepartment].sort((a, b) => {
      const av = getValue(a);
      const bv = getValue(b);
      if (typeof av === 'string' || typeof bv === 'string') return dir * String(bv).localeCompare(String(av), 'fr-FR');
      return dir * (bv - av);
    });
  })();
  const withOrderCount = articlesInDepartmentAll.filter((e) => e.hasOrder).length;
  const withoutOrderCount = articlesInDepartmentAll.length - withOrderCount;
  const deliveredCount = articlesInDepartmentAll.filter((e) => e.deliveryStatus === 'LIVREE').length;

  const showArticleList = !!selectedSector && !!selectedDepartment;

  return (
    <div>
      <style>{`
        .stockout-mini-kpi { border: 1px solid rgba(27,42,74,.08); border-radius: 8px; padding: 10px 14px; background: #fff; display: flex; align-items: center; gap: 10px; }
        .stockout-mini-kpi .icon { width: 30px; height: 30px; border-radius: 7px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; font-size: 15px; }
        .stockout-mini-kpi .label { font-size: .68rem; color: #8591A0; text-transform: uppercase; letter-spacing: .04em; font-weight: 600; line-height: 1.2; }
        .stockout-mini-kpi .value { font-size: 1.15rem; font-weight: 700; color: #1B2A4A; line-height: 1.1; }
        .stockout-mini-kpi .sub { font-size: .7rem; color: #8591A0; margin-top: 2px; }
        .stockout-toggle-charts { font-size: .76rem; color: #5B6B85; background: none; border: none; display: inline-flex; align-items: center; gap: 4px; padding: 0; }
        .stockout-toggle-charts:hover { color: #1B2A4A; }
        .stockout-section-title { font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #8591A0; margin: 20px 0 10px; padding-top: 10px; border-top: 1px solid rgba(27,42,74,.08); }
        .stockout-section-title:first-of-type { margin-top: 0; padding-top: 0; border-top: none; }
        .stockout-period-filter-card { background: #fff; border: 1px solid rgba(27,42,74,.08); border-radius: 8px; padding: 12px 16px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 14px; }
        .stockout-period-filter-icon { width: 30px; height: 30px; border-radius: 7px; background: rgba(27,42,74,.05); display: flex; align-items: center; justify-content: center; font-size: 15px; color: #5B6B85; flex-shrink: 0; }
        .stockout-period-preset { border: 1px solid rgba(27,42,74,.12); background: #fff; color: #5B6B85; font-size: .76rem; font-weight: 600; padding: 5px 12px; border-radius: 6px; transition: background .15s, color .15s, border-color .15s; }
        .stockout-period-preset:hover { background: #F6F8FB; color: #1B2A4A; border-color: rgba(27,42,74,.2); }
        .sof-filter-card { background: #fff; border: 1px solid rgba(27,42,74,.08); border-radius: 12px; padding: 16px 18px; }
        .sof-pill-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; padding-bottom: 14px; border-bottom: 1px dashed rgba(27,42,74,.08); }
        .sof-pill { border: 1px solid rgba(27,42,74,.12); background: #fff; color: #5B6B85; font-size: .8rem; font-weight: 600; padding: 6px 13px; border-radius: 20px; display: inline-flex; align-items: center; gap: 6px; cursor: pointer; transition: background .15s, color .15s, border-color .15s; }
        .sof-pill:hover { background: #F6F8FB; color: #1B2A4A; }
        .sof-pill.active { background: #1B2A4A; color: #fff; border-color: #1B2A4A; }
        .sof-pill-count { font-size: .72rem; font-weight: 700; opacity: .75; }
        .sof-filter-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
        .sof-input { border: 1px solid rgba(27,42,74,.12); border-radius: 6px; font-size: .8rem; padding: 6px 10px; color: #1B2A4A; background: #fff; }
        .sof-input:focus { outline: none; border-color: rgba(27,42,74,.3); box-shadow: 0 0 0 3px rgba(27,42,74,.06); }
        .sof-search-wrap { position: relative; }
        .sof-search-icon { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: #B6BFCF; font-size: 14px; pointer-events: none; }
        .sof-search-input { width: 240px; padding-left: 30px; }
        .sof-adv-filter-btn { border: 1px solid rgba(27,42,74,.1); background: #FAFBFD; color: #5B6B85; font-size: .8rem; font-weight: 600; padding: 6px 13px; border-radius: 20px; display: inline-flex; align-items: center; gap: 7px; cursor: pointer; transition: background .15s, color .15s, border-color .15s; }
        .sof-adv-filter-btn:hover { background: #F0F3F9; color: #1B2A4A; }
        .sof-adv-filter-btn.active { background: rgba(36,86,166,.08); color: #2456A6; border-color: rgba(36,86,166,.25); }
        .sof-clear-btn { border: none; background: none; color: #B8302C; font-size: .78rem; font-weight: 600; display: inline-flex; align-items: center; gap: 5px; cursor: pointer; padding: 6px 10px; border-radius: 20px; transition: background .15s; }
        .sof-clear-btn:hover { background: rgba(214,69,65,.08); }
        /* Filtres globaux (22/10/2026, demande explicite : "il faut personalisé les filtre") —
           version agrandie/espacée du .sof-input ci-dessus (lui conservé tel quel, réutilisé ailleurs
           sur cette page pour le panneau "Détail par article" plus compact) avec une icône dédiée par
           filtre pour les distinguer d'un coup d'œil, plutôt qu'une rangée de <select> identiques. */
        .sof-global-filter-group { display: flex; align-items: center; gap: 8px; background: #F6F8FB; border: 1px solid rgba(27,42,74,.08); border-radius: 10px; padding: 4px 6px 4px 12px; transition: background .15s, border-color .15s; }
        .sof-global-filter-group:hover { border-color: rgba(27,42,74,.18); }
        .sof-global-filter-group.active { background: rgba(36,86,166,.07); border-color: rgba(36,86,166,.3); }
        .sof-global-filter-group.active iconify-icon { color: #2456A6; }
        .sof-global-filter-group iconify-icon { font-size: 16px; color: #5B6B85; flex-shrink: 0; }
        .sof-global-filter { border: none; background: none; font-size: .86rem; font-weight: 600; padding: 9px 6px; color: #1B2A4A; min-width: 150px; cursor: pointer; }
        .sof-global-filter:focus { outline: none; }
        .sof-global-filter-group.active .sof-global-filter { color: #2456A6; }
        .sof-ms-root { position: relative; }
        .sof-ms-trigger { display: inline-flex; align-items: center; white-space: nowrap; }
        .sof-ms-menu { position: absolute; top: calc(100% + 6px); left: 0; z-index: 20; background: #fff; border: 1px solid rgba(27,42,74,.12); border-radius: 10px; box-shadow: 0 8px 24px rgba(27,42,74,.12); padding: 6px; min-width: 240px; max-height: 280px; overflow-y: auto; }
        .sof-ms-option { display: flex; align-items: center; gap: 8px; padding: 7px 9px; border-radius: 6px; font-size: .82rem; color: #1B2A4A; cursor: pointer; white-space: nowrap; }
        .sof-ms-option:hover { background: #F6F8FB; }
        .sof-ms-option input { margin: 0; cursor: pointer; }
        .sof-range-panel { margin-top: 14px; padding-top: 14px; border-top: 1px dashed rgba(27,42,74,.08); display: flex; align-items: flex-end; gap: 24px; flex-wrap: wrap; }
        .sof-range-field { display: flex; flex-direction: column; gap: 6px; }
        .sof-range-label { font-size: .72rem; font-weight: 600; color: #8591A0; text-transform: uppercase; letter-spacing: .02em; }
      `}</style>

      {/* Organisation de la page revue le 18/10/2026 (demande explicite : "il faut mettre en haut
          tu vois c'est trop caché... donne moi une organisation du dash... bien placé... affiché en
          vrac un coup") — ordre de lecture du dashboard, du plus synthétique/stratégique vers le
          plus détaillé/opérationnel :
          1. Analyse de période + IA (filtres de date tout en haut, visibles sans scroll)
          2. KPI instantanés (situation "maintenant")
          3. Graphes (tendance + causes, masquables)
          4. Analyse par rayon (priorisation)
          5. Navigation Secteur → Rayon → Articles (détail opérationnel, en bas) */}
      {error ? (
        <div className="text-danger small mb-3">Erreur : {error}</div>
      ) : !mountRef.current ? null :
      summary === null ? (
        <div className="text-muted small mb-3">Chargement des données de rupture...</div>
      ) : (
        <>
          {/* Filtre de période UNIQUE, en haut de page, modifiable (demande explicite du
              18/10/2026 : "le filtre il faut aiffché en haut et le filtre doit etre pour tout a
              emme temps tu vois ne donne pas un filtre par detaut qui n'est pas modifialbe comme
              Ruptures en cours — 30 derniers jours") — pilote à la fois le graphe de tendance et
              l'analyse des pertes plus bas, qui utilisaient auparavant deux systèmes de dates
              séparés et incohérents (l'un figé à 30j, l'autre son propre sélecteur). */}
          {/* Habillage visuel ajouté le 19/10/2026 (demande explicite : "le haut est vide il faut
              fait un jolie style pour comblet le vide") — le bandeau nu (juste un label + 2 champs
              date) laissait un grand espace blanc sous l'onglet "Ce magasin". Transformé en une
              vraie carte avec icône, fond distinct et des raccourcis de période courants, pour
              occuper l'espace utilement plutôt que de le combler avec de la décoration gratuite. */}
          <div className="stockout-period-filter-card mb-3">
            <div className="d-flex align-items-center gap-2">
              <span className="stockout-period-filter-icon">
                <iconify-icon icon="solar:calendar-bold-duotone"></iconify-icon>
              </span>
              <div>
                <div className="fw-semibold" style={{ color: '#1B2A4A', fontSize: '.88rem' }}>Période affichée sur cette page</div>
                <div className="text-muted" style={{ fontSize: '.74rem' }}>Pilote le graphe de tendance et l'analyse des pertes ci-dessous</div>
              </div>
            </div>
            <div className="d-flex align-items-center gap-2 flex-wrap">
              {[
                { label: '7 j', days: 7 },
                { label: '30 j', days: 30 },
                { label: '90 j', days: 90 },
              ].map((preset) => (
                <button
                  key={preset.days}
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

          {/* Filtres globaux (demande explicite du 22/10/2026 : "ajoute plusieur type de filtre en
              fonction des donner") — même style sof-pill/sof-input que le panneau de filtres
              "Détail par article" plus bas, mais agissant ici sur TOUTE la page (KPI, donut causes,
              drill-down), pas seulement sur la liste d'articles d'un rayon déjà sélectionné. */}
          <div className="sof-filter-card mb-3">
            <div className="sof-filter-row">
              <MultiSelectFilter
                icon="solar:flag-bold-duotone"
                placeholder="Tous les statuts"
                title="RÉSOLUE = article réapprovisionné, le stock est redevenu positif"
                options={[
                  { value: 'EN_COURS', label: 'Ruptures en cours' },
                  { value: 'RESOLUE', label: 'Ruptures résolues (réapprovisionnées)' },
                ]}
                selected={globalStatusFilter}
                onChange={setGlobalStatusFilter}
              />
              <MultiSelectFilter
                icon="solar:widget-bold-duotone"
                placeholder="Tous les secteurs"
                options={allSectorsForFilter.map((s) => ({ value: s, label: s }))}
                selected={globalSectorFilter}
                onChange={setGlobalSectorFilter}
              />
              <MultiSelectFilter
                icon="solar:shop-bold-duotone"
                placeholder="Tous les rayons"
                options={allDepartmentsForFilter.map((d) => ({ value: d, label: d }))}
                selected={globalDepartmentFilter}
                onChange={setGlobalDepartmentFilter}
              />
              <MultiSelectFilter
                icon="solar:cart-bold-duotone"
                placeholder="Avec ou sans commande"
                options={[
                  { value: 'with-order', label: 'Avec commande en cours' },
                  { value: 'without-order', label: 'Sans commande en cours' },
                ]}
                selected={globalOrderFilter}
                onChange={setGlobalOrderFilter}
              />
              <MultiSelectFilter
                icon="solar:question-circle-bold-duotone"
                placeholder="Toutes les causes"
                options={Object.entries(CAUSE_FILTER_LABELS).map(([key, label]) => ({ value: key, label, title: CAUSE_LABELS[key] }))}
                selected={globalCauseFilter}
                onChange={setGlobalCauseFilter}
              />
              {activeGlobalFilterCount > 0 && (
                <button type="button" className="sof-clear-btn" onClick={clearGlobalFilters}>
                  <iconify-icon icon="solar:close-circle-bold"></iconify-icon> Effacer les filtres ({activeGlobalFilterCount})
                </button>
              )}
            </div>
          </div>

          {/* Ordre des sections revu le 18/10/2026 (demande explicite : "met cette carte en
              premier et Ruptures en cours — 30 derniers jours et Analyse des pertes sur une
              période en deuxieme") — Situation actuelle (KPI + graphes) passe avant l'analyse de
              période, qui était auparavant tout en haut. */}
          <div className="stockout-section-title">Situation actuelle</div>
          <div className="row row-cols-2 row-cols-md-4 g-2 mb-3">
            <div className="col">
              <div className="stockout-mini-kpi">
                <span className="icon bg-warning-subtle"><iconify-icon icon="solar:alert-bold-duotone" className="text-warning"></iconify-icon></span>
                <div>
                  {/* "En cours" reste le libellé affiché, mais depuis le filtre de période appliqué
                      partout (20/10/2026), ce chiffre compte les ruptures ACTIVES À UN MOMENT de la
                      période choisie (pas seulement celles encore ouvertes maintenant) — cohérent
                      avec le graphe de tendance, qui fait déjà ce calcul. */}
                  <div className="label">
                    Articles touchés (période)
                    <FormulaInfoButton
                      title="Articles touchés sur la période"
                      steps={[
                        { label: 'Calcul', detail: "Nombre d'articles distincts ayant eu une rupture active à N'IMPORTE QUEL moment de la période sélectionnée — pas seulement ceux encore en rupture aujourd'hui." },
                        { label: 'Différent du graphe', detail: 'Le dernier point du graphe "Ruptures en cours" ci-dessus montre, lui, uniquement les ruptures actives le DERNIER jour de la période — un chiffre presque toujours plus petit que ce total cumulé.' },
                      ]}
                    />
                  </div>
                  <div className="value">{displayedOpenCount}</div>
                  {/* Ratio ajouté le 19/10/2026 (demande explicite : "la rupture par rapport quoi
                      la rupture est trop 90% ?") — un nombre brut d'articles en rupture ne dit rien
                      de l'ampleur réelle sans le comparer au catalogue total du magasin. Reste basé
                      sur le total magasin même filtres globaux actifs (comparer un sous-ensemble
                      filtré au catalogue entier n'aurait pas de sens). */}
                  {summary.ruptureRatioPct !== null && (
                    <div className="sub">{summary.ruptureRatioPct} % du catalogue ({summary.totalOrderableArticles} articles)</div>
                  )}
                </div>
              </div>
            </div>
            <div className="col">
              <div className="stockout-mini-kpi">
                <span className="icon bg-danger-subtle"><iconify-icon icon="solar:dollar-bold-duotone" className="text-danger"></iconify-icon></span>
                <div>
                  {/* Libellé rendu dynamique le 20/10/2026 (ex-"CA perdu (30j)" fixe, désormais
                      trompeur depuis que ce KPI suit le sélecteur de période unique de la page —
                      demande explicite : "quand je fait un filtre il doit etre appliqué sur tout"). */}
                  <div className="label">CA perdu</div>
                  <div className="value">{Math.round(displayedTotalCaPerdu).toLocaleString('fr-FR')} CFA</div>
                  <div className="sub">{new Date(periodStart).toLocaleDateString('fr-FR')} → {new Date(periodEnd).toLocaleDateString('fr-FR')}</div>
                </div>
              </div>
            </div>
            <div className="col">
              <div className="stockout-mini-kpi">
                <span className="icon bg-info-subtle"><iconify-icon icon="solar:clock-bold-duotone" className="text-info"></iconify-icon></span>
                <div>
                  <div className="label">Durée moyenne</div>
                  <div className="value">{formatDuration(displayedAvgDurationHours)}</div>
                </div>
              </div>
            </div>
            <div className="col">
              <div className="stockout-mini-kpi">
                <span className="icon bg-secondary-subtle"><iconify-icon icon="solar:box-minimalistic-bold-duotone" className="text-secondary"></iconify-icon></span>
                <div>
                  <div className="label">
                    CA perdu sans commande
                    <FormulaInfoButton
                      title="CA perdu sans commande"
                      steps={[
                        { label: 'Calcul', detail: 'Part du CA perdu (ci-dessus) provenant des ruptures où AUCUNE commande n\'a encore été passée pour réapprovisionner l\'article — responsabilité magasin, pas un délai fournisseur.' },
                      ]}
                    />
                  </div>
                  <div className="value">{Math.round(displayedCaPerdueSansCommande).toLocaleString('fr-FR')} CFA</div>
                </div>
              </div>
            </div>
            <div className="col">
              <div className="stockout-mini-kpi">
                <span className="icon bg-warning-subtle"><iconify-icon icon="solar:delivery-bold-duotone" className="text-warning"></iconify-icon></span>
                <div>
                  <div className="label">
                    CA perdu non livré
                    <FormulaInfoButton
                      title="CA perdu non livré"
                      steps={[
                        { label: 'Calcul', detail: 'Part du CA perdu (ci-dessus) provenant des ruptures où une commande EXISTE mais n\'est pas encore livrée (commandé pas livré, livraison en retard, ou livraison douteuse) — un délai côté fournisseur/logistique, pas une absence de réaction magasin.' },
                      ]}
                    />
                  </div>
                  <div className="value">{Math.round(displayedCaPerdueNonLivree).toLocaleString('fr-FR')} CFA</div>
                </div>
              </div>
            </div>
            <div className="col d-flex align-items-center justify-content-end justify-content-md-start">
              <button type="button" className="stockout-toggle-charts" onClick={() => setShowCharts((v) => !v)}>
                <iconify-icon icon={showCharts ? 'solar:alt-arrow-up-linear' : 'solar:chart-2-bold'}></iconify-icon>
                {showCharts ? 'Masquer les graphes' : 'Voir les graphes'}
              </button>
            </div>
          </div>

          {showCharts && (
            <div className="row row-cols-1 row-cols-md-2 g-3 mb-3">
              <div className="col">
                <StockoutTrendChart shopQueryParam={shopQueryParam} startDate={periodStart} endDate={periodEnd} />
              </div>
              <div className="col">
                <StockoutCauseChart causeCounts={displayedCauseCounts} />
              </div>
            </div>
          )}

          <StockoutPeriodAnalysis shopQueryParam={shopQueryParam} startDate={periodStart} endDate={periodEnd} episodeCountOverride={displayedOpenCount} />

          {/* Analyse par rayon (demande du 16/10/2026 : "doit etre dans les detail quand je clique
              sur pour mag" — classement/priorisation, distinct de la navigation Secteur → Rayon →
              Articles juste en dessous, qui sert au drill-down vers les articles). */}
          <div className="stockout-section-title">Priorisation par rayon</div>
          <div className="mb-3">
            <StockoutDepartmentAnalysis shopQueryParam={shopQueryParam} startDate={periodStart} endDate={periodEnd} />
          </div>

          <div className="stockout-section-title">Détail par article</div>
        </>
      )}

      {/* Navigation hiérarchique Secteur → Rayon → Articles, identique à PurchaseOrder.tsx. */}
      <div className="card">
        <div className="card-body">
          <div className="d-flex align-items-center gap-2 mb-3">
            {selectedSector && (
              <button
                type="button"
                className="btn btn-sm btn-outline-secondary"
                title="Retour"
                onClick={() => (selectedDepartment ? setSelectedDepartment(null) : setSelectedSector(null))}
              >
                <iconify-icon icon="solar:arrow-left-linear" className="align-middle"></iconify-icon>
              </button>
            )}
            <h5 className="mb-0">
              {showArticleList
                ? `Articles — ${selectedSector} › ${selectedDepartment}`
                : selectedSector
                  ? `Rayons — ${selectedSector}`
                  : 'Secteurs'}
            </h5>
          </div>

          {!selectedSector ? (
            // Niveau 1 : Secteurs
            bySector === null ? (
              <div className="text-muted small">Chargement...</div>
            ) : !bySector.groups || bySector.groups.length === 0 ? (
              <div className="text-muted small py-3">{bySector.message || 'Aucune rupture en cours.'}</div>
            ) : (
              // Masque les secteurs à 0 article en rupture (demande explicite du 18/10/2026 : "il
              // faut donc masque le sans rayon si c'est vide") — un secteur peut apparaître dans
              // l'agrégation (ex: résolu entre-temps par stockoutSectorBackfillJob) sans plus avoir
              // aucun épisode EN_COURS associé, une tuile à 0 n'apporte rien à afficher.
              <div className="row g-3">
                {bySector.groups.filter((s) => s.openCount > 0).map((s) => (
                  <div className="col-12 col-md-4" key={s.group}>
                    <div className="card h-100" role="button" style={{ cursor: 'pointer' }} onClick={() => setSelectedSector(s.group)}>
                      <div className="card-body">
                        <h6 className="mb-1">{s.group}</h6>
                        <div className="text-muted small">{s.openCount} article(s) en rupture</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : !selectedDepartment ? (
            // Niveau 2 : Rayons du secteur sélectionné
            byDepartment === null ? (
              <div className="text-muted small">Chargement...</div>
            ) : !byDepartment.groups || byDepartment.groups.length === 0 ? (
              <div className="text-muted small py-3">{byDepartment.message || 'Aucune rupture en cours pour ce secteur.'}</div>
            ) : (
              // Même correctif que pour les secteurs ci-dessus : masque les rayons à 0 article.
              <div className="row g-3">
                {byDepartment.groups.filter((d) => d.openCount > 0).map((d) => (
                  <div className="col-12 col-md-4" key={d.group}>
                    <div className="card h-100" role="button" style={{ cursor: 'pointer' }} onClick={() => setSelectedDepartment(d.group)}>
                      <div className="card-body">
                        <h6 className="mb-1">{d.group}</h6>
                        <div className="text-muted small">{d.openCount} article(s) en rupture</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : (
            // Niveau 3 : Articles du rayon sélectionné — filtre avec/sans commande (demande
            // explicite du 17/10/2026 : "on doit voit un filtre aussi sur ce qui son en rupture et
            // qui on une commande qui a ete passe dessu et ceux qui son en rupture et il ya pas de
            // commande dessu").
            <>
              {/* Barre de filtres restylée (demande explicite du 21/10/2026 : "personalyse tout les
                  filtre met un style plus joli tu vois") — mêmes codes visuels que la page Surstock
                  (OverstockReport.tsx) : pills pour le statut commande, carte claire pour la barre
                  de filtres, panneau "Filtres avancés" en grille plutôt qu'une ligne compressée. */}
              <div className="sof-filter-card mb-3">
                <div className="sof-pill-row">
                  <button type="button" className={`sof-pill${orderFilter === 'all' ? ' active' : ''}`} onClick={() => setOrderFilter('all')}>
                    Toutes <span className="sof-pill-count">{articlesInDepartmentAll.length}</span>
                  </button>
                  <button type="button" className={`sof-pill${orderFilter === 'with-order' ? ' active' : ''}`} onClick={() => setOrderFilter('with-order')}>
                    Avec commande <span className="sof-pill-count">{withOrderCount}</span>
                  </button>
                  <button type="button" className={`sof-pill${orderFilter === 'without-order' ? ' active' : ''}`} onClick={() => setOrderFilter('without-order')}>
                    Sans commande <span className="sof-pill-count">{withoutOrderCount}</span>
                  </button>
                  <button type="button" className={`sof-pill${orderFilter === 'delivered' ? ' active' : ''}`} onClick={() => setOrderFilter('delivered')}>
                    Livrées <span className="sof-pill-count">{deliveredCount}</span>
                  </button>
                </div>

                <div className="sof-filter-row">
                  <div className="sof-search-wrap">
                    <iconify-icon icon="solar:magnifer-linear" className="sof-search-icon"></iconify-icon>
                    <input
                      type="search"
                      className="sof-input sof-search-input"
                      placeholder="Rechercher un article (EAN ou libellé)..."
                      value={articleSearch}
                      onChange={(e) => setArticleSearch(e.target.value)}
                    />
                  </div>
                  <select className="sof-input" value={causeFilter} onChange={(e) => setCauseFilter(e.target.value)}>
                    <option value="">Toutes les causes</option>
                    {Object.entries(CAUSE_LABELS).map(([key, label]) => (
                      <option key={key} value={key}>{label}</option>
                    ))}
                  </select>
                  <select className="sof-input" value={reactionFilter} onChange={(e) => setReactionFilter(e.target.value)}>
                    <option value="">Toutes les réactions</option>
                    {Object.entries(REACTION_LIGHT_META).map(([key, meta]) => (
                      <option key={key} value={key}>{meta.label}</option>
                    ))}
                  </select>
                  <select className="sof-input" value={deliveryFilter} onChange={(e) => setDeliveryFilter(e.target.value)}>
                    <option value="">Tous les statuts de livraison</option>
                    {Object.entries(DELIVERY_STATUS_META).map(([key, meta]) => (
                      <option key={key} value={key}>{meta.label}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className={`sof-adv-filter-btn${activeRangeFilterCount > 0 ? ' active' : ''}`}
                    onClick={() => setRangeFiltersOpen((v) => !v)}
                  >
                    <iconify-icon icon="solar:tuning-2-bold-duotone"></iconify-icon>
                    Filtres avancés{activeRangeFilterCount > 0 ? ` (${activeRangeFilterCount})` : ''}
                    <iconify-icon icon={rangeFiltersOpen ? 'solar:alt-arrow-up-linear' : 'solar:alt-arrow-down-linear'} style={{ fontSize: '12px', opacity: .6 }}></iconify-icon>
                  </button>
                  {activeExtraFilterCount > 0 && (
                    <button type="button" className="sof-clear-btn" onClick={clearAllArticleFilters}>
                      <iconify-icon icon="solar:close-circle-bold"></iconify-icon> Effacer les filtres
                    </button>
                  )}
                </div>

                {rangeFiltersOpen && (
                  <div className="sof-range-panel">
                    {([
                      ['durationHours', 'Durée (heures)'],
                      ['sellingPrice', 'Prix (CFA)'],
                      ['qtyPerdueEstimee', 'Qté perdue'],
                      ['caPerdueEstime', 'CA perdu (CFA)'],
                    ] as [RangeFilterKey, string][]).map(([key, label]) => (
                      <div key={key} className="sof-range-field">
                        <span className="sof-range-label">{label}</span>
                        <div className="d-flex align-items-center gap-1">
                          <input
                            type="number"
                            className="sof-input"
                            style={{ width: 90 }}
                            placeholder="Min"
                            value={rangeFilters[key].min}
                            onChange={(e) => setRangeFilter(key, 'min', e.target.value)}
                          />
                          <span className="text-muted small">—</span>
                          <input
                            type="number"
                            className="sof-input"
                            style={{ width: 90 }}
                            placeholder="Max"
                            value={rangeFilters[key].max}
                            onChange={(e) => setRangeFilter(key, 'max', e.target.value)}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="table-responsive">
                <table className="table align-middle mb-0 table-hover table-centered">
                  <thead className="bg-light-subtle">
                    <tr>
                      <th className="osr-sortable-th" style={{ cursor: 'pointer' }} onClick={() => toggleArticleSort('label')}>Article{articleSortIcon('label')}</th>
                      <th className="osr-sortable-th" style={{ cursor: 'pointer' }} onClick={() => toggleArticleSort('startedAt')}>Depuis{articleSortIcon('startedAt')}</th>
                      <th className="osr-sortable-th" style={{ cursor: 'pointer' }} onClick={() => toggleArticleSort('duration')}>Durée{articleSortIcon('duration')}</th>
                      <th>Réaction</th>
                      <th>Livraison</th>
                      <th>Reçue (estimée) le</th>
                      <th className="osr-sortable-th" style={{ cursor: 'pointer' }} onClick={() => toggleArticleSort('sellingPrice')}>Prix{articleSortIcon('sellingPrice')}</th>
                      <th className="osr-sortable-th" style={{ cursor: 'pointer' }} onClick={() => toggleArticleSort('qtyPerdueEstimee')}>Qté perdue{articleSortIcon('qtyPerdueEstimee')}</th>
                      <th className="osr-sortable-th" style={{ cursor: 'pointer' }} onClick={() => toggleArticleSort('caPerdueEstime')}>Valorisation (CA perdu){articleSortIcon('caPerdueEstime')}</th>
                      <th>Cause probable</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedArticlesInDepartment.length === 0 ? (
                      <tr>
                        <td colSpan={10} className="text-center text-muted py-4">
                          {articlesInDepartmentAll.length === 0 ? 'Aucune rupture en cours pour ce rayon.' : 'Aucun article ne correspond à ce filtre.'}
                        </td>
                      </tr>
                    ) : (
                      sortedArticlesInDepartment.map((e) => {
                        // Repli "Calcul en cours" (demande du 20/10/2026, statut désormais
                        // précalculé en base par stockoutStatusRecalcJob.js) — un épisode tout juste
                        // détecté peut, en théorie, être lu avant le premier passage du job (fenêtre
                        // de quelques minutes au pire) ; ce repli évite un crash sur une clé absente
                        // plutôt que de supposer que la colonne est toujours renseignée.
                        const reaction = REACTION_LIGHT_META[e.reactionStatus] || { label: 'Calcul en cours…', badge: 'reassort-badge-neutral' };
                        const delivery = DELIVERY_STATUS_META[e.deliveryStatus] || { label: 'Calcul en cours…', badge: 'reassort-badge-neutral' };
                        return (
                          <tr key={e.id} role="button" style={{ cursor: 'pointer' }} onClick={() => navigate(`/stockouts/episode/${e.id}?from=${encodeURIComponent(`/stockouts?${searchParams.toString()}`)}`)}>
                            <td>{e.label || e.ean}</td>
                            <td>{new Date(e.startedAt).toLocaleString('fr-FR')}</td>
                            <td>{formatDuration(liveDurationHours(e.startedAt))}</td>
                            <td>
                              <span className={`badge ${reaction.badge} py-1 px-2`}>{reaction.label}</span>
                            </td>
                            <td>
                              <span className={`badge ${delivery.badge} py-1 px-2`}>{delivery.label}</span>
                            </td>
                            {/* CORRIGÉ le 19/10/2026 (signalé avec capture : colonne "Livré le" avec
                                une date remplie alors que le badge Livraison affiche "Livraison
                                douteuse" — "il na pas mis ajour l capture", confusion entre la DATE
                                ESTIMÉE RPOS (actualReceptionDate, jamais une preuve, cf.
                                deliveryStatus réécrit dans stockoutEpisodeService.js) et une vraie
                                réception confirmée). N'affiche cette date QUE si le statut est
                                réellement LIVREE (un vrai mouvement Arrivage a été détecté) —
                                EN_ATTENTE_LIVRAISON et LIVRAISON_DOUTEUSE affichent "—", même si
                                actualReceptionDate est techniquement renseigné côté RPOS. */}
                            <td>{e.deliveryStatus === 'LIVREE' && e.actualReceptionDate ? new Date(e.actualReceptionDate).toLocaleString('fr-FR') : '—'}</td>
                            <td>{e.sellingPrice !== null ? `${Math.round(e.sellingPrice).toLocaleString('fr-FR')} CFA` : '—'}</td>
                            <td>{e.qtyPerdueEstimee !== null ? Math.round(e.qtyPerdueEstimee) : '—'}</td>
                            <td>{e.caPerdueEstime !== null ? `${Math.round(e.caPerdueEstime).toLocaleString('fr-FR')} CFA` : '—'}</td>
                            <td>{CAUSE_LABELS[e.causeProposee] || e.causeProposee}</td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
