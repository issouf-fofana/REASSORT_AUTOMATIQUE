import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../../shared/api/client';
import { consumeSseStream } from '../../shared/lib/sseStream';
import { FormulaInfoButton } from './StockoutEpisodePage';

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

type AnalysisDepartment = { department: string; caPerdue: number; qtyPerdue: number; episodeCount: number; pctOfTotal: number; prevention: string };

type AnalysisResult = {
  level: 'faible' | 'modere' | 'eleve';
  verdict: string;
  departments: AnalysisDepartment[];
  recommendations: string[];
  providerUsed: string;
};

const LEVEL_META: Record<AnalysisResult['level'], { label: string; color: string; bg: string; icon: string }> = {
  eleve: { label: 'Perte élevée', color: '#8a221e', bg: '#f9ecea', icon: 'solar:danger-triangle-bold-duotone' },
  modere: { label: 'Perte modérée', color: '#7a4910', bg: '#fdf1dd', icon: 'solar:shield-warning-bold-duotone' },
  faible: { label: 'Perte faible', color: '#2d6a3f', bg: '#e9f3ec', icon: 'solar:shield-check-bold-duotone' },
};

// Dates pilotées par le parent (StockoutShopDetail) via un seul sélecteur en haut de page (demande
// explicite du 18/10/2026 : "le filtre doit etre pour tout a emme temps tu vois ne donne pas un
// filtre par detaut qui n'est pas modifialbe") — plus de sélecteur propre à ce composant, qui
// dupliquait un second système de dates distinct de celui du graphe de tendance.
type DeptSortKey = 'department' | 'caPerdue' | 'qtyPerdue' | 'episodeCount';

