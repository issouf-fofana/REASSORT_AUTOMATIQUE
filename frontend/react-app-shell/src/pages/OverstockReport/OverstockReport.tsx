import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../../shared/api/client';

// Page Surstock (demande explicite du 21/10/2026) : "sortir pour les magasins chaque magasin les
// articles en sur stock", "identifier les articles que les magasins ont en commun en surstock",
// "si tu les casse sortir la casse de ces articles sur les 3 dernières mois", "avoir la possibilité
// d'avoir ca sur une page ou je peux telechargé en exel ou csv", "les info comme vente moyen par
// jour semaine et mois... prix de vente, nom de l'article, code".
//
// Filtre de période ajouté le 21/10/2026 (demande explicite : "si moi meme je veux le surstok sur
// une periode comment je peux faire le filtre", confirmé "historique : quels articles étaient en
// surstock à un moment donné") — analyse TOUTES les propositions générées sur la période choisie
// (une par magasin par nuit, jamais supprimée), pas juste la dernière. Permet aussi "les article on
// son toujour en surstok" (onglet dédié, ratio de persistance ≥ 90% des propositions de la période).
//
// Définition du surstock IDENTIQUE à getOverstockArticles (chatbotToolsService.js) : stock actuel
// ÷ vente moyenne hebdomadaire ≥ seuil (en semaines de couverture) — pas un nouveau calcul
// indépendant. Seuil par défaut 2 semaines (pas 6, le seuil du chatbot jugé trop élevé par
// l'utilisateur le 21/10/2026 : "6 semaine est trop"), réglable directement sur cette page, comme
// demandé ("il faut rendre le surtok dans les parametre sur le UI... le user puisse lancer lui
// meme").

type ShopArticleRow = {
  rposShopId: string;
  shopReference: string | null;
  shopName: string | null;
  ean: string;
  label: string;
  department: string | null;
  stock: number;
  sellingPrice: number | null;
  avgDailySales: number;
  avgWeeklySales: number;
  avgMonthlySales: number;
  weeksOfCoverage: number | null;
  overstockRatio?: number;
  overstockCount?: number;
  proposalCount?: number;
  scrapQuantity90d: number;
  scrapMoveCount90d: number;
  lastScrapDate: string | null;
  // DLV actuelle (demande explicite du 24/10/2026 : "une colonne de combien est en dlv actu pour
  // les surstok") — quantité ACTUELLEMENT basculée en DLV pour cet article dans ce magasin, pas
  // bornée par la période d'analyse choisie (contrairement à la casse) : la DLV est un état présent.
  dlvStock?: number;
  dlvLineCount?: number;
  // Période de surstock (demande explicite du 21/10/2026 : "je doit voir la periode de surtok...
  // quand es ce que ca pris fin ou ca continue") — n'existe qu'en mode période (undefined sinon,
  // la notion n'a pas de sens sur un simple snapshot "situation actuelle").
  firstOverstockDate?: string;
  lastOverstockDate?: string;
  stillOverstocked?: boolean;
};

type CommonShopEntry = {
  rposShopId: string;
  shopReference: string | null;
  shopName: string | null;
  stock: number;
  sellingPrice: number | null;
  avgDailySales: number;
  avgWeeklySales: number;
  avgMonthlySales: number;
  weeksOfCoverage: number | null;
  overstockRatio?: number;
  overstockCount?: number;
  proposalCount?: number;
  scrapQuantity90d: number;
  scrapMoveCount90d: number;
  lastScrapDate: string | null;
};

type CommonArticle = {
  ean: string;
  label: string;
  department: string | null;
  sellingPrice: number | null;
  shops: CommonShopEntry[];
};

type OverstockReportData = {
  found: boolean;
  periodMode?: boolean;
  periodStart?: string | null;
  periodEnd?: string | null;
  minWeeksOfCoverage: number;
  alwaysOverstockMinDays?: number | null;
  scrapLookbackDays?: number;
  shopCount: number;
  articleCount: number;
  articlesByShop: ShopArticleRow[];
  commonArticleCount: number;
  commonArticles: CommonArticle[];
  persistentArticleCount?: number | null;
  persistentArticles?: CommonArticle[] | null;
  // "Aujourd'hui" (demande explicite du 24/10/2026 : "ou je vois les article en surtok auj dans le
  // magasin ? comme les 181 ?") — liste PLATE (ShopArticleRow, comme articlesByShop), pas groupée
  // par EAN comme persistentArticles/commonArticles. N'existe qu'en mode période.
  todayArticleCount?: number | null;
  todayArticles?: ShopArticleRow[] | null;
  trendPoints?: { date: string; count: number }[] | null;
  trendPointsByShop?: { date: string; rposShopId: string; count: number }[] | null;
  message?: string;
};

function fmtCfa(n: number | null): string {
  if (n === null || n === undefined) return '—';
  return `${Math.round(n).toLocaleString('fr-FR')} CFA`;
}

function fmtPct(ratio: number | undefined): string {
  if (ratio === undefined) return '—';
  return `${Math.round(ratio * 100)}%`;
}

// Pastille de sévérité sur la couverture (demande explicite du 21/10/2026 : style avec badges
// colorés, inspiré de la capture "Success/Blocked") — plus la couverture dépasse le seuil, plus la
// pastille vire au rouge : un repère visuel immédiat pour repérer les pires excès sans lire chaque
// chiffre.
function CoveragePill({ weeks, threshold }: { weeks: number | null; threshold: number }) {
  if (weeks === null) return <span className="text-muted small">—</span>;
  const ratio = threshold > 0 ? weeks / threshold : 1;
  const variant = ratio >= 4 ? 'osr-pill-danger' : ratio >= 2 ? 'osr-pill-warning' : 'osr-pill-neutral';
  return <span className={`osr-pill ${variant}`}>{weeks} sem.</span>;
}

// Génère un CSV et déclenche son téléchargement côté navigateur — même principe que l'export
// ag-Grid déjà utilisé sur Proposition de commande (ProposalTable.tsx), mais construit à la main
// ici : cette page n'utilise pas ag-Grid (juste des tableaux HTML), pas de raison d'ajouter cette
// dépendance pour un seul export. CSV plutôt que .xlsx (demande explicite du 21/10/2026, confirmé
// "CSV recommandé" — s'ouvre directement dans Excel, aucune nouvelle librairie nécessaire).
function downloadCsv(filename: string, headers: string[], rows: (string | number | null)[][]) {
  const escapeCell = (v: string | number | null) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers, ...rows].map((row) => row.map(escapeCell).join(';'));
  // BOM UTF-8 : sans lui, Excel (notamment sous Windows) affiche mal les accents français à
  // l'ouverture directe d'un .csv généré côté navigateur.
  const csvContent = '﻿' + lines.join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// Modale de choix du nombre de lignes à exporter — REMPLACE un window.confirm("OK = tout, Annuler
// = page actuelle") (demande explicite du 23/10/2026 : "il me donne pas le moyer de choisir
// personalise") : la popup native ne proposait que 2 choix fixes, jamais de valeur intermédiaire.
// Boutons rapides + un champ libre, dans le même style de carte/overlay que FormulaInfoButton
// (StockoutEpisodePage.tsx) — rendu via portal pour échapper à tout ancêtre avec `transform` qui
// piégerait un `position: fixed` (même piège déjà rencontré et documenté sur ce composant-là).
// `kind` distingue explicitement "page actuelle" d'un nombre de lignes qui lui ressemblerait par
// coïncidence (ex: la page affichée fait justement 100 lignes, même valeur que le bouton rapide
// "100 lignes") — comparer uniquement des `count` numériques aurait rendu ces deux boutons
// indiscernables côté appelant, "page actuelle" n'étant pas forcément les N PREMIÈRES lignes du
// jeu complet (page 3 d'une pagination, par exemple).
type ExportChoice = { kind: 'page' } | { kind: 'all' } | { kind: 'custom'; count: number };

