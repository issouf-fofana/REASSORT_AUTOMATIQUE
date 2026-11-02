import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../../shared/api/client';

// Page Conformité (demande explicite du 02/11/2026 : "je veux voir les article dont le magasin a
// modifié la quantité... article avec toutes ses infos, quantité proposée, quantité validée par
// le magasin... je dois pouvoir suivre ça sur l'UI et voir le taux de conformité direct pour le
// magasin"). Jusqu'ici seul le taux agrégé (%) était visible sur le Tableau de bord — impossible de
// savoir CONCRÈTEMENT quels articles et de combien le magasin s'écarte des propositions. Consomme
// GET /api/reassort/conformity/details (proposalService.getConformityDetails), même filtre de fond
// (status VALIDATED/PARTIALLY_VALIDATED) que le taux déjà affiché ailleurs, pour rester cohérent.

type ConformityArticle = {
  ean: string;
  label: string | null;
  department: string | null;
  sector: string | null;
  quantitySuggested: number;
  quantityValidated: number | null;
  wasExcluded: boolean;
  sellingPrice: number | null;
  buyingPrice: number | null;
  stockAtGeneration: number | null;
  generatedAt: string | null;
  validatedAt: string | null;
  validatedBy: string | null;
};

type ConformityDetailsData = {
  rate: number | null;
  totalLines: number;
  changedLines: number;
  articles: ConformityArticle[];
};

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString('fr-FR') : '—';
}
function fmtNum(n: number | null): string {
  if (n === null || n === undefined) return '—';
  return (Math.round(n * 10) / 10).toLocaleString('fr-FR');
}
function fmtPct(rate: number | null): string {
  return rate === null ? 'N/A' : `${Math.round(rate * 100)}%`;
}

type SortKey = 'label' | 'department' | 'quantitySuggested' | 'quantityValidated' | 'delta' | 'validatedAt';

