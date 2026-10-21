import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../../shared/api/client';

// Page Surstock (demande explicite du 21/10/2026) : "sortir pour les magasins chaque magasin les
// articles en sur stock", "identifier les articles que les magasins ont en commun en surstock",
// "si tu les casse sortir la casse de ces articles sur les 3 dernières mois", "avoir la possibilité
// d'avoir ca sur une page ou je peux telechargé en exel ou csv", "les info comme vente moyen par
// jour semaine et mois... prix de vente, nom de l'article, code".
//
// Définition du surstock IDENTIQUE à getOverstockArticles (chatbotToolsService.js) : stock actuel
// ÷ vente moyenne hebdomadaire ≥ seuil (en semaines de couverture), lu depuis la DERNIÈRE
// proposition générée par magasin (overstockReportService.js côté backend) — pas un nouveau calcul
// indépendant. Seuil par défaut 2 semaines (pas 6, le seuil du chatbot jugé trop élevé par
// l'utilisateur le 21/10/2026 : "6 semaine est trop"), réglable directement sur cette page.

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
  weeksOfCoverage: number;
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
  weeksOfCoverage: number;
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
  minWeeksOfCoverage: number;
  scrapLookbackDays?: number;
  shopCount: number;
  articleCount: number;
  articlesByShop: ShopArticleRow[];
  commonArticleCount: number;
  commonArticles: CommonArticle[];
  message?: string;
};

