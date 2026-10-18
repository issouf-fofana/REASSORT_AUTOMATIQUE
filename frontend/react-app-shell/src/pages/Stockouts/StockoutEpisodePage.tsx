import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { apiFetch } from '../../shared/api/client';

// Page dédiée de détail d'une rupture. Refonte du 17/10/2026 (demande explicite, sur le modèle
// d'une capture d'écran d'une autre application "Suivi Interventions" : header sombre contrasté +
// badge statut, bandeau d'alerte, 4 tuiles compactes, timeline horizontale début→durée→fin, puis
// sections "Informations générales" / "Métriques temporelles" en grille 2 colonnes) — remplace la
// précédente mise en page à sections empilées (plus proche de la maquette "Analyse de rupture.html"
// initiale), jugée trop longue à parcourir.
//
// Traçabilité demandée explicitement : détection (date/heure début, compteur continu tant
// qu'aucune commande), commande (date/heure de création ET de validation, qui a validé, numéro de
// commande RPOS), délai de livraison restant après commande, perte estimée SÉPARÉMENT avant et
// après la commande (pas une seule perte globale) — et le verdict "magasin fautif" quand aucune
// commande n'a été passée alors que des ventes ont continué d'être constatées (reactionStatus
// MAGASIN_NA_PAS_REAGI, cf. stockoutEpisodeService.js).
type StockMove = {
  date: string;
  typeLabel: string;
  recording: string | null;
  isScrap: boolean;
  quantity: number;
  previousQuantity: number | null;
};

type OrderInfo = {
  id: string;
  rposOrderReference: string | null;
  status: string;
  receptionStatus: string;
  rposOrderValidated: boolean | null;
  supplierName: string | null;
  deliveryType: string | null;
  createdAt: string;
  createdBy: string | null;
  validatedAt: string | null;
  validatedBy: string | null;
  expectedReceptionDate: string | null;
  actualReceptionDate: string | null;
  quantityOrdered: number | null;
};

type ReceptionEvent = { observedAt: string; receptionStatus: string; rposStatus: number };

type ReactionStatus = 'EN_ATTENTE' | 'RETARD' | 'MAGASIN_NA_PAS_REAGI' | 'REAGI' | 'STOCK_PEUT_ETRE_PAS_A_JOUR';

type OrderQuantitySufficiency = { quantityOrdered: number; expectedDemand: number; sufficient: boolean };

type Loss = { qtyPerdue: number | null; caPerdue: number | null };

type EpisodeDetail = {
  id: string;
  ean: string;
  label: string | null;
  department: string | null;
  sector?: string | null;
  rposShopId: string;
  startedAt: string;
  endedAt: string | null;
  status: string;
  durationHours: number;
  causeProposee: string;
  niveauConfiance: string;
  reactionStatus: ReactionStatus;
  qtyPerdueEstimee: number | null;
  caPerdueEstime: number | null;
  salesBeforeEpisode: { windowDays: number; quantity: number; revenue: number };
  salesDuringEpisode: { quantity: number; revenue: number };
  stockMoves: StockMove[];
  order: OrderInfo | null;
  receptionEvents: ReceptionEvent[];
  reactionDelayHours: number | null;
  replenishmentDelayHours: number | null;
  totalDurationHours: number;
  orderQuantitySufficiency: OrderQuantitySufficiency | null;
  lossBeforeOrder: Loss | null;
  lossAfterOrder: Loss | null;
  reactionDeadlineHours: number;
  deliveryDeadlineHours: number;
  stockAtStart: { value: number; capturedAt: string } | null;
  stockCurrent: { value: number; capturedAt: string } | null;
  stockRpos: { value: number; syncedAt: string } | null;
  stockAtEnd: { value: number; capturedAt: string } | null;
  stockAfterDelivery: { value: number; capturedAt: string } | null;
  sellingPrice: number | null;
  buyingPrice: number | null;
  deliveryLooksDoubtful: boolean;
  deliveryDelay: {
    expectedReceptionDate: string;
    daysLate: number;
    invoiceSlotsPassedWithoutArrival: number;
    likelyInvoiceIntegrationIssue: boolean;
  } | null;
};

const CAUSE_LABELS: Record<string, string> = {
  MAGASIN_REASSORT: 'Magasin / réassort',
  MAGASIN_COMMANDE_NON_VALIDEE: 'Commande non validée',
  AMONT_A_PRECISER: 'Amont — à préciser',
  ECART_STOCK_RAYON: 'Écart stock / rayon',
  INDETERMINEE: 'Indéterminée',
};

const RECEPTION_STATUS_LABELS: Record<string, string> = {
  COMMANDEE: 'Commandée',
  EN_ATTENTE_RECEPTION: 'En attente de réception',
  RECUE_ESTIMEE: 'Reçue (estimée)',
  ANNULEE: 'Annulée',
};

