import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../../shared/api/client';

// Analyse par rayon (demande explicite du 16/10/2026, reprise du cahier des charges rupture.md §3 :
// "Quel rayon connaît le plus de ruptures ? ... Quels rayons nécessitent une intervention
// prioritaire ?") — classement trié et triable, distinct de la navigation Secteur→Rayon→Articles
// (StockoutShopDetail.tsx), qui ne montre les rayons qu'une fois un secteur choisi et sert à
// drill-down vers les articles, pas à comparer.
//
// Simplifié le 17/10/2026 (demande explicite : "j'aime pas le stle d'ici il faut simplifier et
// dais comme un pro... si on viens on doit tous voir sans scroller") — l'ancienne version (carte
// sombre isolée, donut, mini-stats, cartes "Item") prenait trop de place et détonnait avec le reste
// de la page (claire). Remplacée par un bandeau de 3 chiffres + un tableau compact, même style que
// le reste du module (cartes claires, badges `reassort-badge-*`), limité aux 5 premiers rayons avec
// un bouton pour voir le reste.
type DepartmentRow = {
  group: string;
  openCount: number;
  totalEpisodesCount: number;
  avgDurationHours: number;
  longEpisodesCount: number;
  noOrderCount: number;
  totalCaPerduEstime: number;
  // Ventilation du CA perdu ajoutée le 19/10/2026 (demande explicite : "dans 'Analyse par rayon' je
  // dois voir CA perdu sans commande et avec commande pas encore livré") — sans commande = perte sur
  // des épisodes où rien n'a encore été fait côté magasin ; avec commande non livrée = perte malgré
  // une réaction déjà en cours, à ne pas confondre dans le même total.
  caPerduSansCommande: number;
  caPerduAvecCommandeNonLivree: number;
};

type ByFieldSummary = { found: boolean; groupCount: number; groups: DepartmentRow[]; message?: string };

type SortKey = 'openCount' | 'avgDurationHours' | 'totalCaPerduEstime' | 'longEpisodesCount';

function formatDuration(hours: number): string {
  if (hours < 24) return `${Math.round(hours)} h`;
  const days = Math.floor(hours / 24);
  const rest = Math.round(hours % 24);
  return `${days} j ${rest} h`;
}

// Priorité d'intervention : combine durée longue ET coût — un rayon avec beaucoup de ruptures
// longues ET un CA perdu élevé mérite une action avant un rayon avec juste beaucoup de petites
// ruptures récentes. Seuils pragmatiques, pas de configuration dédiée pour l'instant.
function priorityLevel(row: DepartmentRow): { label: string; badge: string } {
  if (row.longEpisodesCount >= 3 || row.totalCaPerduEstime >= 50000) {
    return { label: 'Prioritaire', badge: 'reassort-badge-soft-danger' };
  }
  if (row.longEpisodesCount >= 1 || row.openCount >= 10) {
    return { label: 'À surveiller', badge: 'reassort-badge-soft-warning' };
  }
  return { label: 'Normal', badge: 'reassort-badge-neutral' };
}