export function StockoutPeriodAnalysis({ shopQueryParam, startDate, endDate }: { shopQueryParam: string; startDate: string; endDate: string }) {
  const [summary, setSummary] = useState<PeriodSummary | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  // Texte BRUT (JSON encore incomplet, pas parsable) accumulé au fil du flux SSE (demande explicite
  // du 22/10/2026 : "l'analyse IA dure trop ici" — bouton figé 30s à 1min sans retour visuel).
  // Affiché tel quel pendant analyzing, puis remplacé par le rendu structuré dès que l'événement
  // "done" arrive avec le résultat déjà parsé/fusionné côté serveur.
  const [streamedText, setStreamedText] = useState('');
  // Tri croissant/décroissant (demande explicite du 21/10/2026 : "sur tout les tableau il faut
  // ajouter la possibilité de filtrer par croissant ou decroissant") — ce tableau n'avait aucun tri.
  const [deptSortKey, setDeptSortKey] = useState<DeptSortKey>('caPerdue');
  const [deptSortDir, setDeptSortDir] = useState<'asc' | 'desc'>('desc');

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

  // Chargement automatique à l'arrivée sur la page, à chaque changement de magasin, ET à chaque
  // changement de la période choisie dans le sélecteur unique du parent (demande explicite :
  // affichage par défaut, sans action préalable de l'utilisateur).
  useEffect(() => {
    if (!shopQueryParam) return;
    loadSummary(startDate, endDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shopQueryParam, startDate, endDate]);

  async function runAnalysis() {
    if (!shopQueryParam) return;
    setAnalyzing(true);
    setAnalysisError(null);
    setStreamedText('');
    try {
      const res = await window.reassortFetch(`/reassort/stockout-episodes/period-analysis-stream?${shopQueryParam}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start: new Date(startDate).toISOString(),
          end: new Date(endDate + 'T23:59:59').toISOString(),
        }),
      });
      if (!res.ok) throw new Error(`Erreur serveur (${res.status})`);

      let done: AnalysisResult | null = null;
      let streamError: string | null = null;
      let accumulated = '';
      // streamError plutôt qu'un throw direct dans le callback (BUG évité le 22/10/2026, trouvé en
      // relisant consumeSseStream : son try/catch interne n'attrape QUE un JSON.parse invalide,
      // "événement mal formé ignoré" — une exception levée PAR onEvent lui-même y serait avalée
      // silencieusement de la même façon, laissant runAnalysis croire que le flux s'est juste
      // terminé sans "done", avec un message d'erreur générique au lieu du vrai message serveur,
      // ex: "Aucune clé API IA configurée").
      await consumeSseStream(res, (eventName, data) => {
        if (eventName === 'chunk') {
          accumulated += data.text;
          setStreamedText(accumulated);
        } else if (eventName === 'error') {
          streamError = data.message;
        } else if (eventName === 'done') {
          done = data;
        }
      });
      if (streamError) throw new Error(streamError);
      if (!done) throw new Error('Flux terminé sans réponse exploitable.');
      setAnalysis(done);
    } catch (err) {
      setAnalysisError(err instanceof Error ? err.message : String(err));
    } finally {
      setAnalyzing(false);
    }
  }

  const ratioTone = summary?.lossRatioPct === null ? 'muted' : summary && summary.lossRatioPct! >= 5 ? 'danger' : summary && summary.lossRatioPct! >= 2 ? 'warning' : 'success';

  const sortedDepartmentBreakdown = useMemo(() => {
    const list = summary?.departmentBreakdown || [];
    const dir = deptSortDir === 'desc' ? 1 : -1;
    return [...list].sort((a, b) => {
      if (deptSortKey === 'department') return dir * b.department.localeCompare(a.department, 'fr-FR');
      return dir * (b[deptSortKey] - a[deptSortKey]);
    });
  }, [summary, deptSortKey, deptSortDir]);

  function toggleDeptSort(k: DeptSortKey) {
    if (deptSortKey === k) setDeptSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setDeptSortKey(k); setDeptSortDir('desc'); }
  }

  function deptSortIcon(k: DeptSortKey) {
    if (deptSortKey !== k) return null;
    return <iconify-icon icon={deptSortDir === 'desc' ? 'solar:alt-arrow-down-linear' : 'solar:alt-arrow-up-linear'} style={{ fontSize: '11px', marginLeft: 4 }}></iconify-icon>;
  }

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
        .stockout-ai-dept-card { background: #fff; border: 1px solid rgba(27,42,74,.1); border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; }
        .stockout-ai-dept-card:last-child { margin-bottom: 0; }
        .stockout-ai-dept-prevention { font-size: .82rem; color: #2A2F45; margin-top: 4px; display: flex; gap: 6px; align-items: flex-start; }
      `}</style>
      <div className="card-body">
        <div className="d-flex align-items-center justify-content-between flex-wrap gap-2 mb-3">
          <h6 className="mb-0 d-flex align-items-center gap-2" style={{ color: '#1B2A4A', fontWeight: 700 }}>
            <iconify-icon icon="solar:chart-square-bold-duotone" style={{ color: '#F5A623', fontSize: '1.2rem' }}></iconify-icon>
            Analyse des pertes sur une période
          </h6>
        </div>

        {error && <div className="text-danger small mb-2">Erreur : {error}</div>}

        {loadingSummary && !summary ? (
          <div className="text-muted small">Calcul en cours...</div>
        ) : summary && (
          <>
            <div className="row g-3 mb-3">
              <div className="col-6 col-md-3">
                <div className="text-muted small">
                  CA perdu (rupture)
                  <FormulaInfoButton
                    title="Comment le CA perdu sur la période est calculé"
                    steps={[
                      {
                        label: 'Pour chaque rupture qui chevauche la période',
                        detail: "Seule la portion de la rupture qui tombe DANS la période choisie est comptée — une rupture ouverte depuis des mois n'est comptée que pour les jours qui chevauchent le filtre, jamais pour sa durée totale.",
                      },
                      {
                        label: 'Demande attendue, jour par jour',
                        detail: "Pour chaque jour de cette portion, on calcule la vente moyenne de CE jour de semaine précis sur l'historique comparable, puis on additionne ces moyennes journalières (jamais une seule moyenne étendue à toute la durée).",
                      },
                      {
                        label: 'Perte de la rupture = demande attendue − ventes réelles',
                        detail: 'On soustrait les ventes réellement réalisées sur cette même portion de période. Le total affiché est la somme des pertes de toutes les ruptures chevauchant la période.',
                      },
                    ]}
                    note="Recalculé précisément pour la période choisie à chaque changement de filtre — jamais une approximation figée sur la durée totale des ruptures."
                  />
                </div>
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
                <div className="text-muted small">
                  Ruptures d'article
                  <FormulaInfoButton
                    title="Ruptures d'article sur la période"
                    steps={[
                      { label: 'Calcul', detail: "Nombre d'articles distincts ayant eu une rupture active à un moment de la période — même principe que \"Articles touchés (période)\" plus haut sur la page." },
                      { label: 'Léger écart possible', detail: 'Les deux chiffres sont calculés par deux requêtes séparées, à quelques instants d\'intervalle : si une rupture se résout pile entre les deux, un petit écart (quelques unités) peut apparaître — rien d\'anormal, pas de recalcul nécessaire.' },
                    ]}
                  />
                </div>
                <div className="fs-5 fw-semibold">{summary.episodeCount}</div>
              </div>
            </div>

            {summary.departmentBreakdown.length > 0 && (
              <div className="table-responsive mb-1">
                <table className="table table-sm align-middle mb-0">
                  <thead className="bg-light-subtle">
                    <tr>
                      <th className="osr-sortable-th" style={{ cursor: 'pointer' }} onClick={() => toggleDeptSort('department')}>Rayon{deptSortIcon('department')}</th>
                      <th className="osr-sortable-th" style={{ cursor: 'pointer' }} onClick={() => toggleDeptSort('caPerdue')}>CA perdu{deptSortIcon('caPerdue')}</th>
                      <th className="osr-sortable-th" style={{ cursor: 'pointer' }} onClick={() => toggleDeptSort('qtyPerdue')}>Qté perdue{deptSortIcon('qtyPerdue')}</th>
                      <th className="osr-sortable-th" style={{ cursor: 'pointer' }} onClick={() => toggleDeptSort('episodeCount')}>Ruptures d'article{deptSortIcon('episodeCount')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedDepartmentBreakdown.slice(0, 8).map((d) => (
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
            {summary.departmentBreakdown.length > 0 && (
              <div className="text-muted mb-3" style={{ fontSize: '.76rem' }}>
                <iconify-icon icon="solar:info-circle-linear" className="align-middle me-1"></iconify-icon>
                Une « rupture d'article » = une période continue où un article a manqué en rayon. Un même article qui tombe en rupture plusieurs fois dans la période compte autant de fois.
              </div>
            )}

            {!analysis && (
              <button type="button" className="btn btn-sm btn-outline-primary" disabled={analyzing} onClick={runAnalysis}>
                <iconify-icon icon="solar:magic-stick-3-bold-duotone" className="align-middle me-1"></iconify-icon>
                {analyzing ? 'Analyse en cours...' : "Analyser avec l'IA"}
              </button>
            )}

            {analysisError && <div className="text-danger small mt-2">Erreur : {analysisError}</div>}

            {analyzing && (
              <div className="stockout-ai-block" style={{ background: '#f8fafb' }}>
                <div className="stockout-ai-block-title" style={{ color: '#5B6B85' }}>
                  <iconify-icon icon="solar:magic-stick-3-bold-duotone" className="align-middle me-1"></iconify-icon>
                  L'IA rédige son analyse...
                </div>
                {/* Texte brut (JSON en cours de génération, pas encore parsable) affiché tel quel —
                    préférable à un bouton figé sans aucun retour, même si le format n'est pas encore
                    celui des cartes finales (remplacées dès l'arrivée du résultat structuré). */}
                <div style={{ fontSize: '.8rem', color: '#8591A0', fontFamily: 'monospace', whiteSpace: 'pre-wrap', maxHeight: 160, overflowY: 'auto' }}>
                  {streamedText || '…'}
                </div>
              </div>
            )}

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

                {/* Bloc 2 : rayons concernés — %, montant estimé et conseil de prévention par rayon
                    (demande explicite du 18/10/2026 : "il doit montré les pourcentage, et montant
                    exitimé... et comment prevenir ce genre de perte"). */}
                {analysis.departments.length > 0 && (
                  <div className="stockout-ai-block" style={{ background: '#f8fafb' }}>
                    <div className="stockout-ai-block-title" style={{ color: '#5B6B85' }}>Rayons concernés</div>
                    {analysis.departments.map((d) => (
                      <div key={d.department} className="stockout-ai-dept-card">
                        <div className="d-flex align-items-baseline justify-content-between flex-wrap gap-2">
                          <strong style={{ color: '#1B2A4A', fontSize: '.88rem' }}>{d.department}</strong>
                          <span className="text-muted small">
                            {d.caPerdue.toLocaleString('fr-FR')} CFA ({d.pctOfTotal} % du total) · {d.qtyPerdue} unité(s) perdue(s) · {d.episodeCount} rupture(s) d'article
                          </span>
                        </div>
                        {d.prevention && (
                          <div className="stockout-ai-dept-prevention">
                            <iconify-icon icon="solar:shield-plus-bold-duotone" style={{ color: '#2d6a3f', flexShrink: 0, marginTop: 1 }}></iconify-icon>
                            <span>{d.prevention}</span>
                          </div>
                        )}
                      </div>
                    ))}
                    {/* Légende explicative (demande explicite du 18/10/2026 : "epidode c'est quoi
                        fait plus explicative") — "épisode"/"rupture" n'est pas évident sans contexte :
                        un article en rupture 3 fois dans le mois compte pour 3, pas 1. */}
                    <div className="text-muted" style={{ fontSize: '.76rem', marginTop: 8, paddingTop: 8, borderTop: '1px dashed rgba(27,42,74,.12)' }}>
                      <iconify-icon icon="solar:info-circle-linear" className="align-middle me-1"></iconify-icon>
                      Une « rupture d'article » correspond à une période continue où UN article donné a été en rupture de stock. Un même article qui tombe en rupture 3 fois dans le mois compte pour 3 ruptures, pas 1.
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
