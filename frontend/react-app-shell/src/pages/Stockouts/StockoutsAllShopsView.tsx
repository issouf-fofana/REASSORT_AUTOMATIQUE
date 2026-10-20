import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../../shared/api/client';

// Vue réseau du module Ruptures (spec rupture.md §2, 16/10/2026) : une ligne-résumé par magasin
// accessible (ADMIN = tous, SUPERVISOR = son périmètre). Clic sur un magasin -> bascule l'onglet
// "Ce magasin" sur ce magasin (drill-down, étape 1 — détail article/rayon/chronologie à venir).
type ShopSummary = {
  rposShopId: string;
  shopReference: string;
  shopName: string;
  openCount: number;
  totalEpisodesCount: number;
  avgDurationHours: number;
  longEpisodesCount: number;
  noOrderCount: number;
  totalCaPerduEstime: number;
};

// Cumuls réseau (demande explicite du 18/10/2026 : "me faire le cumul des CA de rupture le temps
// de rupture et combien en perte") — calculés côté client à partir des lignes déjà reçues, pas un
// appel API supplémentaire : la liste par magasin contient déjà tout ce qu'il faut. Recalculés sur
// les lignes FILTRÉES (demande du 20/10/2026, cf. filtres ci-dessous) pour que les totaux affichés
// restent cohérents avec ce que montre le tableau en dessous, pas avec l'ensemble non filtré.
function computeNetworkTotals(shops: ShopSummary[]) {
  const totalOpen = shops.reduce((s, sh) => s + sh.openCount, 0);
  const totalCaPerdu = shops.reduce((s, sh) => s + sh.totalCaPerduEstime, 0);
  // Moyenne pondérée par le nombre de ruptures en cours de chaque magasin, pas une simple moyenne
  // des moyennes (un magasin à 1 rupture ne doit pas peser autant qu'un magasin à 1500).
  const weightedDurationSum = shops.reduce((s, sh) => s + sh.avgDurationHours * sh.openCount, 0);
  const avgDurationHours = totalOpen > 0 ? weightedDurationSum / totalOpen : 0;
  const totalLongEpisodes = shops.reduce((s, sh) => s + sh.longEpisodesCount, 0);
  const totalNoOrder = shops.reduce((s, sh) => s + sh.noOrderCount, 0);
  return { totalOpen, totalCaPerdu, avgDurationHours, totalLongEpisodes, totalNoOrder };
}

type AllShopsSummary = {
  found: boolean;
  shopCount: number;
  totalOpenAcrossShops: number;
  shops: ShopSummary[];
  message?: string;
};

type SortKey = 'shopName' | 'openCount' | 'totalEpisodesCount' | 'avgDurationHours' | 'longEpisodesCount' | 'noOrderCount' | 'totalCaPerduEstime';

function formatDuration(hours: number): string {
  if (hours < 24) return `${Math.round(hours)} h`;
  const days = Math.floor(hours / 24);
  const rest = Math.round(hours % 24);
  return `${days} j ${rest} h`;
}

