import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
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

type Loss = { qtyPerdue: number | null; caPerdue: number | null; method: 'SAME_WEEKDAY' | 'ALL_DAYS' | null };

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
  // 3e tranche "après arrivage, toujours en rupture" (ajoutée le 19/10/2026, demande explicite :
  // "apres arrive on a le temps apres commande et quand ya arrivage il bloque... ce temps la n'est
  // plus calculé") — non-null uniquement si un vrai arrivage a eu lieu mais que la rupture est
  // restée ouverte après (stock résiduel négatif).
  lossAfterArrival: Loss | null;
  arrivalStillOpenAt: string | null;
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
  // Réglages ACTIFS du calcul de perte (demande explicite du 19/10/2026 : "le message de la formule
  // doit etre en fonction de la config des parametre") — permet de construire un texte reflétant les
  // VRAIS réglages courants (Paramètres > Planification), jamais un texte générique figé.
  lossConfig: {
    method: 'SAME_WEEKDAY' | 'ALL_DAYS';
    lookbackWeeks: number;
    minComparableWeeks: number;
    fallbackToAllDays: boolean;
    minComparableDaysAll: number;
  };
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

// Formulations réécrites le 18/10/2026 (demande explicite : "met un texte bien explicative au pdg
// et dg... pas un struc supperieur") — un mot sec comme "magasin fautif" n'explique ni le contexte
// ni l'enjeu à un lecteur de direction qui n'a pas forcément le détail opérationnel sous les yeux.
// Chaque verdict explique maintenant le FAIT constaté, le DÉLAI de référence et la CONSÉQUENCE
// business, en une phrase complète et autoportante.
const REACTION_STATUS_META: Record<ReactionStatus, { label: string; tone: 'critical' | 'warning' | 'success' | 'info'; verdict: string }> = {
  REAGI: { label: 'Le magasin a réagi', tone: 'success', verdict: "Une commande de réassort a bien été passée pendant la rupture. À partir de cette commande, le magasin a rempli son rôle : toute perte constatée ensuite relève d'un délai de livraison fournisseur, pas d'un manque de réaction en magasin." },
  EN_ATTENTE: { label: 'En attente de commande (< 24h)', tone: 'info', verdict: "La rupture dure depuis moins de 24 heures et aucune commande n'a encore été passée. Ce délai reste dans la norme opérationnelle ; aucune conclusion ne peut être tirée à ce stade." },
  RETARD: { label: 'Retard de commande (24-48h)', tone: 'warning', verdict: "La rupture dure depuis 24 à 48 heures sans qu'aucune commande n'ait été passée. Le délai normal de réaction est dépassé, mais pas encore le seuil (48h) à partir duquel la situation est considérée comme anormale." },
  MAGASIN_NA_PAS_REAGI: { label: "Le magasin n'a pas réagi (> 48h)", tone: 'critical', verdict: "Plus de 48 heures se sont écoulées depuis le début de la rupture, avec des ventes constatées sur l'article, sans qu'aucune commande de réassort n'ait été passée. Ce délai dépasse largement le temps de réaction attendu d'un magasin et explique directement la perte de chiffre d'affaires enregistrée sur cette période." },
  STOCK_PEUT_ETRE_PAS_A_JOUR: { label: 'Stock potentiellement pas à jour', tone: 'info', verdict: "Aucune vente ni commande n'a été enregistrée depuis le début de la rupture, ce qui peut signifier que le stock à zéro affiché par le système ne reflète pas la réalité du rayon (désynchronisation informatique). Une vérification physique est nécessaire avant de conclure." },
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

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function formatMoney(value: number | null): string {
  if (value === null) return '—';
  return `${Math.round(value).toLocaleString('fr-FR')} CFA`;
}

// Ajouté le 19/10/2026 (demande explicite : "affiche la formule de calcule pour la perte" puis
// "pour affiche la formule de calcule il faut ajouter un bouton a coté pour voir la formule utilisé
// et l'explication de pourquoi cette formmule") — un simple `title` HTML (tooltip au survol) était
// peu visible/peu pratique sur mobile ; remplacé par un vrai bouton ⓘ cliquable qui ouvre une
// explication en dur dans la page (formule + pourquoi ce choix de méthode).
// Modale d'explication de formule — demande explicite du 19/10/2026 ("met a jour les note sur les
// formule sur le U et donne une style bien defini") : présentée en ÉTAPES numérotées plutôt qu'une
// seule phrase dense, avec un exemple chiffré concret, pour que le calcul (en particulier la
// décomposition jour par jour, cf. estimateLoss corrigé le même jour) soit lisible d'un coup d'œil.
type FormulaStep = { label: string; detail: string };
export function FormulaInfoButton({
  title,
  steps,
  example,
  note,
}: {
  title: string;
  steps: FormulaStep[];
  example?: string;
  note?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Voir la formule de calcul"
        style={{
          border: 'none', background: 'rgba(27,42,74,.08)', color: '#5B6B85', borderRadius: '50%',
          width: 16, height: 16, fontSize: '.68rem', lineHeight: '16px', padding: 0, marginLeft: 4,
          cursor: 'pointer', verticalAlign: 'middle',
        }}
      >
        i
      </button>
      {open && createPortal(
        // RE-CORRIGÉ le 19/10/2026 (signalé une 3e fois avec capture : la modale restait collée en
        // haut à gauche, visiblement coincée dans une boîte au lieu de couvrir tout l'écran) — un
        // `position: fixed` est positionné relativement à l'ancêtre le plus proche qui a un
        // `transform` (ou filter/perspective) appliqué, PAS forcément à la fenêtre : `.ep2-card:hover
        // { transform: translateY(-2px); }` (StockoutEpisodePage.tsx) crée justement ce piège pour
        // tout bouton ⓘ rendu à l'intérieur d'une `.ep2-card`. Rendu maintenant via un PORTAL React
        // directement sous `document.body`, en dehors de toute hiérarchie DOM affectée par un
        // `transform` d'ancêtre — la modale n'est plus jamais piégée dans la boîte d'une carte.
        //
        // Fermer sur `onMouseDown` (et seulement si le clic démarre ET finit sur l'overlay lui-même)
        // plutôt que `onClick`, pour ne pas se déclencher après un clic-glisser de sélection de texte
        // qui déborderait sur la zone semi-transparente ; `userSelect: 'none'` sur l'overlay empêche
        // toute sélection accidentelle de démarrer en dehors de la boîte de texte.
        <div
          onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
          style={{
            position: 'fixed', inset: 0, zIndex: 1040, background: 'rgba(27,42,74,.4)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
            userSelect: 'none',
          }}
        >
          <div
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              background: '#fff', border: '1px solid rgba(27,42,74,.12)', borderRadius: 12,
              boxShadow: '0 12px 32px rgba(27,42,74,.3)', padding: '18px 20px',
              width: 'min(420px, 100%)', maxHeight: '82vh', overflowY: 'auto',
              fontSize: '.82rem', color: '#2A2F45', fontWeight: 400, lineHeight: 1.5,
              userSelect: 'text',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 14 }}>
              <div style={{ fontWeight: 700, color: '#1B2A4A', fontSize: '.95rem' }}>{title}</div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Fermer"
                style={{ border: 'none', background: 'transparent', color: '#8591A0', fontSize: '1.2rem', lineHeight: 1, padding: 0, cursor: 'pointer' }}
              >
                ×
              </button>
            </div>

            {steps.map((step, i) => (
              <div key={i} style={{ display: 'flex', gap: 10, marginBottom: i < steps.length - 1 ? 10 : 0 }}>
                <div
                  style={{
                    flexShrink: 0, width: 20, height: 20, borderRadius: '50%', background: '#1B2A4A',
                    color: '#fff', fontSize: '.7rem', fontWeight: 700, display: 'flex',
                    alignItems: 'center', justifyContent: 'center', marginTop: 1,
                  }}
                >
                  {i + 1}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, color: '#1B2A4A', marginBottom: 2 }}>{step.label}</div>
                  <div style={{ color: '#5B6B85', fontSize: '.78rem' }}>{step.detail}</div>
                </div>
              </div>
            ))}

            {example && (
              <div
                style={{
                  marginTop: 14, background: '#F6F8FB', border: '1px solid rgba(27,42,74,.08)',
                  borderRadius: 8, padding: '10px 12px',
                }}
              >
                <div style={{ fontSize: '.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.03em', color: '#8591A0', marginBottom: 4 }}>
                  Exemple
                </div>
                <div style={{ fontFamily: 'monospace', fontSize: '.78rem', color: '#2A2F45', whiteSpace: 'pre-line' }}>{example}</div>
              </div>
            )}

            {note && (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px dashed rgba(27,42,74,.12)', color: '#5B6B85', fontSize: '.76rem' }}>
                {note}
              </div>
            )}
          </div>
        </div>,
        document.body
      )}
    </span>
  );
}

