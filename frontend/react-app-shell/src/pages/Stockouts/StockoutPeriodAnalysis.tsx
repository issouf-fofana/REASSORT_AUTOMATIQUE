import { useEffect, useState } from 'react';
import { apiFetch } from '../../shared/api/client';

// Analyse des pertes de rupture sur une période personnalisée, comparée au CA réellement réalisé
// par le magasin (demande explicite du 18/10/2026 : "il faut me donne la possiblité de faire les
// filtre sur une periode personalisé pour voir sur quel periode les perte que j'ai eu pendant les
// rupture... vs mon CA du mag sur cette periode aussi voir est ce que la perte est trop ou pas et
// sil ya une sensibilisation a faire"). L'analyse IA est À LA DEMANDE (bouton "Analyser", jamais
// automatique) — confirmé explicitement par l'utilisateur, pour maîtriser le coût des appels IA.
//
// Simplifié le 18/10/2026 (demande explicite : "je ne dois pas voir trop de truc compliqué...
// par defaut j'ai l'analyse bien formaté et affiché") — la synthèse (chiffres) se charge
// automatiquement dès l'arrivée sur la page, sans clic préalable ; seul le vrai appel IA (coût
// réel) reste un clic explicite. L'analyse IA est aussi reformatée (gras/listes) au lieu d'un bloc
// de texte brut.
type PeriodSummary = {
  found: boolean;
  period: { startDate: string; endDate: string };
  totalCaPerdu: number;
  totalQtyPerdue: number;
  episodeCount: number;
  shopRevenueExclTax: number;
  lossRatioPct: number | null;
  departmentBreakdown: { department: string; caPerdue: number; qtyPerdue: number; episodeCount: number }[];
};

type AnalysisResult = {
  level: 'faible' | 'modere' | 'eleve';
  verdict: string;
  concernedDepartments: string[];
  recommendations: string[];
  providerUsed: string;
};

const LEVEL_META: Record<AnalysisResult['level'], { label: string; color: string; bg: string; icon: string }> = {
  eleve: { label: 'Perte élevée', color: '#8a221e', bg: '#f9ecea', icon: 'solar:danger-triangle-bold-duotone' },
  modere: { label: 'Perte modérée', color: '#7a4910', bg: '#fdf1dd', icon: 'solar:shield-warning-bold-duotone' },
  faible: { label: 'Perte faible', color: '#2d6a3f', bg: '#e9f3ec', icon: 'solar:shield-check-bold-duotone' },
};

function formatIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function defaultRange(): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { start: formatIsoDate(start), end: formatIsoDate(end) };
}

