import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { apiFetch } from '../../shared/api/client';

// Page détail de la casse d'un article en surstock (demande explicite du 21/10/2026 : "quand je
// clique sur l'article je peux avoir ca... tout les casse les quantité, la date et autre") — ouverte
// depuis n'importe quelle ligne/carte de la page Surstock (onglets "Par magasin", "Surstock commun"
// ou "Toujours en surstock"), montre CHAQUE mouvement de casse individuel sur la fenêtre choisie,
// par magasin.

type ScrapMove = {
  rposShopId: string;
  shopReference: string | null;
  shopName: string | null;
  date: string;
  quantity: number;
  recording: string | null;
};

type ScrapByShop = {
  rposShopId: string;
  shopReference: string | null;
  shopName: string | null;
  totalQuantity: number;
  moveCount: number;
};

type ScrapDetailData = {
  found: boolean;
  ean?: string;
  label?: string | null;
  lookbackDays?: number;
  since?: string;
  totalQuantity?: number;
  totalMoveCount?: number;
  byShop?: ScrapByShop[];
  moves?: ScrapMove[];
  message?: string;
};

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

  const [data, setData] = useState<ScrapDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lookbackDays, setLookbackDays] = useState(90);

  useEffect(() => {
    if (!ean) return;
    let cancelled = false;
    setData(null);
    setError(null);
    apiFetch<ScrapDetailData>(`/reassort/overstock-report/scrap-detail?ean=${encodeURIComponent(ean)}&lookbackDays=${lookbackDays}`)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [ean, lookbackDays]);

  function exportCsv() {
    if (!data?.moves) return;
    downloadCsv(
      `casse-${ean}-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Date', 'Magasin', 'Référence magasin', 'Quantité', 'Type de mouvement'],
      data.moves.map((m) => [new Date(m.date).toLocaleString('fr-FR'), m.shopName, m.shopReference, m.quantity, m.recording])
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
      `}</style>

      <button type="button" className="osd-back" onClick={() => navigate(-1)}>
        <iconify-icon icon="solar:arrow-left-linear"></iconify-icon> Retour
      </button>

      <div className="osd-header-card">
        <div className="d-flex align-items-center gap-3">
          <span className="osd-avatar">{(labelFromQuery || data?.label || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase()}</span>
          <div>
            <div className="osd-title">{labelFromQuery || data?.label || 'Article'}</div>
            <div className="osd-subtitle">{ean} — Détail des mouvements de casse</div>
          </div>
        </div>
        <div className="osd-presets">
          {LOOKBACK_PRESETS.map((p) => (
            <button key={p.days} type="button" className={`osd-preset${lookbackDays === p.days ? ' active' : ''}`} onClick={() => setLookbackDays(p.days)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="text-danger small mb-3">Erreur : {error}</div>}

      {data === null && !error ? (
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
                {data.since ? new Date(data.since).toLocaleDateString('fr-FR') : '—'} → aujourd'hui
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
                        <td>{m.recording || '—'}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