const LOSS_FORMULA_TITLE = 'Comment la perte estimée est calculée';

// RÉÉCRIT le 19/10/2026 (demande explicite : "le message de la formule doit etre en fonction de la
// config des parametre") — avant, le texte dépendait uniquement de `method` (la méthode utilisée
// pour CE calcul précis), avec des nombres en dur (52 semaines, etc.) qui pouvaient décrire un
// réglage différent de la config RÉELLEMENT active si l'utilisateur avait changé les paramètres.
// Construit maintenant le texte à partir de `lossConfig` (renvoyé par getEpisodeDetail,
// stockoutEpisodeService.js), qui reflète les valeurs EXACTES actuellement configurées dans
// Paramètres > Planification (fenêtre de recul, seuils, repli).
type LossConfig = EpisodeDetail['lossConfig'];

function buildLossFormulaSteps(config: LossConfig): FormulaStep[] {
  if (config.method === 'ALL_DAYS') {
    return [
      {
        label: 'Demande attendue (moyenne tous jours confondus)',
        detail: `Vente moyenne par jour, TOUS jours de semaine confondus, calculée sur les ${config.lookbackWeeks} dernières semaines (réglage actif) — ne distingue pas lundi de samedi. Cette moyenne journalière est multipliée par le nombre de jours de la période.`,
      },
      {
        label: 'Perte = demande attendue − ventes réelles',
        detail: 'On soustrait les ventes RÉELLEMENT réalisées pendant la période. Le résultat est plafonné à 0 : jamais de perte négative.',
      },
    ];
  }
  return [
    {
      label: 'Demande attendue, jour par jour',
      detail: `Pour CHAQUE jour calendaire de la période (lundi, mardi, ...), on calcule la vente moyenne de CE jour de semaine précis sur les ${config.lookbackWeeks} dernières semaines (lundi → moyenne des lundis précédents, mardi → moyenne des mardis précédents, etc.), puis on additionne ces moyennes journalières.`,
    },
    {
      label: 'Perte = demande attendue − ventes réelles',
      detail: "On soustrait les ventes RÉELLEMENT réalisées pendant la période (un article en rupture n'est pas toujours à 0 vente strict — stock résiduel, ventes partielles). Le résultat est plafonné à 0 : jamais de perte négative.",
    },
  ];
}

function buildLossFormulaExample(config: LossConfig): string {
  if (config.method === 'ALL_DAYS') {
    return (
      'Rupture de 3 jours, moyenne tous jours confondus = 220/jour :\n' +
      '  220 × 3 jours = 660 unités attendues\n' +
      '− ventes réelles sur ces 3 jours (ex: 30)\n' +
      '= perte estimée = 630 unités'
    );
  }
  return (
    'Rupture du lundi au mercredi (3 jours) :\n' +
    '  moyenne des lundis    =  400\n' +
    '+ moyenne des mardis    =   50\n' +
    '+ moyenne des mercredis =  200\n' +
    '= demande attendue      =  650 unités\n' +
    '− ventes réelles sur ces 3 jours (ex: 30)\n' +
    '= perte estimée = 620 unités'
  );
}

function buildLossFormulaNote(config: LossConfig): string {
  if (config.method === 'ALL_DAYS') {
    return `Méthode active : « Tous les jours confondus » (choisie dans Paramètres > Planification). « — » = historique de vente insuffisant pour estimer une demande fiable (moins de ${config.minComparableDaysAll} jours de vente constatés sur la fenêtre de recul) — donnée manquante, pas une erreur.`;
  }
  const fallbackText = config.fallbackToAllDays
    ? `Si un article a moins de ${config.minComparableWeeks} semaines comparables du même jour, repli automatique sur la moyenne tous jours confondus (activé, seuil : ${config.minComparableDaysAll} jours de vente minimum) — réglable dans Paramètres > Planification.`
    : 'Le repli sur la moyenne tous jours confondus est actuellement DÉSACTIVÉ (réglable dans Paramètres > Planification) : en dessous du seuil de semaines comparables, « — » est affiché plutôt qu\'un chiffre peu fiable.';
  return `Méthode active : « Même jour de semaine », historique sur ${config.lookbackWeeks} semaines, minimum ${config.minComparableWeeks} semaines comparables (Paramètres > Planification). ${fallbackText} 0 CFA = la demande attendue était déjà très faible sur cette fenêtre précise : un résultat réel du calcul, pas une absence de donnée.`;
}

