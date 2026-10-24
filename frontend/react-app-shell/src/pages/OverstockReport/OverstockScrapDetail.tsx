import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { apiFetch } from '../../shared/api/client';

// Page détail d'un article en surstock (demande explicite du 21/10/2026 : "quand je clique sur
// l'article je peux avoir ca... tout les casse les quantité, la date et autre", ÉTENDUE le
// 24/10/2026 : "quand je clique il doit me donner les movement de vente,casse,dvl sur larticle") —
// ouverte depuis n'importe quelle ligne du tableau "Articles en surstock", 3 onglets : Ventes
// (pourquoi la couverture est si haute — l'article s'est-il arrêté de vendre ?), Casse, DLV (une
// partie du stock est-elle basculée hors circuit normal ?).

type SalesLine = {
  rposShopId: string;
  shopReference: string | null;
  shopName: string | null;
  date: string;
  quantity: number;
  revenueExclTax: number;
};

type SalesByShop = {
  rposShopId: string;
  shopReference: string | null;
  shopName: string | null;
  totalQuantity: number;
  saleCount: number;
};

type SalesByDay = {
  date: string;
  quantity: number;
  saleCount: number;
};

type SalesDetailData = {
  found: boolean;
  ean?: string;
  label?: string | null;
  lookbackDays?: number;
  since?: string;
  until?: string;
  totalQuantity?: number;
  totalRevenue?: number;
  totalSaleCount?: number;
  byShop?: SalesByShop[];
  byDay?: SalesByDay[];
  sales?: SalesLine[];
  message?: string;
};

type EndOfLifeLine = {
  rposShopId: string;
  shopReference: string | null;
  shopName: string | null;
  dlvEan: string;
  dlvStock: number;
  sellingPrice: number | null;
  syncedAt: string;
};

type EndOfLifeDetailData = {
  found: boolean;
  ean?: string;
  label?: string | null;
  totalDlvStock?: number;
  lineCount?: number;
  lines?: EndOfLifeLine[];
  message?: string;
};

type ScrapMove = {
  rposShopId: string;
  shopReference: string | null;
  shopName: string | null;
  date: string;
  quantity: number;
  recording: string | null;
  typeLabel: string | null;
};

type ScrapByShop = {
  rposShopId: string;
  shopReference: string | null;
  shopName: string | null;
  totalQuantity: number;
  moveCount: number;
};

type ScrapByDay = {
  date: string;
  quantity: number;
  moveCount: number;
};

