import { useEffect, useState } from 'react';
import { apiFetch } from './api/client';

// Page dédiée "Consommation de tokens" (09/10/2026) — extraite de l'onglet Config IA des
// Paramètres, où elle était mélangée aux autres réglages ("mettre cette partie à part, supprimer de
// l'autre côté"). Disposition en widgets séparés façon dashboard (maquette fournie, style Creative
// Tim), mais dans la palette marine/ambre du site plutôt que le thème sombre bleu/rose de la
// maquette d'origine — mêmes fonctionnalités que l'ancienne carte unique (graphique avec étiquettes
// de donnée + détail heure par heure au clic, tableaux par fournisseur/usage, détail jour/mois).

interface AiUsage {
  totalTokens: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  callCount: number;
  trackingSince?: string;
  byProvider: { provider: string; callCount: number; totalTokens: number }[];
  byContext: { context: string; callCount: number; totalTokens: number }[];
  dailyHistory?: { date: string; tokens: number }[];
}

function formatTokenCount(n: number): string {
  return (n || 0).toLocaleString('fr-FR');
}

const MONTH_LABELS = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
];

function formatDayLabel(dateKey: string): string {
  const d = new Date(dateKey + 'T00:00:00');
  return d.toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
}

function formatMonthLabel(monthKey: string): string {
  const [year, month] = monthKey.split('-');
  return `${MONTH_LABELS[parseInt(month, 10) - 1]} ${year}`;
}

function formatHourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}h`;
}

// --- Modale "détail heure par heure" (ouverte en cliquant un point du graphique) ---
function TokenUsageHourlyModal({
  date,
  hourlyHistory,
  totalTokens,
  callCount,
  loading,
  error,
  onClose,
}: {
  date: string;
  hourlyHistory: { hour: number; tokens: number }[] | null;
  totalTokens: number | null;
  callCount: number | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}) {
  const width = 720;
  const height = 220;
  const padding = 40;
  const hasData = !!hourlyHistory && hourlyHistory.some((h) => h.tokens > 0);
  const max = hasData ? Math.max(...hourlyHistory!.map((h) => h.tokens), 1) : 1;
  const stepX = hourlyHistory ? (width - padding * 2) / Math.max(hourlyHistory.length - 1, 1) : 0;
  const peakHour = hasData ? hourlyHistory!.reduce((best, h) => (h.tokens > best.tokens ? h : best)) : null;

  const coords = (hourlyHistory || []).map((h, i) => ({
    x: padding + i * stepX,
    y: height - padding - (h.tokens / max) * (height - padding * 2),
    tokens: h.tokens,
    hour: h.hour,
  }));
  const smoothPath = coords.length
    ? coords.reduce((path, c, i) => {
        if (i === 0) return `M ${c.x},${c.y}`;
        const prev = coords[i - 1];
        const midX = (prev.x + c.x) / 2;
        return `${path} C ${midX},${prev.y} ${midX},${c.y} ${c.x},${c.y}`;
      }, '')
    : '';
  const smoothAreaPath = coords.length ? `${smoothPath} L ${width - padding},${height - padding} L ${padding},${height - padding} Z` : '';

  return (
    <>
      <div className="modal fade show" style={{ display: 'block' }} tabIndex={-1} role="dialog">
        <div className="modal-dialog modal-lg modal-dialog-centered" role="document">
          <div className="modal-content">
            <div className="modal-header">
              <h5 className="modal-title">Détail heure par heure — {formatDayLabel(date)}</h5>
              <button type="button" className="btn-close" onClick={onClose}></button>
            </div>
            <div className="modal-body">
              {loading && <div className="text-center text-muted py-4">Chargement...</div>}
              {error && <div className="alert alert-danger small">{error}</div>}
              {!loading && !error && hourlyHistory && (
                <>
                  <div className="row text-center mb-3">
                    <div className="col">
                      <div className="fs-5 fw-semibold">{formatTokenCount(totalTokens || 0)}</div>
                      <div className="small text-muted">Total tokens ce jour</div>
                    </div>
                    <div className="col">
                      <div className="fs-5 fw-semibold">{formatTokenCount(callCount || 0)}</div>
                      <div className="small text-muted">Appels</div>
                    </div>
                    <div className="col">
                      <div className="fs-5 fw-semibold">{peakHour ? formatHourLabel(peakHour.hour) : '—'}</div>
                      <div className="small text-muted">Heure la plus active</div>
                    </div>
                  </div>
                  {!hasData ? (
                    <div className="text-center text-muted small py-4">Aucun appel IA enregistré ce jour-là.</div>
                  ) : (
                    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto', overflow: 'visible' }}>
                      <defs>
                        <linearGradient id="tokenUsageHourlyGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#1B2A4A" stopOpacity={0.22} />
                          <stop offset="100%" stopColor="#1B2A4A" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
                        const y = padding + frac * (height - padding * 2);
                        return <line key={frac} x1={padding} y1={y} x2={width - padding} y2={y} stroke="#e5e7eb" strokeWidth={1} strokeDasharray="4 4" />;
                      })}
                      <path d={smoothAreaPath} fill="url(#tokenUsageHourlyGradient)" stroke="none" />
                      <path d={smoothPath} fill="none" stroke="#1B2A4A" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
                      {coords.map((c) => (
                        <g key={c.hour}>
                          {c.hour === peakHour?.hour && c.tokens > 0 && (
                            <text x={c.x} y={c.y - 12} textAnchor="middle" fontSize="11" fontWeight="600" fill="#1B2A4A">
                              {formatTokenCount(c.tokens)}
                            </text>
                          )}
                          <circle cx={c.x} cy={c.y} r={10} fill="transparent" style={{ cursor: 'default' }}>
                            <title>{`${formatHourLabel(c.hour)} : ${formatTokenCount(c.tokens)} tokens`}</title>
                          </circle>
                          <circle cx={c.x} cy={c.y} r={c.tokens > 0 ? 3 : 1.5} fill="#1B2A4A" style={{ pointerEvents: 'none' }} />
                        </g>
                      ))}
                    </svg>
                  )}
                  {hasData && (
                    <div className="d-flex justify-content-between small text-muted mt-1">
                      <span>00h</span>
                      <span>23h</span>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
      <div className="modal-backdrop fade show"></div>
    </>
  );
}

// --- Widget "Évolution" (carte dédiée, graphique seul) ---
function TokenUsageChartCard({ dailyHistory }: { dailyHistory: { date: string; tokens: number }[] }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [drillDate, setDrillDate] = useState<string | null>(null);
  const [hourly, setHourly] = useState<{ hour: number; tokens: number }[] | null>(null);
  const [hourlyTotal, setHourlyTotal] = useState<number | null>(null);
  const [hourlyCalls, setHourlyCalls] = useState<number | null>(null);
  const [hourlyLoading, setHourlyLoading] = useState(false);
  const [hourlyError, setHourlyError] = useState<string | null>(null);

  if (dailyHistory.length < 2) {
    return (
      <div className="card">
        <div className="card-body">
          <h5 className="card-title">Évolution</h5>
          <div className="text-center text-muted small py-4">Pas assez de données sur cette période pour tracer une courbe.</div>
        </div>
      </div>
    );
  }

  const width = 900;
  const height = 280;
  const padding = 40;
  const leftPadding = 64;
  const values = dailyHistory.map((d) => d.tokens);
  const max = Math.max(...values, 1);
  const stepX = (width - leftPadding - padding) / Math.max(values.length - 1, 1);

  const coords = dailyHistory.map((d, i) => ({
    x: leftPadding + i * stepX,
    y: height - padding - (d.tokens / max) * (height - padding * 2),
    tokens: d.tokens,
    date: d.date,
  }));

  const smoothPath = coords.reduce((path, c, i) => {
    if (i === 0) return `M ${c.x},${c.y}`;
    const prev = coords[i - 1];
    const midX = (prev.x + c.x) / 2;
    return `${path} C ${midX},${prev.y} ${midX},${c.y} ${c.x},${c.y}`;
  }, '');
  const smoothAreaPath = `${smoothPath} L ${width - padding},${height - padding} L ${leftPadding},${height - padding} Z`;

  const yAxisTicks = [1, 0.75, 0.5, 0.25, 0].map((frac) => ({
    y: padding + (1 - frac) * (height - padding * 2),
    value: Math.round(max * frac),
  }));

  const maxTokens = Math.max(...values);
  const isNotablePeak = (i: number) => {
    if (values[i] === 0) return false;
    if (values[i] === maxTokens) return true;
    const prev = i > 0 ? values[i - 1] : -Infinity;
    const next = i < values.length - 1 ? values[i + 1] : -Infinity;
    return values[i] > prev && values[i] > next;
  };

  async function openHourly(date: string) {
    setDrillDate(date);
    setHourly(null);
    setHourlyError(null);
    setHourlyLoading(true);
    try {
      const data = await apiFetch<{ hourlyHistory: { hour: number; tokens: number }[]; totalTokens: number; callCount: number }>(
        `/reassort/ai-usage/hourly?date=${encodeURIComponent(date)}`,
      );
      setHourly(data.hourlyHistory);
      setHourlyTotal(data.totalTokens);
      setHourlyCalls(data.callCount);
    } catch (err) {
      setHourlyError((err as Error).message);
    } finally {
      setHourlyLoading(false);
    }
  }

  const hovered = hoverIdx !== null ? coords[hoverIdx] : null;

  return (
    <div className="card">
      <div className="card-body">
        <div className="d-flex justify-content-between align-items-start mb-3">
          <div>
            <h5 className="card-title mb-1">Évolution</h5>
            <p className="text-muted small mb-0">Tokens consommés par jour — cliquez un point pour le détail heure par heure</p>
          </div>
        </div>
        <div style={{ position: 'relative' }}>
          <svg
            viewBox={`0 0 ${width} ${height}`}
            style={{ width: '100%', height: 'auto', overflow: 'visible' }}
            onMouseLeave={() => setHoverIdx(null)}
          >
            <defs>
              <linearGradient id="tokenUsageAreaGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#1B2A4A" stopOpacity={0.22} />
                <stop offset="100%" stopColor="#1B2A4A" stopOpacity={0} />
              </linearGradient>
            </defs>
            {yAxisTicks.map((tick) => (
              <g key={tick.y}>
                <line x1={leftPadding} y1={tick.y} x2={width - padding} y2={tick.y} stroke="#e5e7eb" strokeWidth={1} strokeDasharray="4 4" />
                <text x={leftPadding - 10} y={tick.y + 4} textAnchor="end" fontSize="11" fill="#9aa4b2">
                  {formatTokenCount(tick.value)}
                </text>
              </g>
            ))}
            <path d={smoothAreaPath} fill="url(#tokenUsageAreaGradient)" stroke="none" />
            <path d={smoothPath} fill="none" stroke="#1B2A4A" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
            {hovered && <line x1={hovered.x} y1={padding} x2={hovered.x} y2={height - padding} stroke="#1B2A4A" strokeWidth={1} strokeDasharray="3 3" opacity={0.4} />}
            {coords.map((c, i) => (
              <g key={c.date}>
                {isNotablePeak(i) && (
                  <text x={c.x} y={c.y - 12} textAnchor="middle" fontSize="11" fontWeight="600" fill="#1B2A4A">
                    {formatTokenCount(c.tokens)}
                  </text>
                )}
                <circle
                  cx={c.x}
                  cy={c.y}
                  r={10}
                  fill="transparent"
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={() => setHoverIdx(i)}
                  onClick={() => openHourly(c.date)}
                >
                  <title>{`${formatDayLabel(c.date)} : ${formatTokenCount(c.tokens)} tokens — cliquer pour le détail par heure`}</title>
                </circle>
                <circle cx={c.x} cy={c.y} r={hoverIdx === i ? 4.5 : 2.5} fill="#1B2A4A" style={{ pointerEvents: 'none' }} />
              </g>
            ))}
          </svg>
          {hovered && (
            <div
              className="small"
              style={{
                position: 'absolute',
                left: `${(hovered.x / width) * 100}%`,
                top: `${(hovered.y / height) * 100}%`,
                transform: 'translate(-50%, -130%)',
                backgroundColor: '#1B2A4A',
                color: '#fff',
                padding: '4px 8px',
                borderRadius: 6,
                whiteSpace: 'nowrap',
                pointerEvents: 'none',
                zIndex: 1,
              }}
            >
              <strong>{formatTokenCount(hovered.tokens)}</strong> tokens — {formatDayLabel(hovered.date)}
            </div>
          )}
        </div>
        <div className="d-flex justify-content-between small text-muted mt-1">
          <span>{formatDayLabel(dailyHistory[0].date)}</span>
          <span>{formatDayLabel(dailyHistory[dailyHistory.length - 1].date)}</span>
        </div>
      </div>
      {drillDate && (
        <TokenUsageHourlyModal
          date={drillDate}
          hourlyHistory={hourly}
          totalTokens={hourlyTotal}
          callCount={hourlyCalls}
          loading={hourlyLoading}
          error={hourlyError}
          onClose={() => setDrillDate(null)}
        />
      )}
    </div>
  );
}

// --- Widget "Détail jour/mois" (carte dédiée, tableau seul) ---
function TokenUsageDetailCard({ dailyHistory }: { dailyHistory: { date: string; tokens: number }[] }) {
  const [grouping, setGrouping] = useState<'day' | 'month'>('day');

  if (!dailyHistory.length) return null;

  const dayRows: [string, number][] = [...dailyHistory].reverse().map((d) => [d.date, d.tokens]);
  const monthRows: [string, number][] = (() => {
    const byMonth = new Map<string, number>();
    for (const d of dailyHistory) {
      const monthKey = d.date.slice(0, 7);
      byMonth.set(monthKey, (byMonth.get(monthKey) || 0) + d.tokens);
    }
    return Array.from(byMonth.entries()).sort(([a], [b]) => b.localeCompare(a));
  })();
  const rows = grouping === 'day' ? dayRows : monthRows;

  return (
    <div className="card">
      <div className="card-body">
        <div className="d-flex justify-content-between align-items-center mb-2">
          <h5 className="card-title mb-0">Détail de la consommation</h5>
          <div className="btn-group btn-group-sm" role="group">
            <button type="button" className={`btn ${grouping === 'day' ? 'btn-dark' : 'btn-outline-secondary'}`} onClick={() => setGrouping('day')}>
              Par jour
            </button>
            <button type="button" className={`btn ${grouping === 'month' ? 'btn-dark' : 'btn-outline-secondary'}`} onClick={() => setGrouping('month')}>
              Par mois
            </button>
          </div>
        </div>
        <div className="table-responsive" style={{ maxHeight: 360, overflowY: 'auto' }}>
          <table className="table table-sm table-hover mb-0">
            <thead style={{ position: 'sticky', top: 0, backgroundColor: '#fff' }}>
              <tr>
                <th>{grouping === 'day' ? 'Jour' : 'Mois'}</th>
                <th className="text-end">Tokens</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([key, tokens]) => (
                <tr key={key}>
                  <td>{grouping === 'day' ? formatDayLabel(key) : formatMonthLabel(key)}</td>
                  <td className="text-end">{formatTokenCount(tokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// --- Widgets "Par fournisseur" / "Par usage" (cartes dédiées) ---
function TokenUsageBreakdownCard({ title, rows }: { title: string; rows: { label: string; callCount: number; totalTokens: number }[] }) {
  return (
    <div className="card h-100">
      <div className="card-body">
        <h5 className="card-title">{title}</h5>
        {!rows.length ? (
          <div className="text-center text-muted small py-3">Aucune donnée.</div>
        ) : (
          <table className="table table-sm mb-0">
            <thead>
              <tr>
                <th></th>
                <th className="text-end">Appels</th>
                <th className="text-end">Tokens</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label}>
                  <td>{r.label}</td>
                  <td className="text-end">{r.callCount}</td>
                  <td className="text-end">{formatTokenCount(r.totalTokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// --- Widget KPI (petite carte avec une seule grande valeur, style "Total Shipments"/"Daily Sales"
// de la maquette) ---
function TokenUsageKpiCard({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="card h-100">
      <div className="card-body d-flex align-items-center gap-3">
        <div
          style={{
            width: 44, height: 44, borderRadius: 10, flexShrink: 0,
            background: 'linear-gradient(135deg, #1B2A4A 0%, #2d4068 100%)',
            color: '#F5A623', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.2rem',
          }}
        >
          <iconify-icon icon={icon}></iconify-icon>
        </div>
        <div>
          <div className="fs-4 fw-semibold" style={{ color: '#1B2A4A' }}>{value}</div>
          <div className="small text-muted">{label}</div>
        </div>
      </div>
    </div>
  );
}

export function TokenUsagePage() {
  const [period, setPeriod] = useState('30');
  const [usage, setUsage] = useState<AiUsage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    const params = period === 'all' ? 'days=all' : `days=${encodeURIComponent(period)}`;
    apiFetch<AiUsage>(`/reassort/ai-usage?${params}`)
      .then(setUsage)
      .catch((err: Error) => setError(err.message));
  }, [period]);

  return (
    <div>
      <div className="d-flex justify-content-between align-items-start mb-3 flex-wrap gap-2">
        <div>
          <h4 className="mb-1">Consommation de tokens</h4>
          <p className="text-muted small mb-0">
            Chaque appel IA réussi (chatbot, prévision de commande) consomme des tokens sur la clé utilisée — cette
            vue permet de suivre le volume consommé avant d'atteindre une limite de quota côté fournisseur.
          </p>
        </div>
        <div className="btn-group btn-group-sm" role="group" style={{ backgroundColor: '#F1F3F5', borderRadius: 999, padding: 3 }}>
          {[
            { value: '7', label: '7j' },
            { value: '30', label: '30j' },
            { value: '90', label: '90j' },
            { value: 'all', label: 'Tout' },
          ].map((opt) => (
            <button
              key={opt.value}
              type="button"
              className="btn"
              style={{
                borderRadius: 999,
                border: 'none',
                padding: '.3rem .85rem',
                fontWeight: 600,
                backgroundColor: period === opt.value ? '#1B2A4A' : 'transparent',
                color: period === opt.value ? '#fff' : '#5B6B85',
              }}
              onClick={() => setPeriod(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="alert alert-danger">{error}</div>}

      {usage && period === 'all' && usage.trackingSince && (
        <div className="small text-muted mb-3">Suivi depuis le {new Date(usage.trackingSince).toLocaleDateString('fr-FR')}</div>
      )}

      {usage && period !== 'all' && !usage.callCount ? (
        <div className="text-center text-muted py-5">Aucun appel IA sur cette période.</div>
      ) : (
        <>
          {/* Rangée de widgets KPI, un par chiffre clé — même esprit que les cartes "Total
              Shipments"/"Daily Sales"/"Completed Tasks" de la maquette. */}
          <div className="row g-3 mb-3">
            <div className="col-6 col-lg-3">
              <TokenUsageKpiCard icon="solar:bolt-bold-duotone" label="Total tokens" value={usage ? formatTokenCount(usage.totalTokens) : '—'} />
            </div>
            <div className="col-6 col-lg-3">
              <TokenUsageKpiCard icon="solar:login-3-bold-duotone" label="Tokens entrée" value={usage ? formatTokenCount(usage.totalPromptTokens) : '—'} />
            </div>
            <div className="col-6 col-lg-3">
              <TokenUsageKpiCard icon="solar:logout-3-bold-duotone" label="Tokens sortie" value={usage ? formatTokenCount(usage.totalCompletionTokens) : '—'} />
            </div>
            <div className="col-6 col-lg-3">
              <TokenUsageKpiCard icon="solar:phone-calling-bold-duotone" label="Appels" value={usage ? formatTokenCount(usage.callCount) : '—'} />
            </div>
          </div>

          {usage && !!usage.dailyHistory?.length && (
            <div className="mb-3">
              <TokenUsageChartCard dailyHistory={usage.dailyHistory} />
            </div>
          )}

          {usage && (
            <div className="row g-3 mb-3">
              <div className="col-md-6">
                <TokenUsageBreakdownCard
                  title="Par fournisseur"
                  rows={usage.byProvider.map((p) => ({ label: p.provider, callCount: p.callCount, totalTokens: p.totalTokens }))}
                />
              </div>
              <div className="col-md-6">
                <TokenUsageBreakdownCard
                  title="Par usage"
                  rows={usage.byContext.map((c) => ({ label: c.context, callCount: c.callCount, totalTokens: c.totalTokens }))}
                />
              </div>
            </div>
          )}

          {usage && !!usage.dailyHistory?.length && <TokenUsageDetailCard dailyHistory={usage.dailyHistory} />}
        </>
      )}
    </div>
  );
}