function ExportRowCountModal({
  pageCount,
  totalCount,
  onExport,
  onClose,
}: {
  pageCount: number;
  totalCount: number;
  onExport: (choice: ExportChoice) => void;
  onClose: () => void;
}) {
  const [customValue, setCustomValue] = useState('');

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  function exportCustom() {
    const n = parseInt(customValue, 10);
    if (!Number.isFinite(n) || n < 1) return;
    onExport({ kind: 'custom', count: Math.min(n, totalCount) });
  }

  return createPortal(
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1040, background: 'rgba(27,42,74,.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          background: '#fff', border: '1px solid rgba(27,42,74,.12)', borderRadius: 12,
          boxShadow: '0 12px 32px rgba(27,42,74,.3)', padding: '18px 20px',
          width: 'min(360px, 100%)', fontSize: '.84rem', color: '#2A2F45',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: 14 }}>
          <div style={{ fontWeight: 700, color: '#1B2A4A', fontSize: '.95rem' }}>Exporter combien de lignes ?</div>
          <button type="button" onClick={onClose} aria-label="Fermer" style={{ border: 'none', background: 'transparent', color: '#8591A0', fontSize: '1.2rem', lineHeight: 1, padding: 0, cursor: 'pointer' }}>×</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <button type="button" className="osr-export-choice-btn" onClick={() => onExport({ kind: 'page' })}>
            Page actuelle ({pageCount.toLocaleString('fr-FR')})
          </button>
          {[100, 500].filter((n) => n < totalCount).map((n) => (
            <button key={n} type="button" className="osr-export-choice-btn" onClick={() => onExport({ kind: 'custom', count: n })}>
              {n.toLocaleString('fr-FR')} lignes
            </button>
          ))}
          <button type="button" className="osr-export-choice-btn" onClick={() => onExport({ kind: 'all' })}>
            Toutes les lignes filtrées ({totalCount.toLocaleString('fr-FR')})
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, paddingTop: 14, borderTop: '1px dashed rgba(27,42,74,.1)' }}>
          <input
            type="number"
            min={1}
            max={totalCount}
            placeholder="Nombre précis..."
            value={customValue}
            onChange={(e) => setCustomValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') exportCustom(); }}
            className="osr-input"
            style={{ flex: 1, minWidth: 0 }}
          />
          <button type="button" className="osr-run-btn" style={{ padding: '6px 14px' }} onClick={exportCustom} disabled={!customValue.trim()}>
            Exporter
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// Bandeau "hero" en dégradé bleu avec courbe de tendance (demande explicite du 21/10/2026, capture
// d'un tableau de bord type "Today $764.39" avec graphique + cartes arrondies + badges de tendance :
// "je veux le style sur cette vue... il faut me faire un truc bien fait"). Le graphique montre le
// nombre d'articles distincts en surstock jour par jour sur la période choisie (trendPoints,
// overstockReportService.js) — n'existe qu'en mode période, pas sur un simple snapshot instantané,
// donc affiche un repère "situation actuelle" à la place quand aucune période n'est active.
function OverstockHero({ data, rows }: { data: OverstockReportData; rows: ShopArticleRow[] }) {
  const chartRef = useRef<HTMLDivElement>(null);
  const chartInstanceRef = useRef<any>(null);
  // Page restructurée le 23/10/2026 en vue mono-magasin (suit le sélecteur global de la topbar,
  // demande explicite : "pas pour tout les magasin a meme temps un seul magasin") — le backend ne
  // renvoie donc déjà plus que les données du magasin actif, trendPoints suffit (plus besoin de
  // recalculer depuis trendPointsByShop pour un filtre multi-magasin qui n'existe plus).
  const points = data.trendPoints || [];
  const filteredCount = rows.length;

  // Répartition par sévérité (demande explicite du 21/10/2026 : "fait un joli style ic" — le
  // bandeau en mode "situation actuelle" n'affichait qu'une phrase vide à la place du graphique,
  // qui n'a de sens qu'en mode période). Mêmes seuils que CoveragePill (couverture ÷ seuil choisi :
  // ≥4x = sévère, ≥2x = modéré, sinon léger) pour rester cohérent avec les pastilles déjà affichées
  // dans le tableau en dessous.
  const severity = { severe: 0, moderate: 0, light: 0 };
  for (const r of rows) {
    if (r.weeksOfCoverage === null) continue;
    const ratio = data.minWeeksOfCoverage > 0 ? r.weeksOfCoverage / data.minWeeksOfCoverage : 1;
    if (ratio >= 4) severity.severe += 1;
    else if (ratio >= 2) severity.moderate += 1;
    else severity.light += 1;
  }

  useEffect(() => {
    if (!points.length || !chartRef.current || !window.ApexCharts) return;
    const categories = points.map((p) => new Date(p.date).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }));
    const values = points.map((p) => p.count);

    const chart = new window.ApexCharts(chartRef.current, {
      chart: { type: 'area', height: 170, toolbar: { show: false }, sparkline: { enabled: false }, background: 'transparent' },
      series: [{ name: 'Articles en surstock', data: values }],
      xaxis: { categories, labels: { style: { colors: 'rgba(255,255,255,.75)', fontSize: '10px' } }, axisBorder: { show: false }, axisTicks: { show: false } },
      yaxis: { labels: { style: { colors: 'rgba(255,255,255,.75)' }, formatter: (v: number) => String(Math.round(v)) } },
      colors: ['#fff'],
      stroke: { curve: 'smooth', width: 2.5 },
      fill: { type: 'gradient', gradient: { opacityFrom: 0.35, opacityTo: 0.02, shadeIntensity: 1, colorStops: [{ offset: 0, color: '#fff', opacity: 0.35 }, { offset: 100, color: '#fff', opacity: 0 }] } },
      markers: { size: 3, colors: ['#fff'], strokeColors: '#2456A6', strokeWidth: 2 },
      dataLabels: { enabled: false },
      tooltip: { theme: 'dark', y: { formatter: (v: number) => `${v} article(s) en surstock` } },
      grid: { borderColor: 'rgba(255,255,255,.12)', strokeDashArray: 3 },
    });

    chart.render();
    chartInstanceRef.current = chart;
    return () => { chart.destroy(); };
  }, [points]);

  const latest = points[points.length - 1];
  const previous = points[points.length - 2];
  const trendDiff = latest && previous ? latest.count - previous.count : null;

  const totalSeverity = severity.severe + severity.moderate + severity.light;
  const pct = (n: number) => (totalSeverity > 0 ? Math.round((n / totalSeverity) * 100) : 0);

  return (
    <div className="osr-hero mb-3">
      <div className="osr-hero-decor" aria-hidden="true">
        <iconify-icon icon="solar:box-bold-duotone"></iconify-icon>
      </div>
      <div className="osr-hero-top">
        <div>
          <div className="osr-hero-label">{data.periodMode ? 'Articles en surstock aujourd\'hui' : 'Situation actuelle'}</div>
          <div className="osr-hero-value">
            <iconify-icon icon="solar:box-minimalistic-bold-duotone" className="osr-hero-icon"></iconify-icon>
            {data.periodMode ? (latest ? latest.count.toLocaleString('fr-FR') : filteredCount.toLocaleString('fr-FR')) : filteredCount.toLocaleString('fr-FR')}
            {trendDiff !== null && (
              <span className={`osr-hero-trend ${trendDiff <= 0 ? 'down' : 'up'}`}>
                <iconify-icon icon={trendDiff <= 0 ? 'solar:alt-arrow-down-bold' : 'solar:alt-arrow-up-bold'}></iconify-icon>
                {Math.abs(trendDiff)}
              </span>
            )}
          </div>
          {previous && <div className="osr-hero-sub">Hier : {previous.count.toLocaleString('fr-FR')}</div>}
        </div>
        <div className="osr-hero-period">
          {data.periodMode
            ? <>{new Date(data.periodStart!).toLocaleDateString('fr-FR')} → {new Date(data.periodEnd!).toLocaleDateString('fr-FR')}</>
            : 'Dernière proposition par magasin'}
        </div>
      </div>
      {/* BUG CORRIGÉ le 23/10/2026 (signalé : "quand je décoche tous [les magasins] la page devis
          blanc" — en réalité un crash React sur TOUT changement de filtre faisant passer points.length
          de >1 à ≤1 ou inversement) : le <div ref={chartRef}> et le bloc "severity" ci-dessous
          s'excluaient mutuellement dans le JSX (ternaire), alors qu'ApexCharts insère ses propres
          nœuds DOM à l'intérieur de chartRef.current en dehors du contrôle de React. Quand points
          repassait sous ce seuil, React tentait de démonter le <div ref={chartRef}> pour le remplacer
          par le bloc severity dans le MÊME render où le useEffect([points]) n'avait pas encore eu la
          chance de détruire le graphe ApexCharts précédent — "Failed to execute 'removeChild'" :
          React et ApexCharts se disputaient le même nœud. Les deux blocs restent désormais TOUJOURS
          montés (jamais démontés/remontés par un changement de filtre), seule leur visibilité CSS
          alterne — chartRef.current existe en permanence pour ApexCharts. */}
      <div style={{ display: data.periodMode && points.length > 1 ? 'block' : 'none' }}>
        <div ref={chartRef}></div>
      </div>
      {!(data.periodMode && points.length > 1) && (
        <div className="osr-hero-severity">
          <div className="osr-hero-severity-bar">
            {totalSeverity > 0 && (
              <>
                {severity.severe > 0 && <div style={{ width: `${pct(severity.severe)}%`, background: 'rgba(255,255,255,.95)' }}></div>}
                {severity.moderate > 0 && <div style={{ width: `${pct(severity.moderate)}%`, background: 'rgba(255,255,255,.55)' }}></div>}
                {severity.light > 0 && <div style={{ width: `${pct(severity.light)}%`, background: 'rgba(255,255,255,.22)' }}></div>}
              </>
            )}
          </div>
          <div className="osr-hero-severity-legend">
            <span><i style={{ background: 'rgba(255,255,255,.95)' }}></i>Sévère (≥4x le seuil) — {severity.severe}</span>
            <span><i style={{ background: 'rgba(255,255,255,.55)' }}></i>Modéré (≥2x) — {severity.moderate}</span>
            <span><i style={{ background: 'rgba(255,255,255,.22)' }}></i>Léger — {severity.light}</span>
          </div>
          {data.periodMode && (
            <div className="osr-hero-note">Pas assez de points pour tracer une courbe sur cette période.</div>
          )}
        </div>
      )}
    </div>
  );
}

