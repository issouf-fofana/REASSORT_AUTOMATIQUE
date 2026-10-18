import { useState } from 'react';
import { apiFetch } from '../../shared/api/client';

// Analyse des pertes de rupture sur une période personnalisée, comparée au CA réellement réalisé
// par le magasin (demande explicite du 18/10/2026 : "il faut me donne la possiblité de faire les
// filtre sur une periode personalisé pour voir sur quel periode les perte que j'ai eu pendant les
// rupture... vs mon CA du mag sur cette periode aussi voir est ce que la perte est trop ou pas et
// sil ya une sensibilisation a faire"). L'analyse IA est À LA DEMANDE (bouton "Analyser", jamais
// automatique) — confirmé explicitement par l'utilisateur, pour maîtriser le coût des appels IA.
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

type AnalysisResult = { analysis: string; providerUsed: string; summary: PeriodSummary };

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

  async function loadSummary() {
    if (!shopQueryParam) return;
    setLoadingSummary(true);
    setError(null);
    setAnalysis(null);
    setAnalysisError(null);
    try {
      const data = await apiFetch<PeriodSummary>(
        `/reassort/stockout-episodes/period-summary?start=${encodeURIComponent(new Date(startDate).toISOString())}&end=${encodeURIComponent(new Date(endDate + 'T23:59:59').toISOString())}&${shopQueryParam}`
      );
      setSummary(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingSummary(false);
    }
  }

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
    <div className="card mb-3">
      <style>{`
        .stockout-period-ratio.tone-danger { color: #8a221e; }
        .stockout-period-ratio.tone-warning { color: #7a4910; }
        .stockout-period-ratio.tone-success { color: #2d6a3f; }
        .stockout-period-ratio.tone-muted { color: #8591A0; }
        .stockout-ai-box { background: #f8fafb; border-left: 3px solid #4A3FB8; border-radius: 0 8px 8px 0; padding: 14px 16px; white-space: pre-line; font-size: .88rem; line-height: 1.6; }
      `}</style>
      <div className="card-body">
        <div className="d-flex align-items-center justify-content-between flex-wrap gap-2 mb-3">
          <h6 className="mb-0" style={{ color: '#1B2A4A', fontWeight: 700 }}>Analyse des pertes sur une période</h6>
        </div>

        <div className="d-flex align-items-end gap-2 flex-wrap mb-3">
          <div>
            <label className="form-label small mb-1">Du</label>
            <input type="date" className="form-control form-control-sm" value={startDate} max={endDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
          <div>
            <label className="form-label small mb-1">Au</label>
            <input type="date" className="form-control form-control-sm" value={endDate} min={startDate} max={formatIsoDate(new Date())} onChange={(e) => setEndDate(e.target.value)} />
          </div>
          <button type="button" className="btn btn-sm btn-primary" disabled={loadingSummary} onClick={loadSummary}>
            {loadingSummary ? 'Calcul...' : 'Voir la synthèse'}
          </button>
        </div>

        {error && <div className="text-danger small mb-2">Erreur : {error}</div>}

        {summary && (
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

            <button type="button" className="btn btn-sm btn-outline-primary" disabled={analyzing} onClick={runAnalysis}>
              <iconify-icon icon="solar:magic-stick-3-bold-duotone" className="align-middle me-1"></iconify-icon>
              {analyzing ? 'Analyse en cours...' : 'Analyser avec l\'IA'}
            </button>

            {analysisError && <div className="text-danger small mt-2">Erreur : {analysisError}</div>}

            {analysis && (
              <div className="stockout-ai-box mt-3">
                {analysis.analysis}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
