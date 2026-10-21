import { useEffect, useMemo, useState } from 'react';
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

type TabKey = 'common' | 'byShop' | 'persistent';

export function OverstockReport() {
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

  const [activeTab, setActiveTab] = useState<TabKey>('common');
  const [shopFilter, setShopFilter] = useState('');
  const [search, setSearch] = useState('');

  // Pagination (demande explicite du 21/10/2026 : "ici il me dis 2107 en surktok et il affuche 25...
  // il faut ajouter un systeme de pagination") — 2107+ lignes dans un seul tableau HTML sans
  // virtualisation (contrairement à Proposition de commande, qui utilise ag-Grid) ralentissait le
  // rendu et rendait la liste inutilisable. Un seul état de page par onglet : changer d'onglet ou de
  // filtre revient toujours à la page 1 (cf. resets ci-dessous), jamais une page vide sur un onglet
  // qui a moins de résultats que la page courante sur un autre.
  const PAGE_SIZE = 50;
  const [page, setPage] = useState(1);

  // Page intrinsèquement multi-magasins (backend : requireAdminOrSupervisor) — un compte
  // Rayonniste/Chef de département (mono-magasin) n'y a pas accès. Message explicite plutôt que de
  // laisser le 403 backend remonter tel quel, même esprit que AdminGuard ("garde-fou cosmétique, la
  // vraie sécurité reste le backend") mais basé sur le rôle réel plutôt que sur isAdmin seul, pour
  // ne pas masquer la page aux SUPERVISOR qui, eux, y ont accès (cf. navConfig.ts).
  const user = window.reassortGetUser ? window.reassortGetUser() : null;
  const isSingleShop = user ? window.reassortIsSingleShopRole(user.role) : false;

  // Étendue réelle des données disponibles (demande explicite : "on doit me dire j'ai des donner de
  // quel periode... si je clique de 10/10/2026 alors que les donner commence de 12 le 10 doit etre
  // grisé") — chargé une fois au montage, sert de borne min au sélecteur de dates ci-dessous.
  useEffect(() => {
    if (isSingleShop) return;
    apiFetch<Availability>('/reassort/overstock-report/availability')
      .then(setAvailability)
      .catch(() => setAvailability(null));
  }, [isSingleShop]);

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
    if (isSingleShop) return;
    runAnalysis();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSingleShop]);

  if (isSingleShop) {
    return (
      <div className="container-fluid py-4">
        <div className="alert alert-info">Cette page compare plusieurs magasins entre eux — réservée aux comptes ayant accès à plusieurs magasins (administrateur ou superviseur).</div>
      </div>
    );
  }

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
      if (shopFilter && a.rposShopId !== shopFilter) return false;
      if (q && !a.label.toLowerCase().includes(q) && !a.ean.includes(q)) return false;
      return true;
    });
  }, [data, shopFilter, search]);

  // Nombre de magasins distincts réellement représentés dans filteredByShop (demande explicite du
  // 21/10/2026 : "quand je vais le filtre sur un magasin je dois voir que les donner du magasin...
  // Magasins concernés il doit affiché 1") — les KPI du haut de page doivent suivre le filtre actif
  // (magasin + recherche), jamais les totaux bruts non filtrés renvoyés par l'API.
  const filteredShopCount = useMemo(() => new Set(filteredByShop.map((a) => a.rposShopId)).size, [filteredByShop]);

  // Quand un magasin précis est filtré, chaque carte "article commun"/"persistant" ne doit montrer
  // QUE la ligne de ce magasin, pas les autres magasins qui partagent aussi cet article (demande
  // explicite du 21/10/2026 : "je dois voir que les donner du magasin") — restreint shops EN PLUS
  // de filtrer quelles cartes apparaissent.
  const filteredCommon = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.commonArticles
      .filter((a) => !q || a.label.toLowerCase().includes(q) || a.ean.includes(q))
      .map((a) => (shopFilter ? { ...a, shops: a.shops.filter((s) => s.rposShopId === shopFilter) } : a))
      .filter((a) => a.shops.length > 0);
  }, [data, shopFilter, search]);

  const filteredPersistent = useMemo(() => {
    if (!data?.persistentArticles) return [];
    const q = search.trim().toLowerCase();
    return data.persistentArticles
      .filter((a) => !q || a.label.toLowerCase().includes(q) || a.ean.includes(q))
      .map((a) => (shopFilter ? { ...a, shops: a.shops.filter((s) => s.rposShopId === shopFilter) } : a))
      .filter((a) => a.shops.length > 0);
  }, [data, shopFilter, search]);

  // Revient à la page 1 dès que la liste affichée change de taille/contenu (changement d'onglet, de
  // filtre magasin, de recherche, ou nouvelle analyse) — évite une page 3 vide quand le nouveau
  // résultat n'a que 2 pages.
  useEffect(() => { setPage(1); }, [activeTab, shopFilter, search, data]);

  const activeRows = activeTab === 'byShop' ? filteredByShop : activeTab === 'common' ? filteredCommon : filteredPersistent;
  const totalPages = Math.max(1, Math.ceil(activeRows.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * PAGE_SIZE;
  const pagedByShop = activeTab === 'byShop' ? filteredByShop.slice(pageStart, pageStart + PAGE_SIZE) : [];
  const pagedCommon = activeTab === 'common' ? filteredCommon.slice(pageStart, pageStart + PAGE_SIZE) : [];
  const pagedPersistent = activeTab === 'persistent' ? filteredPersistent.slice(pageStart, pageStart + PAGE_SIZE) : [];

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
  function confirmShopScope(): 'filtered' | 'all' | null {
    if (!shopFilter) return 'all';
    const shopLabel = shopOptions.find(([id]) => id === shopFilter)?.[1] || 'ce magasin';
    const wantsAll = window.confirm(
      `Un filtre magasin est actif (${shopLabel}).\n\nOK = exporter TOUS les magasins\nAnnuler = exporter seulement ${shopLabel}`
    );
    return wantsAll ? 'all' : 'filtered';
  }

  function exportByShopCsv() {
    const scope = confirmShopScope();
    if (!scope) return;
    const rows = scope === 'all' ? searchOnlyByShop : filteredByShop;
    downloadCsv(
      `surstock-par-magasin-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Magasin', 'Référence magasin', 'EAN', 'Article', 'Rayon', 'Stock actuel', 'Prix de vente (CFA)', 'Vente moy./jour', 'Vente moy./semaine', 'Vente moy./mois', 'Semaines de couverture', '% du temps en surstock sur la période'],
      rows.map((a) => [a.shopName, a.shopReference, a.ean, a.label, a.department, a.stock, a.sellingPrice, a.avgDailySales, a.avgWeeklySales, a.avgMonthlySales, a.weeksOfCoverage, a.overstockRatio !== undefined ? fmtPct(a.overstockRatio) : ''])
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
        .osr-tabs { display: flex; gap: 4px; border-bottom: 1px solid rgba(27,42,74,.08); margin-bottom: 1rem; flex-wrap: wrap; }
        .osr-tab { border: none; background: none; padding: 10px 16px; font-size: .86rem; font-weight: 600; color: #8591A0; border-bottom: 2px solid transparent; cursor: pointer; white-space: nowrap; }
        .osr-tab.active { color: #1B2A4A; border-bottom-color: #1B2A4A; }
        .osr-common-card { background: #fff; border: 1px solid rgba(27,42,74,.08); border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; }
        .osr-common-head { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
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
      `}</style>

      <div className="d-flex justify-content-between align-items-center flex-wrap gap-2 mb-3">
        <h4 className="mb-0" style={{ color: '#1B2A4A', fontWeight: 700 }}>Surstock</h4>
      </div>
      <p className="text-muted small mb-3">
        Articles dont le stock couvre largement plus que la vente moyenne — même règle que l'assistant IA (stock ÷ vente moyenne/semaine).
        Réglez les paramètres ci-dessous puis lancez l'analyse.
      </p>

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
            <select className="osr-input" style={{ width: 220 }} value={shopFilter} onChange={(e) => setShopFilter(e.target.value)}>
              <option value="">Tous les magasins</option>
              {shopOptions.map(([id, label]) => (
                <option key={id} value={id}>{label}</option>
              ))}
            </select>
            <input
              type="search"
              className="osr-input"
              style={{ width: 220 }}
              placeholder="Rechercher un article..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
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

          <div className="row g-3 mb-3">
            <div className="col-6 col-md-3">
              <div className="text-muted small">Magasins concernés</div>
              <div className="fs-4 fw-semibold">{filteredShopCount}</div>
            </div>
            <div className="col-6 col-md-3">
              <div className="text-muted small">Articles en surstock{shopFilter ? ' (ce magasin)' : ' (total)'}</div>
              <div className="fs-4 fw-semibold">{filteredByShop.length}</div>
            </div>
            <div className="col-6 col-md-3">
              <div className="text-muted small">Communs à plusieurs magasins</div>
              <div className="fs-4 fw-semibold">{filteredCommon.length}</div>
            </div>
            <div className="col-6 col-md-3">
              <div className="text-muted small">{data.periodMode ? 'Toujours en surstock' : 'Casse analysée sur'}</div>
              <div className="fs-4 fw-semibold">{data.periodMode ? filteredPersistent.length : `${data.scrapLookbackDays || 90} j`}</div>
            </div>
          </div>

          <div className="osr-tabs">
            <button type="button" className={`osr-tab${activeTab === 'common' ? ' active' : ''}`} onClick={() => setActiveTab('common')}>
              Surstock commun à plusieurs magasins ({filteredCommon.length})
            </button>
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
            filteredCommon.length === 0 ? (
              <div className="text-muted small py-4">Aucun article en surstock dans plusieurs magasins à la fois pour ce seuil.</div>
            ) : (
              <>
                {pagedCommon.map((a) => <CommonArticleCard key={a.ean} a={a} showRatio={!!data.periodMode} />)}
                <PaginationBar page={currentPage} totalPages={totalPages} totalItems={filteredCommon.length} onChange={setPage} />
              </>
            )
          )}

          {activeTab === 'persistent' && (
            filteredPersistent.length === 0 ? (
              <div className="text-muted small py-4">Aucun article en surstock de façon persistante sur cette période pour ce seuil.</div>
            ) : (
              <>
                <p className="text-muted small">
                  Articles en surstock dans au moins {fmtPct(data.alwaysOverstockThresholdRatio ?? 0.9)} des propositions générées sur la période, magasin par magasin.
                </p>
                {pagedPersistent.map((a) => <CommonArticleCard key={a.ean} a={a} showRatio />)}
                <PaginationBar page={currentPage} totalPages={totalPages} totalItems={filteredPersistent.length} onChange={setPage} />
              </>
            )
          )}

          {activeTab === 'byShop' && (
            <>
              <div className="table-responsive">
                <table className="table align-middle table-hover mb-0">
                  <thead className="bg-light-subtle">
                    <tr>
                      <th>Magasin</th>
                      <th>EAN</th>
                      <th>Article</th>
                      <th>Rayon</th>
                      <th>Stock</th>
                      <th>Prix de vente</th>
                      <th>Vente/jour</th>
                      <th>Vente/semaine</th>
                      <th>Vente/mois</th>
                      <th>Couverture</th>
                      {data.periodMode && <th>% du temps en surstock</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {pagedByShop.length === 0 ? (
                      <tr><td colSpan={data.periodMode ? 11 : 10} className="text-center text-muted py-4">Aucun article en surstock pour ce seuil.</td></tr>
                    ) : (
                      pagedByShop.map((a, i) => (
                        <tr key={`${a.rposShopId}:${a.ean}:${i}`}>
                          <td>{a.shopName} ({a.shopReference})</td>
                          <td>{a.ean}</td>
                          <td>{a.label}</td>
                          <td>{a.department || '—'}</td>
                          <td>{a.stock}</td>
                          <td>{fmtCfa(a.sellingPrice)}</td>
                          <td>{a.avgDailySales}</td>
                          <td>{a.avgWeeklySales}</td>
                          <td>{a.avgMonthlySales}</td>
                          <td>{a.weeksOfCoverage ?? '—'} sem.</td>
                          {data.periodMode && <td>{fmtPct(a.overstockRatio)}</td>}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              <PaginationBar page={currentPage} totalPages={totalPages} totalItems={filteredByShop.length} onChange={setPage} />
            </>
          )}
        </>
      ) : null}
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

function CommonArticleCard({ a, showRatio }: { a: CommonArticle; showRatio: boolean }) {
  return (
    <div className="osr-common-card">
      <div className="osr-common-head">
        <div>
          <strong>{a.label}</strong> <span className="text-muted small">({a.ean})</span>
          {a.department && <span className="text-muted small"> — {a.department}</span>}
        </div>
        <div className="small text-muted">{a.shops.length} magasin(s) · {fmtCfa(a.sellingPrice)}</div>
      </div>
      <div className="table-responsive">
        <table className="table table-sm align-middle mb-0">
          <thead className="bg-light-subtle">
            <tr>
              <th>Magasin</th>
              <th>Stock</th>
              <th>Vente/jour</th>
              <th>Vente/semaine</th>
              <th>Vente/mois</th>
              <th>Couverture</th>
              {showRatio && <th>% du temps en surstock</th>}
              <th>Casse (90j)</th>
            </tr>
          </thead>
          <tbody>
            {a.shops.map((s) => (
              <tr key={s.rposShopId}>
                <td>{s.shopName} ({s.shopReference})</td>
                <td>{s.stock}</td>
                <td>{s.avgDailySales}</td>
                <td>{s.avgWeeklySales}</td>
                <td>{s.avgMonthlySales}</td>
                <td>{s.weeksOfCoverage ?? '—'} sem.</td>
                {showRatio && (
                  <td>
                    <span className="osr-persist-badge">{fmtPct(s.overstockRatio)}</span>
                  </td>
                )}
                <td>
                  {s.scrapQuantity90d > 0 ? (
                    <span className="osr-scrap-badge" title={s.lastScrapDate ? `Dernière casse : ${new Date(s.lastScrapDate).toLocaleDateString('fr-FR')}` : undefined}>
                      −{s.scrapQuantity90d} ({s.scrapMoveCount90d})
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
  );
}