type TabKey = 'today' | 'persistent';

// Cache module-level (demande explicite du 24/10/2026 : "si je fait un retour il recharge toute les
// page... il ne dois pas actualisé a tout moment") — clique sur un article → navigation vers la page
// détail → retour démonte puis remonte OverstockReport (comportement normal de React Router), ce qui
// relançait tout le chargement depuis zéro à chaque fois. Survit au démontage/remontage du composant
// (contrairement à un useState), tant que l'onglet reste ouvert — jamais persisté au-delà (pas de
// localStorage), une simple query string identique à la dernière réutilise directement le résultat
// déjà en mémoire, sans nouvel appel réseau.
const overstockReportCache = new Map<string, OverstockReportData>();

export function OverstockReport() {
  const navigate = useNavigate();
  // Page restructurée le 23/10/2026 en vue MONO-MAGASIN (demande explicite : "fais comme les
  // commande et les autre page si un filtre: du magasin [sélecteur global topbar]... pas pour tout
  // les magasin a meme temps un seul magasin" — confirmé "Supprimer complètement la vue
  // multi-magasins"). Même pattern que Stockouts.tsx/StockoutShopDetail.tsx/TableauDeBord.tsx : un
  // compte mono-magasin (Rayonniste/Chef de rayon/Directeur) reste cantonné à son propre magasin ;
  // un compte ADMIN/SUPERVISOR suit le sélecteur GLOBAL de la topbar (window.reassortGetActiveShop/
  // reassortOnActiveShopChange) au lieu du multi-sélection locale à cette page (ShopDropdown,
  // supprimé) qui permettait de voir plusieurs/tous les magasins à la fois.
  const user = window.reassortGetUser ? window.reassortGetUser() : null;
  const isSingleShop = user ? window.reassortIsSingleShopRole(user.role) : false;
  const [activeShop, setActiveShop] = useState<{ id: string; posId?: string } | null>(
    isSingleShop && user?.rposShopId ? { id: user.rposShopId, posId: user.rposPosId ?? undefined } : null
  );

  useEffect(() => {
    if (isSingleShop) return;
    const active = window.reassortGetActiveShop ? window.reassortGetActiveShop() : null;
    if (active) setActiveShop(active);
    if (window.reassortOnActiveShopChange) {
      window.reassortOnActiveShopChange((shop) => setActiveShop(shop ?? null));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSingleShop]);

  const [data, setData] = useState<OverstockReportData | null>(null);
  const [error, setError] = useState<string | null>(null);

  // "Paramètres" de l'analyse (demande explicite : "rendre le surtok dans les parametre sur le
  // UI... le user puisse lancer lui meme") — valeurs en attente tant que l'utilisateur n'a pas
  // cliqué "Lancer l'analyse", pour ne jamais relancer un calcul coûteux à chaque frappe clavier.
  // 4 (= 1 mois) en repli immédiat le temps du chargement — remplacé juste en dessous par la vraie
  // valeur réglée dans Paramètres (OVERSTOCK_MIN_WEEKS_OF_COVERAGE, demande explicite du
  // 29/10/2026 : "je dois pouvoir les modifier", config déplacée hors du code).
  const [minWeeksOfCoverage, setMinWeeksOfCoverage] = useState(4);
  // Lit le seuil configuré une seule fois au montage, AVANT que runAnalysis() ci-dessous ne parte
  // (celui-ci dépend de minWeeksOfCoverage dans son tableau de dépendances) — si l'admin a changé
  // la valeur dans Paramètres, la page doit l'utiliser dès le premier chargement, pas seulement
  // après un rechargement manuel du seuil par l'utilisateur.
  useEffect(() => {
    apiFetch<{ OVERSTOCK_MIN_WEEKS_OF_COVERAGE?: string }>('/reassort/system-config')
      .then((d) => {
        const configured = parseFloat(d.OVERSTOCK_MIN_WEEKS_OF_COVERAGE || '');
        if (Number.isFinite(configured) && configured > 0) setMinWeeksOfCoverage(configured);
      })
      // Silencieux si non-admin (route protégée) : garde le repli 4 ci-dessus, comme SchedulingSection.
      .catch(() => {});
  }, []);
  // BUG CORRIGÉ le 24/10/2026 (signalé : "supprime les filtre [de période]... le surstok doit etre
  // au jour si il n'es plus en surstok on ne dois plus le voir") — la sélection de période (presets
  // 7j/30j/3mois/6mois + dates personnalisées, "Historique de la période") permettait de voir des
  // articles qui ne sont PLUS en surstock aujourd'hui, contradictoire avec "je dois voir que les
  // article qui son en surtok". Plus de sélecteur visible : periodEnabled reste TOUJOURS activé
  // (nécessaire pour calculer "En surstock depuis 14j+", qui compare plusieurs jours entre eux),
  // periodStart/periodEnd fixés en permanence sur une fenêtre de 3 mois glissante, jamais affichés
  // ni modifiables depuis l'UI.
  const periodEnabled = true;
  const periodStart = useMemo(() => new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10), []);
  const periodEnd = useMemo(() => new Date().toISOString().slice(0, 10), []);

  // BUG CORRIGÉ le 24/10/2026 (signalé : "je veux voir mes perte si je viens sur la vue je dois voir
  // que les artile en surtok... je veux maintennt quel article est en surtok comme les rupture" —
  // même correction que l'onglet "En cours" par défaut sur Ruptures de stock) : "byShop" ("Historique
  // de la période") était l'onglet par défaut, mélangeant des articles qui ONT ÉTÉ en surstock à un
  // moment donné sur la période avec l'état ACTUEL — "today" ("Aujourd'hui") ne montre, lui, que les
  // articles réellement en surstock maintenant, exactement la question posée en arrivant sur la page.
  const [activeTab, setActiveTab] = useState<TabKey>('today');
  // État du bouton Export, générique aux 2 onglets restants (demande explicite du 21/10/2026 : le
  // bouton export doit être sur la ligne des onglets, avec le même choix "vue actuelle / tout"
  // partout) — remonté par chaque tableau enfant via son propre callback (CommonArticlesTable :
  // pagination client sur une liste déjà chargée).
  const [persistentPageRows, setPersistentPageRows] = useState<FlatCommonRow[]>([]);
  const [todayPageRows, setTodayPageRows] = useState<FlatCommonRow[]>([]);
  const [search, setSearch] = useState('');

  // Filtres par plage de valeurs (demande explicite du 21/10/2026 : "ajoute tout ses filtre
  // possible, dois pouvoir filtre par tout ca... Stock, Vente/jour, Vente/semaine, Vente/mois,
  // Couverture, Casse") — chaque métrique a son min et son max, vide = pas de borne sur ce côté.
  // Appliqués côté client sur les données déjà chargées, comme search ci-dessus.
  const [rangeFilters, setRangeFilters] = useState<Record<string, { min: string; max: string }>>({
    stock: { min: '', max: '' },
    avgDailySales: { min: '', max: '' },
    avgWeeklySales: { min: '', max: '' },
    avgMonthlySales: { min: '', max: '' },
    weeksOfCoverage: { min: '', max: '' },
    scrapQuantity90d: { min: '', max: '' },
  });
  const [rangeFiltersOpen, setRangeFiltersOpen] = useState(false);
  // Interrupteur on/off "articles avec casse uniquement" (demande explicite du 21/10/2026 : "pour
  // le filtre des casse ajout un bouton on/off pour ca") — distinct du min/max sur la quantité de
  // casse ci-dessus (qui reste disponible pour affiner), ce bouton répond directement à "n'afficher
  // que les articles qui ont eu de la casse", sans avoir à deviner une borne min=1.
  const [scrapOnly, setScrapOnly] = useState(false);

  function setRangeFilter(key: string, side: 'min' | 'max', value: string) {
    setRangeFilters((prev) => ({ ...prev, [key]: { ...prev[key], [side]: value } }));
  }
  function clearRangeFilters() {
    setRangeFilters((prev) => Object.fromEntries(Object.keys(prev).map((k) => [k, { min: '', max: '' }])) as typeof prev);
    setScrapOnly(false);
  }
  const activeRangeFilterCount = Object.values(rangeFilters).filter((r) => r.min !== '' || r.max !== '').length + (scrapOnly ? 1 : 0);

  // Teste une ligne (ShopArticleRow ou CommonShopEntry, mêmes noms de champs) contre toutes les
  // plages actives — une plage vide d'un côté (min ou max) ne borne pas ce côté.
  function matchesRangeFilters(row: { stock: number; avgDailySales: number; avgWeeklySales: number; avgMonthlySales: number; weeksOfCoverage: number | null; scrapQuantity90d: number }): boolean {
    if (scrapOnly && !(row.scrapQuantity90d > 0)) return false;
    const checks: [number | null, { min: string; max: string }][] = [
      [row.stock, rangeFilters.stock],
      [row.avgDailySales, rangeFilters.avgDailySales],
      [row.avgWeeklySales, rangeFilters.avgWeeklySales],
      [row.avgMonthlySales, rangeFilters.avgMonthlySales],
      [row.weeksOfCoverage, rangeFilters.weeksOfCoverage],
      [row.scrapQuantity90d, rangeFilters.scrapQuantity90d],
    ];
    for (const [value, range] of checks) {
      if (range.min !== '' && (value === null || value < Number(range.min))) return false;
      if (range.max !== '' && (value === null || value > Number(range.max))) return false;
    }
    return true;
  }

  // Paramètre magasin commun à tous les appels de la page (demande explicite du 23/10/2026 :
  // "si un filtre: du magasin [sélecteur global]... pas pour tout les magasin a meme temps un seul
  // magasin") — même construction que shopQueryParam() dans Stockouts.tsx : magasin propre pour un
  // compte mono-magasin, magasin actif du sélecteur global sinon. Vide si aucun magasin résolu
  // (ADMIN sans sélection) : la page affiche alors un message d'invite plutôt qu'un calcul réseau.
  function activeShopId(): string | null {
    return isSingleShop ? (user?.rposShopId || null) : (activeShop?.id || null);
  }


  // Accepte des overrides explicites (demande explicite du 21/10/2026 : boutons de période remontés
  // dans la barre de filtres qui relancent directement l'analyse) — sans ça, l'appel partirait avec
  // l'état React d'AVANT le clic (setPeriodStart/setPeriodEnd/setPeriodEnabled n'ont pas encore été
  // appliqués au moment où runAnalysis() lirait periodStart/periodEnd par closure).
  function runAnalysisWith(overrides?: { periodEnabled?: boolean; periodStart?: string; periodEnd?: string }) {
    const shopId = activeShopId();
    if (!shopId) { setData(null); setError(null); return; }
    const effectivePeriodEnabled = overrides?.periodEnabled ?? periodEnabled;
    const effectivePeriodStart = overrides?.periodStart ?? periodStart;
    const effectivePeriodEnd = overrides?.periodEnd ?? periodEnd;
    const params = new URLSearchParams({ minWeeksOfCoverage: String(minWeeksOfCoverage), shops: shopId });
    if (effectivePeriodEnabled) {
      params.set('start', new Date(effectivePeriodStart).toISOString());
      params.set('end', new Date(effectivePeriodEnd + 'T23:59:59').toISOString());
    }
    const cacheKey = params.toString();
    // Mêmes paramètres déjà chargés (ex: retour depuis la page détail d'un article) : réutilise le
    // résultat en mémoire, jamais de nouvel appel réseau ni de "Chargement..." pour rien.
    const cached = overstockReportCache.get(cacheKey);
    if (cached) { setData(cached); setError(null); return; }
    setData(null);
    setError(null);
    apiFetch<OverstockReportData>(`/reassort/overstock-report?${cacheKey}`)
      .then((d) => { overstockReportCache.set(cacheKey, d); setData(d); })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }

  function runAnalysis() {
    runAnalysisWith();
  }

  // Chargement automatique (snapshot, paramètres par défaut) au montage ET à chaque changement de
  // magasin actif (demande explicite : "que je viens dans la vue il affiché les donner du mag ou
  // je suis") — les relances suivantes restent explicitement déclenchées par l'utilisateur via
  // "Lancer l'analyse" (demande du 21/10/2026).
  useEffect(() => {
    runAnalysis();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeShop?.id, isSingleShop]);

  // "Aujourd'hui" (demande explicite du 24/10/2026) — même filtrage que l'ancien filteredByShop,
  // sur la liste plate todayArticles renvoyée par le backend.
  const filteredToday = useMemo(() => {
    if (!data?.todayArticles) return [];
    const q = search.trim().toLowerCase();
    return data.todayArticles.filter((a) => {
      if (q && !a.label.toLowerCase().includes(q) && !a.ean.includes(q)) return false;
      if (!matchesRangeFilters(a)) return false;
      return true;
    });
  }, [data, search, rangeFilters, scrapOnly]);

  const filteredPersistent = useMemo(() => {
    if (!data?.persistentArticles) return [];
    const q = search.trim().toLowerCase();
    return data.persistentArticles
      .filter((a) => !q || a.label.toLowerCase().includes(q) || a.ean.includes(q))
      .map((a) => ({
        ...a,
        shops: a.shops.filter((s) => matchesRangeFilters(s)),
      }))
      .filter((a) => a.shops.length > 0);
  }, [data, search, rangeFilters, scrapOnly]);

  // BUG CORRIGÉ le 23/10/2026 (signalé : "ca ne fonctionne pas au clique et pas de erreur" sur la
  // pagination de l'onglet "Toujours en surstock") : flattenCommonArticles(filteredPersistent)
  // appelé directement dans le JSX à chaque render créait un nouveau tableau à chaque fois même si
  // filteredPersistent n'avait pas changé. CommonArticlesTable a un
  // useEffect(() => setPage(1), [rows]) — son propre onPageRowsChange (appelé à chaque page
  // affichée) déclenchait un re-render du parent, qui recréait ce tableau, qui redéclenchait ce
  // useEffect, qui remettait page à 1 juste après le clic. useMemo garde la même référence tant que
  // filteredPersistent (déjà mémorisé ci-dessus) ne change pas.
  const flatPersistentRows = useMemo(() => flattenCommonArticles(filteredPersistent), [filteredPersistent]);

  // BUG CORRIGÉ le 24/10/2026 (signalé : "je suis dans un magasin il ne dois pas me donner pour
  // tout les mag... je dois voir pour un seul magasin") — shopId du magasin actif transmis en query
  // param, repris par OverstockScrapDetail.tsx pour restreindre les 3 onglets (Ventes/Casse/DLV) au
  // même magasin que celui affiché sur la page Surstock, au lieu du périmètre complet du compte.
  function openScrapDetail(ean: string, label: string) {
    const shopId = activeShopId();
    const shopParam = shopId ? `&shops=${encodeURIComponent(shopId)}` : '';
    navigate(`/overstock-report/scrap/${encodeURIComponent(ean)}?label=${encodeURIComponent(label)}&from=overstock-report${shopParam}`);
  }

  // État de la modale "combien de lignes exporter" — RÉÉCRIT le 23/10/2026 (demande explicite :
  // "il me donne pas le moyer de choisir personalise", remplace l'ancien window.confirm binaire
  // tout/page). pageRows/allRows/filenamePrefix mis de côté le temps que l'utilisateur choisisse un
  // nombre dans la modale ; count personnalisé supporté via un simple .slice(0, n) côté client, ces
  // deux tableaux étant déjà entièrement chargés en mémoire (contrairement à ByShopTable plus bas,
  // paginé serveur, qui gère son propre export séparément).
  const [exportModal, setExportModal] = useState<{ pageRows: FlatCommonRow[]; allRows: FlatCommonRow[]; filenamePrefix: string } | null>(null);

  function exportFlatCommonCsvRows(rows: FlatCommonRow[], label: string, filenamePrefix: string) {
    downloadCsv(
      `${filenamePrefix}-${label}-${new Date().toISOString().slice(0, 10)}.csv`,
      ['EAN', 'Article', 'Rayon', 'Magasin', 'Référence magasin', 'Stock actuel', 'Prix de vente (CFA)', 'Vente moy./jour', 'Vente moy./semaine', 'Vente moy./mois', 'Semaines de couverture', '% du temps en surstock sur la période', 'Casse (qté, 90j)', 'Casse (nb mouvements, 90j)', 'Dernière casse'],
      rows.map((r) => [
        r.ean, r.label, r.department, r.shopName, r.shopReference, r.stock, r.sellingPrice,
        r.avgDailySales, r.avgWeeklySales, r.avgMonthlySales, r.weeksOfCoverage,
        r.overstockRatio !== undefined ? fmtPct(r.overstockRatio) : '',
        r.scrapQuantity90d, r.scrapMoveCount90d, r.lastScrapDate ? new Date(r.lastScrapDate).toLocaleDateString('fr-FR') : '',
      ])
    );
  }

  function handleFlatCommonExportChoice(choice: ExportChoice) {
    if (!exportModal) return;
    const { pageRows, allRows, filenamePrefix } = exportModal;
    if (choice.kind === 'page') {
      exportFlatCommonCsvRows(pageRows, 'page-actuelle', filenamePrefix);
    } else if (choice.kind === 'all') {
      exportFlatCommonCsvRows(allRows, 'complet', filenamePrefix);
    } else {
      exportFlatCommonCsvRows(allRows.slice(0, choice.count), `${choice.count}-lignes`, filenamePrefix);
    }
    setExportModal(null);
  }

  return (
    <div className="container-fluid py-4">
      <style>{`
        .osr-settings-card { background: #fff; border: 1px solid rgba(27,42,74,.08); border-radius: 10px; padding: 16px 18px; margin-bottom: 1rem; }
        .osr-settings-row { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
        .osr-settings-row + .osr-settings-row { margin-top: 12px; padding-top: 12px; border-top: 1px dashed rgba(27,42,74,.08); }
        .osr-icon { width: 32px; height: 32px; border-radius: 8px; background: rgba(27,42,74,.05); display: flex; align-items: center; justify-content: center; font-size: 15px; color: #5B6B85; flex-shrink: 0; }
        .osr-label { font-size: .78rem; font-weight: 600; color: #5B6B85; }
        .osr-input { border: 1px solid rgba(27,42,74,.12); border-radius: 6px; font-size: .8rem; padding: 5px 10px; color: #1B2A4A; background: #fff; }
        .osr-input:disabled { background: #F6F8FB; color: #B6BFCF; }
        .osr-input:focus { outline: none; border-color: rgba(27,42,74,.3); box-shadow: 0 0 0 3px rgba(27,42,74,.06); }
        .osr-switch { position: relative; display: inline-flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; }
        .osr-switch input { width: 34px; height: 19px; appearance: none; background: #D7DEEA; border-radius: 10px; position: relative; cursor: pointer; transition: background .15s; }
        .osr-switch input:checked { background: #1B2A4A; }
        .osr-switch input::before { content: ''; position: absolute; top: 2px; left: 2px; width: 15px; height: 15px; background: #fff; border-radius: 50%; transition: transform .15s; }
        .osr-switch input:checked::before { transform: translateX(15px); }
        .osr-run-btn { background: #1B2A4A; color: #fff; border: none; border-radius: 7px; padding: 8px 18px; font-size: .84rem; font-weight: 600; display: inline-flex; align-items: center; gap: 6px; transition: background .15s; }
        .osr-run-btn:hover { background: #142037; }
        .osr-run-btn:disabled { background: #B6BFCF; cursor: not-allowed; }
        .osr-export-choice-btn { text-align: left; border: 1px solid rgba(27,42,74,.12); background: #fff; color: #1B2A4A; font-size: .84rem; font-weight: 600; padding: 8px 12px; border-radius: 8px; cursor: pointer; transition: background .15s, border-color .15s; }
        .osr-export-choice-btn:hover { background: #F6F8FB; border-color: rgba(27,42,74,.2); }
        .osr-availability { font-size: .74rem; color: #8591A0; }
        .osr-filter-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 1rem; }
        .osr-adv-filter-btn { border: 1px solid rgba(27,42,74,.1); background: #FAFBFD; color: #5B6B85; font-size: .8rem; font-weight: 600; padding: 6px 13px; border-radius: 20px; display: inline-flex; align-items: center; gap: 7px; cursor: pointer; transition: background .15s, color .15s, border-color .15s; }
        .osr-adv-filter-btn:hover { background: #F0F3F9; color: #1B2A4A; }
        .osr-adv-filter-btn.active { background: rgba(36,86,166,.08); color: #2456A6; border-color: rgba(36,86,166,.25); }
        .osr-preset-pill { border: 1px solid rgba(27,42,74,.12); background: #fff; color: #5B6B85; font-size: .78rem; font-weight: 600; padding: 6px 13px; border-radius: 7px; cursor: pointer; transition: background .15s, color .15s, border-color .15s; }
        .osr-preset-pill:hover { background: #F6F8FB; color: #1B2A4A; }
        .osr-preset-pill.active { background: #1B2A4A; color: #fff; border-color: #1B2A4A; }
        .osr-range-panel { background: #FAFBFD; border: 1px solid rgba(27,42,74,.06); border-radius: 14px; padding: 18px 22px; display: flex; align-items: flex-end; gap: 24px; flex-wrap: wrap; }
        .osr-range-field { display: flex; flex-direction: column; gap: 6px; }
        .osr-range-label { font-size: .72rem; font-weight: 600; color: #8591A0; text-transform: uppercase; letter-spacing: .02em; }
        .osr-range-field .osr-input { border-color: rgba(27,42,74,.08); background: #fff; border-radius: 8px; }
        .osr-range-field .osr-input::placeholder { color: #B6BFCF; }
        .osr-range-field span { color: #C3CBDA; }
        .osr-range-clear { border: none; background: #fff; color: #B8302C; font-size: .76rem; font-weight: 600; display: inline-flex; align-items: center; gap: 5px; cursor: pointer; padding: 7px 14px; border-radius: 20px; margin-left: auto; transition: background .15s; }
        .osr-range-clear:hover { background: rgba(214,69,65,.08); }
        .osr-sortable-th { cursor: pointer; user-select: none; white-space: nowrap; }
        .osr-sortable-th:hover { color: #1B2A4A; }
        .osr-tabs { display: flex; gap: 4px; border-bottom: 1px solid rgba(27,42,74,.08); margin-bottom: 1rem; flex-wrap: wrap; }
        .osr-tab { border: none; background: none; padding: 10px 16px; font-size: .86rem; font-weight: 600; color: #8591A0; border-bottom: 2px solid transparent; cursor: pointer; white-space: nowrap; }
        .osr-tab.active { color: #1B2A4A; border-bottom-color: #1B2A4A; }
        .osr-scrap-badge { background: rgba(214,69,65,.08); color: #B8302C; border-radius: 5px; padding: 1px 7px; font-size: .72rem; font-weight: 700; }
        .osr-persist-badge { background: rgba(27,42,74,.06); color: #1B2A4A; border-radius: 5px; padding: 1px 7px; font-size: .72rem; font-weight: 700; }
        .osr-period-banner { background: #F6F8FB; border: 1px solid rgba(27,42,74,.08); border-radius: 8px; padding: 9px 14px; font-size: .82rem; color: #44516B; }
        .osr-period-banner strong { color: #1B2A4A; }
        .osr-pagination { display: flex; align-items: center; justify-content: center; gap: 6px; margin: 1.25rem 0; flex-wrap: wrap; }
        .osr-page-btn { border: 1px solid rgba(27,42,74,.12); background: #fff; color: #5B6B85; font-size: .78rem; font-weight: 600; padding: 5px 11px; border-radius: 6px; cursor: pointer; transition: background .15s, color .15s, border-color .15s; }
        .osr-page-btn:hover:not(:disabled) { background: #F6F8FB; color: #1B2A4A; border-color: rgba(27,42,74,.2); }
        .osr-page-btn:disabled { opacity: .4; cursor: not-allowed; }
        .osr-page-btn.active { background: #1B2A4A; color: #fff; border-color: #1B2A4A; }
        .osr-page-info { font-size: .76rem; color: #8591A0; margin: 0 6px; }
        .osr-hero { position: relative; overflow: hidden; background: linear-gradient(135deg, #1B2A4A 0%, #2456A6 100%); border-radius: 14px; padding: 22px 26px 20px; color: #fff; box-shadow: 0 10px 28px rgba(27,42,74,.22); }
        .osr-hero-decor { position: absolute; top: -18px; right: -14px; font-size: 128px; opacity: .08; transform: rotate(-12deg); pointer-events: none; line-height: 1; }
        .osr-hero-top { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-bottom: 6px; position: relative; }
        .osr-hero-label { font-size: .8rem; opacity: .8; font-weight: 500; }
        .osr-hero-value { font-size: 2rem; font-weight: 700; display: flex; align-items: center; gap: 10px; line-height: 1.2; }
        .osr-hero-icon { font-size: 1.6rem; opacity: .85; }
        .osr-hero-trend { font-size: .72rem; font-weight: 700; border-radius: 6px; padding: 2px 8px; display: inline-flex; align-items: center; gap: 2px; }
        .osr-hero-trend.down { background: rgba(94,214,145,.22); color: #B6F2CF; }
        .osr-hero-trend.up { background: rgba(255,255,255,.18); color: #fff; }
        .osr-hero-sub { font-size: .76rem; opacity: .7; margin-top: 2px; }
        .osr-hero-period { background: rgba(255,255,255,.12); border-radius: 7px; padding: 6px 12px; font-size: .76rem; font-weight: 600; }
        .osr-hero-severity { position: relative; margin-top: 14px; }
        .osr-hero-severity-bar { display: flex; height: 10px; border-radius: 6px; overflow: hidden; background: rgba(255,255,255,.1); }
        .osr-hero-severity-bar > div { transition: width .3s; }
        .osr-hero-severity-legend { display: flex; gap: 18px; flex-wrap: wrap; margin-top: 10px; font-size: .76rem; opacity: .85; }
        .osr-hero-severity-legend span { display: inline-flex; align-items: center; gap: 6px; }
        .osr-hero-severity-legend i { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
        .osr-hero-note { font-size: .74rem; opacity: .6; margin-top: 10px; }
        .osr-kpi-row { display: flex; gap: 14px; flex-wrap: wrap; margin: -34px 0 1.25rem; position: relative; z-index: 1; padding: 0 2px; }
        .osr-kpi-card { flex: 1 1 200px; background: #fff; border-radius: 12px; padding: 14px 18px; box-shadow: 0 4px 18px rgba(27,42,74,.08); border: 1px solid rgba(27,42,74,.05); }
        .osr-kpi-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
        .osr-kpi-label { font-size: .76rem; color: #8591A0; font-weight: 600; }
        .osr-kpi-value { font-size: 1.5rem; font-weight: 700; color: #1B2A4A; }
        .osr-kpi-icon { width: 30px; height: 30px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 14px; }
        .osr-table-card { background: #fff; border-radius: 12px; border: 1px solid rgba(27,42,74,.06); overflow: hidden; }
        /* Scrollbar horizontale toujours visible (demande explicite du 21/10/2026 : "tu ajoute
           option de croll pour affiché les colonne comme dans les propostion de commande") — les
           tableaux ont plus de colonnes que l'écran n'en affiche (Rayon, % du temps en surstock,
           Casse...), overflow-x: auto seul ne montre la scrollbar qu'au survol sur certains OS/
           navigateurs, peu découvrable. scrollbar-gutter réserve la place en bas même quand le
           contenu tient déjà à l'écran, pour que la barre soit un repère visuel constant. */
        .osr-table-card .table-responsive { scrollbar-gutter: stable bottom; }
        .osr-table-card .table-responsive::-webkit-scrollbar { height: 10px; }
        .osr-table-card .table-responsive::-webkit-scrollbar-track { background: #F6F8FB; }
        .osr-table-card .table-responsive::-webkit-scrollbar-thumb { background: rgba(27,42,74,.22); border-radius: 6px; }
        .osr-table-card .table-responsive::-webkit-scrollbar-thumb:hover { background: rgba(27,42,74,.35); }
        .osr-pill { border-radius: 20px; padding: 3px 11px; font-size: .72rem; font-weight: 700; display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
        .osr-pill-danger { background: rgba(214,69,65,.1); color: #B8302C; }
        .osr-pill-warning { background: rgba(214,158,46,.12); color: #8A5A00; }
        .osr-pill-neutral { background: rgba(27,42,74,.06); color: #5B6B85; }
        .osr-settings-details summary { list-style: none; cursor: pointer; }
        .osr-settings-details summary::-webkit-details-marker { display: none; }
        .osr-settings-summary { display: inline-flex; align-items: center; gap: 8px; font-size: .84rem; font-weight: 600; color: #1B2A4A; padding: 9px 16px; background: #fff; border: 1px solid rgba(27,42,74,.14); border-radius: 8px; box-shadow: 0 1px 3px rgba(27,42,74,.05); transition: background .15s, border-color .15s, box-shadow .15s; }
        .osr-settings-summary:hover { background: #F6F8FB; border-color: rgba(27,42,74,.22); box-shadow: 0 2px 6px rgba(27,42,74,.08); }
        .osr-settings-chevron { margin-left: 2px; font-size: 12px; opacity: .6; transition: transform .15s; }
        .osr-settings-details[open] .osr-settings-summary { background: rgba(36,86,166,.08); border-color: rgba(36,86,166,.3); color: #2456A6; }
        .osr-settings-details[open] .osr-settings-chevron { transform: rotate(180deg); }
        .osr-settings-details .osr-settings-card { margin-top: 10px; }
        .osr-shop-badge { background: #EDF1F7; color: #1B2A4A; }
      `}</style>

      <div className="d-flex justify-content-between align-items-center flex-wrap gap-2 mb-2">
        <h4 className="mb-0" style={{ color: '#1B2A4A', fontWeight: 700 }}>Surstock</h4>
      </div>

      {/* Contexte explicite du magasin consulté (même pattern que Stockouts.tsx, demande explicite
          du 18/10/2026 reprise ici le 23/10/2026 pour cette page désormais mono-magasin) — la page
          suit le sélecteur global de la topbar pour un ADMIN/SUPERVISOR. */}
      <div className="mb-3">
        <span className="badge osr-shop-badge py-1 px-2">
          <iconify-icon icon="solar:shop-bold-duotone" className="align-middle me-1"></iconify-icon>
          {isSingleShop
            ? (user?.rposShopName || 'Votre magasin')
            : activeShop
              ? (window.reassortGetActiveShop?.()?.name || 'Magasin sélectionné')
              : 'Aucun magasin sélectionné'}
        </span>
      </div>

      {/* Réglages réduits au seul seuil (demande explicite du 24/10/2026 : "supprime les filtre [de
          période]... laisse juste la recherche d'article et les filtre avancé") — la sélection de
          période (presets, dates personnalisées, bandeau "analyse sur la période") a été retirée de
          l'UI : periodStart/periodEnd restent fixés en permanence à 3 mois en arrière-plan (cf.
          déclaration plus haut), jamais affichés. */}
      <details className="osr-settings-details mb-3">
        <summary className="osr-settings-summary">
          <iconify-icon icon="solar:settings-bold-duotone"></iconify-icon> Paramètres de l'analyse
          <iconify-icon icon="solar:alt-arrow-down-linear" className="osr-settings-chevron"></iconify-icon>
        </summary>
      <div className="osr-settings-card">
        <div className="osr-settings-row">
          <span className="osr-icon"><iconify-icon icon="solar:settings-bold-duotone"></iconify-icon></span>
          <span className="osr-label">Seuil de surstock</span>
          <input
            type="number"
            min={0.5}
            step={0.5}
            className="osr-input"
            style={{ width: 70 }}
            value={minWeeksOfCoverage}
            onChange={(e) => setMinWeeksOfCoverage(Math.max(0.5, Number(e.target.value) || 1))}
          />
          <span className="small text-muted">semaines de couverture ou plus</span>
        </div>

        <div className="osr-settings-row">
          <button type="button" className="osr-run-btn" onClick={runAnalysis}>
            <iconify-icon icon="solar:play-bold"></iconify-icon> Lancer l'analyse
          </button>
        </div>
      </div>
      </details>

      {data && data.found && (
        <>
          <div className="osr-filter-bar">
            <input
              type="search"
              className="osr-input"
              style={{ width: 220 }}
              placeholder="Rechercher un article..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button
              type="button"
              className={`osr-adv-filter-btn${activeRangeFilterCount > 0 ? ' active' : ''}`}
              onClick={() => setRangeFiltersOpen((v) => !v)}
            >
              <iconify-icon icon="solar:tuning-2-bold-duotone"></iconify-icon>
              Filtres avancés{activeRangeFilterCount > 0 ? ` (${activeRangeFilterCount})` : ''}
              <iconify-icon icon={rangeFiltersOpen ? 'solar:alt-arrow-up-linear' : 'solar:alt-arrow-down-linear'} style={{ fontSize: '12px', opacity: .6 }}></iconify-icon>
            </button>
          </div>

          {rangeFiltersOpen && (
            <div className="osr-range-panel mb-3">
              {[
                { key: 'stock', label: 'Stock' },
                { key: 'avgDailySales', label: 'Vente/jour' },
                { key: 'avgWeeklySales', label: 'Vente/semaine' },
                { key: 'avgMonthlySales', label: 'Vente/mois' },
                { key: 'weeksOfCoverage', label: 'Couverture (semaines)' },
                { key: 'scrapQuantity90d', label: 'Casse (90j)' },
              ].map(({ key, label }) => (
                <div key={key} className="osr-range-field">
                  <span className="osr-range-label">{label}</span>
                  <div className="d-flex align-items-center gap-1">
                    <input
                      type="number"
                      className="osr-input"
                      style={{ width: 80 }}
                      placeholder="Min"
                      value={rangeFilters[key].min}
                      onChange={(e) => setRangeFilter(key, 'min', e.target.value)}
                    />
                    <span className="text-muted small">—</span>
                    <input
                      type="number"
                      className="osr-input"
                      style={{ width: 80 }}
                      placeholder="Max"
                      value={rangeFilters[key].max}
                      onChange={(e) => setRangeFilter(key, 'max', e.target.value)}
                    />
                  </div>
                </div>
              ))}
              <div className="osr-range-field">
                <span className="osr-range-label">Casse</span>
                <label className="osr-switch">
                  <input type="checkbox" checked={scrapOnly} onChange={(e) => setScrapOnly(e.target.checked)} />
                  <span className="small" style={{ color: '#44516B' }}>Avec casse uniquement</span>
                </label>
              </div>
              {activeRangeFilterCount > 0 && (
                <button type="button" className="osr-range-clear" onClick={clearRangeFilters}>
                  <iconify-icon icon="solar:close-circle-bold"></iconify-icon> Effacer les filtres
                </button>
              )}
            </div>
          )}
        </>
      )}

      {data && data.found && <OverstockHero data={data} rows={filteredToday} />}

      {data && data.found && (
        <div className="osr-kpi-row">
          <div className="osr-kpi-card">
            <div className="osr-kpi-top">
              {/* BUG CORRIGÉ le 24/10/2026 (signalé : "le surstok doit etre au jour si il n'es plus
                  en surstok on ne dois plus le voir") — affichait auparavant "Historique de la
                  période" (filteredByShop, tout article vu en surstock au moins une fois sur 3
                  mois, y compris ceux plus en surstock aujourd'hui), remplacé par l'état PRÉSENT
                  (filteredToday), cohérent avec l'onglet "Aujourd'hui" juste en dessous. */}
              <span className="osr-kpi-label">Articles en surstock aujourd'hui</span>
              <span className="osr-kpi-icon" style={{ background: 'rgba(214,158,46,.12)', color: '#8A5A00' }}>
                <iconify-icon icon="solar:box-bold-duotone"></iconify-icon>
              </span>
            </div>
            <div className="osr-kpi-value">{filteredToday.length}</div>
          </div>
          <div className="osr-kpi-card">
            <div className="osr-kpi-top">
              {/* BUG CORRIGÉ le 24/10/2026 (signalé : "Toujours en surstock (0)... il faut corrigé
                  les terme") : renommé pour clarifier que c'est un sous-ensemble ENCORE en
                  surstock aujourd'hui ET depuis longtemps — le calcul lui-même était aussi cassé
                  (voir overstockReportService.js), corrigé en même temps. */}
              <span
                className="osr-kpi-label"
                title={data.periodMode ? `Articles encore en surstock aujourd'hui, de façon continue depuis au moins ${data.alwaysOverstockMinDays ?? 14} jours.` : undefined}
              >
                {data.periodMode ? 'En surstock depuis 14j+' : 'Casse analysée sur'}
              </span>
              <span className="osr-kpi-icon" style={{ background: 'rgba(214,69,65,.1)', color: '#B8302C' }}>
                <iconify-icon icon={data.periodMode ? 'solar:repeat-bold-duotone' : 'solar:trash-bin-trash-bold-duotone'}></iconify-icon>
              </span>
            </div>
            <div className="osr-kpi-value">{data.periodMode ? filteredPersistent.length : `${data.scrapLookbackDays || 90} j`}</div>
          </div>
        </div>
      )}

      {error && <div className="text-danger small mb-3">Erreur : {error}</div>}

      {!activeShopId() && !error ? (
        <div className="text-muted small py-4">Sélectionnez un magasin pour voir son surstock.</div>
      ) : null}

      {activeShopId() && data === null && !error ? (
        <div className="text-muted small">Chargement...</div>
      ) : data && !data.found ? (
        <div className="text-muted small py-4">{data.message || 'Aucune donnée.'}</div>
      ) : data ? (
        <>
          {/* Bouton Export sur la ligne des onglets (demande explicite du 21/10/2026 : "le bouton
              export il faut mettre a coté"... "fait pareil pour tout les autre onglé comme Toujours
              en surstock, Par magasin") — supprimé de la barre de filtres tout en haut de page,
              comme demandé explicitement ("le bouton export en haut il faut le supprimé"). Onglet
              "Surstock commun à plusieurs magasins" et son tableau "Magasins les plus en surstock"
              retirés le 23/10/2026 (page désormais mono-magasin, demande explicite : "supprime les
              autre filtre unitile") — n'ont plus de sens sans comparaison inter-magasins. */}
          <div className="osr-tabs">
            <button
              type="button"
              className={`osr-tab${activeTab === 'today' ? ' active' : ''}`}
              onClick={() => setActiveTab('today')}
              title="Articles en surstock À LA DERNIÈRE proposition générée (même définition que le graphique en haut de page)."
            >
              Aujourd'hui ({filteredToday.length})
            </button>
            <button
              type="button"
              className={`osr-tab${activeTab === 'persistent' ? ' active' : ''}`}
              onClick={() => setActiveTab('persistent')}
              title={`Encore en surstock aujourd'hui, de façon continue depuis au moins ${data.alwaysOverstockMinDays ?? 14} jours.`}
            >
              En surstock depuis 14j+ ({filteredPersistent.length})
            </button>
            <div className="ms-auto d-flex align-items-center">
              {activeTab === 'today' && (
                <button
                  type="button"
                  className="btn btn-sm btn-outline-primary"
                  onClick={() => setExportModal({ pageRows: todayPageRows, allRows: filteredToday, filenamePrefix: 'surstock-aujourdhui' })}
                  disabled={filteredToday.length === 0}
                >
                  <iconify-icon icon="solar:download-bold-duotone"></iconify-icon> Exporter (CSV)
                </button>
              )}
              {activeTab === 'persistent' && (
                <button
                  type="button"
                  className="btn btn-sm btn-outline-primary"
                  onClick={() => setExportModal({ pageRows: persistentPageRows, allRows: flatPersistentRows, filenamePrefix: 'surstock-toujours' })}
                  disabled={filteredPersistent.length === 0}
                >
                  <iconify-icon icon="solar:download-bold-duotone"></iconify-icon> Exporter (CSV)
                </button>
              )}
            </div>
          </div>

          {activeTab === 'today' && (
            <>
              {filteredToday.length > 0 && (
                <p className="text-muted small">
                  Articles en surstock à la dernière proposition générée pour ce magasin — même nombre que le graphique en haut de page.
                </p>
              )}
              <CommonArticlesTable
                rows={filteredToday}
                showRatio
                threshold={data.minWeeksOfCoverage}
                onOpenDetail={openScrapDetail}
                emptyMessage="Aucun article en surstock aujourd'hui pour ce seuil."
                onPageRowsChange={setTodayPageRows}
              />
            </>
          )}

          {activeTab === 'persistent' && (
            <>
              {filteredPersistent.length > 0 && (
                <p className="text-muted small">
                  Articles toujours en surstock depuis au moins {data.alwaysOverstockMinDays ?? 14} jours consécutifs, magasin par magasin.
                </p>
              )}
              <CommonArticlesTable
                rows={flatPersistentRows}
                showRatio
                threshold={data.minWeeksOfCoverage}
                onOpenDetail={openScrapDetail}
                emptyMessage="Aucun article en surstock de façon persistante sur cette période pour ce seuil."
                onPageRowsChange={setPersistentPageRows}
              />
            </>
          )}

        </>
      ) : null}
      {exportModal && (
        <ExportRowCountModal
          pageCount={exportModal.pageRows.length}
          totalCount={exportModal.allRows.length}
          onExport={handleFlatCommonExportChoice}
          onClose={() => setExportModal(null)}
        />
      )}
    </div>
  );
}