// startDate/endDate ajoutés le 20/10/2026 (demande explicite : "quand je fait un filtre il doit
// etre appliqué sur tout") — "Analyse par rayon" restait figée sur l'état courant peu importe la
// période choisie en haut de page ; suit désormais le même sélecteur unique que le reste de la page.
export function StockoutDepartmentAnalysis({ shopQueryParam, startDate, endDate }: { shopQueryParam: string; startDate: string; endDate: string }) {
  const [data, setData] = useState<ByFieldSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('openCount');
  // Tri croissant/décroissant (demande explicite du 21/10/2026 : "sur tout les tableau il faut
  // ajouter la possibilité de filtrer par croissant ou decroissant") — avant, un seul sens
  // (décroissant) était possible, choisir le champ ne changeait que la colonne triée.
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (!shopQueryParam) return;
    let cancelled = false;
    setData(null);
    setError(null);
    setShowAll(false);
    const periodParams = `start=${encodeURIComponent(new Date(startDate).toISOString())}&end=${encodeURIComponent(new Date(endDate + 'T23:59:59').toISOString())}`;
    apiFetch<ByFieldSummary>(`/reassort/stockout-episodes/by-department?${periodParams}&${shopQueryParam}`)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [shopQueryParam, startDate, endDate]);

  const rows = useMemo(() => {
    const list = data?.groups || [];
    const dir = sortDir === 'desc' ? 1 : -1;
    return [...list].sort((a, b) => dir * (b[sortKey] - a[sortKey]));
  }, [data, sortKey, sortDir]);

  const priorityCount = rows.filter((r) => priorityLevel(r).label === 'Prioritaire').length;
  const topCaPerdu = rows.length ? Math.max(...rows.map((r) => r.totalCaPerduEstime)) : 0;
  const topCaRow = rows.find((r) => r.totalCaPerduEstime === topCaPerdu && topCaPerdu > 0);
  const visibleRows = showAll ? rows : rows.slice(0, 5);

  function SortButton({ k, label }: { k: SortKey; label: string }) {
    const active = sortKey === k;
    return (
      <button
        type="button"
        className={`btn btn-sm ${active ? 'btn-primary' : 'btn-outline-secondary'}`}
        onClick={() => {
          if (active) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
          else { setSortKey(k); setSortDir('desc'); }
        }}
      >
        {label}
        {active && <iconify-icon icon={sortDir === 'desc' ? 'solar:alt-arrow-down-linear' : 'solar:alt-arrow-up-linear'} style={{ fontSize: '11px', marginLeft: 4 }}></iconify-icon>}
      </button>
    );
  }

  return (
    <div className="card">
      <style>{`
        .stockout-rayon-stat { display: flex; flex-direction: column; gap: 2px; }
        .stockout-rayon-stat .lbl { font-size: .7rem; color: #8591A0; text-transform: uppercase; letter-spacing: .03em; }
        .stockout-rayon-stat .val { font-size: .95rem; font-weight: 700; color: #1B2A4A; }
        .stockout-rayon-table td, .stockout-rayon-table th { padding: 7px 10px; font-size: .82rem; }
      `}</style>
      <div className="card-body py-3">
        <div className="d-flex align-items-center justify-content-between flex-wrap gap-2 mb-2">
          <h6 className="mb-0" style={{ color: '#1B2A4A', fontWeight: 700 }}>Analyse par rayon</h6>
          <div className="d-flex gap-1">
            <SortButton k="openCount" label="Ruptures" />
            <SortButton k="avgDurationHours" label="Durée" />
            <SortButton k="totalCaPerduEstime" label="CA perdu" />
          </div>
        </div>

        {error ? (
          <div className="text-danger small">Erreur : {error}</div>
        ) : data === null ? (
          <div className="text-muted small">Chargement...</div>
        ) : rows.length === 0 ? (
          <div className="text-muted small py-2">{data.message || 'Aucune rupture en cours.'}</div>
        ) : (
          <>
            <div className="d-flex flex-wrap gap-4 mb-3 pb-2" style={{ borderBottom: '1px solid rgba(27,42,74,.08)' }}>
              <div className="stockout-rayon-stat">
                <span className="lbl">Rayon le plus touché</span>
                <span className="val">{rows[0]?.group || '—'} · {rows[0]?.openCount || 0}</span>
              </div>
              <div className="stockout-rayon-stat">
                {/* Libellé corrigé le 21/10/2026 (demande explicite : "je veux un filtre dinamique...
                    faut pas je vais faire le filtre du 10/10/2026 au 20/10/2026 et sur la vue il va
                    me donner les donner de 1an 30j quelque part") — la DONNÉE suivait déjà bien la
                    période choisie (startDate/endDate passés en props), mais ce libellé affichait
                    "(30j)" en dur, laissant croire à tort qu'une fenêtre fixe de 30 jours était
                    utilisée ici alors que le filtre actif en haut de page s'applique partout. */}
                <span className="lbl">Rayon le plus coûteux ({new Date(startDate).toLocaleDateString('fr-FR')} → {new Date(endDate).toLocaleDateString('fr-FR')})</span>
                <span className="val">{topCaRow?.group || '—'} · {topCaPerdu.toLocaleString('fr-FR')} CFA</span>
              </div>
              <div className="stockout-rayon-stat">
                <span className="lbl">Intervention prioritaire</span>
                <span className="val">{priorityCount} / {rows.length} rayon(s)</span>
              </div>
            </div>

            <div className="table-responsive">
              <table className="table align-middle mb-0 stockout-rayon-table">
                <thead className="bg-light-subtle">
                  <tr>
                    <th>Rayon</th>
                    <th>En cours</th>
                    <th>Durée moy.</th>
                    <th>Sans commande</th>
                    <th>CA perdu sans commande</th>
                    <th>CA perdu, commandé non livré</th>
                    <th>Priorité</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((r) => {
                    const priority = priorityLevel(r);
                    return (
                      <tr key={r.group}>
                        <td className="fw-semibold">{r.group}</td>
                        <td>{r.openCount}</td>
                        <td>{formatDuration(r.avgDurationHours)}</td>
                        <td>{r.noOrderCount}</td>
                        <td>{r.caPerduSansCommande.toLocaleString('fr-FR')} CFA</td>
                        <td>{r.caPerduAvecCommandeNonLivree.toLocaleString('fr-FR')} CFA</td>
                        <td><span className={`badge ${priority.badge} py-1 px-2`}>{priority.label}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {rows.length > 5 && (
              <button type="button" className="btn btn-sm btn-link px-0 mt-2" onClick={() => setShowAll((v) => !v)}>
                {showAll ? 'Réduire' : `Voir les ${rows.length - 5} autre(s) rayon(s)`}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