const REACTION_STATUS_META: Record<ReactionStatus, { label: string; tone: 'critical' | 'warning' | 'success' | 'info'; verdict: string }> = {
  REAGI: { label: 'Le magasin a réagi', tone: 'success', verdict: 'Une commande a été passée — magasin non fautif pour la période après réaction.' },
  EN_ATTENTE: { label: 'En attente de commande (< 24h)', tone: 'info', verdict: 'Délai normal, pas encore de jugement possible.' },
  RETARD: { label: 'Retard de commande (24-48h)', tone: 'warning', verdict: 'Retard constaté, pas encore confirmé fautif.' },
  MAGASIN_NA_PAS_REAGI: { label: "Le magasin n'a pas réagi (> 48h)", tone: 'critical', verdict: 'Aucune commande passée après 48h de rupture avec ventes constatées — magasin fautif.' },
  STOCK_PEUT_ETRE_PAS_A_JOUR: { label: 'Stock potentiellement pas à jour', tone: 'info', verdict: "Aucune vente ni commande depuis le début — le stock à 0 n'est peut-être pas réel, pas de jugement possible." },
};

function formatDuration(hours: number | null): string {
  if (hours === null || hours < 0) return '—';
  if (hours < 24) return `${Math.round(hours)} h`;
  const days = Math.floor(hours / 24);
  const rest = Math.round(hours % 24);
  return `${days} j ${rest} h`;
}

