import { useEffect, useState } from 'react';
import { apiFetch } from '../../shared/api/client';

interface Revision {
  id: string;
  revisionNumber: number;
  generatedAt: string;
  status: string;
  articleCount: number;
}

interface ArticleHistoryPoint {
  quantitySuggested: number;
  generatedAt: string | null;
}

interface ArticleHistory {
  ean: string;
  label: string | null;
  variation: number;
  history: ArticleHistoryPoint[];
}

interface WeeklyPlanHistory {
  targetWeekStart: string;
  targetWeekEnd: string;
  revisions: Revision[];
  articles: ArticleHistory[];
}

interface PredictionOutcome {
  ean: string;
  label: string | null;
  predictedWeeklyDemand: number;
  outcome: {
    actualSales: number;
    forecastError: number;
    percentageError: number | null;
  } | null;
}

function statusBadgeClass(status: string): string {
  if (status === 'VALIDATED') return 'success';
  if (status === 'PARTIALLY_VALIDATED') return 'info';
  if (status === 'REJECTED') return 'secondary';
  return 'warning';
}

export function WeeklyPlanHistoryModal({ weeklyPlanId, onClose }: { weeklyPlanId: string; onClose: () => void }) {
  const [history, setHistory] = useState<WeeklyPlanHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<PredictionOutcome[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHistory(null);
    setError(null);
    setOutcomes(null);
    (async () => {
      try {
        const data = await apiFetch<WeeklyPlanHistory>(`/reassort/weekly-plan/${weeklyPlanId}/history`);
        if (cancelled) return;
        setHistory(data);
        if (data.revisions.length) {
          const lastRevisionId = data.revisions[data.revisions.length - 1].id;
          try {
            const predData = await apiFetch<{ predictions: PredictionOutcome[] }>(`/reassort/predictions?proposalId=${lastRevisionId}`);
            if (cancelled) return;
            const evaluated = predData.predictions.filter((p) => p.outcome);
            evaluated.sort((a, b) => (b.outcome?.percentageError || 0) - (a.outcome?.percentageError || 0));
            setOutcomes(evaluated);
          } catch {
            // Silencieux : la fiabilité est une information secondaire, ne doit pas casser la modale.
          }
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [weeklyPlanId]);

  const weekLabel = history
    ? `${new Date(history.targetWeekStart).toLocaleDateString('fr-FR')} → ${new Date(new Date(history.targetWeekEnd).getTime() - 86400000).toLocaleDateString('fr-FR')}`
    : '';
  const articlesWithChange = history ? history.articles.filter((a) => a.variation !== 0) : [];

  // Tri croissant/décroissant ajouté le 25/10/2026 (audit complet des tableaux du site, demande
  // explicite : "les ajouté fait un audit de tout tab") — les 3 tableaux de cette modale n'avaient
  // aucun tri (ni Révisions, ni Évolution par article, ni Fiabilité des prédictions).
  type RevisionSortKey = 'revisionNumber' | 'generatedAt' | 'status' | 'articleCount';
  const [revisionSortKey, setRevisionSortKey] = useState<RevisionSortKey | null>(null);
  const [revisionSortDir, setRevisionSortDir] = useState<'asc' | 'desc'>('desc');
  function toggleRevisionSort(k: RevisionSortKey) {
    if (revisionSortKey === k) setRevisionSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setRevisionSortKey(k); setRevisionSortDir('desc'); }
  }
  function RevisionTh({ k, children, className }: { k: RevisionSortKey; children: React.ReactNode; className?: string }) {
    const active = revisionSortKey === k;
    return (
      <th className={className} role="button" style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleRevisionSort(k)}>
        {children} {active ? (revisionSortDir === 'desc' ? '▼' : '▲') : ''}
      </th>
    );
  }
  const sortedRevisions = (() => {
    if (!history || !revisionSortKey) return history?.revisions;
    const dir = revisionSortDir === 'desc' ? 1 : -1;
    const getValue = (r: Revision): number | string => {
      if (revisionSortKey === 'generatedAt') return new Date(r.generatedAt).getTime();
      if (revisionSortKey === 'status') return r.status;
      return r[revisionSortKey];
    };
    return [...history.revisions].sort((a, b) => {
      const av = getValue(a);
      const bv = getValue(b);
      if (typeof av === 'string' || typeof bv === 'string') return dir * String(bv).localeCompare(String(av), 'fr-FR');
      return dir * ((bv as number) - (av as number));
    });
  })();

  type ArticleSortKey = 'ean' | 'label' | 'variation';
  const [articleSortKey, setArticleSortKey] = useState<ArticleSortKey | null>(null);
  const [articleSortDir, setArticleSortDir] = useState<'asc' | 'desc'>('desc');
  function toggleArticleSort(k: ArticleSortKey) {
    if (articleSortKey === k) setArticleSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setArticleSortKey(k); setArticleSortDir('desc'); }
  }
  function ArticleTh({ k, children, className }: { k: ArticleSortKey; children: React.ReactNode; className?: string }) {
    const active = articleSortKey === k;
    return (
      <th className={className} role="button" style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleArticleSort(k)}>
        {children} {active ? (articleSortDir === 'desc' ? '▼' : '▲') : ''}
      </th>
    );
  }
  const sortedArticlesWithChange = (() => {
    if (!articleSortKey) return articlesWithChange;
    const dir = articleSortDir === 'desc' ? 1 : -1;
    const getValue = (a: ArticleHistory): number | string => {
      if (articleSortKey === 'ean') return a.ean;
      if (articleSortKey === 'label') return (a.label || '').toLowerCase();
      return a.variation;
    };
    return [...articlesWithChange].sort((a, b) => {
      const av = getValue(a);
      const bv = getValue(b);
      if (typeof av === 'string' || typeof bv === 'string') return dir * String(bv).localeCompare(String(av), 'fr-FR');
      return dir * ((bv as number) - (av as number));
    });
  })();

  type OutcomeSortKey = 'ean' | 'label' | 'predictedWeeklyDemand' | 'actualSales' | 'forecastError' | 'percentageError';
  const [outcomeSortKey, setOutcomeSortKey] = useState<OutcomeSortKey | null>(null);
  const [outcomeSortDir, setOutcomeSortDir] = useState<'asc' | 'desc'>('desc');
  function toggleOutcomeSort(k: OutcomeSortKey) {
    if (outcomeSortKey === k) setOutcomeSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setOutcomeSortKey(k); setOutcomeSortDir('desc'); }
  }
  function OutcomeTh({ k, children, className }: { k: OutcomeSortKey; children: React.ReactNode; className?: string }) {
    const active = outcomeSortKey === k;
    return (
      <th className={className} role="button" style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleOutcomeSort(k)}>
        {children} {active ? (outcomeSortDir === 'desc' ? '▼' : '▲') : ''}
      </th>
    );
  }
  const sortedOutcomes = (() => {
    if (!outcomes || !outcomeSortKey) return outcomes;
    const dir = outcomeSortDir === 'desc' ? 1 : -1;
    const getValue = (p: PredictionOutcome): number | string => {
      if (outcomeSortKey === 'ean') return p.ean;
      if (outcomeSortKey === 'label') return (p.label || '').toLowerCase();
      if (outcomeSortKey === 'predictedWeeklyDemand') return p.predictedWeeklyDemand;
      if (outcomeSortKey === 'actualSales') return p.outcome?.actualSales ?? -Infinity;
      if (outcomeSortKey === 'forecastError') return p.outcome?.forecastError ?? -Infinity;
      return p.outcome?.percentageError ?? -Infinity;
    };
    return [...outcomes].sort((a, b) => {
      const av = getValue(a);
      const bv = getValue(b);
      if (typeof av === 'string' || typeof bv === 'string') return dir * String(bv).localeCompare(String(av), 'fr-FR');
      return dir * ((bv as number) - (av as number));
    });
  })();

  return (
    <>
      <div className="modal fade show" style={{ display: 'block' }} tabIndex={-1} role="dialog">
        <div className="modal-dialog modal-dialog-centered modal-xl modal-dialog-scrollable" role="document">
          <div className="modal-content">
            <div className="modal-header">
              <h5 className="modal-title d-flex align-items-center gap-2">
                <iconify-icon icon="solar:history-bold-duotone" className="text-primary fs-24"></iconify-icon>
                <span>Historique de la semaine</span>
              </h5>
              <button type="button" className="btn-close" onClick={onClose}></button>
            </div>
            <div className="modal-body">
              {error && <div className="alert alert-danger">Erreur: {error}</div>}
              {!error && !history && <p className="text-muted text-center py-4">Chargement...</p>}
              {history && (
                <>
                  <h6 className="mb-2">Révisions — semaine du {weekLabel}</h6>
                  <div className="table-responsive mb-4">
                    <table className="table table-sm table-hover">
                      <thead>
                        <tr>
                          <RevisionTh k="revisionNumber">#</RevisionTh>
                          <RevisionTh k="generatedAt">Générée le</RevisionTh>
                          <RevisionTh k="status">Statut</RevisionTh>
                          <RevisionTh k="articleCount" className="text-end">Articles</RevisionTh>
                        </tr>
                      </thead>
                      <tbody>
                        {(sortedRevisions || []).map((r) => (
                          <tr key={r.id}>
                            <td>{r.revisionNumber}</td>
                            <td>{new Date(r.generatedAt).toLocaleString('fr-FR')}</td>
                            <td>
                              <span className={`badge bg-${statusBadgeClass(r.status)}-subtle text-${statusBadgeClass(r.status)}`}>{r.status}</span>
                            </td>
                            <td className="text-end">{r.articleCount}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {history.revisions.length < 2 ? (
                    <p className="text-muted">Une seule révision pour l'instant : pas encore d'évolution à comparer.</p>
                  ) : !articlesWithChange.length ? (
                    <p className="text-muted">Aucun changement de quantité entre les révisions.</p>
                  ) : (
                    <>
                      <h6 className="mb-2">Évolution par article (première → dernière révision)</h6>
                      <div className="table-responsive">
                        <table className="table table-sm table-hover">
                          <thead>
                            <tr>
                              <ArticleTh k="ean">EAN</ArticleTh>
                              <ArticleTh k="label">Article</ArticleTh>
                              <th className="text-end">Historique (qté — date/heure)</th>
                              <ArticleTh k="variation" className="text-end">Variation</ArticleTh>
                            </tr>
                          </thead>
                          <tbody>
                            {sortedArticlesWithChange.map((a) => (
                              <tr key={a.ean}>
                                <td>{a.ean}</td>
                                <td>{a.label || '—'}</td>
                                <td className="text-end">
                                  {a.history.map((pt, i) => (
                                    <span key={i}>
                                      <span className="d-inline-block text-center mx-1">
                                        <span className="fw-semibold">{pt.quantitySuggested}</span>
                                        <br />
                                        <span className="text-muted" style={{ fontSize: '.7rem' }}>
                                          {pt.generatedAt
                                            ? new Date(pt.generatedAt).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
                                            : '—'}
                                        </span>
                                      </span>
                                      {i < a.history.length - 1 && <span className="text-muted mx-1">→</span>}
                                    </span>
                                  ))}
                                </td>
                                <td className={`text-end fw-semibold text-${a.variation > 0 ? 'success' : 'danger'}`}>
                                  {a.variation > 0 ? '+' : ''}
                                  {a.variation}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}

                  {!!outcomes?.length && (
                    <div className="mt-4">
                      <h6 className="mb-2 d-flex align-items-center gap-1">
                        <iconify-icon icon="solar:chart-2-bold-duotone" className="text-primary"></iconify-icon>
                        Fiabilité des prédictions (semaine écoulée)
                      </h6>
                      <div className="alert alert-light border small mb-2">
                        Vente hebdomadaire prévue comparée aux ventes réellement observées sur cette même semaine, pour les articles dont la période
                        est terminée.
                      </div>
                      <div className="table-responsive">
                        <table className="table table-sm table-hover">
                          <thead>
                            <tr>
                              <OutcomeTh k="ean">EAN</OutcomeTh>
                              <OutcomeTh k="label">Article</OutcomeTh>
                              <OutcomeTh k="predictedWeeklyDemand" className="text-end">Prévu/sem.</OutcomeTh>
                              <OutcomeTh k="actualSales" className="text-end">Réel</OutcomeTh>
                              <OutcomeTh k="forecastError" className="text-end">Écart</OutcomeTh>
                              <OutcomeTh k="percentageError" className="text-end">Erreur %</OutcomeTh>
                            </tr>
                          </thead>
                          <tbody>
                            {(sortedOutcomes || []).map((p) => {
                              const o = p.outcome!;
                              const pct = o.percentageError === null ? '—' : Math.round(o.percentageError * 100) + '%';
                              const errSign = o.forecastError > 0 ? '+' : '';
                              return (
                                <tr key={p.ean}>
                                  <td>{p.ean}</td>
                                  <td>{p.label || '—'}</td>
                                  <td className="text-end">{Math.round(p.predictedWeeklyDemand)}</td>
                                  <td className="text-end">{o.actualSales}</td>
                                  <td className="text-end">
                                    {errSign}
                                    {Math.round(o.forecastError)}
                                  </td>
                                  <td className="text-end fw-semibold">{pct}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
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
