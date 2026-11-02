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
  relevantCount: number;
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

type SortKey = 'label' | 'department' | 'quantitySuggested' | 'quantityValidated' | 'delta' | 'generatedAt' | 'validatedAt';

const PAGE_SIZE = 50;

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
  const [page, setPage] = useState(1);
  // Pas de valeur par défaut (contrairement au Tableau de bord qui part sur "aujourd'hui") : sans
  // filtre choisi par l'utilisateur, tout l'historique reste visible — demande explicite du
  // 02/11/2026 : "si je veux voir les article qui ont été modifié il y a longtemps dans la
  // proposition validée par le magasin je fais comment" — le backend supportait déjà start/end,
  // il manquait seulement ce sélecteur de dates.
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');

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
    const periodParam =
      periodStart && periodEnd
        ? `&start=${encodeURIComponent(new Date(periodStart).toISOString())}&end=${encodeURIComponent(new Date(periodEnd + 'T23:59:59').toISOString())}`
        : '';
    apiFetch<ConformityDetailsData>(`/reassort/conformity/details?onlyChanged=${onlyChanged}&shop=${encodeURIComponent(shopId)}${periodParam}`)
      .then((result) => !cancelled && setData(result))
      .catch((err) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onlyChanged, activeShop?.id, isSingleShop, periodStart, periodEnd]);

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
        if (sortKey === 'generatedAt') return r.generatedAt ? new Date(r.generatedAt).getTime() : 0;
        return r.validatedAt ? new Date(r.validatedAt).getTime() : 0;
      };
      const av = getValue(a);
      const bv = getValue(b);
      if (typeof av === 'string' || typeof bv === 'string') return dir * String(av).localeCompare(String(bv), 'fr-FR');
      return dir * ((av as number) - (bv as number));
    });
  }, [data, search, sortKey, sortDir]);

  useEffect(() => {
    setPage(1);
  }, [search, onlyChanged, data]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const paged = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

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
        <br />
        <strong>Générée le</strong> : date de création de la proposition par le système. <strong>Validée
        le</strong> : date à laquelle le magasin a validé (et, le cas échéant, modifié) la quantité —
        il n'existe qu'une seule date de décision humaine par ligne, une modification de quantité a
        toujours lieu au moment même de la validation.
      </div>

      {error && <div className="alert alert-danger">{error}</div>}

      {data && data.relevantCount > data.articles.length && (
        <div className="alert alert-warning small">
          {data.relevantCount.toLocaleString('fr-FR')} lignes trouvées, seules les {data.articles.length} premières sont
          affichées (limite de sécurité). Affinez la recherche ou la période pour tout voir.
        </div>
      )}

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
        <div className="d-flex align-items-center gap-2">
          <span className="text-muted small">Validée entre le</span>
          <input
            type="date"
            className="form-control form-control-sm"
            style={{ width: 150 }}
            value={periodStart}
            max={periodEnd || undefined}
            onChange={(e) => setPeriodStart(e.target.value)}
          />
          <span className="text-muted small">et le</span>
          <input
            type="date"
            className="form-control form-control-sm"
            style={{ width: 150 }}
            value={periodEnd}
            min={periodStart || undefined}
            max={new Date().toISOString().slice(0, 10)}
            onChange={(e) => setPeriodEnd(e.target.value)}
          />
          {(periodStart || periodEnd) && (
            <button
              type="button"
              className="btn btn-sm btn-link p-0"
              onClick={() => {
                setPeriodStart('');
                setPeriodEnd('');
              }}
            >
              Réinitialiser
            </button>
          )}
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
                <SortTh k="generatedAt">Générée le</SortTh>
                <SortTh k="validatedAt">Validée le</SortTh>
                <th>Par</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={8} className="text-center text-muted py-4">
                    Chargement...
                  </td>
                </tr>
              )}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-center text-muted py-4">
                    Aucun article {onlyChanged ? 'modifié' : 'validé'} trouvé.
                  </td>
                </tr>
              )}
              {!loading &&
                paged.map((a) => {
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
                      <td className="text-muted small">{fmtDate(a.generatedAt)}</td>
                      <td className="text-muted small">{fmtDate(a.validatedAt)}</td>
                      <td className="text-muted small">{a.validatedBy || '—'}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </div>

      {totalPages > 1 && (
        <div className="d-flex align-items-center justify-content-center gap-2 mt-3">
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary"
            disabled={currentPage <= 1}
            onClick={() => setPage(currentPage - 1)}
          >
            <iconify-icon icon="solar:alt-arrow-left-linear" />
          </button>
          <span className="small text-muted mx-2">
            Page {currentPage} / {totalPages} — {filtered.length.toLocaleString('fr-FR')} résultat(s)
          </span>
          <button
            type="button"
            className="btn btn-sm btn-outline-secondary"
            disabled={currentPage >= totalPages}
            onClick={() => setPage(currentPage + 1)}
          >
            <iconify-icon icon="solar:alt-arrow-right-linear" />
          </button>
        </div>
      )}
    </div>
  );
}