// Pagination (demande explicite du 21/10/2026) — numéros de page condensés (toujours la première,
// la dernière, la page courante et ses voisines immédiates, "…" pour le reste) : afficher 40+ boutons
// de page pour 2000 lignes serait aussi inutilisable que l'absence totale de pagination.
function PaginationBar({ page, totalPages, totalItems, onChange }: { page: number; totalPages: number; totalItems: number; onChange: (p: number) => void }) {
  if (totalPages <= 1) return null;

  const pages: (number | '…')[] = [];
  const add = (p: number) => { if (!pages.includes(p)) pages.push(p); };
  add(1);
  for (let p = page - 1; p <= page + 1; p++) if (p > 1 && p < totalPages) add(p);
  add(totalPages);
  const withGaps: (number | '…')[] = [];
  let prev = 0;
  for (const p of pages) {
    if (typeof p === 'number' && p - prev > 1) withGaps.push('…');
    withGaps.push(p);
    if (typeof p === 'number') prev = p;
  }

  return (
    <div className="osr-pagination">
      <button type="button" className="osr-page-btn" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        <iconify-icon icon="solar:alt-arrow-left-linear"></iconify-icon>
      </button>
      {withGaps.map((p, i) =>
        p === '…' ? (
          <span key={`gap-${i}`} className="osr-page-info">…</span>
        ) : (
          <button key={p} type="button" className={`osr-page-btn${p === page ? ' active' : ''}`} onClick={() => onChange(p)}>
            {p}
          </button>
        )
      )}
      <button type="button" className="osr-page-btn" disabled={page >= totalPages} onClick={() => onChange(page + 1)}>
        <iconify-icon icon="solar:alt-arrow-right-linear"></iconify-icon>
      </button>
      <span className="osr-page-info">{totalItems.toLocaleString('fr-FR')} résultat(s)</span>
    </div>
  );
}

