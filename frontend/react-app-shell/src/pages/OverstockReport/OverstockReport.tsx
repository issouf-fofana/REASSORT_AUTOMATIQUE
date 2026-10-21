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

  const filteredCommon = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.commonArticles.filter((a) => {
      if (shopFilter && !a.shops.some((s) => s.rposShopId === shopFilter)) return false;
      if (q && !a.label.toLowerCase().includes(q) && !a.ean.includes(q)) return false;
      return true;
    });
  }, [data, shopFilter, search]);

  const filteredPersistent = useMemo(() => {
    if (!data?.persistentArticles) return [];
    const q = search.trim().toLowerCase();
    return data.persistentArticles.filter((a) => {
      if (shopFilter && !a.shops.some((s) => s.rposShopId === shopFilter)) return false;
      if (q && !a.label.toLowerCase().includes(q) && !a.ean.includes(q)) return false;
      return true;
    });
  }, [data, shopFilter, search]);

  function exportByShopCsv() {
    downloadCsv(
      `surstock-par-magasin-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Magasin', 'Référence magasin', 'EAN', 'Article', 'Rayon', 'Stock actuel', 'Prix de vente (CFA)', 'Vente moy./jour', 'Vente moy./semaine', 'Vente moy./mois', 'Semaines de couverture', '% du temps en surstock sur la période'],
      filteredByShop.map((a) => [a.shopName, a.shopReference, a.ean, a.label, a.department, a.stock, a.sellingPrice, a.avgDailySales, a.avgWeeklySales, a.avgMonthlySales, a.weeksOfCoverage, a.overstockRatio !== undefined ? fmtPct(a.overstockRatio) : ''])
    );
  }

  function exportGroupedCsv(rows: CommonArticle[], filenamePrefix: string) {
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
          {data && (
            <span className="text-muted small">
              {data.periodMode
                ? `Analyse sur la période du ${new Date(data.periodStart!).toLocaleDateString('fr-FR')} au ${new Date(data.periodEnd!).toLocaleDateString('fr-FR')}`
                : 'Analyse sur la situation actuelle (dernière proposition par magasin)'}
            </span>
          )}
        </div>
      </div>

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
                <button type="button" className="btn btn-sm btn-outline-primary" onClick={() => exportGroupedCsv(filteredCommon, 'surstock-commun')}>
                  <iconify-icon icon="solar:download-bold-duotone"></iconify-icon> Exporter (CSV)
                </button>
              )}
              {activeTab === 'persistent' && (
                <button type="button" className="btn btn-sm btn-outline-primary" onClick={() => exportGroupedCsv(filteredPersistent, 'surstock-toujours')}>
                  <iconify-icon icon="solar:download-bold-duotone"></iconify-icon> Exporter (CSV)
                </button>
              )}
            </div>
          </div>

          <div className="row g-3 mb-3">
            <div className="col-6 col-md-3">
              <div className="text-muted small">Magasins concernés</div>
              <div className="fs-4 fw-semibold">{data.shopCount}</div>
            </div>
            <div className="col-6 col-md-3">
              <div className="text-muted small">Articles en surstock (total)</div>
              <div className="fs-4 fw-semibold">{data.articleCount}</div>
            </div>
            <div className="col-6 col-md-3">
              <div className="text-muted small">Communs à plusieurs magasins</div>
              <div className="fs-4 fw-semibold">{data.commonArticleCount}</div>
            </div>
            <div className="col-6 col-md-3">
              <div className="text-muted small">{data.periodMode ? 'Toujours en surstock' : 'Casse analysée sur'}</div>
              <div className="fs-4 fw-semibold">{data.periodMode ? (data.persistentArticleCount ?? 0) : `${data.scrapLookbackDays || 90} j`}</div>
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
              filteredCommon.map((a) => <CommonArticleCard key={a.ean} a={a} showRatio={!!data.periodMode} />)
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
                {filteredPersistent.map((a) => <CommonArticleCard key={a.ean} a={a} showRatio />)}
              </>
            )
          )}

          {activeTab === 'byShop' && (
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
                  {filteredByShop.length === 0 ? (
                    <tr><td colSpan={data.periodMode ? 11 : 10} className="text-center text-muted py-4">Aucun article en surstock pour ce seuil.</td></tr>
                  ) : (
                    filteredByShop.map((a, i) => (
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
          )}
        </>
      ) : null}
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
