import { useEffect, useMemo, useRef, useState } from 'react';
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
  alwaysOverstockThresholdRatio?: number | null;
  scrapLookbackDays?: number;
  shopCount: number;
  articleCount: number;
  articlesByShop: ShopArticleRow[];
  commonArticleCount: number;
  commonArticles: CommonArticle[];
  persistentArticleCount?: number | null;
  persistentArticles?: CommonArticle[] | null;
  trendPoints?: { date: string; count: number }[] | null;
  message?: string;
};

type Availability = { found: boolean; oldestDate?: string; newestDate?: string; message?: string };

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

// Menu déroulant personnalisé pour le filtre magasin (demande explicite du 21/10/2026 : "donne moi
// un bon style pour le menu deroulent") — un <select> natif ne peut pas être stylisé en profondeur
// une fois ouvert (c'est le navigateur, pas la page, qui dessine sa liste), d'où ce composant
// maison avec recherche intégrée (28+ magasins, plus rapide à trouver qu'en faisant défiler) et le
// même style doux (coins arrondis, surlignage au survol) que le reste de la page.
// Multi-sélection (demande explicite du 21/10/2026 : "donne la possiblité de prendre un ou
// plusieur magasin") : value est un Set d'ids magasin, vide = "Tous les magasins". Chaque clic sur
// une ligne coche/décoche ce magasin sans fermer le panneau (contrairement à un simple choix
// unique), pour permettre de cocher plusieurs magasins d'affilée.
function ShopDropdown({ value, options, onChange }: { value: Set<string>; options: [string, string][]; onChange: (v: Set<string>) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  useEffect(() => { if (!open) setQuery(''); }, [open]);

  const selectedLabel = value.size === 0
    ? 'Tous les magasins'
    : value.size === 1
      ? options.find(([id]) => value.has(id))?.[1] || '1 magasin'
      : `${value.size} magasins sélectionnés`;
  const filteredOptions = query.trim()
    ? options.filter(([, label]) => label.toLowerCase().includes(query.trim().toLowerCase()))
    : options;

  function toggle(id: string) {
    const next = new Set(value);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange(next);
  }

  return (
    <div className="osr-shop-dropdown" ref={rootRef}>
      <button type="button" className="osr-shop-dropdown-btn" onClick={() => setOpen((v) => !v)}>
        <iconify-icon icon="solar:shop-bold-duotone"></iconify-icon>
        <span className="osr-shop-dropdown-label">{selectedLabel}</span>
        <iconify-icon icon={open ? 'solar:alt-arrow-up-linear' : 'solar:alt-arrow-down-linear'} style={{ marginLeft: 'auto', fontSize: '13px', opacity: 0.6 }}></iconify-icon>
      </button>
      {open && (
        <div className="osr-shop-dropdown-panel">
          <input
            type="search"
            autoFocus
            className="osr-shop-dropdown-search"
            placeholder="Rechercher un magasin..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="osr-shop-dropdown-list">
            <div className={`osr-shop-dropdown-item${value.size === 0 ? ' active' : ''}`} onClick={() => onChange(new Set())}>
              <iconify-icon icon="solar:check-circle-bold" style={{ opacity: value.size === 0 ? 1 : 0, color: '#2456A6' }}></iconify-icon>
              Tous les magasins
            </div>
            {filteredOptions.length === 0 ? (
              <div className="osr-shop-dropdown-empty">Aucun magasin trouvé.</div>
            ) : (
              filteredOptions.map(([id, label]) => (
                <div key={id} className={`osr-shop-dropdown-item${value.has(id) ? ' active' : ''}`} onClick={() => toggle(id)}>
                  <iconify-icon icon="solar:check-circle-bold" style={{ opacity: value.has(id) ? 1 : 0, color: '#2456A6' }}></iconify-icon>
                  {label}
                </div>
              ))
            )}
          </div>
          {value.size > 0 && (
            <button type="button" className="osr-shop-dropdown-clear" onClick={() => onChange(new Set())}>
              Effacer la sélection ({value.size})
            </button>
          )}
        </div>
      )}
    </div>
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
      {data.periodMode && points.length > 1 ? (
        <div ref={chartRef}></div>
      ) : (
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

type TabKey = 'common' | 'byShop' | 'persistent';

export function OverstockReport() {
  const navigate = useNavigate();
  // Un compte mono-magasin (Rayonniste/Chef de rayon/Directeur) a maintenant le droit de voir le
  // surstock de SON PROPRE magasin (demande explicite du 21/10/2026 : "qui a le magasin doit avoir
  // le droit de voir les article sur surstok" — jusque-là la page lui était entièrement bloquée).
  // Le backend (overstockReportService.js/insights.js) le cantonne déjà à son seul magasin ; côté
  // UI, on masque simplement ce qui n'a pas de sens pour un compte qui ne voit qu'un seul magasin :
  // le sélecteur magasin (rien à filtrer) et l'onglet "communs à plusieurs magasins" (démarre donc
  // directement sur "Par magasin", le seul onglet pertinent pour lui).
  const user = window.reassortGetUser ? window.reassortGetUser() : null;
  const isSingleShop = user ? window.reassortIsSingleShopRole(user.role) : false;

  const [data, setData] = useState<OverstockReportData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [availability, setAvailability] = useState<Availability | null>(null);

  // "Paramètres" de l'analyse (demande explicite : "rendre le surtok dans les parametre sur le
  // UI... le user puisse lancer lui meme") — valeurs en attente tant que l'utilisateur n'a pas
  // cliqué "Lancer l'analyse", pour ne jamais relancer un calcul coûteux à chaque frappe clavier.
  const [minWeeksOfCoverage, setMinWeeksOfCoverage] = useState(2);
  const [periodEnabled, setPeriodEnabled] = useState(false);
  const [periodStart, setPeriodStart] = useState(() => new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  const [periodEnd, setPeriodEnd] = useState(() => new Date().toISOString().slice(0, 10));

  const [activeTab, setActiveTab] = useState<TabKey>(isSingleShop ? 'byShop' : 'common');
  // Multi-sélection magasin (demande explicite du 21/10/2026 : "donne la possiblité de prendre un
  // ou plusieur magasin") — Set vide = "Tous les magasins", comme avant la chaîne vide.
  const [shopFilters, setShopFilters] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');

  // Filtres par plage de valeurs (demande explicite du 21/10/2026 : "ajoute tout ses filtre
  // possible, dois pouvoir filtre par tout ca... Stock, Vente/jour, Vente/semaine, Vente/mois,
  // Couverture, Casse") — chaque métrique a son min et son max, vide = pas de borne sur ce côté.
  // Appliqués côté client sur les données déjà chargées, comme shopFilters/search ci-dessus.
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

  // Étendue réelle des données disponibles (demande explicite : "on doit me dire j'ai des donner de
  // quel periode... si je clique de 10/10/2026 alors que les donner commence de 12 le 10 doit etre
  // grisé") — chargé une fois au montage, sert de borne min au sélecteur de dates ci-dessous.
  useEffect(() => {
    apiFetch<Availability>('/reassort/overstock-report/availability')
      .then(setAvailability)
      .catch(() => setAvailability(null));
  }, []);

  function runAnalysis() {
    setData(null);
    setError(null);
    const params = new URLSearchParams({ minWeeksOfCoverage: String(minWeeksOfCoverage) });
    if (periodEnabled) {
      params.set('start', new Date(periodStart).toISOString());
      params.set('end', new Date(periodEnd + 'T23:59:59').toISOString());
    }
    apiFetch<OverstockReportData>(`/reassort/overstock-report?${params.toString()}`)
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }

  // Premier chargement automatique (snapshot, paramètres par défaut) — les relances suivantes sont
  // explicitement déclenchées par l'utilisateur via "Lancer l'analyse" (demande du 21/10/2026).
  useEffect(() => {
    runAnalysis();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const minAvailableDate = availability?.found && availability.oldestDate ? availability.oldestDate.slice(0, 10) : undefined;
  const maxAvailableDate = availability?.found && availability.newestDate ? availability.newestDate.slice(0, 10) : new Date().toISOString().slice(0, 10);

  const shopOptions = useMemo(() => {
    if (!data) return [];
    const seen = new Map<string, string>();
    for (const a of data.articlesByShop) {
      if (a.rposShopId && !seen.has(a.rposShopId)) seen.set(a.rposShopId, `${a.shopName} (${a.shopReference})`);
    }
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1], 'fr-FR'));
  }, [data]);

  const filteredByShop = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.articlesByShop.filter((a) => {
      if (shopFilters.size > 0 && !shopFilters.has(a.rposShopId)) return false;
      if (q && !a.label.toLowerCase().includes(q) && !a.ean.includes(q)) return false;
      if (!matchesRangeFilters(a)) return false;
      return true;
    });
  }, [data, shopFilters, search, rangeFilters, scrapOnly]);

  // Nombre de magasins distincts réellement représentés dans filteredByShop (demande explicite du
  // 21/10/2026 : "quand je vais le filtre sur un magasin je dois voir que les donner du magasin...
  // Magasins concernés il doit affiché 1") — les KPI du haut de page doivent suivre le filtre actif
  // (magasin + recherche), jamais les totaux bruts non filtrés renvoyés par l'API.
  const filteredShopCount = useMemo(() => new Set(filteredByShop.map((a) => a.rposShopId)).size, [filteredByShop]);

  // Quand un ou plusieurs magasins précis sont filtrés, chaque carte "article commun"/"persistant"
  // ne doit montrer QUE les lignes de ces magasins, pas les autres magasins qui partagent aussi cet
  // article (demande explicite du 21/10/2026 : "je dois voir que les donner du magasin" — étendu à
  // "un ou plusieurs magasins" avec la multi-sélection) — restreint shops EN PLUS de filtrer
  // quelles cartes apparaissent.
  const filteredCommon = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.commonArticles
      .filter((a) => !q || a.label.toLowerCase().includes(q) || a.ean.includes(q))
      .map((a) => ({
        ...a,
        shops: a.shops.filter((s) => (shopFilters.size === 0 || shopFilters.has(s.rposShopId)) && matchesRangeFilters(s)),
      }))
      .filter((a) => a.shops.length > 0);
  }, [data, shopFilters, search, rangeFilters, scrapOnly]);

  const filteredPersistent = useMemo(() => {
    if (!data?.persistentArticles) return [];
    const q = search.trim().toLowerCase();
    return data.persistentArticles
      .filter((a) => !q || a.label.toLowerCase().includes(q) || a.ean.includes(q))
      .map((a) => ({
        ...a,
        shops: a.shops.filter((s) => (shopFilters.size === 0 || shopFilters.has(s.rposShopId)) && matchesRangeFilters(s)),
      }))
      .filter((a) => a.shops.length > 0);
  }, [data, shopFilters, search, rangeFilters, scrapOnly]);

  // Versions "recherche seule, sans le filtre magasin" — utilisées quand l'utilisateur choisit
  // "tous les magasins" dans la confirmation d'export ci-dessous, même si un magasin précis est
  // sélectionné à l'écran (demande explicite du 21/10/2026 : "avant de le telecharger demande si il
  // prend tout pour le mag ou le filtre appliqué").
  const searchOnlyByShop = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.articlesByShop.filter((a) => !q || a.label.toLowerCase().includes(q) || a.ean.includes(q));
  }, [data, search]);
  const searchOnlyCommon = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.commonArticles.filter((a) => !q || a.label.toLowerCase().includes(q) || a.ean.includes(q));
  }, [data, search]);
  const searchOnlyPersistent = useMemo(() => {
    if (!data?.persistentArticles) return [];
    const q = search.trim().toLowerCase();
    return data.persistentArticles.filter((a) => !q || a.label.toLowerCase().includes(q) || a.ean.includes(q));
  }, [data, search]);

  // Avant chaque export, demande explicitement si l'export doit rester limité au magasin
  // actuellement filtré à l'écran, ou couvrir tous les magasins (recherche texte toujours
  // appliquée dans les deux cas — seul le filtre magasin est en jeu ici). N'affiche la question que
  // si un filtre magasin est réellement actif ; sinon rien à choisir, export direct.
  function openScrapDetail(ean: string, label: string) {
    navigate(`/overstock-report/scrap/${encodeURIComponent(ean)}?label=${encodeURIComponent(label)}&from=overstock-report`);
  }

  function confirmShopScope(): 'filtered' | 'all' | null {
    if (shopFilters.size === 0) return 'all';
    const shopLabels = shopOptions.filter(([id]) => shopFilters.has(id)).map(([, label]) => label);
    const shopsText = shopFilters.size === 1 ? shopLabels[0] : `${shopFilters.size} magasins sélectionnés`;
    const wantsAll = window.confirm(
      `Un filtre magasin est actif (${shopsText}).\n\nOK = exporter TOUS les magasins\nAnnuler = exporter seulement ${shopsText}`
    );
    return wantsAll ? 'all' : 'filtered';
  }

  function exportByShopCsv() {
    const scope = confirmShopScope();
    if (!scope) return;
    const rows = scope === 'all' ? searchOnlyByShop : filteredByShop;
    downloadCsv(
      `surstock-par-magasin-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Magasin', 'Référence magasin', 'EAN', 'Article', 'Rayon', 'Stock actuel', 'Prix de vente (CFA)', 'Vente moy./jour', 'Vente moy./semaine', 'Vente moy./mois', 'Semaines de couverture', '% du temps en surstock sur la période', 'Casse (qté, 90j)', 'Casse (nb mouvements, 90j)', 'Dernière casse'],
      rows.map((a) => [
        a.shopName, a.shopReference, a.ean, a.label, a.department, a.stock, a.sellingPrice, a.avgDailySales, a.avgWeeklySales, a.avgMonthlySales, a.weeksOfCoverage, a.overstockRatio !== undefined ? fmtPct(a.overstockRatio) : '',
        a.scrapQuantity90d, a.scrapMoveCount90d, a.lastScrapDate ? new Date(a.lastScrapDate).toLocaleDateString('fr-FR') : '',
      ])
    );
  }

  function exportGroupedCsv(filteredRows: CommonArticle[], searchOnlyRows: CommonArticle[], filenamePrefix: string) {
    const scope = confirmShopScope();
    if (!scope) return;
    const rows = scope === 'all' ? searchOnlyRows : filteredRows;
    const out: (string | number | null)[][] = [];
    for (const a of rows) {
      for (const s of a.shops) {
        out.push([
          a.ean, a.label, a.department, s.shopName, s.shopReference, s.stock, s.sellingPrice,
          s.avgDailySales, s.avgWeeklySales, s.avgMonthlySales, s.weeksOfCoverage,
          s.overstockRatio !== undefined ? fmtPct(s.overstockRatio) : '',
          s.scrapQuantity90d, s.scrapMoveCount90d, s.lastScrapDate ? new Date(s.lastScrapDate).toLocaleDateString('fr-FR') : '',
        ]);
      }
    }
    downloadCsv(
      `${filenamePrefix}-${new Date().toISOString().slice(0, 10)}.csv`,
      ['EAN', 'Article', 'Rayon', 'Magasin', 'Référence magasin', 'Stock actuel', 'Prix de vente (CFA)', 'Vente moy./jour', 'Vente moy./semaine', 'Vente moy./mois', 'Semaines de couverture', '% du temps en surstock sur la période', 'Casse (qté, 90j)', 'Casse (nb mouvements, 90j)', 'Dernière casse'],
      out
    );
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
        .osr-availability { font-size: .74rem; color: #8591A0; }
        .osr-filter-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 1rem; }
        .osr-adv-filter-btn { border: 1px solid rgba(27,42,74,.1); background: #FAFBFD; color: #5B6B85; font-size: .8rem; font-weight: 600; padding: 6px 13px; border-radius: 20px; display: inline-flex; align-items: center; gap: 7px; cursor: pointer; transition: background .15s, color .15s, border-color .15s; }
        .osr-adv-filter-btn:hover { background: #F0F3F9; color: #1B2A4A; }
        .osr-adv-filter-btn.active { background: rgba(36,86,166,.08); color: #2456A6; border-color: rgba(36,86,166,.25); }
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
        .osr-pill { border-radius: 20px; padding: 3px 11px; font-size: .72rem; font-weight: 700; display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
        .osr-pill-danger { background: rgba(214,69,65,.1); color: #B8302C; }
        .osr-pill-warning { background: rgba(214,158,46,.12); color: #8A5A00; }
        .osr-pill-neutral { background: rgba(27,42,74,.06); color: #5B6B85; }
        .osr-settings-details summary { list-style: none; cursor: pointer; }
        .osr-settings-details summary::-webkit-details-marker { display: none; }
        .osr-settings-summary { display: inline-flex; align-items: center; gap: 7px; font-size: .82rem; font-weight: 600; color: #5B6B85; padding: 6px 2px; }
        .osr-settings-summary:hover { color: #1B2A4A; }
        .osr-settings-details[open] .osr-settings-summary { color: #1B2A4A; }
        .osr-settings-details .osr-settings-card { margin-top: 10px; }
        .osr-shop-dropdown { position: relative; width: 240px; }
        .osr-shop-dropdown-btn { width: 100%; display: flex; align-items: center; gap: 8px; border: 1px solid rgba(27,42,74,.12); border-radius: 6px; background: #fff; padding: 6px 10px; font-size: .8rem; color: #1B2A4A; cursor: pointer; transition: border-color .15s, box-shadow .15s; }
        .osr-shop-dropdown-btn:hover { border-color: rgba(27,42,74,.25); }
        .osr-shop-dropdown-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; flex: 1; }
        .osr-shop-dropdown-panel { position: absolute; top: calc(100% + 6px); left: 0; width: 280px; background: #fff; border: 1px solid rgba(27,42,74,.1); border-radius: 10px; box-shadow: 0 12px 32px rgba(27,42,74,.14); z-index: 20; overflow: hidden; }
        .osr-shop-dropdown-search { width: 100%; border: none; border-bottom: 1px solid rgba(27,42,74,.08); padding: 10px 14px; font-size: .82rem; color: #1B2A4A; outline: none; background: #F9FAFC; }
        .osr-shop-dropdown-list { max-height: 280px; overflow-y: auto; padding: 6px; }
        .osr-shop-dropdown-item { padding: 8px 12px; border-radius: 7px; font-size: .82rem; color: #44516B; cursor: pointer; transition: background .12s, color .12s; display: flex; align-items: center; gap: 8px; }
        .osr-shop-dropdown-item:hover { background: #F6F8FB; color: #1B2A4A; }
        .osr-shop-dropdown-item.active { background: rgba(36,86,166,.1); color: #2456A6; font-weight: 600; }
        .osr-shop-dropdown-item iconify-icon { font-size: 15px; flex-shrink: 0; }
        .osr-shop-dropdown-empty { padding: 14px; text-align: center; font-size: .78rem; color: #8591A0; }
        .osr-shop-dropdown-clear { width: 100%; border: none; border-top: 1px solid rgba(27,42,74,.08); background: #F9FAFC; color: #B8302C; font-size: .78rem; font-weight: 600; padding: 9px 14px; cursor: pointer; text-align: center; }
        .osr-shop-dropdown-clear:hover { background: #F6F8FB; }
      `}</style>

      <div className="d-flex justify-content-between align-items-center flex-wrap gap-2 mb-3">
        <h4 className="mb-0" style={{ color: '#1B2A4A', fontWeight: 700 }}>Surstock</h4>
      </div>

      {data && data.found && <OverstockHero data={data} rows={filteredByShop} />}

      {data && data.found && (
        <div className="osr-kpi-row">
          <div className="osr-kpi-card">
            <div className="osr-kpi-top">
              <span className="osr-kpi-label">Magasins concernés</span>
              <span className="osr-kpi-icon" style={{ background: 'rgba(36,86,166,.1)', color: '#2456A6' }}>
                <iconify-icon icon="solar:shop-bold-duotone"></iconify-icon>
              </span>
            </div>
            <div className="osr-kpi-value">{filteredShopCount}</div>
          </div>
          <div className="osr-kpi-card">
            <div className="osr-kpi-top">
              <span className="osr-kpi-label">Articles en surstock{shopFilters.size > 0 ? ' (sélection)' : ' (total)'}</span>
              <span className="osr-kpi-icon" style={{ background: 'rgba(214,158,46,.12)', color: '#8A5A00' }}>
                <iconify-icon icon="solar:box-bold-duotone"></iconify-icon>
              </span>
            </div>
            <div className="osr-kpi-value">{filteredByShop.length}</div>
          </div>
          <div className="osr-kpi-card">
            <div className="osr-kpi-top">
              <span className="osr-kpi-label">Communs à plusieurs magasins</span>
              <span className="osr-kpi-icon" style={{ background: 'rgba(94,214,145,.14)', color: '#1C8A52' }}>
                <iconify-icon icon="solar:layers-bold-duotone"></iconify-icon>
              </span>
            </div>
            <div className="osr-kpi-value">{filteredCommon.length}</div>
          </div>
          <div className="osr-kpi-card">
            <div className="osr-kpi-top">
              <span className="osr-kpi-label">{data.periodMode ? 'Toujours en surstock' : 'Casse analysée sur'}</span>
              <span className="osr-kpi-icon" style={{ background: 'rgba(214,69,65,.1)', color: '#B8302C' }}>
                <iconify-icon icon={data.periodMode ? 'solar:repeat-bold-duotone' : 'solar:trash-bin-trash-bold-duotone'}></iconify-icon>
              </span>
            </div>
            <div className="osr-kpi-value">{data.periodMode ? filteredPersistent.length : `${data.scrapLookbackDays || 90} j`}</div>
          </div>
        </div>
      )}

      <details className="osr-settings-details mb-3">
        <summary className="osr-settings-summary">
          <iconify-icon icon="solar:settings-bold-duotone"></iconify-icon> Paramètres de l'analyse
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
          <span className="osr-icon"><iconify-icon icon="solar:calendar-bold-duotone"></iconify-icon></span>
          <label className="osr-switch">
            <input type="checkbox" checked={periodEnabled} onChange={(e) => setPeriodEnabled(e.target.checked)} />
            <span className="osr-label">Analyser sur une période (historique)</span>
          </label>
          <input
            type="date"
            className="osr-input"
            style={{ width: 150 }}
            value={periodStart}
            min={minAvailableDate}
            max={periodEnd}
            disabled={!periodEnabled}
            onChange={(e) => setPeriodStart(e.target.value)}
          />
          <span className="text-muted small">au</span>
          <input
            type="date"
            className="osr-input"
            style={{ width: 150 }}
            value={periodEnd}
            min={periodStart}
            max={maxAvailableDate}
            disabled={!periodEnabled}
            onChange={(e) => setPeriodEnd(e.target.value)}
          />
          <div className="d-flex align-items-center gap-2">
            {[
              { label: '7 j', days: 7 },
              { label: '30 j', days: 30 },
              { label: '3 mois', days: 90 },
              { label: '6 mois', days: 180 },
            ].map((preset) => (
              <button
                key={preset.days}
                type="button"
                className="btn btn-sm btn-outline-secondary"
                disabled={!periodEnabled}
                onClick={() => {
                  const end = new Date();
                  const earliestMs = minAvailableDate ? new Date(minAvailableDate).getTime() : 0;
                  const start = new Date(Math.max(earliestMs, end.getTime() - preset.days * 24 * 60 * 60 * 1000));
                  setPeriodEnd(end.toISOString().slice(0, 10));
                  setPeriodStart(start.toISOString().slice(0, 10));
                }}
              >
                {preset.label}
              </button>
            ))}
          </div>
          {availability?.found ? (
            <span className="osr-availability ms-auto">
              Données disponibles du {new Date(availability.oldestDate!).toLocaleDateString('fr-FR')} au {new Date(availability.newestDate!).toLocaleDateString('fr-FR')}
            </span>
          ) : availability && !availability.found ? (
            <span className="osr-availability ms-auto">{availability.message}</span>
          ) : null}
        </div>

        <div className="osr-settings-row">
          <button type="button" className="osr-run-btn" onClick={runAnalysis}>
            <iconify-icon icon="solar:play-bold"></iconify-icon> Lancer l'analyse
          </button>
        </div>
      </div>
      </details>

      {/* Bandeau "période analysée" (demande explicite du 21/10/2026 : "l'analyse deja fait c'est
          sur quel periode il faut affiche ca aussi") — toujours visible au-dessus des résultats,
          pas seulement dans le panneau paramètres qu'on peut avoir déjà fermé/oublié des yeux. */}
      {data && data.found && (
        <div className="osr-period-banner mb-3">
          <iconify-icon icon="solar:clock-circle-bold-duotone"></iconify-icon>{' '}
          {data.periodMode
            ? <>Analyse sur la période du <strong>{new Date(data.periodStart!).toLocaleDateString('fr-FR')}</strong> au <strong>{new Date(data.periodEnd!).toLocaleDateString('fr-FR')}</strong></>
            : <>Analyse sur la <strong>situation actuelle</strong> (dernière proposition générée par magasin)</>}
        </div>
      )}

      {error && <div className="text-danger small mb-3">Erreur : {error}</div>}

      {data === null && !error ? (
        <div className="text-muted small">Chargement...</div>
      ) : data && !data.found ? (
        <div className="text-muted small py-4">{data.message || 'Aucune donnée.'}</div>
      ) : data ? (
        <>
          <div className="osr-filter-bar">
            {!isSingleShop && <ShopDropdown value={shopFilters} options={shopOptions} onChange={setShopFilters} />}
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
            <div className="ms-auto">
              {activeTab === 'byShop' && (
                <button type="button" className="btn btn-sm btn-outline-primary" onClick={exportByShopCsv}>
                  <iconify-icon icon="solar:download-bold-duotone"></iconify-icon> Exporter (CSV)
                </button>
              )}
              {activeTab === 'common' && (
                <button type="button" className="btn btn-sm btn-outline-primary" onClick={() => exportGroupedCsv(filteredCommon, searchOnlyCommon, 'surstock-commun')}>
                  <iconify-icon icon="solar:download-bold-duotone"></iconify-icon> Exporter (CSV)
                </button>
              )}
              {activeTab === 'persistent' && (
                <button type="button" className="btn btn-sm btn-outline-primary" onClick={() => exportGroupedCsv(filteredPersistent, searchOnlyPersistent, 'surstock-toujours')}>
                  <iconify-icon icon="solar:download-bold-duotone"></iconify-icon> Exporter (CSV)
                </button>
              )}
            </div>
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

          <div className="osr-tabs">
            {!isSingleShop && (
              <button type="button" className={`osr-tab${activeTab === 'common' ? ' active' : ''}`} onClick={() => setActiveTab('common')}>
                Surstock commun à plusieurs magasins ({filteredCommon.length})
              </button>
            )}
            {data.periodMode && (
              <button type="button" className={`osr-tab${activeTab === 'persistent' ? ' active' : ''}`} onClick={() => setActiveTab('persistent')}>
                Toujours en surstock ({filteredPersistent.length})
              </button>
            )}
            <button type="button" className={`osr-tab${activeTab === 'byShop' ? ' active' : ''}`} onClick={() => setActiveTab('byShop')}>
              Par magasin ({filteredByShop.length})
            </button>
          </div>

          {activeTab === 'common' && (
            <CommonArticlesTable
              rows={flattenCommonArticles(filteredCommon)}
              showRatio={!!data.periodMode}
              threshold={data.minWeeksOfCoverage}
              onOpenDetail={openScrapDetail}
              emptyMessage="Aucun article en surstock dans plusieurs magasins à la fois pour ce seuil."
            />
          )}

          {activeTab === 'persistent' && (
            <>
              {filteredPersistent.length > 0 && (
                <p className="text-muted small">
                  Articles en surstock dans au moins {fmtPct(data.alwaysOverstockThresholdRatio ?? 0.9)} des propositions générées sur la période, magasin par magasin.
                </p>
              )}
              <CommonArticlesTable
                rows={flattenCommonArticles(filteredPersistent)}
                showRatio
                threshold={data.minWeeksOfCoverage}
                onOpenDetail={openScrapDetail}
                emptyMessage="Aucun article en surstock de façon persistante sur cette période pour ce seuil."
              />
            </>
          )}

          {activeTab === 'byShop' && (
            <ByShopTable rows={filteredByShop} periodMode={!!data.periodMode} threshold={data.minWeeksOfCoverage} onOpenDetail={openScrapDetail} />
          )}
        </>
      ) : null}
    </div>
  );
}