function fmtCfa(n: number | null): string {
  if (n === null || n === undefined) return '—';
  return `${Math.round(n).toLocaleString('fr-FR')} CFA`;
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

export function OverstockReport() {
  const [data, setData] = useState<OverstockReportData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [minWeeksOfCoverage, setMinWeeksOfCoverage] = useState(2);
  const [activeTab, setActiveTab] = useState<'byShop' | 'common'>('common');
  const [shopFilter, setShopFilter] = useState('');
  const [search, setSearch] = useState('');

  // Page intrinsèquement multi-magasins (backend : requireAdminOrSupervisor) — un compte
  // Rayonniste/Chef de département (mono-magasin) n'y a pas accès. Message explicite plutôt que de
  // laisser le 403 backend remonter tel quel, même esprit que AdminGuard ("garde-fou cosmétique, la
  // vraie sécurité reste le backend") mais basé sur le rôle réel plutôt que sur isAdmin seul, pour
  // ne pas masquer la page aux SUPERVISOR qui, eux, y ont accès (cf. navConfig.ts).
  const user = window.reassortGetUser ? window.reassortGetUser() : null;
  const isSingleShop = user ? window.reassortIsSingleShopRole(user.role) : false;

  useEffect(() => {
    if (isSingleShop) return;
    let cancelled = false;
    setData(null);
    setError(null);
    apiFetch<OverstockReportData>(`/reassort/overstock-report?minWeeksOfCoverage=${minWeeksOfCoverage}`)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minWeeksOfCoverage, isSingleShop]);

  if (isSingleShop) {
    return (
      <div className="container-fluid py-4">
        <div className="alert alert-info">Cette page compare plusieurs magasins entre eux — réservée aux comptes ayant accès à plusieurs magasins (administrateur ou superviseur).</div>
      </div>
    );
  }

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

  function exportByShopCsv() {
    downloadCsv(
      `surstock-par-magasin-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Magasin', 'Référence magasin', 'EAN', 'Article', 'Rayon', 'Stock actuel', 'Prix de vente (CFA)', 'Vente moy./jour', 'Vente moy./semaine', 'Vente moy./mois', 'Semaines de couverture'],
      filteredByShop.map((a) => [a.shopName, a.shopReference, a.ean, a.label, a.department, a.stock, a.sellingPrice, a.avgDailySales, a.avgWeeklySales, a.avgMonthlySales, a.weeksOfCoverage])
    );
  }

  function exportCommonCsv() {
    const rows: (string | number | null)[][] = [];
    for (const a of filteredCommon) {
      for (const s of a.shops) {
        rows.push([
          a.ean, a.label, a.department, s.shopName, s.shopReference, s.stock, s.sellingPrice,
          s.avgDailySales, s.avgWeeklySales, s.avgMonthlySales, s.weeksOfCoverage,
          s.scrapQuantity90d, s.scrapMoveCount90d, s.lastScrapDate ? new Date(s.lastScrapDate).toLocaleDateString('fr-FR') : '',
        ]);
      }
    }
    downloadCsv(
      `surstock-commun-${new Date().toISOString().slice(0, 10)}.csv`,
      ['EAN', 'Article', 'Rayon', 'Magasin', 'Référence magasin', 'Stock actuel', 'Prix de vente (CFA)', 'Vente moy./jour', 'Vente moy./semaine', 'Vente moy./mois', 'Semaines de couverture', 'Casse (qté, 90j)', 'Casse (nb mouvements, 90j)', 'Dernière casse'],
      rows
    );
  }

  if (error) return <div className="container-fluid py-4"><div className="text-danger small">Erreur : {error}</div></div>;

  return (
    <div className="container-fluid py-4">
      <style>{`
        .osr-filter-card { background: #fff; border: 1px solid rgba(27,42,74,.08); border-radius: 8px; padding: 12px 16px; display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 1rem; }
        .osr-filter-icon { width: 30px; height: 30px; border-radius: 7px; background: rgba(27,42,74,.05); display: flex; align-items: center; justify-content: center; font-size: 15px; color: #5B6B85; flex-shrink: 0; }
        .osr-input { border: 1px solid rgba(27,42,74,.12); border-radius: 6px; font-size: .8rem; padding: 5px 10px; color: #1B2A4A; background: #fff; }
        .osr-input:focus { outline: none; border-color: rgba(27,42,74,.3); box-shadow: 0 0 0 3px rgba(27,42,74,.06); }
        .osr-tabs { display: flex; gap: 4px; border-bottom: 1px solid rgba(27,42,74,.08); margin-bottom: 1rem; }
        .osr-tab { border: none; background: none; padding: 10px 16px; font-size: .86rem; font-weight: 600; color: #8591A0; border-bottom: 2px solid transparent; cursor: pointer; }
        .osr-tab.active { color: #1B2A4A; border-bottom-color: #1B2A4A; }
        .osr-common-card { background: #fff; border: 1px solid rgba(27,42,74,.08); border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; }
        .osr-common-head { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
        .osr-scrap-badge { background: rgba(214,69,65,.08); color: #B8302C; border-radius: 5px; padding: 1px 7px; font-size: .72rem; font-weight: 700; }
      `}</style>

      <div className="d-flex justify-content-between align-items-center flex-wrap gap-2 mb-3">
        <h4 className="mb-0" style={{ color: '#1B2A4A', fontWeight: 700 }}>Surstock</h4>
      </div>
      <p className="text-muted small mb-3">
        Articles dont le stock actuel couvre largement plus que la vente moyenne — même règle que l'assistant IA (stock ÷ vente moyenne/semaine),
        seuil réglable ci-dessous. Calculé à partir de la dernière proposition générée pour chaque magasin.
      </p>

      <div className="osr-filter-card">
        <span className="osr-filter-icon">
          <iconify-icon icon="solar:box-bold-duotone"></iconify-icon>
        </span>
        <div className="d-flex align-items-center gap-2">
          <label className="small text-muted mb-0">Seuil de surstock</label>
          <input
            type="number"
            min={1}
            step={0.5}
            className="osr-input"
            style={{ width: 70 }}
            value={minWeeksOfCoverage}
            onChange={(e) => setMinWeeksOfCoverage(Math.max(0.5, Number(e.target.value) || 1))}
          />
          <span className="small text-muted">semaines de couverture ou plus</span>
        </div>
        <select className="osr-input" style={{ width: 220 }} value={shopFilter} onChange={(e) => setShopFilter(e.target.value)}>
          <option value="">Tous les magasins</option>
          {shopOptions.map(([id, label]) => (
            <option key={id} value={id}>{label}</option>
          ))}
        </select>
        <input
          type="search"
          className="osr-input"
          style={{ width: 200 }}
          placeholder="Rechercher un article..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="ms-auto d-flex align-items-center gap-2">
          {activeTab === 'byShop' ? (
            <button type="button" className="btn btn-sm btn-outline-primary" onClick={exportByShopCsv}>
              <iconify-icon icon="solar:download-bold-duotone"></iconify-icon> Exporter (CSV)
            </button>
          ) : (
            <button type="button" className="btn btn-sm btn-outline-primary" onClick={exportCommonCsv}>
              <iconify-icon icon="solar:download-bold-duotone"></iconify-icon> Exporter (CSV)
            </button>
          )}
        </div>
      </div>

      {data === null ? (
        <div className="text-muted small">Chargement...</div>
      ) : !data.found ? (
        <div className="text-muted small py-4">{data.message || 'Aucune donnée.'}</div>
      ) : (
        <>
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
              <div className="text-muted small">Articles en surstock commun (≥2 magasins)</div>
              <div className="fs-4 fw-semibold">{data.commonArticleCount}</div>
            </div>
            <div className="col-6 col-md-3">
              <div className="text-muted small">Casse analysée sur</div>
              <div className="fs-4 fw-semibold">{data.scrapLookbackDays || 90} j</div>
            </div>
          </div>

          <div className="osr-tabs">
            <button type="button" className={`osr-tab${activeTab === 'common' ? ' active' : ''}`} onClick={() => setActiveTab('common')}>
              Surstock commun à plusieurs magasins ({filteredCommon.length})
            </button>
            <button type="button" className={`osr-tab${activeTab === 'byShop' ? ' active' : ''}`} onClick={() => setActiveTab('byShop')}>
              Par magasin ({filteredByShop.length})
            </button>
          </div>

          {activeTab === 'common' ? (
            filteredCommon.length === 0 ? (
              <div className="text-muted small py-4">Aucun article en surstock dans plusieurs magasins à la fois pour ce seuil.</div>
            ) : (
              filteredCommon.map((a) => (
                <div key={a.ean} className="osr-common-card">
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
                            <td>{s.weeksOfCoverage} sem.</td>
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
              ))
            )
          ) : (
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
                  </tr>
                </thead>
                <tbody>
                  {filteredByShop.length === 0 ? (
                    <tr><td colSpan={10} className="text-center text-muted py-4">Aucun article en surstock pour ce seuil.</td></tr>
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
                        <td>{a.weeksOfCoverage} sem.</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