export function StockoutsAllShopsView({ onSelectShop }: { onSelectShop: (shop: { id: string; reference: string; name: string }) => void }) {
  const [summary, setSummary] = useState<AllShopsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Filtre de période (demande explicite du 20/10/2026 : "il ya pas de filtre ajoute tout les
  // filtre possible sur ca") — même préréglages 7j/30j/90j + dates libres que l'onglet "Ce
  // magasin" (StockoutShopDetail.tsx), qui pilote déjà ce même calcul côté backend pour un seul
  // magasin (getDashboardSummary periodMode). Par défaut 30 derniers jours, cohérent avec l'ancien
  // comportement non filtré (lookback 30j implicite côté backend).
  const [periodStart, setPeriodStart] = useState(() => new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  const [periodEnd, setPeriodEnd] = useState(() => new Date().toISOString().slice(0, 10));

  // Recherche + filtres avancés + tri : appliqués côté client sur la liste déjà reçue (une ligne
  // par magasin accessible, jamais plus de quelques dizaines) — pas besoin d'un aller-retour
  // serveur supplémentaire pour ça, contrairement à la période qui change le calcul lui-même.
  const [search, setSearch] = useState('');
  const [longOnly, setLongOnly] = useState(false);
  const [noOrderOnly, setNoOrderOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('openCount');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  useEffect(() => {
    let cancelled = false;
    setSummary(null);
    setError(null);
    const periodParams = `start=${encodeURIComponent(new Date(periodStart).toISOString())}&end=${encodeURIComponent(new Date(periodEnd + 'T23:59:59').toISOString())}`;
    apiFetch<AllShopsSummary>(`/reassort/stockout-episodes/all-shops?${periodParams}`)
      .then((data) => { if (!cancelled) setSummary(data); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [periodStart, periodEnd]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  }

  const allShops = summary?.shops || [];

  const filteredShops = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = allShops;
    if (q) {
      list = list.filter((s) => s.shopName.toLowerCase().includes(q) || s.shopReference.toLowerCase().includes(q));
    }
    if (longOnly) list = list.filter((s) => s.longEpisodesCount > 0);
    if (noOrderOnly) list = list.filter((s) => s.noOrderCount > 0);
    const sorted = [...list].sort((a, b) => {
      let cmp: number;
      if (sortKey === 'shopName') cmp = a.shopName.localeCompare(b.shopName, 'fr-FR');
      else cmp = a[sortKey] - b[sortKey];
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [allShops, search, longOnly, noOrderOnly, sortKey, sortDir]);

  if (error) return <div className="text-danger small">Erreur : {error}</div>;
  if (summary === null) return <div className="text-muted small">Chargement...</div>;

  const totals = computeNetworkTotals(filteredShops);

  function SortableHeader({ k, label }: { k: SortKey; label: string }) {
    const active = sortKey === k;
    return (
      <th role="button" onClick={() => toggleSort(k)} style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}>
        {label} {active ? (sortDir === 'desc' ? '▼' : '▲') : ''}
      </th>
    );
  }

  // Préréglage de période actuellement actif (surbrillance du bouton correspondant) — comparaison
  // sur le jour plutôt que l'horodatage exact, periodEnd/periodStart étant des dates (pas des
  // datetimes) ici.
  const activePresetDays = (() => {
    const start = new Date(periodStart).getTime();
    const end = new Date(periodEnd).getTime();
    const diffDays = Math.round((end - start) / (24 * 60 * 60 * 1000));
    const today = new Date().toISOString().slice(0, 10);
    if (periodEnd !== today) return null;
    return [7, 30, 90].includes(diffDays) ? diffDays : null;
  })();

  return (
    <div className="card">
      <style>{`
        .aso-filter-card { background: #fff; border: 1px solid rgba(27,42,74,.08); border-radius: 8px; padding: 12px 16px; display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
        .aso-filter-icon { width: 30px; height: 30px; border-radius: 7px; background: rgba(27,42,74,.05); display: flex; align-items: center; justify-content: center; font-size: 15px; color: #5B6B85; flex-shrink: 0; }
        .aso-preset { border: 1px solid rgba(27,42,74,.12); background: #fff; color: #5B6B85; font-size: .76rem; font-weight: 600; padding: 5px 12px; border-radius: 6px; transition: background .15s, color .15s, border-color .15s; }
        .aso-preset:hover { background: #F6F8FB; color: #1B2A4A; border-color: rgba(27,42,74,.2); }
        .aso-preset.active { background: #1B2A4A; color: #fff; border-color: #1B2A4A; }
        .aso-input { border: 1px solid rgba(27,42,74,.12); border-radius: 6px; font-size: .8rem; padding: 5px 10px; color: #1B2A4A; background: #fff; }
        .aso-input:focus { outline: none; border-color: rgba(27,42,74,.3); box-shadow: 0 0 0 3px rgba(27,42,74,.06); }
        .aso-toggle { border: 1px solid rgba(27,42,74,.12); background: #fff; color: #5B6B85; font-size: .76rem; font-weight: 600; padding: 5px 12px; border-radius: 6px; display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; transition: background .15s, color .15s, border-color .15s; }
        .aso-toggle:hover { background: #F6F8FB; }
        .aso-toggle.active { background: rgba(214,69,65,.08); color: #B8302C; border-color: rgba(214,69,65,.3); }
        .aso-toggle input { accent-color: #B8302C; margin: 0; }
      `}</style>
      <div className="card-body">
        {/* Filtre de période : même style de carte douce (icône + fond clair + boutons arrondis) que
            l'onglet "Ce magasin" (StockoutShopDetail.tsx), demande explicite du 20/10/2026 : "fair un
            stle bien soft" — étendu ici avec recherche/filtres avancés/surbrillance d'état actif. */}
        <div className="aso-filter-card mb-3">
          <span className="aso-filter-icon">
            <iconify-icon icon="solar:filter-bold-duotone"></iconify-icon>
          </span>
          <div className="d-flex align-items-center gap-2 flex-wrap">
            {[
              { label: '7 j', days: 7 },
              { label: '30 j', days: 30 },
              { label: '90 j', days: 90 },
            ].map((preset) => (
              <button
                key={preset.days}
                type="button"
                className={`aso-preset${activePresetDays === preset.days ? ' active' : ''}`}
                onClick={() => {
                  const end = new Date();
                  const start = new Date(end.getTime() - preset.days * 24 * 60 * 60 * 1000);
                  setPeriodEnd(end.toISOString().slice(0, 10));
                  setPeriodStart(start.toISOString().slice(0, 10));
                }}
              >
                {preset.label}
              </button>
            ))}
            <input type="date" className="aso-input" style={{ width: 142 }} value={periodStart} max={periodEnd} onChange={(e) => setPeriodStart(e.target.value)} />
            <span className="text-muted small">au</span>
            <input type="date" className="aso-input" style={{ width: 142 }} value={periodEnd} min={periodStart} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setPeriodEnd(e.target.value)} />
          </div>

          <div className="ms-auto d-flex align-items-center gap-2 flex-wrap">
            <input
              type="search"
              className="aso-input"
              style={{ width: 200 }}
              placeholder="Rechercher un magasin..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <label className={`aso-toggle${longOnly ? ' active' : ''}`}>
              <input type="checkbox" checked={longOnly} onChange={(e) => setLongOnly(e.target.checked)} />
              Ruptures longues
            </label>
            <label className={`aso-toggle${noOrderOnly ? ' active' : ''}`}>
              <input type="checkbox" checked={noOrderOnly} onChange={(e) => setNoOrderOnly(e.target.checked)} />
              Sans commande
            </label>
          </div>
        </div>

        <div className="row g-3 mb-4">
          <div className="col-6 col-md-3">
            <div className="text-muted small">Magasins affichés</div>
            <div className="fs-4 fw-semibold">{filteredShops.length}</div>
          </div>
          <div className="col-6 col-md-3">
            <div className="text-muted small">Total ruptures en cours (filtré)</div>
            <div className="fs-4 fw-semibold">{totals.totalOpen}</div>
          </div>
          <div className="col-6 col-md-3">
            <div className="text-muted small">CA perdu estimé (filtré)</div>
            <div className="fs-4 fw-semibold">{totals.totalCaPerdu.toLocaleString('fr-FR')} CFA</div>
          </div>
          <div className="col-6 col-md-3">
            <div className="text-muted small">Durée moyenne (filtré)</div>
            <div className="fs-4 fw-semibold">{formatDuration(totals.avgDurationHours)}</div>
          </div>
        </div>
        <div className="row g-3 mb-4">
          <div className="col-6 col-md-3">
            <div className="text-muted small">Ruptures longues (≥48h, filtré)</div>
            <div className="fs-5 fw-semibold">{totals.totalLongEpisodes}</div>
          </div>
          <div className="col-6 col-md-3">
            <div className="text-muted small">Sans commande identifiée (filtré)</div>
            <div className="fs-5 fw-semibold">{totals.totalNoOrder}</div>
          </div>
        </div>

        <div className="table-responsive">
          <table className="table align-middle mb-0 table-hover table-centered">
            <thead className="bg-light-subtle">
              <tr>
                <SortableHeader k="shopName" label="Magasin" />
                <SortableHeader k="openCount" label="Ruptures en cours" />
                <SortableHeader k="totalEpisodesCount" label="Ruptures d'article (total)" />
                <SortableHeader k="avgDurationHours" label="Durée moyenne" />
                <SortableHeader k="longEpisodesCount" label="Ruptures longues (≥48h)" />
                <SortableHeader k="noOrderCount" label="Sans commande identifiée" />
                <SortableHeader k="totalCaPerduEstime" label="CA perdu estimé" />
              </tr>
            </thead>
            <tbody>
              {filteredShops.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center text-muted py-4">
                    {allShops.length === 0 ? (summary.message || 'Aucun magasin avec une rupture détectée.') : 'Aucun magasin ne correspond aux filtres.'}
                  </td>
                </tr>
              ) : (
                filteredShops.map((s) => (
                  <tr
                    key={s.rposShopId}
                    role="button"
                    onClick={() => onSelectShop({ id: s.rposShopId, reference: s.shopReference, name: s.shopName })}
                    style={{ cursor: 'pointer' }}
                  >
                    <td>{s.shopName} ({s.shopReference})</td>
                    <td>{s.openCount}</td>
                    <td>{s.totalEpisodesCount}</td>
                    <td>{formatDuration(s.avgDurationHours)}</td>
                    <td>{s.longEpisodesCount}</td>
                    <td>{s.noOrderCount}</td>
                    <td>{s.totalCaPerduEstime.toLocaleString('fr-FR')} CFA</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