// Affiche une valeur de stock avec le code couleur demandé explicitement le 17/10/2026 : négatif
// (désynchro RPOS probable) en rouge, 0 (rupture propre) en ambre neutre, positif en vert — avec
// l'horodatage du relevé pour qu'on sache à quel moment précis cette valeur a été constatée.
function StockValue({ stock }: { stock: { value: number; capturedAt: string } | null }) {
  if (!stock) return <div className="text-muted small">—</div>;
  const tone = stock.value < 0 ? '#b8302c' : stock.value === 0 ? '#a86718' : '#2d6a3f';
  return (
    <div>
      <div style={{ fontSize: '1.1rem', fontWeight: 700, color: tone }}>{stock.value} {Math.abs(stock.value) === 1 ? 'unité' : 'unités'}</div>
      <div className="text-muted" style={{ fontSize: '.7rem' }}>{formatDateTime(stock.capturedAt)}</div>
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

  // Analyse IA à la demande (bouton, jamais automatique) de la section "Détection / Commande /
  // Prise en charge" — demande explicite du 18/10/2026 : "cette partie aussi on doit avoir une
  // analyse Ia". Réinitialisée à chaque changement d'épisode, jamais conservée d'une fiche à l'autre.
  const [episodeAnalysis, setEpisodeAnalysis] = useState<{ summary: string; action: string; providerUsed: string } | null>(null);
  const [analyzingEpisode, setAnalyzingEpisode] = useState(false);
  const [episodeAnalysisError, setEpisodeAnalysisError] = useState<string | null>(null);

  useEffect(() => {
    if (!episodeId) return;
    let cancelled = false;
    setDetail(null);
    setError(null);
    setEpisodeAnalysis(null);
    setEpisodeAnalysisError(null);
    apiFetch<EpisodeDetail>(`/reassort/stockout-episodes/${episodeId}`)
      .then((data) => { if (!cancelled) setDetail(data); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [episodeId]);

  async function runEpisodeAnalysis() {
    if (!episodeId) return;
    setAnalyzingEpisode(true);
    setEpisodeAnalysisError(null);
    try {
      const data = await apiFetch<{ summary: string; action: string; providerUsed: string }>(
        `/reassort/stockout-episodes/${episodeId}/analyze`,
        { method: 'POST' }
      );
      setEpisodeAnalysis(data);
    } catch (err) {
      setEpisodeAnalysisError(err instanceof Error ? err.message : String(err));
    } finally {
      setAnalyzingEpisode(false);
    }
  }

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
    // 3e tranche (ajoutée le 19/10/2026) : si un arrivage réel a eu lieu mais que la rupture est
    // restée ouverte, "après commande" se borne désormais à l'arrivage (cohérent avec
    // lossAfterOrder/lossAfterArrival côté backend), et une tranche distincte prend le relais.
    const arrivalAt = detail.arrivalStillOpenAt ? new Date(detail.arrivalStillOpenAt).getTime() : null;

    const beforeOrderEnd = orderCreatedAt !== null ? orderCreatedAt : endedAt;
    const beforeOrderHours = Math.max(0, (beforeOrderEnd - startedAt) / (60 * 60 * 1000));

    let afterOrderHours = null;
    if (orderCreatedAt !== null) {
      const afterOrderEnd = arrivalAt !== null && arrivalAt < endedAt ? arrivalAt : endedAt;
      afterOrderHours = Math.max(0, (afterOrderEnd - orderCreatedAt) / (60 * 60 * 1000));
    }

    let afterArrivalHours = null;
    if (arrivalAt !== null) {
      afterArrivalHours = Math.max(0, (endedAt - arrivalAt) / (60 * 60 * 1000));
    }

    const totalHours = Math.max(0, (endedAt - startedAt) / (60 * 60 * 1000));

    return { beforeOrderHours, afterOrderHours, afterArrivalHours, totalHours };
  })();

  const isLongDuration = liveDurations ? liveDurations.totalHours >= (detail?.deliveryDeadlineHours ?? 48) : false;

  return (
    <div className="container-fluid py-4">
      <style>{`
        /* Habillage clair demandé explicitement le 18/10/2026 ("le bande bleu en haut il faut faire
           un style claire pas sombre... donne moi un style plus jolie") — même structure qu'avant
           (header + 4 tuiles + timeline + cartes), mais fond blanc/clair partout, accents de couleur
           sur les icônes et les bordures plutôt que des blocs pleins sombres. */
        .ep2-crumb-back { background: #fff; border: 1px solid #E4E9F0; color: #1B2A4A; font-size: .82rem; font-weight: 600; display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border-radius: 10px; margin-bottom: 14px; transition: background .15s, box-shadow .15s; }
        .ep2-crumb-back:hover { background: #F6F8FB; box-shadow: 0 1px 4px rgba(27,42,74,.08); }

        .ep2-alert { background: linear-gradient(0deg,#FFF8ED,#FFF8ED); border: 1px solid #F5D9A8; color: #8a5a10; border-radius: 12px; padding: 13px 18px; display: flex; align-items: center; gap: 12px; font-size: .86rem; margin-bottom: 18px; box-shadow: 0 1px 3px rgba(154,110,20,.08); }

        .ep2-header { background: #fff; border: 1px solid #E8ECF2; border-radius: 16px; padding: 26px 28px; color: #1B2A4A; margin-bottom: 18px; box-shadow: 0 2px 10px rgba(27,42,74,.05); position: relative; overflow: hidden; }
        .ep2-header::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 4px; background: linear-gradient(90deg,#F5A623,#F2C879); }
        .ep2-header-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
        .ep2-header .eyebrow { font-size: .7rem; letter-spacing: .08em; text-transform: uppercase; color: #8591A0; font-weight: 700; margin-bottom: 6px; }
        .ep2-header h2 { font-size: 1.6rem; font-weight: 800; margin: 0 0 6px; color: #1B2A4A; letter-spacing: -.01em; }
        .ep2-header .meta { font-size: .85rem; color: #5B6B85; }
        .ep2-status-badge { display: inline-flex; align-items: center; gap: 7px; padding: 7px 16px; border-radius: 999px; font-size: .78rem; font-weight: 700; white-space: nowrap; }
        .ep2-status-badge.active { background: #FDEEEC; color: #C0392B; border: 1px solid #F6D4CF; }
        .ep2-status-badge.resolved { background: #E9F7EF; color: #1E8449; border: 1px solid #C8E9D4; }
        .ep2-tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-top: 22px; }
        @media (max-width: 860px) { .ep2-tiles { grid-template-columns: repeat(2, 1fr); } }
        .ep2-tile { background: #FAFBFD; border: 1px solid #EEF1F6; border-radius: 12px; padding: 14px 16px; transition: box-shadow .15s; }
        .ep2-tile:hover { box-shadow: 0 2px 8px rgba(27,42,74,.06); }
        .ep2-tile .lbl { font-size: .66rem; text-transform: uppercase; letter-spacing: .05em; color: #8591A0; font-weight: 700; margin-bottom: 5px; }
        .ep2-tile .val { font-size: 1.15rem; font-weight: 800; color: #1B2A4A; }
        .ep2-tile .val.warn { color: #D98324; }
        .ep2-tile .sub { font-size: .7rem; color: #8591A0; margin-top: 3px; }

        .ep2-timeline { background: #fff; border: 1px solid #E8ECF2; border-radius: 16px; padding: 20px 24px; margin-bottom: 18px; display: flex; align-items: center; gap: 0; box-shadow: 0 2px 10px rgba(27,42,74,.04); }
        .ep2-timeline-pt { display: flex; flex-direction: column; gap: 3px; min-width: 120px; }
        .ep2-timeline-pt.end { text-align: right; align-items: flex-end; }
        .ep2-timeline-pt .lbl { font-size: .66rem; text-transform: uppercase; letter-spacing: .05em; color: #8591A0; font-weight: 700; }
        .ep2-timeline-pt .date { font-size: .85rem; color: #1B2A4A; font-weight: 600; }
        .ep2-timeline-pt .time { font-size: 1rem; font-weight: 800; }
        .ep2-timeline-mid { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 0 20px; }
        .ep2-timeline-mid .arrow { color: #F5A623; font-size: 1.2rem; }
        .ep2-timeline-mid .dur { font-size: 1.2rem; font-weight: 800; color: #1B2A4A; }
        .ep2-timeline-mid .sub { font-size: .68rem; color: #8591A0; }

        .ep2-card { background: #fff; border: 1px solid #E8ECF2; border-radius: 16px; height: 100%; box-shadow: 0 2px 10px rgba(27,42,74,.04); }
        .ep2-card-head { padding: 14px 20px; border-bottom: 1px solid #F0F3F7; font-weight: 700; font-size: .8rem; color: #1B2A4A; display: flex; align-items: center; gap: 10px; text-transform: uppercase; letter-spacing: .04em; }
        .ep2-card-head > iconify-icon:first-child, .ep2-card-head > span > iconify-icon:first-child { width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; border-radius: 8px; background: #FEF3E2; color: #D98324; font-size: 15px; }
        /* Header avec titre + action (demande explicite du 18/10/2026 : "le bouton analyse ai il
           faut le bien placé en haut") — bouton "Analyser avec l'IA" aligné à droite du titre de
           section plutôt qu'enterré en bas de carte. */
        .ep2-card-head-row { justify-content: space-between; text-transform: none; letter-spacing: normal; }
        .ep2-card-head-row > span { display: flex; align-items: center; gap: 10px; text-transform: uppercase; letter-spacing: .04em; }
        .ep2-card-body { padding: 18px 20px; }
        .ep2-field dt { font-size: .68rem; text-transform: uppercase; letter-spacing: .05em; color: #8591A0; font-weight: 700; margin-bottom: 3px; }
        .ep2-field dd { font-size: .86rem; color: #1B2A4A; font-weight: 600; margin: 0 0 14px; }
        .ep2-field dd.accent { color: #2f5a85; }
        .ep2-field dd.money { color: #C0392B; }
        .ep2-badge { display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; border-radius: 999px; font-size: .74rem; font-weight: 700; }
        .ep2-badge.tone-critical { background: #FDEEEC; color: #C0392B; }
        .ep2-badge.tone-warning { background: #FEF3E2; color: #B06A0B; }
        .ep2-badge.tone-success { background: #E9F7EF; color: #1E8449; }
        .ep2-badge.tone-info { background: #EAF1FB; color: #2f5a85; }
        .ep2-verdict { border-radius: 12px; padding: 13px 16px; font-size: .84rem; margin-top: 12px; line-height: 1.5; }
        .ep2-verdict.tone-critical { background: #FDEEEC; color: #9E2B20; border: 1px solid #F6D4CF; }
        .ep2-verdict.tone-warning { background: #FEF3E2; color: #8a5a10; border: 1px solid #F5D9A8; }
        .ep2-verdict.tone-success { background: #E9F7EF; color: #1E6B3C; border: 1px solid #C8E9D4; }
        .ep2-verdict.tone-info { background: #EAF1FB; color: #27486B; border: 1px solid #D2E0F2; }
        .ep2-loss-split { display: flex; gap: 12px; }
        .ep2-loss-split > div { flex: 1; border-radius: 10px; padding: 12px 14px; background: #FAFBFD; border: 1px solid #EEF1F6; }
        .ep2-loss-split .lbl { font-size: .66rem; text-transform: uppercase; color: #8591A0; font-weight: 700; margin-bottom: 3px; }
        .ep2-loss-split .val { font-size: 1rem; font-weight: 800; color: #1B2A4A; }

        /* 3 cartes timeline "Détection / Commande / Livraison" (demande explicite du 18/10/2026,
           sur le modèle de rapport_rupture_stock_v3.html) + animations/hover plus visibles sur
           l'ensemble de la page ("il faut faire un bon style avec les hover visible et dan
           animation"). fadeInUp joue une seule fois à l'arrivée sur la fiche (pas en boucle, pas
           sur les mises à jour du chronomètre live) — chaque carte démarre décalée pour un effet de
           cascade léger plutôt que tout qui apparaît d'un coup.
        */
        @keyframes ep2-fade-in-up { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        .ep2-card, .ep2-header, .ep2-timeline { animation: ep2-fade-in-up .35s ease-out backwards; }

        .ep2-card { transition: box-shadow .2s ease, transform .2s ease; }
        .ep2-card:hover { box-shadow: 0 6px 20px rgba(27,42,74,.09); transform: translateY(-2px); }

        .ep2-steps { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 16px; }
        @media (max-width: 860px) { .ep2-steps { grid-template-columns: 1fr; } }
        .ep2-step { border: 1px solid #E8ECF2; border-radius: 12px; overflow: hidden; background: #fff; transition: box-shadow .2s ease, transform .2s ease, border-color .2s ease; }
        .ep2-step:hover { box-shadow: 0 6px 18px rgba(27,42,74,.1); transform: translateY(-3px); border-color: #DCE3EC; }
        .ep2-step-head { padding: 11px 14px; background: #FAFBFD; border-bottom: 1px solid #F0F3F7; display: flex; justify-content: space-between; align-items: center; gap: 8px; position: relative; }
        .ep2-step-head::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px; }
        .ep2-step.detect .ep2-step-head::before { background: #4FA87A; }
        .ep2-step.order .ep2-step-head::before { background: #D2A04A; }
        .ep2-step.delivery .ep2-step-head::before { background: #C0392B; }
        .ep2-step-head b { font-size: .72rem; text-transform: uppercase; letter-spacing: .04em; color: #1B2A4A; }
        .ep2-step-body { padding: 14px; }
        .ep2-step-lbl { font-size: .66rem; text-transform: uppercase; letter-spacing: .05em; color: #8591A0; font-weight: 700; margin-bottom: 3px; }
        .ep2-step-date { font-size: .88rem; font-weight: 800; color: #1B2A4A; margin-bottom: 7px; }
        .ep2-step-desc { font-size: .76rem; color: #5B6B85; line-height: 1.6; }

        /* Hover visible sur tuiles/badges/boutons déjà présents sur la page — manquait de feedback
           interactif sur les éléments non cliquables mais survolables ("c'est trop simple on a pas
           de bon style"). */
        .ep2-badge { transition: transform .15s ease; }
        .ep2-badge:hover { transform: scale(1.05); }
        .ep2-status-badge { transition: transform .15s ease, box-shadow .15s ease; }
        .ep2-status-badge:hover { transform: scale(1.03); box-shadow: 0 2px 8px rgba(27,42,74,.1); }

        /* Blocs "Avant/Après commande" de Métriques temporelles (demande explicite du 18/10/2026 :
           "affiche heure de debut et fin... bien separe les info") — chaque bloc est une carte à
           part entière (bordure + fond légèrement distinct), regroupant borne de temps, durée et
           perte, plutôt que 4 chiffres isolés dans une grille sans contexte visuel. */
        .ep2-metric-block { border: 1px solid #EEF1F6; border-radius: 12px; padding: 14px 16px; margin-bottom: 12px; background: #FAFBFD; transition: box-shadow .2s ease; }
        .ep2-metric-block:last-child { margin-bottom: 0; }
        .ep2-metric-block:hover { box-shadow: 0 4px 14px rgba(27,42,74,.07); }
        .ep2-metric-block.before { border-left: 3px solid #2f5a85; }
        .ep2-metric-block.after { border-left: 3px solid #C0392B; }
        .ep2-metric-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: .72rem; text-transform: uppercase; letter-spacing: .05em; font-weight: 700; color: #1B2A4A; margin-bottom: 8px; }
        .ep2-live-dot { color: #C0392B; font-size: .68rem; font-weight: 700; }
        .ep2-metric-range { display: flex; align-items: center; gap: 8px; font-size: .8rem; color: #5B6B85; font-weight: 600; margin-bottom: 12px; flex-wrap: wrap; }
        .ep2-metric-range iconify-icon { color: #B8C1CE; font-size: .9rem; }
        .ep2-metric-figures { display: flex; gap: 20px; }
        .ep2-metric-lbl { font-size: .64rem; text-transform: uppercase; letter-spacing: .04em; color: #8591A0; font-weight: 700; margin-bottom: 3px; }
        .ep2-metric-val { font-size: 1rem; font-weight: 800; color: #1B2A4A; }
        .ep2-metric-val.accent { color: #2f5a85; }
        .ep2-metric-val.money { color: #C0392B; }
        .ep2-metric-empty { font-size: .78rem; color: #8591A0; font-style: italic; }

        /* Analyse IA à la demande sur la fiche d'un épisode (demande explicite du 18/10/2026). */
        .ep2-ai-box { background: #f8fafb; border-left: 3px solid #4A3FB8; border-radius: 0 10px 10px 0; padding: 16px 18px; box-shadow: 0 2px 10px rgba(74,63,184,.06); animation: ep2-fade-in-up .25s ease-out; }
        .ep2-ai-head { display: flex; align-items: center; gap: 7px; color: #4A3FB8; font-size: .76rem; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; margin-bottom: 10px; }
        .ep2-ai-section-lbl { font-size: .64rem; text-transform: uppercase; letter-spacing: .05em; color: #8591A0; font-weight: 700; margin-bottom: 4px; }
        .ep2-ai-summary { font-size: .88rem; color: #2A2F45; line-height: 1.65; margin: 0 0 14px; }
        .ep2-ai-action { display: flex; gap: 10px; align-items: flex-start; background: #EEF0FB; border-radius: 8px; padding: 11px 13px; font-size: .84rem; color: #1B2A4A; font-weight: 600; line-height: 1.5; }
        .ep2-ai-action iconify-icon { color: #4A3FB8; flex-shrink: 0; margin-top: 2px; font-size: 1.05rem; }
      `}</style>

      <button
        type="button"
        className="ep2-crumb-back"
        onClick={() => navigate(backTo || '/stockouts')}
      >
        <iconify-icon icon="solar:arrow-left-linear"></iconify-icon> Retour aux ruptures
      </button>

      {error ? (
        <div className="alert alert-danger">Erreur : {error}</div>
      ) : detail === null ? (
        <div className="text-muted small">Chargement des données de rupture...</div>
      ) : (
        <>
          {isLongDuration && (
            <div className="ep2-alert">
              <iconify-icon icon="solar:danger-triangle-bold-duotone" style={{ fontSize: '18px' }}></iconify-icon>
              Durée inhabituelle détectée — cette rupture dépasse {detail.deliveryDeadlineHours}h ({formatDuration(liveDurations?.totalHours ?? null)}). Vérifiez si une commande a été passée.
            </div>
          )}

          {/* Header */}
          <div className="ep2-header">
            <div className="ep2-header-top">
              <div>
                <div className="eyebrow">Rupture n° {detail.ean}</div>
                <h2>{detail.label || detail.ean}</h2>
                <div className="meta">{detail.department || 'Sans rayon'} · {detail.sector || 'Sans secteur'}</div>
              </div>
              <span className={`ep2-status-badge ${detail.status === 'EN_COURS' ? 'active' : 'resolved'}`}>
                <iconify-icon icon={detail.status === 'EN_COURS' ? 'solar:alert-bold' : 'solar:check-circle-bold'}></iconify-icon>
                {detail.status === 'EN_COURS' ? 'Rupture active' : 'Résolue'}
              </span>
            </div>

            <div className="ep2-tiles">
              <div className="ep2-tile">
                <div className="lbl">Détectée le</div>
                <div className="val" style={{ fontSize: '.95rem' }}>{formatDate(detail.startedAt)}</div>
                <div className="sub">{formatTime(detail.startedAt)}</div>
              </div>
              <div className="ep2-tile">
                <div className={`val ${isLongDuration ? 'warn' : ''}`} style={{ fontVariantNumeric: 'tabular-nums' }}>{formatDurationLive(liveDurations?.totalHours ?? null)}</div>
                <div className="lbl" style={{ marginTop: 4 }}>Durée totale</div>
                <div className="sub">{detail.status === 'EN_COURS' ? 'Compteur toujours actif' : 'Rupture terminée'}</div>
              </div>
              <div className="ep2-tile">
                <div className="val">{formatMoney(detail.caPerdueEstime)}</div>
                <div className="lbl" style={{ marginTop: 4 }}>CA perdu estimé</div>
                <div className="sub">{detail.qtyPerdueEstimee !== null ? `${Math.round(detail.qtyPerdueEstimee)} unité(s)` : 'Estimation indisponible'}</div>
              </div>
              <div className="ep2-tile">
                <div className="val">{detail.order ? (detail.order.quantityOrdered ?? '—') : '—'}</div>
                <div className="lbl" style={{ marginTop: 4 }}>Quantité commandée</div>
                <div className="sub">{detail.order ? detail.order.rposOrderReference || `Commande ${detail.order.id.slice(0, 8)}` : 'Aucune commande'}</div>
              </div>
            </div>
          </div>

          {/* Timeline horizontale début → durée → fin */}
          <div className="ep2-timeline">
            <div className="ep2-timeline-pt">
              <span className="lbl">Début de rupture</span>
              <span className="date">{formatDate(detail.startedAt)}</span>
              <span className="time" style={{ color: '#2f5a85' }}>{formatTime(detail.startedAt)}</span>
            </div>
            <div className="ep2-timeline-mid">
              <iconify-icon icon="solar:arrow-right-linear" className="arrow"></iconify-icon>
              <span className="dur" style={{ fontVariantNumeric: 'tabular-nums' }}>{formatDurationLive(liveDurations?.totalHours ?? null)}</span>
              <span className="sub">{liveDurations ? `${Math.round(liveDurations.totalHours * 60)} minutes` : ''}</span>
            </div>
            <div className="ep2-timeline-pt end">
              <span className="lbl">Fin de rupture</span>
              <span className="date">{detail.endedAt ? formatDate(detail.endedAt) : 'En cours'}</span>
              <span className="time" style={{ color: detail.endedAt ? '#2d6a3f' : '#b8302c' }}>{detail.endedAt ? formatTime(detail.endedAt) : '—'}</span>
            </div>
          </div>

          {/* Informations générales + Métriques temporelles */}
          <div className="row g-3 mb-3">
            <div className="col-12 col-lg-6">
              <section className="ep2-card">
                <div className="ep2-card-head"><iconify-icon icon="solar:document-text-bold-duotone"></iconify-icon> Informations générales</div>
                <div className="ep2-card-body">
                  <dl className="row mb-0 ep2-field">
                    <div className="col-6"><dt>Article</dt><dd>{detail.label || detail.ean}</dd></div>
                    <div className="col-6"><dt>EAN</dt><dd style={{ fontFamily: 'monospace', fontSize: '.78rem' }}>{detail.ean}</dd></div>
                    <div className="col-6"><dt>Rayon</dt><dd>{detail.department || 'Sans rayon'}</dd></div>
                    <div className="col-6"><dt>Secteur</dt><dd>{detail.sector || 'Sans secteur'}</dd></div>
                    <div className="col-6"><dt>Prix de vente</dt><dd>{formatMoney(detail.sellingPrice)}</dd></div>
                    <div className="col-6"><dt>Marge unitaire</dt><dd>{detail.sellingPrice !== null && detail.buyingPrice !== null ? formatMoney(detail.sellingPrice - detail.buyingPrice) : '—'}</dd></div>
                    <div className="col-6"><dt>Cause probable</dt><dd>{CAUSE_LABELS[detail.causeProposee] || detail.causeProposee}</dd></div>
                    <div className="col-6"><dt>Confiance</dt><dd>{detail.niveauConfiance.toLowerCase()}</dd></div>
                  </dl>
                </div>
              </section>
            </div>
            <div className="col-12 col-lg-6">
              <section className="ep2-card">
                <div className="ep2-card-head"><iconify-icon icon="solar:clock-circle-bold-duotone"></iconify-icon> Métriques temporelles</div>
                <div className="ep2-card-body">
                  {/* Refondu le 18/10/2026 (demande explicite : "affiche heure de debut et fin le
                      nombre de minuque qu'il a fait... et le style il faut bien separe les info") —
                      chaque bloc avant/après commande regroupe maintenant sa propre borne de temps
                      (début → fin), sa durée et sa perte au même endroit, au lieu de 4 valeurs
                      dispersées dans une grille 2x2 sans lien visuel évident entre elles. */}
                  <div className="ep2-metric-block before">
                    <div className="ep2-metric-head">
                      <span>Avant commande</span>
                      {!detail.order && detail.status === 'EN_COURS' && <span className="ep2-live-dot">● en direct</span>}
                    </div>
                    <div className="ep2-metric-range">
                      {formatDateTime(detail.startedAt)}
                      <iconify-icon icon="solar:arrow-right-linear"></iconify-icon>
                      {detail.order ? formatDateTime(detail.order.createdAt) : (detail.status === 'EN_COURS' ? 'maintenant' : formatDateTime(detail.endedAt))}
                    </div>
                    <div className="ep2-metric-figures">
                      <div>
                        <div className="ep2-metric-lbl">Durée</div>
                        <div className="ep2-metric-val accent" style={{ fontVariantNumeric: 'tabular-nums' }}>{formatDurationLive(liveDurations?.beforeOrderHours ?? null)}</div>
                      </div>
                      <div>
                        <div className="ep2-metric-lbl">
                          Perte estimée
                          <FormulaInfoButton
                            title={LOSS_FORMULA_TITLE}
                            steps={buildLossFormulaSteps(detail.lossConfig)}
                            example={buildLossFormulaExample(detail.lossConfig)}
                            note={buildLossFormulaNote(detail.lossConfig)}
                          />
                        </div>
                        <div className="ep2-metric-val">{formatMoney(detail.lossBeforeOrder?.caPerdue ?? null)}</div>
                      </div>
                    </div>
                  </div>

                  <div className="ep2-metric-block after">
                    <div className="ep2-metric-head">
                      <span>Après commande</span>
                      {detail.order && !detail.order.actualReceptionDate && detail.status === 'EN_COURS' && <span className="ep2-live-dot">● en direct</span>}
                    </div>
                    {detail.order ? (
                      <>
                        <div className="ep2-metric-range">
                          {formatDateTime(detail.order.createdAt)}
                          <iconify-icon icon="solar:arrow-right-linear"></iconify-icon>
                          {detail.arrivalStillOpenAt
                            ? formatDateTime(detail.arrivalStillOpenAt)
                            : detail.order.actualReceptionDate
                              ? formatDateTime(detail.order.actualReceptionDate)
                              : (detail.status === 'EN_COURS' ? 'maintenant' : formatDateTime(detail.endedAt))}
                        </div>
                        <div className="ep2-metric-figures">
                          <div>
                            <div className="ep2-metric-lbl">Durée</div>
                            {/* Rouge UNIQUEMENT si la livraison est en retard ou douteuse (demande
                                explicite du 18/10/2026 : "a quelle moment le temps qui compte
                                deviens rougé ?") — avant ce correctif, cette durée était toujours
                                affichée en rouge quelle que soit sa valeur, une simple couleur de
                                bloc sans rapport avec un vrai seuil d'alerte, ce qui laissait croire
                                à tort à un signal. */}
                            <div className={`ep2-metric-val ${detail.deliveryDelay || detail.deliveryLooksDoubtful ? 'money' : ''}`} style={{ fontVariantNumeric: 'tabular-nums' }}>{formatDurationLive(liveDurations?.afterOrderHours ?? null)}</div>
                          </div>
                          <div>
                            <div className="ep2-metric-lbl">
                              Perte estimée
                              <FormulaInfoButton
                                title={LOSS_FORMULA_TITLE}
                                steps={buildLossFormulaSteps(detail.lossConfig)}
                                example={buildLossFormulaExample(detail.lossConfig)}
                                note={buildLossFormulaNote(detail.lossConfig)}
                              />
                            </div>
                            <div className="ep2-metric-val">{formatMoney(detail.lossAfterOrder?.caPerdue ?? null)}</div>
                          </div>
                        </div>
                      </>
                    ) : (
                      <div className="ep2-metric-empty">Pas encore de commande — rien à mesurer sur cette période.</div>
                    )}
                  </div>

                  {/* 3e tranche "Après arrivage, toujours en rupture" — ajoutée le 19/10/2026
                      (demande explicite : "apres arrive on a le temps apres commande et quand ya
                      arrivage il bloque et le temps s'arrete si ca continue peutre que le stock est
                      negative... ce temps la n'est plus calculé"). N'apparaît QUE si un vrai
                      arrivage a eu lieu (StockMove type Arrivage) mais que la rupture est restée
                      ouverte après — signale explicitement que le compteur continue à cause d'un
                      problème de STOCK RÉSIDUEL, pas d'un simple délai de livraison. */}
                  {detail.arrivalStillOpenAt && (
                    <div className="ep2-metric-block after" style={{ borderLeftColor: '#b8302c' }}>
                      <div className="ep2-metric-head">
                        <span>Après arrivage, toujours en rupture</span>
                        <span className="ep2-live-dot">● en direct</span>
                      </div>
                      <div className="ep2-metric-range">
                        {formatDateTime(detail.arrivalStillOpenAt)}
                        <iconify-icon icon="solar:arrow-right-linear"></iconify-icon>
                        {detail.status === 'EN_COURS' ? 'maintenant' : formatDateTime(detail.endedAt)}
                      </div>
                      <div className="ep2-metric-figures">
                        <div>
                          <div className="ep2-metric-lbl">Durée</div>
                          <div className="ep2-metric-val money" style={{ fontVariantNumeric: 'tabular-nums' }}>{formatDurationLive(liveDurations?.afterArrivalHours ?? null)}</div>
                        </div>
                        <div>
                          <div className="ep2-metric-lbl">Perte estimée</div>
                          {/* SUPPRIMÉ le 19/10/2026 (demande explicite : "quand apres arrivage il ne
                              dois petre compté la perte encore il peux arrivé que le stock du mag
                              n'et pas ajour donc il sera pas a jour taemps que a pas inventaire sur
                              l'articcle pour avoir un bon stok") — une fois qu'un vrai arrivage
                              prouve que le déficit vient d'une désynchronisation RPOS (pas d'une
                              vraie absence physique de stock), continuer à chiffrer une "perte"
                              ici est trompeur : ce n'est plus une vente manquée, c'est un problème
                              de données qui ne se résout que par un inventaire physique. Remplacé
                              par un message explicite au lieu d'un chiffre qui laisserait croire à
                              une perte réelle continue. */}
                          <div className="ep2-metric-val" style={{ fontSize: '.78rem', fontWeight: 600, color: '#b8302c' }}>Stock non à jour</div>
                        </div>
                      </div>
                      <div className="ep2-metric-empty" style={{ color: '#b8302c', marginTop: 8 }}>
                        Un arrivage a bien été détecté, mais le stock RPOS est resté en-dessous de 0 depuis — probable désynchronisation plutôt qu'une vraie rupture physique. Le stock ne redeviendra fiable qu'après un inventaire physique de cet article en magasin ; la perte n'est plus comptabilisée au-delà de l'arrivage pour éviter de surestimer l'impact réel.
                      </div>
                    </div>
                  )}
                </div>
              </section>
            </div>
          </div>

          {/* Détection / Commande / Prise en charge — refondu en 3 cartes timeline (demande
              explicite du 18/10/2026, sur le modèle de rapport_rupture_stock_v3.html : "tu vois ce
              style je veux sur cette partie") — chaque étape a sa propre carte avec bordure colorée
              en haut et badge de statut, au lieu de 3 colonnes de texte brut. */}
          <section className="ep2-card mb-3">
            <div className="ep2-card-head ep2-card-head-row">
              <span><iconify-icon icon="solar:magnifer-bold-duotone"></iconify-icon> Détection / Commande / Prise en charge</span>
              {/* Bouton "Analyser avec l'IA" déplacé en haut de la section (demande explicite du
                  18/10/2026 : "le bouton analyse ai il faut le bien placé en haut") — jamais
                  déclenché automatiquement, pour maîtriser le coût des appels IA. */}
              {!episodeAnalysis && (
                <button type="button" className="btn btn-sm btn-outline-primary" disabled={analyzingEpisode} onClick={runEpisodeAnalysis}>
                  <iconify-icon icon="solar:magic-stick-3-bold-duotone" className="align-middle me-1"></iconify-icon>
                  {analyzingEpisode ? 'Analyse en cours...' : "Analyser avec l'IA"}
                </button>
              )}
            </div>
            <div className="ep2-card-body">
              <div className="ep2-steps">
                <div className="ep2-step detect">
                  <div className="ep2-step-head">
                    <b>1 · Détection</b>
                    <span className="ep2-badge tone-success">Confirmée</span>
                  </div>
                  <div className="ep2-step-body">
                    <div className="ep2-step-lbl">Début de rupture</div>
                    <div className="ep2-step-date">{formatDateTime(detail.startedAt)}</div>
                    <div className="ep2-step-desc">Stock passé à 0 — compteur {detail.status === 'EN_COURS' ? 'toujours actif' : 'arrêté à la réception'}.</div>
                  </div>
                </div>
                <div className="ep2-step order">
                  <div className="ep2-step-head">
                    <b>2 · Commande fournisseur</b>
                    <span className={`ep2-badge ${detail.order ? (detail.order.validatedAt ? 'tone-success' : 'tone-warning') : 'tone-info'}`}>{detail.order ? (detail.order.validatedAt ? 'Validée' : 'À valider') : 'Aucune'}</span>
                  </div>
                  <div className="ep2-step-body">
                    {detail.order ? (
                      <>
                        <div className="ep2-step-lbl">Commande n° {detail.order.rposOrderReference || detail.order.id.slice(0, 10)}</div>
                        <div className="ep2-step-date">{formatDateTime(detail.order.createdAt)}</div>
                        <div className="ep2-step-desc">
                          Quantité : {detail.order.quantityOrdered ?? '—'} unité(s)<br />
                          Fournisseur : {detail.order.supplierName || '—'}{detail.order.deliveryType ? ` (${detail.order.deliveryType})` : ''}<br />
                          Créée par : {detail.order.createdBy || 'inconnu'}<br />
                          Statut : {detail.order.validatedAt ? `validée le ${formatDateTime(detail.order.validatedAt)}${detail.order.validatedBy ? ` par ${detail.order.validatedBy}` : ''}` : 'pas encore validée'}
                        </div>
                      </>
                    ) : (
                      <div className="ep2-step-desc">Aucune commande passée depuis le début de la rupture.</div>
                    )}
                  </div>
                </div>
                <div className="ep2-step delivery">
                  <div className="ep2-step-head">
                    <b>3 · Livraison</b>
                    <span className={`ep2-badge ${detail.deliveryLooksDoubtful || detail.deliveryDelay ? 'tone-critical' : detail.order?.actualReceptionDate ? 'tone-success' : 'tone-warning'}`}>{detail.deliveryLooksDoubtful ? 'À rapprocher' : detail.deliveryDelay ? 'En retard' : detail.order?.actualReceptionDate ? 'Estimée reçue' : 'En attente'}</span>
                  </div>
                  <div className="ep2-step-body">
                    {detail.order ? (
                      <>
                        <div className="ep2-step-lbl">{detail.order.actualReceptionDate ? 'Date de réception' : 'Date prévue'}</div>
                        <div className="ep2-step-date">{detail.order.actualReceptionDate ? formatDateTime(detail.order.actualReceptionDate) : detail.order.expectedReceptionDate ? formatDate(detail.order.expectedReceptionDate) : '—'}</div>
                        <div className="ep2-step-desc">
                          {detail.order.actualReceptionDate
                            ? `Statut déclaré « ${RECEPTION_STATUS_LABELS[detail.order.receptionStatus] || detail.order.receptionStatus} ». ${detail.deliveryLooksDoubtful ? "Aucun mouvement de réception ne le confirme dans l'historique." : ''}`
                            : 'Pas encore reçue.'}
                        </div>
                      </>
                    ) : (
                      <div className="ep2-step-desc">—</div>
                    )}
                  </div>
                </div>
              </div>

              {/* Résultat de l'analyse IA (demande explicite du 18/10/2026 : "le restal de ia doit
                  etre affiche aussi bien formaté et affiché") — placé juste après les 3 cartes
                  timeline, avant les callouts déterministes, pour rester bien visible sans scroller
                  une fois l'analyse lancée depuis le bouton du header. */}
              {episodeAnalysisError && <div className="text-danger small mt-3">Erreur : {episodeAnalysisError}</div>}
              {episodeAnalysis && (
                <div className="ep2-ai-box mt-3">
                  <div className="ep2-ai-head">
                    <iconify-icon icon="solar:magic-stick-3-bold-duotone"></iconify-icon>
                    Analyse IA
                  </div>
                  <div className="ep2-ai-section-lbl">Résumé</div>
                  <p className="ep2-ai-summary">{episodeAnalysis.summary}</p>
                  {episodeAnalysis.action && (
                    <>
                      <div className="ep2-ai-section-lbl">Action recommandée</div>
                      <div className="ep2-ai-action">
                        <iconify-icon icon="solar:flag-bold-duotone"></iconify-icon>
                        <span>{episodeAnalysis.action}</span>
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* Alerte "livraison douteuse" ajoutée le 18/10/2026 (bug signalé avec capture : le
                  champ "Livraison" affichait "Reçue — Reçue (estimée)" alors que la rupture reste
                  EN_COURS et qu'aucun mouvement de réception n'apparaît dans l'historique — "il me
                  dis les quantité livré or si je vais dessu le temps de rupture continue de
                  compté"). RECUE_ESTIMEE est une estimation de délai, jamais une confirmation
                  (cf. schema.prisma) ; deliveryLooksDoubtful est calculé côté serveur à partir du
                  fait le plus fiable disponible ici : l'épisode est toujours ouvert après la date de
                  réception estimée.
                  N'affiche PAS ce bloc quand deliveryDelay est déjà présent juste en dessous : les
                  deux sont désormais toujours vrais ensemble côté serveur (deliveryLooksDoubtful
                  exige maintenant deliveryDelay non-null, cf. stockoutEpisodeService.js) — afficher
                  les deux serait redondant, celui-ci redit juste la même chose avec moins de détail
                  (pas de vraie date attendue ni de diagnostic facture). */}
              {detail.deliveryLooksDoubtful && !detail.deliveryDelay && (
                <div className="ep2-verdict tone-critical">
                  <strong>Livraison douteuse.</strong> La réception de cette commande est estimée comme reçue depuis le {detail.order?.actualReceptionDate ? formatDateTime(detail.order.actualReceptionDate) : '—'}, mais la rupture est toujours en cours et aucun mouvement de réception n'apparaît dans l'historique de stock — l'article n'est probablement pas réellement revenu en rayon, malgré le statut RPOS.
                </div>
              )}

              {/* Retard de livraison (demande explicite du 18/10/2026 : "si non pas recu soit ca
                  peux etre le 12 donc 2j ca peux etre expliqué mais 3j il faut avoir des
                  explication donc on doit nous dire que la livrasion est en retart") — comparaison
                  à la date de livraison ATTENDUE (règle 14h/week-end), avec un distinguo quand
                  aucun créneau d'intégration facture (12h/17h/23h) passé depuis cette date n'a
                  produit de mouvement Arrivage : plus probablement un échec d'intégration côté
                  entrepôt qu'un simple retard de transport. */}
              {detail.deliveryDelay && (
                <div className="ep2-verdict tone-critical">
                  <strong>Livraison en retard ({detail.deliveryDelay.daysLate} j).</strong> Attendue le {formatDateTime(detail.deliveryDelay.expectedReceptionDate)}, toujours pas reçue.
                  {detail.deliveryDelay.likelyInvoiceIntegrationIssue ? (
                    <> Les 3 créneaux d'intégration des factures entrepôt (12h, 17h, 23h) sont déjà passés depuis cette date sans qu'aucun mouvement d'arrivage n'apparaisse — l'intégration de la facture a probablement échoué côté entrepôt (cron non exécuté, ou facture jamais générée), plutôt qu'un simple retard de transport.</>
                  ) : (
                    <> En attente du prochain créneau d'intégration facture ({detail.deliveryDelay.invoiceSlotsPassedWithoutArrival}/3 déjà passés sans arrivage détecté).</>
                  )}
                </div>
              )}

              {reactionMeta && (
                <div className={`ep2-verdict tone-${reactionMeta.tone}`}>
                  <strong>{reactionMeta.label}.</strong> {reactionMeta.verdict}
                </div>
              )}

              {detail.order && (
                <div className="ep2-loss-split mt-3">
                  <div>
                    <div className="lbl">CA perdu avant commande</div>
                    <div className="val">{formatMoney(detail.lossBeforeOrder?.caPerdue ?? null)}</div>
                  </div>
                  <div>
                    <div className="lbl">CA perdu après commande</div>
                    <div className="val">{formatMoney(detail.lossAfterOrder?.caPerdue ?? null)}</div>
                  </div>
                </div>
              )}

              {detail.orderQuantitySufficiency && (
                <div className={`ep2-badge tone-${detail.orderQuantitySufficiency.sufficient ? 'success' : 'warning'} mt-3`}>
                  Quantité commandée ({detail.orderQuantitySufficiency.quantityOrdered} u) {detail.orderQuantitySufficiency.sufficient ? 'suffisante' : 'probablement insuffisante'} face à ~{Math.round(detail.orderQuantitySufficiency.expectedDemand)} u estimées sur la période.
                </div>
              )}
            </div>
          </section>

          {/* Niveau de stock (demande explicite du 17/10/2026 : "je veux tout les detail possibile...
              le stock pendant la rupture et le stock apres... si le stock et negative il faut
              affiche si 0 il faut affiche") — un stock négatif révèle une désynchronisation RPOS
              (ventes enregistrées au-delà du stock réellement disponible), distinct d'un stock à 0
              qui est une rupture "propre". */}
          <section className="ep2-card mb-3">
            <div className="ep2-card-head"><iconify-icon icon="solar:box-minimalistic-bold-duotone"></iconify-icon> Niveau de stock</div>
            <div className="ep2-card-body">
              <div className="row g-3">
                <div className="col-6 col-md-3">
                  <div className="text-muted text-uppercase mb-1" style={{ fontSize: '.68rem', fontWeight: 600 }}>Au début de la rupture</div>
                  <StockValue stock={detail.stockAtStart} />
                </div>
                <div className="col-6 col-md-3">
                  <div className="text-muted text-uppercase mb-1" style={{ fontSize: '.68rem', fontWeight: 600 }}>
                    {detail.status === 'EN_COURS' ? 'Actuellement' : 'Dernier relevé pendant'}
                  </div>
                  <StockValue stock={detail.stockCurrent} />
                </div>
                <div className="col-6 col-md-3">
                  <div className="text-muted text-uppercase mb-1" style={{ fontSize: '.68rem', fontWeight: 600 }}>Stock RPOS (temps réel)</div>
                  <StockValue stock={detail.stockRpos ? { value: detail.stockRpos.value, capturedAt: detail.stockRpos.syncedAt } : null} />
                </div>
                <div className="col-6 col-md-3">
                  <div className="text-muted text-uppercase mb-1" style={{ fontSize: '.68rem', fontWeight: 600 }}>Après résolution</div>
                  {detail.status === 'EN_COURS' ? (
                    <div className="text-muted small">Rupture toujours en cours</div>
                  ) : (
                    <StockValue stock={detail.stockAtEnd} />
                  )}
                </div>
                {detail.order?.actualReceptionDate && (
                  <div className="col-6 col-md-3">
                    <div className="text-muted text-uppercase mb-1" style={{ fontSize: '.68rem', fontWeight: 600 }}>Après arrivage</div>
                    {detail.stockAfterDelivery ? (
                      <StockValue stock={detail.stockAfterDelivery} />
                    ) : (
                      <div className="text-muted small">Pas encore relevé</div>
                    )}
                  </div>
                )}
              </div>
              {detail.stockAtStart && detail.stockAtStart.value < 0 && (
                <div className="ep2-verdict tone-warning mt-3">
                  <strong>Stock négatif détecté.</strong> Le stock constaté est descendu en dessous de 0, signe probable d'une désynchronisation RPOS (ventes enregistrées au-delà du stock réellement disponible en magasin) plutôt que d'une rupture physique classique.
                </div>
              )}
            </div>
          </section>

          {/* Historique des mouvements */}
          <section className="ep2-card mb-4">
            <div className="ep2-card-head"><iconify-icon icon="solar:history-bold-duotone"></iconify-icon> Mouvements de stock récents</div>
            <div className="table-responsive">
              <table className="table align-middle mb-0 table-hover table-centered">
                <thead className="bg-light-subtle">
                  <tr>
                    <th>Date / heure</th>
                    <th>Type</th>
                    <th className="text-end">Quantité</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.stockMoves.length === 0 ? (
                    <tr><td colSpan={3} className="text-center text-muted py-4">Aucun mouvement enregistré sur la période.</td></tr>
                  ) : (
                    detail.stockMoves.slice(0, 40).map((m, i) => (
                      <tr key={i}>
                        <td style={{ fontFamily: 'monospace', fontSize: '.8rem' }}>{formatDateTime(m.date)}</td>
                        <td>{m.typeLabel}{m.isScrap ? ' (casse)' : ''}</td>
                        <td className="text-end" style={{ fontFamily: 'monospace' }}>{m.quantity}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
