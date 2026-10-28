import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../../shared/api/client';

// Page Casse (demande explicite du 21/10/2026 : "les casse des article on doit voir un bouton sur
// la sidebare") — liste TOUS les articles ayant eu de la casse sur la période choisie, qu'ils
// soient en surstock ou non (contrairement à la casse déjà présente dans Surstock, limitée aux
// articles déjà identifiés en surstock). Cliquer sur un article ouvre la même page de détail que
// depuis Surstock (OverstockScrapDetail.tsx, liste de chaque mouvement individuel) — même route,
// jamais un second composant de détail à maintenir.
//
// BUG CORRIGÉ le 28/10/2026 (signalé : "ca ne doit pas etre multi magasin... corrige comme les
// autre") — la page chargeait systématiquement TOUT le réseau (38 magasins) et filtrait seulement
// côté client via un <select> local, sans jamais suivre le sélecteur global de la topbar ni envoyer
// de paramètre magasin au backend (qui l'ignorait de toute façon). Reconverti en mono-magasin avec
// EXACTEMENT le même pattern que OverstockReport.tsx (Surstock, déjà corrigé le 23/10/2026) :
// compte mono-magasin cantonné à son propre magasin, ADMIN/SUPERVISOR suit le sélecteur global
// (window.reassortGetActiveShop/reassortOnActiveShopChange), ?shops= envoyé à chaque appel API.

type ScrapArticleRow = {
  rposShopId: string;
  shopReference: string | null;
  shopName: string | null;
  ean: string;
  label: string | null;
  sellingPrice: number | null;
  quantity: number;
  moveCount: number;
  estimatedLoss: number | null;
  lastDate: string;
};

type ScrapOverviewData = {
  found: boolean;
  lookbackDays?: number;
  since?: string;
  shopCount: number;
  articleCount: number;
  totalQuantity: number;
  totalEstimatedLoss?: number;
  articles: ScrapArticleRow[];
  message?: string;
};

type MovementType = {
  typeLabel: string;
  moveCount: number;
  isDefaultScrapType: boolean;
};

type MovementTypesData = {
  found: boolean;
  lookbackDays?: number;
  types: MovementType[];
  message?: string;
};