export function Conformity() {
  const user = window.reassortGetUser ? window.reassortGetUser() : null;
  const isSingleShop = user ? window.reassortIsSingleShopRole(user.role) : false;

  // Même pattern que ScrapReport.tsx/OverstockReport.tsx : magasin propre pour un compte
  // mono-magasin, sélecteur GLOBAL de la topbar pour ADMIN/SUPERVISOR — resolveShopId côté backend
  // (middleware/auth.js) exige ?shop= pour ces deux rôles, sinon "Aucun magasin assigné à ce compte".
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

  const [data, setData] = useState<ConformityDetailsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [onlyChanged, setOnlyChanged] = useState(true);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('validatedAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  useEffect(() => {
    const shopId = activeShopId();
    if (!shopId) {
      setData(null);
      setError('Aucun magasin sélectionné.');
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<ConformityDetailsData>(`/reassort/conformity/details?onlyChanged=${onlyChanged}&shop=${encodeURIComponent(shopId)}`)
      .then((result) => !cancelled && setData(result))
      .catch((err) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onlyChanged, activeShop?.id, isSingleShop]);

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else {
      setSortKey(k);
      setSortDir('desc');
    }
  }

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    const rows = !q
      ? data.articles
      : data.articles.filter((a) => `${a.ean} ${a.label || ''} ${a.department || ''}`.toLowerCase().includes(q));
    const dir = sortDir === 'desc' ? -1 : 1;
    return [...rows].sort((a, b) => {
      const getValue = (r: ConformityArticle): number | string => {
        if (sortKey === 'label') return (r.label || '').toLowerCase();
        if (sortKey === 'department') return (r.department || '').toLowerCase();
        if (sortKey === 'quantitySuggested') return r.quantitySuggested;
        if (sortKey === 'quantityValidated') return r.quantityValidated ?? 0;
        if (sortKey === 'delta') return (r.quantityValidated ?? 0) - r.quantitySuggested;
        return r.validatedAt ? new Date(r.validatedAt).getTime() : 0;
      };
      const av = getValue(a);
      const bv = getValue(b);
      if (typeof av === 'string' || typeof bv === 'string') return dir * String(av).localeCompare(String(bv), 'fr-FR');
      return dir * ((av as number) - (bv as number));
    });
  }, [data, search, sortKey, sortDir]);

  function SortTh({ k, children }: { k: SortKey; children: React.ReactNode }) {
    const active = sortKey === k;
    return (
      <th role="button" style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }} onClick={() => toggleSort(k)}>
        {children} {active ? (sortDir === 'desc' ? '▼' : '▲') : ''}
      </th>
    );
  }

  return (
    <div>
      <div className="d-flex card-header justify-content-between align-items-center mb-3 px-0">
        <h4 className="card-title d-flex align-items-center gap-1 mb-0">
          <iconify-icon icon="solar:checklist-bold-duotone" className="text-primary fs-20" />
          Conformité des commandes
        </h4>
      </div>

      <div className="alert alert-light border mb-4 small">
        Compare, article par article, la quantité <strong>proposée</strong> par le système à la quantité
        finalement <strong>validée</strong> par le magasin, sur les commandes déjà validées. Le taux de
        conformité ci-dessous est le même indicateur que celui affiché sur le Tableau de bord.
      </div>

      {error && <div className="alert alert-danger">{error}</div>}

      {data && (
        <div className="row mb-4">
          <div className="col-md-4">
            <div className="card">
              <div className="card-body">
                <div className="text-muted small">Taux de conformité</div>
                <div className="fs-24 fw-bold">{fmtPct(data.rate)}</div>
              </div>
            </div>
          </div>
          <div className="col-md-4">
            <div className="card">
              <div className="card-body">
                <div className="text-muted small">Lignes validées (total)</div>
                <div className="fs-24 fw-bold">{data.totalLines}</div>
              </div>
            </div>
          </div>
          <div className="col-md-4">
            <div className="card">
              <div className="card-body">
                <div className="text-muted small">Lignes modifiées par le magasin</div>
                <div className="fs-24 fw-bold">{data.changedLines}</div>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="d-flex gap-3 align-items-center mb-3 flex-wrap">
        <input
          type="text"
          className="form-control form-control-sm"
          style={{ maxWidth: 280 }}
          placeholder="Rechercher par article, EAN, rayon..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="form-check">
          <input
            className="form-check-input"
            type="checkbox"
            id="conformity-only-changed"
            checked={onlyChanged}
            onChange={(e) => setOnlyChanged(e.target.checked)}
          />
          <label className="form-check-label" htmlFor="conformity-only-changed">
            Uniquement les articles modifiés
          </label>
        </div>
        {data && <span className="text-muted small ms-auto">{filtered.length} article(s) affiché(s)</span>}
      </div>

      <div className="card">
        <div className="table-responsive">
          <table className="table table-sm mb-0">
            <thead>
              <tr>
                <SortTh k="label">Article</SortTh>
                <SortTh k="department">Rayon</SortTh>
                <SortTh k="quantitySuggested">Qté proposée</SortTh>
                <SortTh k="quantityValidated">Qté validée</SortTh>
                <SortTh k="delta">Écart</SortTh>
                <SortTh k="validatedAt">Validée le</SortTh>
                <th>Par</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={7} className="text-center text-muted py-4">
                    Chargement...
                  </td>
                </tr>
              )}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-center text-muted py-4">
                    Aucun article {onlyChanged ? 'modifié' : 'validé'} trouvé.
                  </td>
                </tr>
              )}
              {!loading &&
                filtered.map((a) => {
                  const delta = a.wasExcluded ? null : (a.quantityValidated ?? 0) - a.quantitySuggested;
                  return (
                    <tr key={a.ean}>
                      <td>
                        <div className="fw-semibold">{a.label || '—'}</div>
                        <div className="text-muted small">{a.ean}</div>
                      </td>
                      <td>{a.department || '—'}</td>
                      <td>{fmtNum(a.quantitySuggested)}</td>
                      <td>{a.wasExcluded ? <span className="badge bg-secondary">Exclue</span> : fmtNum(a.quantityValidated)}</td>
                      <td>
                        {delta === null ? (
                          '—'
                        ) : (
                          <span className={delta > 0 ? 'text-success fw-semibold' : delta < 0 ? 'text-danger fw-semibold' : 'text-muted'}>
                            {delta > 0 ? '+' : ''}
                            {fmtNum(delta)}
                          </span>
                        )}
                      </td>
                      <td className="text-muted small">{fmtDate(a.validatedAt)}</td>
                      <td className="text-muted small">{a.validatedBy || '—'}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