// Tableau plat (une ligne par article × magasin) pour "Surstock commun"/"Toujours en surstock"
// (demande explicite du 21/10/2026 : "les tableau ici il ne faut pas utilisé les carde de ng que tu
// prend fait des tab avec un nouveau style" — remplace les cartes par article avec mini-tableau
// imbriqué par un vrai tableau simple, même style que "Par magasin", avec pagination à 50.
type FlatCommonRow = CommonShopEntry & { ean: string; label: string; department: string | null };

function flattenCommonArticles(articles: CommonArticle[]): FlatCommonRow[] {
  const rows: FlatCommonRow[] = [];
  for (const a of articles) {
    for (const s of a.shops) {
      rows.push({ ...s, ean: a.ean, label: a.label, department: a.department });
    }
  }
  return rows;
}

// Tri client (demande explicite du 24/10/2026 : "on ne peux pas filtré par croissant et decroissant
// comment les autre ajout tout ca") — CommonArticlesTable (onglets "Aujourd'hui"/"En surstock
// depuis 14j+") n'avait aucun tri de colonne, contrairement à ByShopTable. Les données sont déjà
// entièrement chargées en mémoire ici (pas de pagination serveur), donc un tri côté client simple
// suffit, jamais un second appel réseau.
const COMMON_TABLE_SORTABLE_FIELDS = new Set(['label', 'shopName', 'stock', 'sellingPrice', 'avgDailySales', 'avgWeeklySales', 'avgMonthlySales', 'weeksOfCoverage', 'overstockRatio', 'scrapQuantity90d']);

