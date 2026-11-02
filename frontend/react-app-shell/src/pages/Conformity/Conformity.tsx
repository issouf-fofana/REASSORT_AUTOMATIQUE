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
  rposOrderId: string | null;
  rposOrderReference: string | null;
  rposOrderStatus: string | null;
  isRegression: boolean;
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
  // Par défaut, montre TOUS les articles proposés de la commande (pas seulement les modifiés) —
  // demande explicite du 02/11/2026 : "si il y a 30 article proposé... je veux voir ça tu vois ?"
  // — l'utilisateur veut voir l'ensemble de la commande, pas uniquement les écarts.
  const [onlyChanged, setOnlyChanged] = useState(false);
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

      <p className="text-muted mb-4" style={{ maxWidth: 760, lineHeight: 1.6 }}>
        Compare, article par article, la quantité <strong className="text-body">proposée</strong> par le
        système à la quantité finalement <strong className="text-body">validée</strong> par le magasin,
        sur les commandes déjà validées. Le taux de conformité ci-dessous est le même indicateur que
        celui affiché sur le Tableau de bord.{' '}
        <span className="text-body">Générée le</span> est la date de création de la proposition par le
        système ; <span className="text-body">Validée le</span> est la date à laquelle le magasin a
        validé — et, le cas échéant, modifié — la quantité.
      </p>

      {error && (
        <div className="alert alert-danger d-flex align-items-center gap-2">
          <iconify-icon icon="solar:danger-triangle-bold" />
          {error}
        </div>
      )}

      {data && data.relevantCount > data.articles.length && (
        <div className="alert alert-warning d-flex align-items-center gap-2 small">
          <iconify-icon icon="solar:info-circle-bold" />
          {data.relevantCount.toLocaleString('fr-FR')} lignes trouvées, seules les {data.articles.length} premières sont
          affichées (limite de sécurité). Affinez la recherche ou la période pour tout voir.
        </div>
      )}

      {data && (
        <div className="row g-3 mb-4">
          <div className="col-md-4">
            <StatCard
              icon="solar:target-bold-duotone"
              tone="primary"
              label="Taux de conformité"
              value={fmtPct(data.rate)}
              hint="Lignes validées sans modification"
            />
          </div>
          <div className="col-md-4">
            <StatCard
              icon="solar:clipboard-list-bold-duotone"
              tone="neutral"
              label="Lignes validées"
              value={data.totalLines.toLocaleString('fr-FR')}
              hint="Toutes commandes confondues"
            />
          </div>
          <div className="col-md-4">
            <StatCard
              icon="solar:pen-new-square-bold-duotone"
              tone={data.changedLines > 0 ? 'warning' : 'neutral'}
              label="Modifiées par le magasin"
              value={data.changedLines.toLocaleString('fr-FR')}
              hint={data.totalLines ? `${Math.round((data.changedLines / data.totalLines) * 100)}% des lignes` : undefined}
            />
          </div>
        </div>
      )}

      <div className="card mb-3">
        <div className="card-body py-3">
          <div className="d-flex gap-3 align-items-center flex-wrap">
            <div className="position-relative" style={{ minWidth: 260 }}>
              <iconify-icon
                icon="solar:magnifer-linear"
                className="text-muted position-absolute"
                style={{ left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 16 }}
              />
              <input
                type="text"
                className="form-control form-control-sm"
                style={{ paddingLeft: 34 }}
                placeholder="Rechercher par article, EAN, rayon..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="form-check form-switch mb-0">
              <input
                className="form-check-input"
                type="checkbox"
                role="switch"
                id="conformity-only-changed"
                checked={onlyChanged}
                onChange={(e) => setOnlyChanged(e.target.checked)}
              />
              <label className="form-check-label small" htmlFor="conformity-only-changed">
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
            {data && (
              <span className="text-muted small ms-auto">
                {filtered.length.toLocaleString('fr-FR')} article{filtered.length > 1 ? 's' : ''} affiché{filtered.length > 1 ? 's' : ''}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="table-responsive">
          <table className="table table-sm table-hover align-middle mb-0 conformity-table">
            <thead>
              <tr>
                <SortTh k="label">Article</SortTh>
                <SortTh k="department">Rayon</SortTh>
                <SortTh k="quantitySuggested">Qté proposée</SortTh>
                <SortTh k="quantityValidated">Qté validée</SortTh>
                <SortTh k="delta">Écart</SortTh>
                <th>Régression</th>
                <SortTh k="generatedAt">Générée le</SortTh>
                <SortTh k="validatedAt">Validée le</SortTh>
                <th>Par</th>
                <th>Commande</th>
              </tr>
            </thead>
            <tbody>
              {loading &&
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={`skeleton-${i}`}>
                    {Array.from({ length: 10 }).map((__, j) => (
                      <td key={j}>
                        <span className="skeleton-bar" style={{ width: j === 0 ? '70%' : '50%' }} />
                      </td>
                    ))}
                  </tr>
                ))}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={10} className="text-center text-muted py-5">
                    <iconify-icon icon="solar:inbox-line-linear" className="fs-24 d-block mb-2 opacity-50" />
                    Aucun article {onlyChanged ? 'modifié' : 'validé'} trouvé{search ? ` pour « ${search} »` : ''}.
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
                      <td className="text-muted">{a.department || '—'}</td>
                      <td className="fw-medium">{fmtNum(a.quantitySuggested)}</td>
                      <td className="fw-medium">
                        {a.wasExcluded ? <span className="badge text-bg-secondary">Exclue</span> : fmtNum(a.quantityValidated)}
                      </td>
                      <td>
                        {delta === null ? (
                          <span className="text-muted">—</span>
                        ) : delta === 0 ? (
                          <span className="text-muted">0</span>
                        ) : (
                          <span className={delta > 0 ? 'text-success fw-semibold' : 'text-danger fw-semibold'}>
                            {delta > 0 ? '+' : ''}
                            {fmtNum(delta)}
                          </span>
                        )}
                      </td>
                      <td>
                        {a.isRegression ? (
                          <span className="badge text-bg-danger-subtle text-danger-emphasis border border-danger-subtle">
                            Oui
                          </span>
                        ) : (
                          <span className="badge text-bg-light text-muted border">Non</span>
                        )}
                      </td>
                      <td className="text-muted small">{fmtDate(a.generatedAt)}</td>
                      <td className="text-muted small">{fmtDate(a.validatedAt)}</td>
                      <td className="text-muted small">{a.validatedBy || '—'}</td>
                      <td className="text-muted small">
                        {a.rposOrderReference || a.rposOrderId || '—'}
                        {!a.validatedAt && a.rposOrderId && (
                          <div className="text-warning d-flex align-items-center gap-1" style={{ fontSize: '0.75em' }}>
                            <iconify-icon icon="solar:clock-circle-bold" />
                            En attente de synchronisation RPOS
                          </div>
                        )}
                      </td>
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

      <style>{`
        .conformity-table thead th {
          background: var(--bs-tertiary-bg, #f8f9fa);
          font-size: 0.72rem;
          letter-spacing: 0.02em;
          color: var(--bs-secondary-color, #6c757d);
          font-weight: 600;
          border-bottom: 1px solid var(--bs-border-color, #e9ecef);
          padding-top: 0.65rem;
          padding-bottom: 0.65rem;
        }
        .conformity-table tbody tr {
          transition: background-color 0.12s ease;
        }
        .skeleton-bar {
          display: inline-block;
          height: 0.85em;
          border-radius: 4px;
          background: linear-gradient(90deg, rgba(0,0,0,0.06) 25%, rgba(0,0,0,0.1) 37%, rgba(0,0,0,0.06) 63%);
          background-size: 400% 100%;
          animation: conformity-shimmer 1.4s ease infinite;
        }
        @keyframes conformity-shimmer {
          0% { background-position: 100% 50%; }
          100% { background-position: 0 50%; }
        }
        @media (prefers-color-scheme: dark) {
          .skeleton-bar {
            background: linear-gradient(90deg, rgba(255,255,255,0.08) 25%, rgba(255,255,255,0.14) 37%, rgba(255,255,255,0.08) 63%);
            background-size: 400% 100%;
          }
        }
      `}</style>
    </div>
  );
}