export function StockoutPeriodAnalysis({ shopQueryParam }: { shopQueryParam: string }) {
  const defaults = defaultRange();
  const [startDate, setStartDate] = useState(defaults.start);
  const [endDate, setEndDate] = useState(defaults.end);
  const [summary, setSummary] = useState<PeriodSummary | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  async function loadSummary(start: string, end: string) {
    if (!shopQueryParam) return;
    setLoadingSummary(true);
    setError(null);
    setAnalysis(null);
    setAnalysisError(null);
    try {
      const data = await apiFetch<PeriodSummary>(
        `/reassort/stockout-episodes/period-summary?start=${encodeURIComponent(new Date(start).toISOString())}&end=${encodeURIComponent(new Date(end + 'T23:59:59').toISOString())}&${shopQueryParam}`
      );
      setSummary(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingSummary(false);
    }
  }

  // Chargement automatique à l'arrivée sur la page et à chaque changement de magasin (demande
  // explicite : affichage par défaut, sans action préalable de l'utilisateur).
  useEffect(() => {
    if (!shopQueryParam) return;
    loadSummary(startDate, endDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shopQueryParam]);

  async function runAnalysis() {
    if (!shopQueryParam) return;
    setAnalyzing(true);
    setAnalysisError(null);
    try {
      const data = await apiFetch<AnalysisResult>(
        `/reassort/stockout-episodes/period-analysis?${shopQueryParam}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            start: new Date(startDate).toISOString(),
            end: new Date(endDate + 'T23:59:59').toISOString(),
          }),
        }
      );
      setAnalysis(data);
    } catch (err) {
      setAnalysisError(err instanceof Error ? err.message : String(err));
    } finally {
      setAnalyzing(false);
    }
  }

  const ratioTone = summary?.lossRatioPct === null ? 'muted' : summary && summary.lossRatioPct! >= 5 ? 'danger' : summary && summary.lossRatioPct! >= 2 ? 'warning' : 'success';

  return (
    <div className="card mb-3" style={{ borderTop: '3px solid #F5A623' }}>
      <style>{`
        .stockout-period-ratio.tone-danger { color: #8a221e; }
        .stockout-period-ratio.tone-warning { color: #7a4910; }
        .stockout-period-ratio.tone-success { color: #2d6a3f; }
        .stockout-period-ratio.tone-muted { color: #8591A0; }
        .stockout-ai-block { border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; }
        .stockout-ai-block:last-child { margin-bottom: 0; }
        .stockout-ai-block-title { font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; margin-bottom: 6px; opacity: .85; }
        .stockout-ai-block ul { margin: 0; padding-left: 1.1rem; }
        .stockout-ai-block li { margin-bottom: 4px; }
        .stockout-ai-block li:last-child { margin-bottom: 0; }
        .stockout-ai-dept-chip { display: inline-block; background: #EDF1F7; color: #1B2A4A; border-radius: 999px; padding: 3px 10px; font-size: .78rem; font-weight: 600; margin: 0 6px 6px 0; }
      `}</style>
      <div className="card-body">
        <div className="d-flex align-items-center justify-content-between flex-wrap gap-2 mb-3">
          <h6 className="mb-0 d-flex align-items-center gap-2" style={{ color: '#1B2A4A', fontWeight: 700 }}>
            <iconify-icon icon="solar:chart-square-bold-duotone" style={{ color: '#F5A623', fontSize: '1.2rem' }}></iconify-icon>
            Analyse des pertes sur une période
          </h6>
          <div className="d-flex align-items-end gap-2 flex-wrap">
            <input type="date" className="form-control form-control-sm" style={{ width: 150 }} value={startDate} max={endDate} onChange={(e) => { setStartDate(e.target.value); loadSummary(e.target.value, endDate); }} />
            <span className="text-muted small">au</span>
            <input type="date" className="form-control form-control-sm" style={{ width: 150 }} value={endDate} min={startDate} max={formatIsoDate(new Date())} onChange={(e) => { setEndDate(e.target.value); loadSummary(startDate, e.target.value); }} />
          </div>
        </div>

        {error && <div className="text-danger small mb-2">Erreur : {error}</div>}

        {loadingSummary && !summary ? (
          <div className="text-muted small">Calcul en cours...</div>
        ) : summary && (
          <>
            <div className="row g-3 mb-3">
              <div className="col-6 col-md-3">
                <div className="text-muted small">CA perdu (rupture)</div>
                <div className="fs-5 fw-semibold">{summary.totalCaPerdu.toLocaleString('fr-FR')} CFA</div>
              </div>
              <div className="col-6 col-md-3">
                <div className="text-muted small">CA réalisé (magasin)</div>
                <div className="fs-5 fw-semibold">{summary.shopRevenueExclTax.toLocaleString('fr-FR')} CFA</div>
              </div>
              <div className="col-6 col-md-3">
                <div className="text-muted small">Ratio perte / CA</div>
                <div className={`fs-5 fw-semibold stockout-period-ratio tone-${ratioTone}`}>
                  {summary.lossRatioPct !== null ? `${summary.lossRatioPct} %` : '—'}
                </div>
              </div>
              <div className="col-6 col-md-3">
                <div className="text-muted small">Épisodes concernés</div>
                <div className="fs-5 fw-semibold">{summary.episodeCount}</div>
              </div>
            </div>

            {summary.departmentBreakdown.length > 0 && (
              <div className="table-responsive mb-3">
                <table className="table table-sm align-middle mb-0">
                  <thead className="bg-light-subtle">
                    <tr>
                      <th>Rayon</th>
                      <th>CA perdu</th>
                      <th>Qté perdue</th>
                      <th>Épisodes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.departmentBreakdown.slice(0, 8).map((d) => (
                      <tr key={d.department}>
                        <td>{d.department}</td>
                        <td>{d.caPerdue.toLocaleString('fr-FR')} CFA</td>
                        <td>{d.qtyPerdue}</td>
                        <td>{d.episodeCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {!analysis && (
              <button type="button" className="btn btn-sm btn-outline-primary" disabled={analyzing} onClick={runAnalysis}>
                <iconify-icon icon="solar:magic-stick-3-bold-duotone" className="align-middle me-1"></iconify-icon>
                {analyzing ? 'Analyse en cours...' : "Analyser avec l'IA"}
              </button>
            )}

            {analysisError && <div className="text-danger small mt-2">Erreur : {analysisError}</div>}

            {analysis && (
              <div>
                {/* Bloc 1 : verdict + niveau de sévérité */}
                <div
                  className="stockout-ai-block d-flex align-items-start gap-2"
                  style={{ background: LEVEL_META[analysis.level].bg, color: LEVEL_META[analysis.level].color }}
                >
                  <iconify-icon icon={LEVEL_META[analysis.level].icon} style={{ fontSize: '1.3rem', flexShrink: 0, marginTop: 1 }}></iconify-icon>
                  <div>
                    <div className="stockout-ai-block-title">{LEVEL_META[analysis.level].label}</div>
                    <div style={{ fontSize: '.9rem', lineHeight: 1.5 }}>{analysis.verdict}</div>
                  </div>
                </div>

                {/* Bloc 2 : rayons concernés */}
                {analysis.concernedDepartments.length > 0 && (
                  <div className="stockout-ai-block" style={{ background: '#f8fafb' }}>
                    <div className="stockout-ai-block-title" style={{ color: '#5B6B85' }}>Rayons concernés</div>
                    <div>
                      {analysis.concernedDepartments.map((d) => (
                        <span key={d} className="stockout-ai-dept-chip">{d}</span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Bloc 3 : recommandations actionnables */}
                {analysis.recommendations.length > 0 && (
                  <div className="stockout-ai-block" style={{ background: '#EEF0FB' }}>
                    <div className="stockout-ai-block-title" style={{ color: '#4A3FB8' }}>
                      <iconify-icon icon="solar:magic-stick-3-bold-duotone" className="align-middle me-1"></iconify-icon>
                      Recommandations
                    </div>
                    <ul style={{ fontSize: '.88rem', color: '#2A2F45' }}>
                      {analysis.recommendations.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