// Avec minutes et secondes (demande explicite du 17/10/2026 : "je veux que le temps soit en live
// modifier en temps reel") — formatDuration() arrondit à l'heure près, donc un compteur qui
// recalcule bien chaque seconde en interne semblait visuellement figé pendant près d'une heure.
// Réservée aux 3 compteurs live de cette page (durée totale, avant/après commande) ; le reste de
// l'app garde formatDuration() (listes, agrégats) où cette précision serait du bruit.
function formatDurationLive(hours: number | null): string {
  if (hours === null || hours < 0) return '—';
  const totalSeconds = Math.floor(hours * 3600);
  const days = Math.floor(totalSeconds / 86400);
  const h = Math.floor((totalSeconds % 86400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const parts = [];
  if (days > 0) parts.push(`${days}j`);
  if (days > 0 || h > 0) parts.push(`${h}h`);
  parts.push(`${String(m).padStart(2, '0')}min`);
  parts.push(`${String(s).padStart(2, '0')}s`);
  return parts.join(' ');
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('fr-FR');
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('fr-FR');
}

function formatMoney(value: number | null): string {
  if (value === null) return '—';
  return `${Math.round(value).toLocaleString('fr-FR')} CFA`;
}

// Affiche une valeur de stock avec le code couleur demandé explicitement le 17/10/2026 : négatif
// (désynchro RPOS probable) en rouge, 0 (rupture propre) en ambre neutre, positif en vert — avec
// l'horodatage du relevé pour qu'on sache à quel moment précis cette valeur a été constatée.
// Rendu dans le style "rp3-stock" de rapport_rupture_stock_v3.html (demande du 18/10/2026).
function StockValueRp3({ stock }: { stock: { value: number; capturedAt: string } | null }) {
  if (!stock) return <div className="num" style={{ fontSize: 14, color: 'var(--rp3-muted)' }}>—</div>;
  const tone = stock.value < 0 ? 'red' : stock.value === 0 ? 'amber' : 'green';
  return (
    <div>
      <div className={`num ${tone}`}>{stock.value} u.</div>
      <small>{formatDateTime(stock.capturedAt)}</small>
    </div>
  );
}

export function StockoutEpisodePage() {
  const { episodeId } = useParams<{ episodeId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // URL exacte (avec secteur/rayon) d'où on est arrivé, passée par StockoutShopDetail.tsx au clic
  // sur l'article — demande explicite du 17/10/2026 : "quand je fait un retour il m'nevoi sur les
  // Secteurs au debut or il doit m'envoyer dans les rayon". navigate(-1) seul ne suffit pas non
  // plus : ouverture directe (lien partagé, rechargement) = pas d'historique React dans l'onglet.
  const backTo = searchParams.get('from');
  const [detail, setDetail] = useState<EpisodeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!episodeId) return;
    let cancelled = false;
    setDetail(null);
    setError(null);
    apiFetch<EpisodeDetail>(`/reassort/stockout-episodes/${episodeId}`)
      .then((data) => { if (!cancelled) setDetail(data); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [episodeId]);

  // Chronomètre live (demande explicite du 17/10/2026 : "si ya rupture il doid commencé en compté
  // sur le UI le user doit voir compté... si ya pas de commande le compteur de rupture avant la
  // commande continue toujour de compté") — les durées ne sont plus des valeurs figées renvoyées au
  // chargement : recalculées ici à chaque tick à partir des timestamps bruts (startedAt,
  // order.createdAt, endedAt) tant que la rupture est EN_COURS. Une fois résolue (endedAt non nul),
  // le tick n'a plus d'effet : les trois bornes sont fixes, pas besoin de continuer à rafraîchir.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!detail || detail.status !== 'EN_COURS') return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [detail?.status, detail?.id]);

  const reactionMeta = detail ? REACTION_STATUS_META[detail.reactionStatus] : null;

  // Avant commande : du début de la rupture jusqu'à la commande (si elle existe) ou jusqu'à
  // maintenant/la fin (sinon) — continue de monter tant qu'aucune commande n'a été passée.
  // Après commande : de la commande jusqu'à la réception (si connue) ou jusqu'à maintenant/la fin —
  // démarre à 0 et monte dès que la commande est passée, tant que la livraison n'est pas confirmée.
  const liveDurations = (() => {
    if (!detail) return null;
    const startedAt = new Date(detail.startedAt).getTime();
    const endedAt = detail.endedAt ? new Date(detail.endedAt).getTime() : now;
    const orderCreatedAt = detail.order ? new Date(detail.order.createdAt).getTime() : null;

    const beforeOrderEnd = orderCreatedAt !== null ? orderCreatedAt : endedAt;
    const beforeOrderHours = Math.max(0, (beforeOrderEnd - startedAt) / (60 * 60 * 1000));

    let afterOrderHours = null;
    if (orderCreatedAt !== null) {
      afterOrderHours = Math.max(0, (endedAt - orderCreatedAt) / (60 * 60 * 1000));
    }

    const totalHours = Math.max(0, (endedAt - startedAt) / (60 * 60 * 1000));

    return { beforeOrderHours, afterOrderHours, totalHours };
  })();

  const isLongDuration = liveDurations ? liveDurations.totalHours >= (detail?.deliveryDeadlineHours ?? 48) : false;

  // Barres de ventilation perte avant/après commande (panel "Impact estimé") et écart entre la
  // somme des deux périodes et le total affiché par caPerdueEstime — même logique que la maquette
  // rapport_rupture_stock_v3.html ("Le total affiché... présente un écart à expliquer"), calculée
  // ici plutôt qu'en dur : le total vient d'un calcul de perte globale (lookback 52 semaines),
  // distinct de la somme avant/après (deux fenêtres estimées séparément), un écart est donc normal
  // et attendu, pas une erreur à corriger silencieusement.
  const lossBefore = detail?.lossBeforeOrder?.caPerdue ?? 0;
  const lossAfter = detail?.lossAfterOrder?.caPerdue ?? 0;
  const lossSum = lossBefore + lossAfter;
  const lossGap = detail?.caPerdueEstime !== null && detail?.caPerdueEstime !== undefined ? detail.caPerdueEstime - lossSum : null;
  const lossMax = Math.max(lossBefore, lossAfter, 1);
  const lossBarWidths = {
    before: `${Math.min(100, Math.round((lossBefore / lossMax) * 100))}%`,
    after: `${Math.min(100, Math.round((lossAfter / lossMax) * 100))}%`,
  };

  // Actions recommandées, dérivées de l'état réel de l'épisode (jamais une liste fixe) — même
  // principe que les callouts ci-dessus : chaque action répond à un fait constaté sur CET épisode
  // précis (livraison douteuse, retard, stock négatif, pas de commande...), pas un texte générique.
  const recommendedActions = (() => {
    if (!detail) return [];
    const actions: { title: string; desc: string }[] = [];
    if (detail.deliveryLooksDoubtful || detail.deliveryDelay) {
      actions.push({ title: 'Vérifier la réception réelle', desc: detail.order ? `Comparer le bon de livraison à la commande ${detail.order.rposOrderReference || detail.order.id.slice(0, 10)} et enregistrer l'entrée si elle a eu lieu.` : 'Vérifier si une commande a réellement été passée et reçue.' });
    }
    if (detail.stockAtStart && detail.stockAtStart.value < 0) {
      actions.push({ title: 'Réconcilier le stock négatif', desc: "Comparer l'inventaire physique, les ventes et les mouvements de stock synchronisés." });
    }
    if (!detail.order && detail.status === 'EN_COURS') {
      actions.push({ title: 'Passer une commande', desc: "Aucune commande n'a encore été passée depuis le début de la rupture." });
    }
    if (lossGap !== null && Math.abs(lossGap) > 1) {
      actions.push({ title: 'Contrôler le calcul des pertes', desc: `Expliquer l'écart de ${formatMoney(Math.abs(lossGap))} entre le total affiché et les deux périodes.` });
    }
    if (!actions.length) {
      actions.push({ title: 'Suivre la résolution', desc: detail.status === 'EN_COURS' ? "La rupture reste active, continuer à surveiller l'évolution du stock." : 'Rupture résolue, aucune action supplémentaire nécessaire.' });
    }
    return actions;
  })();

  return (
    <div className="container-fluid py-4" style={{ maxWidth: 1580, fontFamily: '"Segoe UI",Arial,sans-serif' }}>
      {/* Style repris de rapport_rupture_stock_v3.html (demande explicite du 18/10/2026 : "je veux
          que tu applique le style sur cette page") — palette navy/rouge/ambre/vert, panels blancs à
          bordure fine, "callout" d'alerte, tuiles KPI, timeline à 3 événements, badges "tag". Noms
          de classe conservés tels quels (préfixe rp3-) pour rester identifiables face à la maquette
          source en cas de futur ajustement visuel. */}
      <style>{`
        :root{--rp3-navy:#1d3557;--rp3-ink:#263548;--rp3-muted:#718096;--rp3-line:#dce3eb;--rp3-bg:#f3f5f8;--rp3-red:#b42318;--rp3-red-bg:#fff0ef;--rp3-orange:#9a5b0c;--rp3-orange-bg:#fff4e2;--rp3-green:#246747;--rp3-green-bg:#e9f5ed;--rp3-blue:#315b89;--rp3-blue-bg:#edf3f9;--rp3-shadow:0 1px 3px #152d4b0b}
        .rp3 { color: var(--rp3-ink); font-size: 13px; line-height: 1.45; }
        .rp3-back { background: #fff; border: 1px solid var(--rp3-line); color: var(--rp3-ink); font-size: .82rem; font-weight: 650; display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; border-radius: 6px; margin-bottom: 15px; }
        .rp3-back:hover { background: #fafbfd; }
        .rp3-crumb { color: var(--rp3-muted); font-size: 11px; margin-bottom: 15px; }
        .rp3-crumb b { color: var(--rp3-ink); }
        .rp3-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 18px; margin-bottom: 15px; flex-wrap: wrap; }
        .rp3-ref { font-size: 10px; text-transform: uppercase; letter-spacing: .09em; font-weight: 800; color: var(--rp3-muted); }
        .rp3-header h2 { margin: 5px 0; font-size: 23px; line-height: 1.25; color: var(--rp3-navy); font-weight: 800; }
        .rp3-sub { font-size: 12px; color: var(--rp3-muted); }
        .rp3-status { display: inline-flex; align-items: center; gap: 7px; border: 1px solid #efc4c1; background: var(--rp3-red-bg); color: var(--rp3-red); padding: 7px 10px; border-radius: 5px; font-size: 10px; font-weight: 800; white-space: nowrap; }
        .rp3-status.resolved { border-color: #c8e3d1; background: var(--rp3-green-bg); color: var(--rp3-green); }
        .rp3-dot { width: 7px; height: 7px; background: var(--rp3-red); border-radius: 50%; }
        .rp3-status.resolved .rp3-dot { background: var(--rp3-green); }
        .rp3-callout { padding: 11px 13px; border-radius: 5px; margin-bottom: 14px; display: flex; gap: 10px; align-items: flex-start; font-size: 11px; }
        .rp3-callout.warn { background: var(--rp3-orange-bg); border: 1px solid #efd5a8; color: #7d4b0b; }
        .rp3-callout.danger { background: var(--rp3-red-bg); border: 1px solid #efc7c4; color: #8d211a; }
        .rp3-callout.good { background: var(--rp3-green-bg); border: 1px solid #c8e3d1; color: #225b40; }
        .rp3-section-title { font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: var(--rp3-muted); font-weight: 850; margin: 21px 0 9px; }
        .rp3-kpis { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 10px; margin-bottom: 16px; }
        @media (max-width: 860px) { .rp3-kpis { grid-template-columns: repeat(2, minmax(0,1fr)); } }
        .rp3-kpi { background: #fff; border: 1px solid var(--rp3-line); border-radius: 6px; padding: 13px 14px; box-shadow: var(--rp3-shadow); min-width: 0; }
        .rp3-kpi-label { color: var(--rp3-muted); font-size: 9px; text-transform: uppercase; letter-spacing: .07em; font-weight: 800; }
        .rp3-kpi-value { font-size: 22px; font-weight: 850; color: var(--rp3-navy); margin: 7px 0 2px; letter-spacing: -.03em; overflow-wrap: anywhere; }
        .rp3-kpi-value.red { color: var(--rp3-red); }
        .rp3-kpi-value.orange { color: var(--rp3-orange); }
        .rp3-kpi-foot { font-size: 10px; color: var(--rp3-muted); }
        .rp3-kpi-foot b { color: var(--rp3-ink); }
        .rp3-panel { background: #fff; border: 1px solid var(--rp3-line); border-radius: 6px; box-shadow: var(--rp3-shadow); min-width: 0; height: 100%; }
        .rp3-panelhead { padding: 12px 15px; border-bottom: 1px solid var(--rp3-line); display: flex; justify-content: space-between; align-items: center; gap: 10px; }
        .rp3-panelhead h3 { margin: 0; color: var(--rp3-navy); font-size: 11px; text-transform: uppercase; letter-spacing: .055em; font-weight: 800; }
        .rp3-panelhead span { font-size: 10px; color: var(--rp3-muted); }
        .rp3-panelbody { padding: 15px; }
        .rp3-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 15px 18px; }
        .rp3-label { font-size: 9px; text-transform: uppercase; letter-spacing: .065em; color: var(--rp3-muted); font-weight: 800; margin-bottom: 4px; }
        .rp3-value { font-size: 12px; font-weight: 700; overflow-wrap: anywhere; }
        .rp3-value.red { color: var(--rp3-red); }
        .rp3-value.muted { font-weight: 500; color: var(--rp3-muted); }
        .rp3-tag { display: inline-block; border-radius: 4px; padding: 3px 6px; background: #edf1f6; color: #4a5a70; font-size: 9px; font-weight: 800; }
        .rp3-tag.red { background: var(--rp3-red-bg); color: var(--rp3-red); }
        .rp3-tag.orange { background: var(--rp3-orange-bg); color: var(--rp3-orange); }
        .rp3-tag.green { background: var(--rp3-green-bg); color: var(--rp3-green); }
        .rp3-impact-top { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        .rp3-impact { padding: 11px; border: 1px solid var(--rp3-line); border-radius: 5px; background: #fbfcfd; }
        .rp3-impact strong { display: block; font-size: 17px; color: var(--rp3-navy); margin-top: 4px; }
        .rp3-impact strong.red { color: var(--rp3-red); }
        .rp3-barrow { display: flex; justify-content: space-between; gap: 10px; font-size: 10px; margin: 12px 0 5px; }
        .rp3-barrow span { color: var(--rp3-muted); }
        .rp3-track { height: 7px; background: #edf0f4; border-radius: 99px; overflow: hidden; }
        .rp3-fill { height: 100%; border-radius: 99px; background: var(--rp3-orange); }
        .rp3-fill.after { background: var(--rp3-red); }
        .rp3-note { font-size: 10px; color: var(--rp3-muted); margin-top: 9px; line-height: 1.5; }
        .rp3-timeline { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 14px; padding: 15px; }
        @media (max-width: 860px) { .rp3-timeline { grid-template-columns: 1fr; } }
        .rp3-event { border: 1px solid var(--rp3-line); border-radius: 5px; overflow: hidden; }
        .rp3-eventhead { padding: 9px 11px; background: #fafbfd; border-bottom: 1px solid var(--rp3-line); display: flex; justify-content: space-between; gap: 8px; align-items: center; }
        .rp3-eventhead b { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; }
        .rp3-eventbody { padding: 12px; }
        .rp3-eventdate { font-size: 12px; font-weight: 800; color: var(--rp3-navy); margin: 2px 0 7px; }
        .rp3-eventdesc { font-size: 10px; color: var(--rp3-muted); line-height: 1.65; }
        .rp3-event.detect .rp3-eventhead { border-top: 3px solid #668b78; }
        .rp3-event.order .rp3-eventhead { border-top: 3px solid #d2a04a; }
        .rp3-event.delivery .rp3-eventhead { border-top: 3px solid var(--rp3-red); }
        .rp3-stockrow { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 10px; padding: 14px; }
        @media (max-width: 860px) { .rp3-stockrow { grid-template-columns: repeat(2, minmax(0,1fr)); } }
        .rp3-stock { border: 1px solid var(--rp3-line); background: #fafbfd; border-radius: 5px; padding: 11px; min-width: 0; }
        .rp3-stock .num { font-size: 19px; font-weight: 850; margin: 4px 0; color: var(--rp3-navy); }
        .rp3-stock .num.red { color: var(--rp3-red); }
        .rp3-stock .num.amber { color: var(--rp3-orange); }
        .rp3-stock .num.green { color: var(--rp3-green); }
        .rp3-stock small { font-size: 10px; color: var(--rp3-muted); line-height: 1.5; display: block; }
        .rp3-actions { padding: 14px; display: flex; flex-direction: column; gap: 10px; }
        .rp3-todo { border: 1px solid var(--rp3-line); border-radius: 5px; padding: 12px; display: flex; gap: 10px; }
        .rp3-todo .n { width: 24px; height: 24px; flex: 0 0 24px; display: grid; place-items: center; border-radius: 5px; background: var(--rp3-blue-bg); color: var(--rp3-blue); font-weight: 850; }
        .rp3-todo b { font-size: 11px; display: block; margin-bottom: 4px; }
        .rp3-todo p { font-size: 10px; color: var(--rp3-muted); margin: 0; line-height: 1.55; }
        .rp3-tablewrap { overflow: auto; }
        .rp3-tablewrap table { border-collapse: collapse; width: 100%; font-size: 10px; }
        .rp3-tablewrap th, .rp3-tablewrap td { padding: 11px 13px; text-align: left; border-bottom: 1px solid var(--rp3-line); white-space: nowrap; }
        .rp3-tablewrap th { background: #fafbfd; color: var(--rp3-muted); text-transform: uppercase; letter-spacing: .06em; font-size: 9px; font-weight: 700; }
        .rp3-tablewrap tbody tr:last-child td { border-bottom: 0; }
        .rp3-tablewrap tbody tr:hover { background: #fafbfd; }
        .rp3-footer { display: flex; justify-content: space-between; gap: 12px; color: var(--rp3-muted); font-size: 10px; margin-top: 13px; }
        @media (max-width: 700px) { .rp3-footer { display: block; } .rp3-footer span { display: block; margin-top: 5px; } }
      `}</style>

      <button type="button" className="rp3-back" onClick={() => navigate(backTo || '/stockouts')}>
        <iconify-icon icon="solar:arrow-left-linear"></iconify-icon> Retour aux ruptures
      </button>

      {error ? (
        <div className="alert alert-danger">Erreur : {error}</div>
      ) : detail === null ? (
        <div className="text-muted small">Chargement des données de rupture...</div>
      ) : (
        <div className="rp3">
          <div className="rp3-crumb">Pilotage / Ruptures de stock / {detail.sector || 'Sans secteur'} / <b>{detail.label || detail.ean}</b></div>

          <div className="rp3-header">
            <div>
              <div className="rp3-ref">Rapport incident · N° {detail.ean} · EAN {detail.ean}</div>
              <h2>{detail.label || detail.ean}</h2>
              <div className="rp3-sub">{detail.department || 'Sans rayon'} · {detail.sector || 'Sans secteur'}</div>
            </div>
            <span className={`rp3-status ${detail.status !== 'EN_COURS' ? 'resolved' : ''}`}>
              <span className="rp3-dot"></span>
              {detail.status === 'EN_COURS' ? 'RUPTURE ACTIVE' : 'RÉSOLUE'}
            </span>
          </div>

          {isLongDuration && (
            <div className="rp3-callout warn">
              <span>⚠</span>
              <div><b>Incident à traiter.</b> Cette rupture dépasse {detail.deliveryDeadlineHours}h ({formatDuration(liveDurations?.totalHours ?? null)}) — vérifiez si une commande a été passée.</div>
            </div>
          )}

          {detail.deliveryLooksDoubtful && (
            <div className="rp3-callout danger">
              <span>⚠</span>
              <div><b>Livraison douteuse.</b> Réception estimée depuis le {detail.order?.actualReceptionDate ? formatDateTime(detail.order.actualReceptionDate) : '—'}, mais la rupture est toujours en cours et aucun mouvement de réception n'apparaît dans l'historique — l'article n'est probablement pas réellement revenu en rayon, malgré le statut RPOS.</div>
            </div>
          )}

          {detail.deliveryDelay && (
            <div className="rp3-callout danger">
              <span>⚠</span>
              <div>
                <b>Livraison en retard ({detail.deliveryDelay.daysLate} j).</b> Attendue le {formatDateTime(detail.deliveryDelay.expectedReceptionDate)}, toujours pas reçue.
                {detail.deliveryDelay.likelyInvoiceIntegrationIssue
                  ? " Les 3 créneaux d'intégration des factures entrepôt (12h, 17h, 23h) sont déjà passés depuis cette date sans qu'aucun arrivage n'apparaisse — l'intégration a probablement échoué côté entrepôt plutôt qu'un simple retard de transport."
                  : ` En attente du prochain créneau d'intégration facture (${detail.deliveryDelay.invoiceSlotsPassedWithoutArrival}/3 déjà passés sans arrivage détecté).`}
              </div>
            </div>
          )}

          {reactionMeta && (
            <div className={`rp3-callout ${reactionMeta.tone === 'critical' ? 'danger' : reactionMeta.tone === 'warning' ? 'warn' : reactionMeta.tone === 'success' ? 'good' : 'warn'}`}>
              <span>{reactionMeta.tone === 'success' ? '✓' : '⚠'}</span>
              <div><b>{reactionMeta.label}.</b> {reactionMeta.verdict}</div>
            </div>
          )}

          <div className="rp3-section-title">Synthèse opérationnelle</div>
          <section className="rp3-kpis">
            <div className="rp3-kpi">
              <div className="rp3-kpi-label">Durée depuis détection</div>
              <div className={`rp3-kpi-value ${isLongDuration ? 'orange' : ''}`} style={{ fontVariantNumeric: 'tabular-nums' }}>{formatDurationLive(liveDurations?.totalHours ?? null)}</div>
              <div className="rp3-kpi-foot">Début : <b>{formatDateTime(detail.startedAt)}</b></div>
            </div>
            <div className="rp3-kpi">
              <div className="rp3-kpi-label">CA perdu estimé</div>
              <div className="rp3-kpi-value red">{formatMoney(detail.caPerdueEstime)}</div>
              <div className="rp3-kpi-foot">{detail.qtyPerdueEstimee !== null ? `${Math.round(detail.qtyPerdueEstimee)} unité(s)` : 'Estimation indisponible'}</div>
            </div>
            <div className="rp3-kpi">
              <div className="rp3-kpi-label">Commande pendant la rupture</div>
              <div className="rp3-kpi-value">{detail.order ? (detail.order.quantityOrdered ?? '—') : '—'}</div>
              <div className="rp3-kpi-foot">{detail.order ? <>N° <b>{detail.order.rposOrderReference || detail.order.id.slice(0, 10)}</b> · {formatDate(detail.order.createdAt)}</> : 'Aucune commande'}</div>
            </div>
            <div className="rp3-kpi">
              <div className="rp3-kpi-label">Stock actuel signalé</div>
              <div className={`rp3-kpi-value ${detail.stockRpos && detail.stockRpos.value < 0 ? 'red' : ''}`}>{detail.stockRpos ? `${detail.stockRpos.value} u.` : '—'}</div>
              <div className="rp3-kpi-foot">{detail.stockRpos && detail.stockRpos.value < 0 ? 'Anomalie de stock à investiguer' : 'Stock RPOS temps réel'}</div>
            </div>
          </section>

          <div className="rp3-section-title">Comprendre l'incident</div>
          <div className="row g-3 mb-3">
            <div className="col-12 col-lg-6">
              <section className="rp3-panel">
                <div className="rp3-panelhead"><h3>Référentiel article</h3><span>Identification &amp; prix</span></div>
                <div className="rp3-panelbody">
                  <div className="rp3-fields">
                    <div><div className="rp3-label">Article</div><div className="rp3-value">{detail.label || detail.ean}</div></div>
                    <div><div className="rp3-label">EAN</div><div className="rp3-value">{detail.ean}</div></div>
                    <div><div className="rp3-label">Rayon</div><div className="rp3-value">{detail.department || 'Sans rayon'}</div></div>
                    <div><div className="rp3-label">Secteur</div><div className="rp3-value">{detail.sector || 'Sans secteur'}</div></div>
                    <div><div className="rp3-label">Prix de vente unitaire</div><div className="rp3-value">{formatMoney(detail.sellingPrice)}</div></div>
                    <div><div className="rp3-label">Marge unitaire</div><div className="rp3-value">{detail.sellingPrice !== null && detail.buyingPrice !== null ? formatMoney(detail.sellingPrice - detail.buyingPrice) : '—'}</div></div>
                    <div><div className="rp3-label">Cause probable</div><div className="rp3-value">{CAUSE_LABELS[detail.causeProposee] || detail.causeProposee}</div></div>
                    <div><div className="rp3-label">Confiance</div><div className="rp3-value">{detail.niveauConfiance.toLowerCase()} <span className="rp3-tag">À confirmer</span></div></div>
                  </div>
                </div>
              </section>
            </div>
            <div className="col-12 col-lg-6">
              <section className="rp3-panel">
                <div className="rp3-panelhead"><h3>Impact estimé de la rupture</h3><span>Ventilation temporelle</span></div>
                <div className="rp3-panelbody">
                  <div className="rp3-impact-top">
                    <div className="rp3-impact">
                      <div className="rp3-label">Avant commande</div>
                      <strong>{formatMoney(detail.lossBeforeOrder?.caPerdue ?? null)}</strong>
                      <div className="rp3-note">{formatDurationLive(liveDurations?.beforeOrderHours ?? null)} de rupture</div>
                    </div>
                    <div className="rp3-impact">
                      <div className="rp3-label">Après commande</div>
                      <strong className="red">{formatMoney(detail.lossAfterOrder?.caPerdue ?? null)}</strong>
                      <div className="rp3-note">{formatDurationLive(liveDurations?.afterOrderHours ?? null)} de rupture</div>
                    </div>
                  </div>
                  <div className="rp3-barrow"><span>Perte avant commande</span><b>{formatMoney(detail.lossBeforeOrder?.caPerdue ?? null)}</b></div>
                  <div className="rp3-track"><div className="rp3-fill" style={{ width: lossBarWidths.before }}></div></div>
                  <div className="rp3-barrow"><span>Perte après commande</span><b>{formatMoney(detail.lossAfterOrder?.caPerdue ?? null)}</b></div>
                  <div className="rp3-track"><div className="rp3-fill after" style={{ width: lossBarWidths.after }}></div></div>
                  <div className="rp3-note">Somme des deux périodes : <b>{formatMoney(lossSum)}</b>.{lossGap !== null && Math.abs(lossGap) > 1 ? <> Le total affiché de {formatMoney(detail.caPerdueEstime)} présente un écart de <b>{formatMoney(Math.abs(lossGap))}</b> à expliquer.</> : null}</div>
                </div>
              </section>
            </div>
          </div>

          <section className="rp3-panel mb-3">
            <div className="rp3-panelhead"><h3>Chronologie et prise en charge</h3><span>Dates enregistrées</span></div>
            <div className="rp3-timeline">
              <article className="rp3-event detect">
                <div className="rp3-eventhead"><b>1 · Détection</b><span className="rp3-tag green">Confirmée</span></div>
                <div className="rp3-eventbody">
                  <div className="rp3-label">Début de rupture</div>
                  <div className="rp3-eventdate">{formatDateTime(detail.startedAt)}</div>
                  <div className="rp3-eventdesc">Le système détecte une rupture. Compteur {detail.status === 'EN_COURS' ? 'toujours actif' : 'arrêté à la résolution'}.</div>
                </div>
              </article>
              <article className="rp3-event order">
                <div className="rp3-eventhead"><b>2 · Commande fournisseur</b><span className={`rp3-tag ${detail.order?.validatedAt ? 'green' : 'orange'}`}>{detail.order ? (detail.order.validatedAt ? 'Validée' : 'À valider') : 'Aucune'}</span></div>
                <div className="rp3-eventbody">
                  {detail.order ? (
                    <>
                      <div className="rp3-label">Commande n° {detail.order.rposOrderReference || detail.order.id.slice(0, 10)}</div>
                      <div className="rp3-eventdate">{formatDateTime(detail.order.createdAt)}</div>
                      <div className="rp3-eventdesc">
                        Quantité : {detail.order.quantityOrdered ?? '—'} unité(s)<br />
                        Fournisseur : {detail.order.supplierName || '—'}{detail.order.deliveryType ? ` (${detail.order.deliveryType})` : ''}<br />
                        Créée par : {detail.order.createdBy || 'inconnu'}<br />
                        Statut : {detail.order.validatedAt ? `validée le ${formatDateTime(detail.order.validatedAt)}${detail.order.validatedBy ? ` par ${detail.order.validatedBy}` : ''}` : 'pas encore validée'}
                      </div>
                    </>
                  ) : (
                    <div className="rp3-eventdesc">Aucune commande passée depuis le début de la rupture.</div>
                  )}
                </div>
              </article>
              <article className="rp3-event delivery">
                <div className="rp3-eventhead"><b>3 · Livraison</b><span className={`rp3-tag ${detail.deliveryLooksDoubtful || detail.deliveryDelay ? 'red' : detail.order?.actualReceptionDate ? 'green' : 'orange'}`}>{detail.deliveryLooksDoubtful ? 'À rapprocher' : detail.deliveryDelay ? 'En retard' : detail.order?.actualReceptionDate ? 'Estimée reçue' : 'En attente'}</span></div>
                <div className="rp3-eventbody">
                  {detail.order ? (
                    <>
                      <div className="rp3-label">{detail.order.actualReceptionDate ? 'Date de réception' : 'Date prévue'}</div>
                      <div className="rp3-eventdate">{detail.order.actualReceptionDate ? formatDateTime(detail.order.actualReceptionDate) : detail.order.expectedReceptionDate ? formatDate(detail.order.expectedReceptionDate) : '—'}</div>
                      <div className="rp3-eventdesc">
                        {detail.order.actualReceptionDate
                          ? `Statut déclaré « ${RECEPTION_STATUS_LABELS[detail.order.receptionStatus] || detail.order.receptionStatus} ». ${detail.deliveryLooksDoubtful ? "Aucun mouvement de réception ne le confirme dans les données visibles." : ''}`
                          : 'Pas encore reçue.'}
                      </div>
                    </>
                  ) : (
                    <div className="rp3-eventdesc">—</div>
                  )}
                </div>
              </article>
            </div>
            {(detail.deliveryLooksDoubtful || detail.deliveryDelay) && (
              <div className="rp3-callout danger" style={{ margin: '0 15px 15px' }}>
                <span>⚠</span>
                <div><b>Incohérence commande / réception :</b> ne pas considérer la rupture comme résolue tant qu'un mouvement de réception ou un stock magasin cohérent n'a pas été observé.</div>
              </div>
            )}
          </section>

          <div className="row g-3 mb-3">
            <div className="col-12 col-lg-6">
              <section className="rp3-panel">
                <div className="rp3-panelhead"><h3>Contrôle des stocks</h3><span>Valeurs de la fiche</span></div>
                <div className="rp3-stockrow">
                  <div className="rp3-stock">
                    <div className="rp3-label">Au début</div>
                    <StockValueRp3 stock={detail.stockAtStart} />
                  </div>
                  <div className="rp3-stock">
                    <div className="rp3-label">{detail.status === 'EN_COURS' ? 'Actuellement' : 'Dernier relevé'}</div>
                    <StockValueRp3 stock={detail.stockCurrent} />
                  </div>
                  <div className="rp3-stock">
                    <div className="rp3-label">RPOS (temps réel)</div>
                    <StockValueRp3 stock={detail.stockRpos ? { value: detail.stockRpos.value, capturedAt: detail.stockRpos.syncedAt } : null} />
                  </div>
                  <div className="rp3-stock">
                    <div className="rp3-label">{detail.order?.actualReceptionDate ? 'Après arrivage' : 'Résolution'}</div>
                    {detail.status === 'EN_COURS' && !detail.order?.actualReceptionDate ? (
                      <div className="num" style={{ fontSize: '14px', color: 'var(--rp3-muted)' }}>En cours</div>
                    ) : detail.order?.actualReceptionDate ? (
                      detail.stockAfterDelivery ? <StockValueRp3 stock={detail.stockAfterDelivery} /> : <div className="num" style={{ fontSize: '14px', color: 'var(--rp3-muted)' }}>Pas encore relevé</div>
                    ) : (
                      <StockValueRp3 stock={detail.stockAtEnd} />
                    )}
                  </div>
                </div>
                {detail.stockAtStart && detail.stockAtStart.value < 0 && (
                  <div className="rp3-callout warn" style={{ margin: '0 15px 15px' }}>
                    <span>⚠</span>
                    <div><b>Stock négatif :</b> signe probable d'une désynchronisation RPOS (ventes enregistrées au-delà du stock réellement disponible) plutôt que d'une rupture physique classique. Vérifier la synchronisation RPOS, les ventes et l'inventaire.</div>
                  </div>
                )}
              </section>
            </div>
            <div className="col-12 col-lg-6">
              <section className="rp3-panel">
                <div className="rp3-panelhead"><h3>Actions recommandées</h3><span>Ordre de priorité</span></div>
                <div className="rp3-actions">
                  {recommendedActions.map((a, i) => (
                    <div className="rp3-todo" key={i}>
                      <div className="n">{i + 1}</div>
                      <div><b>{a.title}</b><p>{a.desc}</p></div>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          </div>

          {detail.orderQuantitySufficiency && (
            <div className={`rp3-callout ${detail.orderQuantitySufficiency.sufficient ? 'good' : 'warn'} mb-3`}>
              <span>{detail.orderQuantitySufficiency.sufficient ? '✓' : '⚠'}</span>
              <div>Quantité commandée ({detail.orderQuantitySufficiency.quantityOrdered} u) {detail.orderQuantitySufficiency.sufficient ? 'suffisante' : 'probablement insuffisante'} face à ~{Math.round(detail.orderQuantitySufficiency.expectedDemand)} u estimées sur la période.</div>
            </div>
          )}

          <section className="rp3-panel" id="journal">
            <div className="rp3-panelhead"><h3>Journal des mouvements de stock</h3><span>Historique récent</span></div>
            <div className="rp3-tablewrap">
              <table>
                <thead><tr><th>Date / heure</th><th>Type</th><th>Quantité</th></tr></thead>
                <tbody>
                  {detail.stockMoves.length === 0 ? (
                    <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--rp3-muted)', padding: '24px 0' }}>Aucun mouvement enregistré sur la période.</td></tr>
                  ) : (
                    detail.stockMoves.slice(0, 40).map((m, i) => (
                      <tr key={i}>
                        <td>{formatDateTime(m.date)}</td>
                        <td>{m.typeLabel}{m.isScrap ? ' (casse)' : ''}</td>
                        <td>{m.quantity}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <div className="rp3-footer">
            <span>Réassort automatique · Analyse de rupture de stock</span>
            <span>Données réelles · Vérifier avant décision opérationnelle.</span>
          </div>
        </div>
      )}
    </div>
  );
}