type ScrapDetailData = {
  found: boolean;
  ean?: string;
  label?: string | null;
  lookbackDays?: number;
  since?: string;
  until?: string;
  totalQuantity?: number;
  totalMoveCount?: number;
  byShop?: ScrapByShop[];
  byDay?: ScrapByDay[];
  moves?: ScrapMove[];
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

// Même sélecteur de types de mouvement que sur la page Casse (ScrapReport.tsx) — demande
// explicite du 21/10/2026 d'appliquer le choix "Partout où la casse est affichée".
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
      <button type="button" className="osd-preset" style={{ width: 240, textAlign: 'left', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }} onClick={() => setOpen((o) => !o)}>
        <span className="text-truncate">{label}</span>
        <iconify-icon icon="solar:alt-arrow-down-linear" style={{ fontSize: '.7rem' }}></iconify-icon>
      </button>
      {open && (
        <div style={{ position: 'absolute', top: '110%', right: 0, zIndex: 20, background: '#fff', border: '1px solid rgba(27,42,74,.12)', borderRadius: 8, boxShadow: '0 8px 24px rgba(27,42,74,.14)', width: 360, maxHeight: 360, overflowY: 'auto', padding: 8 }}>
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

export function OverstockScrapDetail() {
  const { ean } = useParams<{ ean: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const labelFromQuery = searchParams.get('label') || '';
  // Magasin actif transmis par OverstockReport.tsx (demande explicite du 24/10/2026 : "je suis dans
  // un magasin il ne dois pas me donner pour tout les mag... je dois voir pour un seul magasin") —
  // restreint les 3 onglets Ventes/Casse/DLV au même magasin que celui affiché sur la page Surstock,
  // au lieu du périmètre complet du compte (ADMIN/SUPERVISOR). Vide si absent (ex: lien direct sans
  // ce paramètre) : retombe alors sur le comportement d'origine, périmètre complet.
  const shopIdFromQuery = searchParams.get('shops') || '';
  const shopQueryParam = shopIdFromQuery ? `&shops=${encodeURIComponent(shopIdFromQuery)}` : '';

  // Onglet actif (demande explicite du 24/10/2026) — "Ventes" en premier : la question la plus
  // fréquente en cliquant sur un article en surstock est "pourquoi est-il si peu vendu ?", pas
  // "quelle casse a-t-il eue" (déjà le comportement précédent par défaut, conservé).
  const [activeTab, setActiveTab] = useState<'sales' | 'scrap' | 'dlv'>('sales');

  const [data, setData] = useState<ScrapDetailData | null>(null);
  const [salesData, setSalesData] = useState<SalesDetailData | null>(null);
  const [dlvData, setDlvData] = useState<EndOfLifeDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lookbackDays, setLookbackDays] = useState(90);
  const [movementTypes, setMovementTypes] = useState<MovementType[]>([]);
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(() => {
    const raw = searchParams.get('typeLabels');
    return raw ? new Set(raw.split(',').filter(Boolean)) : new Set();
  });
  // Période personnalisée (demande explicite du 21/10/2026 : "donne la possibilité de
  // personalisé cette période") — vide par défaut, les presets 30j/90j/etc. restent utilisés tant
  // que l'utilisateur n'a pas choisi de dates précises.
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const useCustomRange = Boolean(customStart && customEnd);

  useEffect(() => {
    let cancelled = false;
    apiFetch<MovementTypesData>(`/reassort/scrap-report/movement-types?lookbackDays=${lookbackDays}`)
      .then((d) => { if (!cancelled && d.found) setMovementTypes(d.types); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [lookbackDays]);

  useEffect(() => {
    if (!ean) return;
    let cancelled = false;
    setData(null);
    setError(null);
    const typeParam = selectedTypes.size > 0 ? `&typeLabels=${encodeURIComponent([...selectedTypes].join(','))}` : '';
    const rangeParam = useCustomRange ? `&startDate=${customStart}&endDate=${customEnd}` : `&lookbackDays=${lookbackDays}`;
    apiFetch<ScrapDetailData>(`/reassort/overstock-report/scrap-detail?ean=${encodeURIComponent(ean)}${rangeParam}${typeParam}${shopQueryParam}`)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [ean, lookbackDays, selectedTypes, useCustomRange, customStart, customEnd]);

  // Ventes (demande explicite du 24/10/2026) — même fenêtre/période que la casse ci-dessus, pour
  // que l'utilisateur puisse comparer les deux sur la même plage de dates sans reconfigurer.
  useEffect(() => {
    if (!ean) return;
    let cancelled = false;
    setSalesData(null);
    const rangeParam = useCustomRange ? `&startDate=${customStart}&endDate=${customEnd}` : `&lookbackDays=${lookbackDays}`;
    apiFetch<SalesDetailData>(`/reassort/overstock-report/sales-detail?ean=${encodeURIComponent(ean)}${rangeParam}${shopQueryParam}`)
      .then((d) => { if (!cancelled) setSalesData(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [ean, lookbackDays, useCustomRange, customStart, customEnd]);

  // DLV (demande explicite du 24/10/2026) — état ACTUEL, pas de fenêtre de dates (cf. commentaire
  // getEndOfLifeDetailForArticle côté backend), donc un seul chargement par article, indépendant
  // des presets de période ci-dessus.
  useEffect(() => {
    if (!ean) return;
    let cancelled = false;
    setDlvData(null);
    apiFetch<EndOfLifeDetailData>(`/reassort/overstock-report/end-of-life-detail?ean=${encodeURIComponent(ean)}${shopQueryParam}`)
      .then((d) => { if (!cancelled) setDlvData(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [ean]);

  function exportCsv() {
    if (!data?.moves) return;
    downloadCsv(
      `casse-${ean}-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Date', 'Magasin', 'Référence magasin', 'Quantité', 'Type de mouvement'],
      data.moves.map((m) => [new Date(m.date).toLocaleString('fr-FR'), m.shopName, m.shopReference, m.quantity, m.typeLabel])
    );
  }

  function exportSalesCsv() {
    if (!salesData?.sales) return;
    downloadCsv(
      `ventes-${ean}-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Date', 'Magasin', 'Référence magasin', 'Quantité', 'CA HT (CFA)'],
      salesData.sales.map((s) => [new Date(s.date).toLocaleString('fr-FR'), s.shopName, s.shopReference, s.quantity, s.revenueExclTax])
    );
  }

  return (
    <div className="container-fluid py-4">
      <style>{`
        .osd-back { border: none; background: none; color: #5B6B85; font-size: .82rem; font-weight: 600; display: inline-flex; align-items: center; gap: 6px; padding: 4px 0; margin-bottom: .75rem; cursor: pointer; }
        .osd-back:hover { color: #1B2A4A; }
        .osd-header-card { background: #fff; border: 1px solid rgba(27,42,74,.08); border-radius: 12px; padding: 18px 22px; margin-bottom: 1rem; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 14px; }
        .osd-avatar { width: 46px; height: 46px; border-radius: 12px; background: #EEF2FB; color: #2456A6; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 1rem; flex-shrink: 0; }
        .osd-title { font-size: 1.05rem; font-weight: 700; color: #1B2A4A; }
        .osd-subtitle { font-size: .8rem; color: #8591A0; }
        .osd-presets { display: flex; gap: 6px; flex-wrap: wrap; }
        .osd-preset { border: 1px solid rgba(27,42,74,.12); background: #fff; color: #5B6B85; font-size: .78rem; font-weight: 600; padding: 6px 13px; border-radius: 7px; cursor: pointer; transition: background .15s, color .15s, border-color .15s; }
        .osd-preset:hover { background: #F6F8FB; color: #1B2A4A; }
        .osd-preset.active { background: #1B2A4A; color: #fff; border-color: #1B2A4A; }
        .osd-kpi-row { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 1.25rem; }
        .osd-kpi-card { flex: 1 1 180px; background: #fff; border-radius: 12px; padding: 14px 18px; box-shadow: 0 4px 18px rgba(27,42,74,.06); border: 1px solid rgba(27,42,74,.05); }
        .osd-kpi-label { font-size: .76rem; color: #8591A0; font-weight: 600; }
        .osd-kpi-value { font-size: 1.5rem; font-weight: 700; color: #1B2A4A; }
        .osd-table-card { background: #fff; border-radius: 12px; border: 1px solid rgba(27,42,74,.06); overflow: hidden; }
        .osd-scrap-qty { color: #B8302C; font-weight: 700; }
        .osd-tabs { display: flex; gap: 4px; border-bottom: 1px solid rgba(27,42,74,.08); flex-wrap: wrap; }
        .osd-tab { border: none; background: none; padding: 10px 16px; font-size: .86rem; font-weight: 600; color: #8591A0; border-bottom: 2px solid transparent; cursor: pointer; white-space: nowrap; }
        .osd-tab.active { color: #1B2A4A; border-bottom-color: #1B2A4A; }
      `}</style>

      <button type="button" className="osd-back" onClick={() => navigate(-1)}>
        <iconify-icon icon="solar:arrow-left-linear"></iconify-icon> Retour
      </button>

      <div className="osd-header-card">
        <div className="d-flex align-items-center gap-3">
          <span className="osd-avatar">{(labelFromQuery || data?.label || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase()}</span>
          <div>
            <div className="osd-title">{labelFromQuery || data?.label || 'Article'}</div>
            <div className="osd-subtitle">{ean} — Mouvements de vente, casse et DLV</div>
          </div>
        </div>
        <div className="osd-presets">
          {activeTab !== 'dlv' && LOOKBACK_PRESETS.map((p) => (
            <button key={p.days} type="button" className={`osd-preset${!useCustomRange && lookbackDays === p.days ? ' active' : ''}`} onClick={() => { setLookbackDays(p.days); setCustomStart(''); setCustomEnd(''); }}>
              {p.label}
            </button>
          ))}
          {activeTab !== 'dlv' && (
            <>
              <input type="date" className="osd-preset" style={{ cursor: 'auto' }} value={customStart} max={customEnd || undefined} onChange={(e) => setCustomStart(e.target.value)} />
              <span className="text-muted align-self-center" style={{ fontSize: '.78rem' }}>→</span>
              <input type="date" className="osd-preset" style={{ cursor: 'auto' }} value={customEnd} min={customStart || undefined} onChange={(e) => setCustomEnd(e.target.value)} />
              {useCustomRange && (
                <button type="button" className="osd-preset" onClick={() => { setCustomStart(''); setCustomEnd(''); }}>
                  <iconify-icon icon="solar:close-circle-linear"></iconify-icon>
                </button>
              )}
            </>
          )}
          {activeTab === 'scrap' && <MovementTypeSelector types={movementTypes} selected={selectedTypes} onChange={setSelectedTypes} />}
        </div>
      </div>

      {/* Onglets Ventes/Casse/DLV (demande explicite du 24/10/2026 : "quand je clique il doit me
          donner les movement de vente,casse,dvl sur larticle") */}
      <div className="osd-tabs mb-3">
        <button type="button" className={`osd-tab${activeTab === 'sales' ? ' active' : ''}`} onClick={() => setActiveTab('sales')}>
          Ventes {salesData?.totalSaleCount !== undefined ? `(${salesData.totalSaleCount})` : ''}
        </button>
        <button type="button" className={`osd-tab${activeTab === 'scrap' ? ' active' : ''}`} onClick={() => setActiveTab('scrap')}>
          Casse {data?.totalMoveCount !== undefined ? `(${data.totalMoveCount})` : ''}
        </button>
        <button type="button" className={`osd-tab${activeTab === 'dlv' ? ' active' : ''}`} onClick={() => setActiveTab('dlv')}>
          DLV {dlvData?.lineCount !== undefined ? `(${dlvData.lineCount})` : ''}
        </button>
      </div>

      {error && <div className="text-danger small mb-3">Erreur : {error}</div>}

      {activeTab === 'sales' && (
        salesData === null ? (
          <div className="text-muted small">Chargement...</div>
        ) : !salesData.found ? (
          <div className="text-muted small py-4">{salesData.message || 'Aucune donnée.'}</div>
        ) : (
          <>
            <div className="osd-kpi-row">
              <div className="osd-kpi-card">
                <div className="osd-kpi-label">Quantité totale vendue</div>
                <div className="osd-kpi-value">{salesData.totalQuantity?.toLocaleString('fr-FR') ?? 0}</div>
              </div>
              <div className="osd-kpi-card">
                <div className="osd-kpi-label">CA HT total</div>
                <div className="osd-kpi-value">{Math.round(salesData.totalRevenue ?? 0).toLocaleString('fr-FR')} CFA</div>
              </div>
              <div className="osd-kpi-card">
                <div className="osd-kpi-label">Nombre de ventes</div>
                <div className="osd-kpi-value">{salesData.totalSaleCount ?? 0}</div>
              </div>
              <div className="osd-kpi-card">
                <div className="osd-kpi-label">Période analysée</div>
                <div className="osd-kpi-value" style={{ fontSize: '1.05rem' }}>
                  {salesData.since ? new Date(salesData.since).toLocaleDateString('fr-FR') : '—'} → {salesData.until ? new Date(salesData.until).toLocaleDateString('fr-FR') : "aujourd'hui"}
                </div>
              </div>
            </div>

            {salesData.byShop && salesData.byShop.length > 0 && (
              <div className="osd-table-card mb-3">
                <div className="table-responsive">
                  <table className="table align-middle table-sm mb-0">
                    <thead className="bg-light-subtle">
                      <tr>
                        <th>Magasin</th>
                        <th>Quantité vendue</th>
                        <th>Nombre de ventes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {salesData.byShop.map((s) => (
                        <tr key={s.rposShopId}>
                          <td>{s.shopName} ({s.shopReference})</td>
                          <td className="fw-semibold" style={{ color: '#1B2A4A' }}>{s.totalQuantity.toLocaleString('fr-FR')}</td>
                          <td>{s.saleCount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {salesData.byDay && salesData.byDay.length > 0 && (
              <>
                <h6 className="mb-2" style={{ color: '#1B2A4A', fontWeight: 700 }}>Récapitulatif par jour</h6>
                <div className="osd-table-card mb-3">
                  <div className="table-responsive" style={{ maxHeight: 280, overflowY: 'auto' }}>
                    <table className="table align-middle table-sm mb-0">
                      <thead className="bg-light-subtle" style={{ position: 'sticky', top: 0 }}>
                        <tr>
                          <th>Jour</th>
                          <th>Quantité vendue</th>
                          <th>Nombre de ventes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {salesData.byDay.map((d) => (
                          <tr key={d.date}>
                            <td>{new Date(d.date).toLocaleDateString('fr-FR')}</td>
                            <td className="fw-semibold" style={{ color: '#1B2A4A' }}>{d.quantity.toLocaleString('fr-FR')}</td>
                            <td>{d.saleCount}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}

            <div className="d-flex justify-content-between align-items-center mb-2">
              <h6 className="mb-0" style={{ color: '#1B2A4A', fontWeight: 700 }}>Toutes les ventes</h6>
              {salesData.sales && salesData.sales.length > 0 && (
                <button type="button" className="btn btn-sm btn-outline-primary" onClick={exportSalesCsv}>
                  <iconify-icon icon="solar:download-bold-duotone"></iconify-icon> Exporter (CSV)
                </button>
              )}
            </div>

            <div className="osd-table-card">
              <div className="table-responsive">
                <table className="table align-middle table-hover mb-0">
                  <thead className="bg-light-subtle">
                    <tr>
                      <th>Date</th>
                      <th>Magasin</th>
                      <th>Quantité</th>
                      <th>CA HT</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!salesData.sales || salesData.sales.length === 0 ? (
                      <tr><td colSpan={4} className="text-center text-muted py-4">Aucune vente enregistrée sur cette période.</td></tr>
                    ) : (
                      salesData.sales.map((s, i) => (
                        <tr key={i}>
                          <td>{new Date(s.date).toLocaleString('fr-FR')}</td>
                          <td>{s.shopName} ({s.shopReference})</td>
                          <td>{s.quantity.toLocaleString('fr-FR')}</td>
                          <td>{Math.round(s.revenueExclTax).toLocaleString('fr-FR')} CFA</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )
      )}

      {activeTab === 'scrap' && (
        data === null && !error ? (
          <div className="text-muted small">Chargement...</div>
        ) : data && !data.found ? (
          <div className="text-muted small py-4">{data.message || 'Aucune donnée.'}</div>
        ) : data ? (
          <>
            <div className="osd-kpi-row">
              <div className="osd-kpi-card">
                <div className="osd-kpi-label">Quantité totale perdue</div>
                <div className="osd-kpi-value">{data.totalQuantity?.toLocaleString('fr-FR') ?? 0}</div>
              </div>
              <div className="osd-kpi-card">
                <div className="osd-kpi-label">Nombre de mouvements</div>
                <div className="osd-kpi-value">{data.totalMoveCount ?? 0}</div>
              </div>
              <div className="osd-kpi-card">
                <div className="osd-kpi-label">Magasins concernés</div>
                <div className="osd-kpi-value">{data.byShop?.length ?? 0}</div>
              </div>
              <div className="osd-kpi-card">
                <div className="osd-kpi-label">Période analysée</div>
                <div className="osd-kpi-value" style={{ fontSize: '1.05rem' }}>
                  {data.since ? new Date(data.since).toLocaleDateString('fr-FR') : '—'} → {data.until ? new Date(data.until).toLocaleDateString('fr-FR') : "aujourd'hui"}
                </div>
              </div>
            </div>

            {data.byShop && data.byShop.length > 0 && (
              <div className="osd-table-card mb-3">
                <div className="table-responsive">
                  <table className="table align-middle table-sm mb-0">
                    <thead className="bg-light-subtle">
                      <tr>
                        <th>Magasin</th>
                        <th>Quantité perdue</th>
                        <th>Nombre de mouvements</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.byShop.map((s) => (
                        <tr key={s.rposShopId}>
                          <td>{s.shopName} ({s.shopReference})</td>
                          <td className="osd-scrap-qty">−{s.totalQuantity.toLocaleString('fr-FR')}</td>
                          <td>{s.moveCount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {data.byDay && data.byDay.length > 0 && (
              <>
                <h6 className="mb-2" style={{ color: '#1B2A4A', fontWeight: 700 }}>Récapitulatif par jour</h6>
                <div className="osd-table-card mb-3">
                <div className="table-responsive" style={{ maxHeight: 280, overflowY: 'auto' }}>
                  <table className="table align-middle table-sm mb-0">
                    <thead className="bg-light-subtle" style={{ position: 'sticky', top: 0 }}>
                      <tr>
                        <th>Jour</th>
                        <th>Quantité perdue</th>
                        <th>Nombre de mouvements</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.byDay.map((d) => (
                        <tr key={d.date}>
                          <td>{new Date(d.date).toLocaleDateString('fr-FR')}</td>
                          <td className="osd-scrap-qty">−{d.quantity.toLocaleString('fr-FR')}</td>
                          <td>{d.moveCount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                </div>
              </>
            )}

            <div className="d-flex justify-content-between align-items-center mb-2">
              <h6 className="mb-0" style={{ color: '#1B2A4A', fontWeight: 700 }}>Tous les mouvements de casse</h6>
              {data.moves && data.moves.length > 0 && (
                <button type="button" className="btn btn-sm btn-outline-primary" onClick={exportCsv}>
                  <iconify-icon icon="solar:download-bold-duotone"></iconify-icon> Exporter (CSV)
                </button>
              )}
            </div>

            <div className="osd-table-card">
              <div className="table-responsive">
                <table className="table align-middle table-hover mb-0">
                  <thead className="bg-light-subtle">
                    <tr>
                      <th>Date</th>
                      <th>Magasin</th>
                      <th>Quantité</th>
                      <th>Type de mouvement</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!data.moves || data.moves.length === 0 ? (
                      <tr><td colSpan={4} className="text-center text-muted py-4">Aucune casse enregistrée sur cette période.</td></tr>
                    ) : (
                      data.moves.map((m, i) => (
                        <tr key={i}>
                          <td>{new Date(m.date).toLocaleString('fr-FR')}</td>
                          <td>{m.shopName} ({m.shopReference})</td>
                          <td className="osd-scrap-qty">−{m.quantity.toLocaleString('fr-FR')}</td>
                          <td>{m.typeLabel || '—'}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        ) : null
      )}

      {activeTab === 'dlv' && (
        dlvData === null ? (
          <div className="text-muted small">Chargement...</div>
        ) : !dlvData.found ? (
          <div className="text-muted small py-4">{dlvData.message || 'Aucune donnée.'}</div>
        ) : (
          <>
            <div className="osd-kpi-row">
              <div className="osd-kpi-card">
                <div className="osd-kpi-label">Stock DLV actuel</div>
                <div className="osd-kpi-value">{dlvData.totalDlvStock?.toLocaleString('fr-FR') ?? 0}</div>
              </div>
              <div className="osd-kpi-card">
                <div className="osd-kpi-label">Fiches DLV</div>
                <div className="osd-kpi-value">{dlvData.lineCount ?? 0}</div>
              </div>
            </div>

            <div className="osd-table-card">
              <div className="table-responsive">
                <table className="table align-middle table-hover mb-0">
                  <thead className="bg-light-subtle">
                    <tr>
                      <th>Magasin</th>
                      <th>EAN DLV</th>
                      <th>Stock DLV</th>
                      <th>Prix de vente DLV</th>
                      <th>Synchronisé le</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!dlvData.lines || dlvData.lines.length === 0 ? (
                      <tr><td colSpan={5} className="text-center text-muted py-4">Aucune fiche DLV pour cet article.</td></tr>
                    ) : (
                      dlvData.lines.map((l, i) => (
                        <tr key={i}>
                          <td>{l.shopName} ({l.shopReference})</td>
                          <td>{l.dlvEan}</td>
                          <td className={l.dlvStock < 0 ? 'text-muted' : 'fw-semibold'} style={l.dlvStock >= 0 ? { color: '#1B2A4A' } : undefined} title={l.dlvStock < 0 ? 'Valeur négative : ajustement/retour, pas un stock réel' : undefined}>
                            {l.dlvStock.toLocaleString('fr-FR')}
                          </td>
                          <td>{l.sellingPrice !== null ? `${l.sellingPrice.toLocaleString('fr-FR')} CFA` : '—'}</td>
                          <td>{new Date(l.syncedAt).toLocaleDateString('fr-FR')}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )
      )}
    </div>
  );
}