const STAT_TONES: Record<string, { bg: string; fg: string }> = {
  primary: { bg: 'rgba(13,110,253,0.1)', fg: '#0d6efd' },
  warning: { bg: 'rgba(255,193,7,0.14)', fg: '#b8860b' },
  neutral: { bg: 'rgba(108,117,125,0.1)', fg: '#6c757d' },
};

function StatCard({
  icon,
  tone,
  label,
  value,
  hint,
}: {
  icon: string;
  tone: 'primary' | 'warning' | 'neutral';
  label: string;
  value: string;
  hint?: string;
}) {
  const colors = STAT_TONES[tone];
  return (
    <div className="card h-100">
      <div className="card-body d-flex align-items-start gap-3">
        <div
          className="d-flex align-items-center justify-content-center flex-shrink-0"
          style={{ width: 42, height: 42, borderRadius: 10, background: colors.bg, color: colors.fg }}
        >
          <iconify-icon icon={icon} style={{ fontSize: 22 }} />
        </div>
        <div>
          <div className="text-muted small mb-1">{label}</div>
          <div className="fs-24 fw-bold lh-1">{value}</div>
          {hint && <div className="text-muted mt-1" style={{ fontSize: '0.75rem' }}>{hint}</div>}
        </div>
      </div>
    </div>
  );
}