// Sélecteur de types de mouvement à considérer comme "casse" (demande explicite du 21/10/2026 :
// "je veux qui tu affiche les type de mouvement pour les casse et tu me donne... quand c'est
// visible sur le UI on peux les choisir et en fonction de ca on aura des casse"). Affiche TOUS
// les types réels trouvés dans les données (pas seulement ceux pré-cochés), avec les types
// "casse-like" (isDefaultScrapType) pré-cochés et triés en premier. Sans sélection explicite de
// l'utilisateur, le backend retombe sur ces mêmes types par défaut (comportement identique).
function MovementTypeSelector({
  types,
  selected,
  onChange,
}: {
  types: MovementType[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  function toggle(typeLabel: string) {
    const next = new Set(selected);
    if (next.has(typeLabel)) next.delete(typeLabel);
    else next.add(typeLabel);
    onChange(next);
  }

  const label = selected.size === 0 ? 'Types de casse (par défaut)' : `${selected.size} type(s) sélectionné(s)`;

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" className="scr-input" style={{ width: 240, textAlign: 'left', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }} onClick={() => setOpen((o) => !o)}>
        <span className="text-truncate">{label}</span>
        <iconify-icon icon="solar:alt-arrow-down-linear" style={{ fontSize: '.7rem' }}></iconify-icon>
      </button>
      {open && (
        <div style={{ position: 'absolute', top: '110%', left: 0, zIndex: 20, background: '#fff', border: '1px solid rgba(27,42,74,.12)', borderRadius: 8, boxShadow: '0 8px 24px rgba(27,42,74,.14)', width: 360, maxHeight: 360, overflowY: 'auto', padding: 8 }}>
          <div className="d-flex justify-content-between align-items-center px-2 py-1">
            <span className="text-muted" style={{ fontSize: '.72rem' }}>Cochez les types à compter comme casse</span>
            {selected.size > 0 && (
              <button type="button" className="btn btn-link btn-sm p-0" style={{ fontSize: '.72rem' }} onClick={() => onChange(new Set())}>
                Réinitialiser
              </button>
            )}
          </div>
          {types.map((t) => (
            <label key={t.typeLabel} className="d-flex align-items-center gap-2 px-2 py-1" style={{ fontSize: '.8rem', cursor: 'pointer', borderRadius: 6 }}>
              <input type="checkbox" checked={selected.has(t.typeLabel)} onChange={() => toggle(t.typeLabel)} />
              <span className="flex-grow-1 text-truncate" style={{ color: t.isDefaultScrapType ? '#1B2A4A' : '#5B6B85', fontWeight: t.isDefaultScrapType ? 600 : 400 }}>
                {t.typeLabel}
              </span>
              <span className="text-muted" style={{ fontSize: '.7rem' }}>{t.moveCount.toLocaleString('fr-FR')}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function fmtCfa(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return `${Math.round(n).toLocaleString('fr-FR')} CFA`;
}

function articleInitials(label: string | null): string {
  if (!label) return '?';
  const words = label.trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] || '') + (words[1]?.[0] || '')).toUpperCase() || '?';
}

function downloadCsv(filename: string, headers: string[], rows: (string | number | null)[][]) {
  const escapeCell = (v: string | number | null) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers, ...rows].map((row) => row.map(escapeCell).join(';'));
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

const LOOKBACK_PRESETS = [
  { label: '30 j', days: 30 },
  { label: '90 j', days: 90 },
  { label: '6 mois', days: 180 },
  { label: '1 an', days: 365 },
];

const PAGE_SIZE = 50;

export function ScrapReport() {
  const navigate = useNavigate();
  const user = window.reassortGetUser ? window.reassortGetUser() : null;
  const isSingleShop = user ? window.reassortIsSingleShopRole(user.role) : false;

  // Même pattern que OverstockReport.tsx (Surstock) : magasin propre pour un compte mono-magasin,
  // sélecteur GLOBAL de la topbar pour ADMIN/SUPERVISOR — jamais une vue multi-magasins locale à
  // cette page.
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
  function activeShopId(): string | null {
    return isSingleShop ? (user?.rposShopId || null) : (activeShop?.id || null);
  }

  const [data, setData] = useState<ScrapOverviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lookbackDays, setLookbackDays] = useState(90);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [movementTypes, setMovementTypes] = useState<MovementType[]>([]);
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());

  useEffect(() => {
    const shopId = activeShopId();
    if (!shopId) { setMovementTypes([]); return; }
    let cancelled = false;
    apiFetch<MovementTypesData>(`/reassort/scrap-report/movement-types?lookbackDays=${lookbackDays}&shops=${encodeURIComponent(shopId)}`)
      .then((d) => { if (!cancelled && d.found) setMovementTypes(d.types); })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookbackDays, activeShop?.id, isSingleShop]);

  useEffect(() => {
    const shopId = activeShopId();
    if (!shopId) { setData(null); setError(null); return; }
    let cancelled = false;
    setData(null);
    setError(null);
    const typeParam = selectedTypes.size > 0 ? `&typeLabels=${encodeURIComponent([...selectedTypes].join(','))}` : '';
    apiFetch<ScrapOverviewData>(`/reassort/scrap-report?lookbackDays=${lookbackDays}&shops=${encodeURIComponent(shopId)}${typeParam}`)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookbackDays, selectedTypes, activeShop?.id, isSingleShop]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.articles.filter((a) => {
      if (q && !(a.label || '').toLowerCase().includes(q) && !a.ean.includes(q)) return false;
      return true;
    });
  }, [data, search]);

  useEffect(() => { setPage(1); }, [search, data]);

  // Tri croissant/décroissant ajouté le 25/10/2026 (audit complet des tableaux du site, demande
  // explicite : "les ajouté fait un audit de tout tab") — ce tableau n'avait aucun tri.
  type ScrapSortKey = 'label' | 'shopName' | 'sellingPrice' | 'quantity' | 'moveCount' | 'estimatedLoss' | 'lastDate';
  const [sortKey, setSortKey] = useState<ScrapSortKey | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  function toggleSort(key: ScrapSortKey) {
    if (sortKey === key) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setSortKey(key); setSortDir('desc'); }
  }
  function SortTh({ k, children }: { k: ScrapSortKey; children: React.ReactNode }) {
    const active = sortKey === k;
    return (
      <th role="button" style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }} onClick={() => toggleSort(k)}>
        {children} {active ? (sortDir === 'desc' ? '▼' : '▲') : ''}
      </th>
    );
  }
  const sorted = useMemo(() => {
    if (!sortKey) return filtered;
    const dir = sortDir === 'desc' ? 1 : -1;
    const getValue = (a: ScrapArticleRow): number | string => {
      switch (sortKey) {
        case 'label': return (a.label || a.ean).toLowerCase();
        case 'shopName': return (a.shopName || '').toLowerCase();
        case 'sellingPrice': return a.sellingPrice ?? -Infinity;
        case 'quantity': return a.quantity;
        case 'moveCount': return a.moveCount;
        case 'estimatedLoss': return a.estimatedLoss ?? -Infinity;
        case 'lastDate': return new Date(a.lastDate).getTime();
      }
    };
    return [...filtered].sort((a, b) => {
      const av = getValue(a);
      const bv = getValue(b);
      if (typeof av === 'string' || typeof bv === 'string') return dir * String(bv).localeCompare(String(av), 'fr-FR');
      return dir * ((bv as number) - (av as number));
    });
  }, [filtered, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const paged = sorted.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const totalQuantity = filtered.reduce((s, a) => s + a.quantity, 0);
  const totalLoss = filtered.reduce((s, a) => s + (a.estimatedLoss || 0), 0);

  function exportCsv() {
    downloadCsv(
      `casse-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Magasin', 'Référence magasin', 'EAN', 'Article', 'Prix de vente (CFA)', 'Quantité cassée', 'Nb mouvements', 'Perte estimée (CFA)', 'Dernière casse'],
      filtered.map((a) => [a.shopName, a.shopReference, a.ean, a.label, a.sellingPrice, a.quantity, a.moveCount, a.estimatedLoss, new Date(a.lastDate).toLocaleDateString('fr-FR')])
    );
  }

  function openDetail(ean: string, label: string | null) {
    const typeParam = selectedTypes.size > 0 ? `&typeLabels=${encodeURIComponent([...selectedTypes].join(','))}` : '';
    navigate(`/overstock-report/scrap/${encodeURIComponent(ean)}?label=${encodeURIComponent(label || '')}&from=scrap-report${typeParam}`);
  }

  return (
    <div className="container-fluid py-4">
      <style>{`
        .scr-settings-card { background: #fff; border: 1px solid rgba(27,42,74,.08); border-radius: 10px; padding: 14px 18px; margin-bottom: 1rem; display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
        .scr-icon { width: 32px; height: 32px; border-radius: 8px; background: rgba(214,69,65,.1); color: #B8302C; display: flex; align-items: center; justify-content: center; font-size: 15px; flex-shrink: 0; }
        .scr-preset { border: 1px solid rgba(27,42,74,.12); background: #fff; color: #5B6B85; font-size: .78rem; font-weight: 600; padding: 6px 13px; border-radius: 7px; cursor: pointer; transition: background .15s, color .15s, border-color .15s; }
        .scr-preset:hover { background: #F6F8FB; color: #1B2A4A; }
        .scr-preset.active { background: #1B2A4A; color: #fff; border-color: #1B2A4A; }
        .scr-input { border: 1px solid rgba(27,42,74,.12); border-radius: 6px; font-size: .8rem; padding: 5px 10px; color: #1B2A4A; background: #fff; }
        .scr-input:focus { outline: none; border-color: rgba(27,42,74,.3); box-shadow: 0 0 0 3px rgba(27,42,74,.06); }
        .scr-kpi-row { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 1.25rem; }
        .scr-kpi-card { flex: 1 1 180px; background: #fff; border-radius: 12px; padding: 14px 18px; box-shadow: 0 4px 18px rgba(27,42,74,.06); border: 1px solid rgba(27,42,74,.05); }
        .scr-kpi-label { font-size: .76rem; color: #8591A0; font-weight: 600; }
        .scr-kpi-value { font-size: 1.5rem; font-weight: 700; color: #1B2A4A; }
        .scr-table-card { background: #fff; border-radius: 12px; border: 1px solid rgba(27,42,74,.06); overflow: hidden; }
        .scr-row-avatar { width: 32px; height: 32px; border-radius: 9px; background: rgba(214,69,65,.08); color: #B8302C; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: .76rem; flex-shrink: 0; }
        .scr-qty { color: #B8302C; font-weight: 700; }
        .scr-pagination { display: flex; align-items: center; justify-content: center; gap: 6px; margin: 1.25rem 0; flex-wrap: wrap; }
        .scr-page-btn { border: 1px solid rgba(27,42,74,.12); background: #fff; color: #5B6B85; font-size: .78rem; font-weight: 600; padding: 5px 11px; border-radius: 6px; cursor: pointer; transition: background .15s, color .15s, border-color .15s; }
        .scr-page-btn:hover:not(:disabled) { background: #F6F8FB; color: #1B2A4A; border-color: rgba(27,42,74,.2); }
        .scr-page-btn:disabled { opacity: .4; cursor: not-allowed; }
        .scr-page-btn.active { background: #1B2A4A; color: #fff; border-color: #1B2A4A; }
      `}</style>

      <div className="d-flex justify-content-between align-items-center flex-wrap gap-2 mb-3">
        <h4 className="mb-0" style={{ color: '#1B2A4A', fontWeight: 700 }}>Casse</h4>
      </div>
      <p className="text-muted small mb-3">
        Tous les articles ayant eu de la casse sur la période choisie, en surstock ou non. Cliquez sur un article pour voir le détail de chaque mouvement.
      </p>
      {/* Contexte explicite du magasin consulté — même rappel que Stockouts.tsx/OverstockReport.tsx
          (demande explicite du 18/10/2026 reprise ici : "je dois voir... je suis sur quel magasin"),
          page désormais mono-magasin (cf. correctif du 28/10/2026 en tête de fichier). */}
      <div className="mb-3">
        <span className="badge reassort-badge-neutral py-1 px-2" style={{ backgroundColor: '#EDF1F7', color: '#1B2A4A' }}>
          <iconify-icon icon="solar:shop-bold-duotone" className="align-middle me-1"></iconify-icon>
          {isSingleShop
            ? (user?.rposShopName || 'Votre magasin')
            : activeShop
              ? (window.reassortGetActiveShop?.()?.name || 'Magasin sélectionné')
              : 'Aucun magasin sélectionné'}
        </span>
      </div>

      <div className="scr-settings-card">
        <span className="scr-icon"><iconify-icon icon="solar:trash-bin-trash-bold-duotone"></iconify-icon></span>
        {LOOKBACK_PRESETS.map((p) => (
          <button key={p.days} type="button" className={`scr-preset${lookbackDays === p.days ? ' active' : ''}`} onClick={() => setLookbackDays(p.days)}>
            {p.label}
          </button>
        ))}
        <input
          type="search"
          className="scr-input"
          style={{ width: 220 }}
          placeholder="Rechercher un article..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <MovementTypeSelector types={movementTypes} selected={selectedTypes} onChange={setSelectedTypes} />
        <div className="ms-auto">
          <button type="button" className="btn btn-sm btn-outline-primary" onClick={exportCsv} disabled={!filtered.length}>
            <iconify-icon icon="solar:download-bold-duotone"></iconify-icon> Exporter (CSV)
          </button>
        </div>
      </div>

      {error && <div className="text-danger small mb-3">Erreur : {error}</div>}

      {!activeShopId() ? (
        <div className="text-muted small py-4">Sélectionnez un magasin pour voir sa casse.</div>
      ) : data === null && !error ? (
        <div className="text-muted small">Chargement...</div>
      ) : data && !data.found ? (
        <div className="text-muted small py-4">{data.message || 'Aucune donnée.'}</div>
      ) : data ? (
        <>
          <div className="scr-kpi-row">
            <div className="scr-kpi-card">
              <div className="scr-kpi-label">Articles cassés</div>
              <div className="scr-kpi-value">{filtered.length}</div>
            </div>
            <div className="scr-kpi-card">
              <div className="scr-kpi-label">Quantité totale perdue</div>
              <div className="scr-kpi-value">{Math.round(totalQuantity).toLocaleString('fr-FR')}</div>
            </div>
            <div className="scr-kpi-card">
              <div className="scr-kpi-label">Perte estimée</div>
              <div className="scr-kpi-value">{fmtCfa(totalLoss)}</div>
            </div>
          </div>

          <div className="scr-table-card">
            <div className="table-responsive">
              <table className="table align-middle table-hover mb-0">
                <thead className="bg-light-subtle">
                  <tr>
                    <SortTh k="label">Article</SortTh>
                    <SortTh k="shopName">Magasin</SortTh>
                    <SortTh k="sellingPrice">Prix de vente</SortTh>
                    <SortTh k="quantity">Quantité cassée</SortTh>
                    <SortTh k="moveCount">Mouvements</SortTh>
                    <SortTh k="estimatedLoss">Perte estimée</SortTh>
                    <SortTh k="lastDate">Dernière casse</SortTh>
                  </tr>
                </thead>
                <tbody>
                  {paged.length === 0 ? (
                    <tr><td colSpan={7} className="text-center text-muted py-4">Aucune casse sur cette période.</td></tr>
                  ) : (
                    paged.map((a, i) => (
                      <tr key={`${a.rposShopId}:${a.ean}:${i}`} role="button" style={{ cursor: 'pointer' }} onClick={() => openDetail(a.ean, a.label)}>
                        <td>
                          <div className="d-flex align-items-center gap-2">
                            <span className="scr-row-avatar">{articleInitials(a.label)}</span>
                            <div>
                              <div className="fw-semibold" style={{ fontSize: '.84rem', color: '#1B2A4A' }}>{a.label || a.ean}</div>
                              <div className="text-muted" style={{ fontSize: '.72rem' }}>{a.ean}</div>
                            </div>
                          </div>
                        </td>
                        <td>{a.shopName} ({a.shopReference})</td>
                        <td>{fmtCfa(a.sellingPrice)}</td>
                        <td className="scr-qty">−{a.quantity.toLocaleString('fr-FR')}</td>
                        <td>{a.moveCount}</td>
                        <td>{fmtCfa(a.estimatedLoss)}</td>
                        <td>{new Date(a.lastDate).toLocaleDateString('fr-FR')}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {totalPages > 1 && (
            <div className="scr-pagination">
              <button type="button" className="scr-page-btn" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>
                <iconify-icon icon="solar:alt-arrow-left-linear"></iconify-icon>
              </button>
              <span className="small text-muted mx-2">Page {currentPage} / {totalPages} — {filtered.length.toLocaleString('fr-FR')} résultat(s)</span>
              <button type="button" className="scr-page-btn" disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)}>
                <iconify-icon icon="solar:alt-arrow-right-linear"></iconify-icon>
              </button>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