function CommonArticlesTable({ rows, showRatio, threshold, onOpenDetail, emptyMessage, onPageRowsChange }: { rows: FlatCommonRow[]; showRatio: boolean; threshold: number; onOpenDetail: (ean: string, label: string) => void; emptyMessage: string; onPageRowsChange?: (pageRows: FlatCommonRow[]) => void }) {
  const [page, setPage] = useState(1);
  const [sortField, setSortField] = useState<string | undefined>(undefined);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  // 10 par défaut, même raisonnement que ByShopTable ci-dessus (demande explicite du 21/10/2026).
  const PAGE_SIZE = 10;
  useEffect(() => { setPage(1); }, [rows]);

  function toggleSort(field: string) {
    if (sortField === field) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  }

  function sortIcon(field: string) {
    if (sortField !== field) return null;
    return <iconify-icon icon={sortDir === 'desc' ? 'solar:alt-arrow-down-linear' : 'solar:alt-arrow-up-linear'} style={{ fontSize: '11px', marginLeft: 4 }}></iconify-icon>;
  }

  const sortedRows = useMemo(() => {
    if (!sortField || !COMMON_TABLE_SORTABLE_FIELDS.has(sortField)) return rows;
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = (a as any)[sortField];
      const bv = (b as any)[sortField];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'string' || typeof bv === 'string') return dir * String(av).localeCompare(String(bv), 'fr-FR');
      return dir * (av - bv);
    });
  }, [rows, sortField, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const paged = sortedRows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  // Remonte la page affichée au parent (demande explicite du 21/10/2026 : "le bouton export...
  // doit etre la pour l'export et il me demande si je veux la feuille active ou tout" — appliqué
  // aux 3 onglets, pas seulement "Par magasin") — le bouton Export vit sur la ligne des onglets,
  // hors de ce composant, donc il a besoin de connaître la page actuellement affichée ici.
  useEffect(() => { onPageRowsChange?.(paged); }, [paged]); // eslint-disable-line react-hooks/exhaustive-deps

  if (rows.length === 0) {
    return <div className="text-muted small py-4">{emptyMessage}</div>;
  }

  return (
    <>
      <div className="osr-table-card">
        <div className="table-responsive">
          <table className="table align-middle table-hover mb-0">
            <thead className="bg-light-subtle">
              <tr>
                <th className="osr-sortable-th" onClick={() => toggleSort('label')}>Article{sortIcon('label')}</th>
                <th className="osr-sortable-th" onClick={() => toggleSort('shopName')}>Magasin{sortIcon('shopName')}</th>
                <th className="osr-sortable-th" onClick={() => toggleSort('stock')}>Stock{sortIcon('stock')}</th>
                <th className="osr-sortable-th" onClick={() => toggleSort('sellingPrice')}>Prix de vente{sortIcon('sellingPrice')}</th>
                <th className="osr-sortable-th" onClick={() => toggleSort('avgDailySales')}>Vente/jour{sortIcon('avgDailySales')}</th>
                <th className="osr-sortable-th" onClick={() => toggleSort('avgWeeklySales')}>Vente/semaine{sortIcon('avgWeeklySales')}</th>
                <th className="osr-sortable-th" onClick={() => toggleSort('avgMonthlySales')}>Vente/mois{sortIcon('avgMonthlySales')}</th>
                <th className="osr-sortable-th" onClick={() => toggleSort('weeksOfCoverage')}>Couverture{sortIcon('weeksOfCoverage')}</th>
                {showRatio && <th className="osr-sortable-th" onClick={() => toggleSort('overstockRatio')}>% du temps en surstock{sortIcon('overstockRatio')}</th>}
                <th className="osr-sortable-th" onClick={() => toggleSort('scrapQuantity90d')}>Casse (90j){sortIcon('scrapQuantity90d')}</th>
              </tr>
            </thead>
            <tbody>
              {paged.map((r, i) => (
                <tr
                  key={`${r.ean}:${r.rposShopId}:${i}`}
                  role="button"
                  style={{ cursor: 'pointer' }}
                  onClick={() => onOpenDetail(r.ean, r.label)}
                >
                  <td>
                    <div className="fw-semibold" style={{ fontSize: '.84rem', color: '#1B2A4A' }}>{r.label}</div>
                    <div className="text-muted" style={{ fontSize: '.72rem' }}>{r.ean}{r.department ? ` — ${r.department}` : ''}</div>
                  </td>
                  <td>{r.shopName} ({r.shopReference})</td>
                  <td>{r.stock}</td>
                  <td>{fmtCfa(r.sellingPrice)}</td>
                  <td>{r.avgDailySales}</td>
                  <td>{r.avgWeeklySales}</td>
                  <td>{r.avgMonthlySales}</td>
                  <td><CoveragePill weeks={r.weeksOfCoverage} threshold={threshold} /></td>
                  {showRatio && <td><span className="osr-persist-badge">{fmtPct(r.overstockRatio)}</span></td>}
                  <td>
                    {r.scrapQuantity90d > 0 ? (
                      <span className="osr-scrap-badge" title={r.lastScrapDate ? `Dernière casse : ${new Date(r.lastScrapDate).toLocaleDateString('fr-FR')}` : undefined}>
                        −{r.scrapQuantity90d} ({r.scrapMoveCount90d})
                      </span>
                    ) : (
                      <span className="text-muted small">Aucune</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <PaginationBar page={currentPage} totalPages={totalPages} totalItems={rows.length} onChange={setPage} />
    </>
  );
}
