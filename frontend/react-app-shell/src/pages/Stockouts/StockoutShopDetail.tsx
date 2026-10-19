import { useEffect, useState, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { apiFetch } from '../../shared/api/client';
import { StockoutTrendChart } from './StockoutTrendChart';
import { StockoutCauseChart } from './StockoutCauseChart';
import { StockoutDepartmentAnalysis } from './StockoutDepartmentAnalysis';
import { StockoutPeriodAnalysis } from './StockoutPeriodAnalysis';

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
};

type StockoutSummary = {
  openCount: number;
  avgDurationHours: number;
  totalCaPerduEstime: number;
  causeCounts: Record<string, number>;
  openEpisodes: StockoutEpisode[];
};

type GroupSummary = { group: string; openCount: number; totalEpisodesCount: number };
type ByFieldSummary = { found: boolean; groupCount: number; groups: GroupSummary[]; message?: string };

const CAUSE_LABELS: Record<string, string> = {
  MAGASIN_REASSORT: 'Magasin / réassort',
  MAGASIN_COMMANDE_NON_VALIDEE: 'Commande non validée',
  AMONT_A_PRECISER: 'Amont — à préciser',
  ECART_STOCK_RAYON: 'Écart stock / rayon',
  INDETERMINEE: 'Indéterminée',
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

type OrderFilter = 'all' | 'with-order' | 'without-order' | 'delivered';

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
  const [orderFilter, setOrderFilter] = useState<OrderFilter>('all');
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
    apiFetch<StockoutSummary>(`/reassort/stockout-episodes?${shopQueryParam}`)
      .then((data) => { if (!cancelled && mountRef.current) setSummary(data); })
      .catch((err) => { if (!cancelled && mountRef.current) setError(err instanceof Error ? err.message : String(err)); });
    return () => {
      cancelled = true;
      mountRef.current = false;
    };
  }, [shopQueryParam]);

  // Niveau Secteurs : chargé une fois par magasin.
  // (bug corrigé le 18/10/2026 : ce useEffect était dupliqué deux fois à l'identique, doublant
  // inutilement l'appel réseau vers /by-sector à chaque chargement de la page.)
  useEffect(() => {
    if (!shopQueryParam) return;
    let cancelled = false;
    setBySector(null);
    apiFetch<ByFieldSummary>(`/reassort/stockout-episodes/by-sector?${shopQueryParam}`)
      .then((data) => { if (!cancelled) setBySector(data); })
      .catch(() => { /* non bloquant : la liste d'articles reste consultable sans ce niveau */ });
    return () => { cancelled = true; };
  }, [shopQueryParam]);

  // Niveau Rayons : rechargé à chaque changement de secteur sélectionné.
  useEffect(() => {
    if (!shopQueryParam || !selectedSector) { setByDepartment(null); return; }
    let cancelled = false;
    setByDepartment(null);
    const sectorParam = selectedSector === 'Sans secteur' ? '__none__' : selectedSector;
    apiFetch<ByFieldSummary>(`/reassort/stockout-episodes/by-department?sector=${encodeURIComponent(sectorParam)}&${shopQueryParam}`)
      .then((data) => { if (!cancelled) setByDepartment(data); })
      .catch(() => { /* non bloquant */ });
    return () => { cancelled = true; };
  }, [shopQueryParam, selectedSector]);

  // BUG CORRIGÉ le 18/10/2026 (signalé avec capture : "sans rayon affiche mais ya rien mais dans
  // le clique il ya contenu" — en réalité l'inverse : la tuile "0 article(s)" était correcte, la
  // liste qui s'affichait au clic (77 articles) était FAUSSE) : ce filtre ne tenait compte QUE du
  // rayon sélectionné, jamais du secteur — un clic sur "EPICERIE SUCREE" sous "Sans secteur"
  // affichait donc TOUS les articles EPICERIE SUCREE du magasin, y compris ceux ayant un vrai
  // secteur connu, au lieu des seuls articles réellement "Sans secteur" de ce rayon (0 ici).
  const articlesInDepartmentAll = selectedDepartment
    ? (summary?.openEpisodes || []).filter((e) =>
        (e.department || 'Sans rayon') === selectedDepartment &&
        (e.sector || 'Sans secteur') === (selectedSector || 'Sans secteur')
      )
    : [];
  const articlesInDepartment = articlesInDepartmentAll.filter((e) => {
    if (orderFilter === 'with-order') return e.hasOrder;
    if (orderFilter === 'without-order') return !e.hasOrder;
    if (orderFilter === 'delivered') return e.deliveryStatus === 'LIVREE';
    return true;
  });
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
        .stockout-toggle-charts { font-size: .76rem; color: #5B6B85; background: none; border: none; display: inline-flex; align-items: center; gap: 4px; padding: 0; }
        .stockout-toggle-charts:hover { color: #1B2A4A; }
        .stockout-section-title { font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #8591A0; margin: 20px 0 10px; padding-top: 10px; border-top: 1px solid rgba(27,42,74,.08); }
        .stockout-section-title:first-of-type { margin-top: 0; padding-top: 0; border-top: none; }
        .stockout-period-filter-card { background: #fff; border: 1px solid rgba(27,42,74,.08); border-radius: 8px; padding: 12px 16px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 14px; }
        .stockout-period-filter-icon { width: 30px; height: 30px; border-radius: 7px; background: rgba(27,42,74,.05); display: flex; align-items: center; justify-content: center; font-size: 15px; color: #5B6B85; flex-shrink: 0; }
        .stockout-period-preset { border: 1px solid rgba(27,42,74,.12); background: #fff; color: #5B6B85; font-size: .76rem; font-weight: 600; padding: 5px 12px; border-radius: 6px; transition: background .15s, color .15s, border-color .15s; }
        .stockout-period-preset:hover { background: #F6F8FB; color: #1B2A4A; border-color: rgba(27,42,74,.2); }
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
                  <div className="label">En cours</div>
                  <div className="value">{summary.openCount ?? 0}</div>
                </div>
              </div>
            </div>
            <div className="col">
              <div className="stockout-mini-kpi">
                <span className="icon bg-danger-subtle"><iconify-icon icon="solar:dollar-bold-duotone" className="text-danger"></iconify-icon></span>
                <div>
                  <div className="label">CA perdu (30j)</div>
                  <div className="value">{(summary.totalCaPerduEstime ?? 0).toLocaleString('fr-FR')} CFA</div>
                </div>
              </div>
            </div>
            <div className="col">
              <div className="stockout-mini-kpi">
                <span className="icon bg-info-subtle"><iconify-icon icon="solar:clock-bold-duotone" className="text-info"></iconify-icon></span>
                <div>
                  <div className="label">Durée moyenne</div>
                  <div className="value">{formatDuration(summary.avgDurationHours ?? 0)}</div>
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
                <StockoutCauseChart causeCounts={summary.causeCounts || {}} />
              </div>
            </div>
          )}

          <StockoutPeriodAnalysis shopQueryParam={shopQueryParam} startDate={periodStart} endDate={periodEnd} />

          {/* Analyse par rayon (demande du 16/10/2026 : "doit etre dans les detail quand je clique
              sur pour mag" — classement/priorisation, distinct de la navigation Secteur → Rayon →
              Articles juste en dessous, qui sert au drill-down vers les articles). */}
          <div className="stockout-section-title">Priorisation par rayon</div>
          <div className="mb-3">
            <StockoutDepartmentAnalysis shopQueryParam={shopQueryParam} />
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
              <div className="d-flex gap-2 mb-3">
                <button type="button" className={`btn btn-sm ${orderFilter === 'all' ? 'btn-primary' : 'btn-outline-secondary'}`} onClick={() => setOrderFilter('all')}>
                  Toutes ({articlesInDepartmentAll.length})
                </button>
                <button type="button" className={`btn btn-sm ${orderFilter === 'with-order' ? 'btn-primary' : 'btn-outline-secondary'}`} onClick={() => setOrderFilter('with-order')}>
                  Avec commande ({withOrderCount})
                </button>
                <button type="button" className={`btn btn-sm ${orderFilter === 'without-order' ? 'btn-primary' : 'btn-outline-secondary'}`} onClick={() => setOrderFilter('without-order')}>
                  Sans commande ({withoutOrderCount})
                </button>
                <button type="button" className={`btn btn-sm ${orderFilter === 'delivered' ? 'btn-primary' : 'btn-outline-secondary'}`} onClick={() => setOrderFilter('delivered')}>
                  Livrées ({deliveredCount})
                </button>
              </div>
              <div className="table-responsive">
                <table className="table align-middle mb-0 table-hover table-centered">
                  <thead className="bg-light-subtle">
                    <tr>
                      <th>Article</th>
                      <th>Depuis</th>
                      <th>Durée</th>
                      <th>Réaction</th>
                      <th>Livraison</th>
                      <th>Livré le</th>
                      <th>Prix</th>
                      <th>Qté perdue</th>
                      <th>Valorisation (CA perdu)</th>
                      <th>Cause probable</th>
                    </tr>
                  </thead>
                  <tbody>
                    {articlesInDepartment.length === 0 ? (
                      <tr>
                        <td colSpan={10} className="text-center text-muted py-4">
                          {articlesInDepartmentAll.length === 0 ? 'Aucune rupture en cours pour ce rayon.' : 'Aucun article ne correspond à ce filtre.'}
                        </td>
                      </tr>
                    ) : (
                      articlesInDepartment.map((e) => {
                        const reaction = REACTION_LIGHT_META[e.reactionStatus];
                        const delivery = DELIVERY_STATUS_META[e.deliveryStatus];
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
                            <td>{e.actualReceptionDate ? new Date(e.actualReceptionDate).toLocaleString('fr-FR') : '—'}</td>
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