// Tableau "Par magasin" en HTML simple, même style que CommonArticlesTable (demande explicite du
// 21/10/2026 : "les tableau ici il ne faut pas utilisé les carde de ng que tu prend fait des tab
// avec un nouveau style" — remplace la grille ag-Grid précédente, dont la pagination à 50 par page
// avait fini par échapper à l'écran avec des dizaines de milliers de lignes une fois le calcul
// étendu aux ventes/stock pour les magasins sans proposition). Pagination maison (PaginationBar),
// identique sur les 3 onglets de cette page désormais.
function ByShopTable({ rows, periodMode, threshold, onOpenDetail }: { rows: ShopArticleRow[]; periodMode: boolean; threshold: number; onOpenDetail: (ean: string, label: string) => void }) {
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 50;
  useEffect(() => { setPage(1); }, [rows]);
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const paged = rows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  if (rows.length === 0) {
    return <div className="text-muted small py-4">Aucun article en surstock pour ce seuil.</div>;
  }

  return (
    <>
      <div className="osr-table-card">
        <div className="table-responsive">
          <table className="table align-middle table-hover mb-0">
            <thead className="bg-light-subtle">
              <tr>
                <th>Article</th>
                <th>Magasin</th>
                <th>Rayon</th>
                <th>Stock</th>
                <th>Prix de vente</th>
                <th>Vente/jour</th>
                <th>Vente/semaine</th>
                <th>Vente/mois</th>
                <th>Couverture</th>
                {periodMode && <th>% du temps en surstock</th>}
                <th>Casse (90j)</th>
              </tr>
            </thead>
            <tbody>
              {paged.map((r, i) => (
                <tr
                  key={`${r.rposShopId}:${r.ean}:${i}`}
                  role="button"
                  style={{ cursor: 'pointer' }}
                  onClick={() => onOpenDetail(r.ean, r.label)}
                >
                  <td>
                    <div className="fw-semibold" style={{ fontSize: '.84rem', color: '#1B2A4A' }}>{r.label}</div>
                    <div className="text-muted" style={{ fontSize: '.72rem' }}>{r.ean}</div>
                  </td>
                  <td>{r.shopName} ({r.shopReference})</td>
                  <td>{r.department || '—'}</td>
                  <td>{r.stock}</td>
                  <td>{fmtCfa(r.sellingPrice)}</td>
                  <td>{r.avgDailySales}</td>
                  <td>{r.avgWeeklySales}</td>
                  <td>{r.avgMonthlySales}</td>
                  <td><CoveragePill weeks={r.weeksOfCoverage} threshold={threshold} /></td>
                  {periodMode && <td>{fmtPct(r.overstockRatio)}</td>}
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

function CommonArticlesTable({ rows, showRatio, threshold, onOpenDetail, emptyMessage }: { rows: FlatCommonRow[]; showRatio: boolean; threshold: number; onOpenDetail: (ean: string, label: string) => void; emptyMessage: string }) {
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 50;
  useEffect(() => { setPage(1); }, [rows]);
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const paged = rows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

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
                <th>Article</th>
                <th>Magasin</th>
                <th>Stock</th>
                <th>Prix de vente</th>
                <th>Vente/jour</th>
                <th>Vente/semaine</th>
                <th>Vente/mois</th>
                <th>Couverture</th>
                {showRatio && <th>% du temps en surstock</th>}
                <th>Casse (90j)</th>
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
