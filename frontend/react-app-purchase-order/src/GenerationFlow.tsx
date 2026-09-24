import { useEffect, useRef, useState } from 'react';
import { apiFetch } from './api/client';

type GenStep = 'SALES' | 'PARETO' | 'QUANTITIES' | 'AI_ADJUSTMENT' | 'DONE';
type StepState = 'pending' | 'active' | 'done' | 'error';

interface GenStatus {
  status: 'RUNNING' | 'DONE' | 'ERROR';
  step: GenStep;
  articlesTotal?: number;
  articlesProcessed?: number;
  lastArticleLabel?: string;
  lastArticleEan?: string;
  aiUnavailable?: boolean;
  aiErrorMessage?: string;
  errorMessage?: string;
  proposal?: { lines: unknown[] };
}

interface PeriodPreview {
  start: string;
  end: string;
  referenceDate?: string;
  coverageWarning?: { message: string };
}

const STEP_ORDER: GenStep[] = ['SALES', 'PARETO', 'QUANTITIES', 'AI_ADJUSTMENT', 'DONE'];
const STEP_LABELS: Record<GenStep, string> = {
  SALES: 'Analyse des ventes du magasin',
  PARETO: 'Classement des articles prioritaires (Pareto)',
  QUANTITIES: 'Calcul des quantités à commander',
  AI_ADJUSTMENT: 'Analyse IA des quantités',
  DONE: 'Terminé',
};

const STEP_ICON: Record<StepState, string> = {
  pending: 'solar:clock-circle-bold-duotone',
  active: 'solar:refresh-bold-duotone',
  done: 'solar:check-circle-bold-duotone',
  error: 'solar:close-circle-bold-duotone',
};

function StepRow({ label, state }: { label: string; state: StepState }) {
  const colorClass = state === 'pending' ? 'text-muted' : state === 'active' ? 'text-primary' : state === 'done' ? 'text-success' : 'text-danger';
  return (
    <li className="list-group-item d-flex align-items-center gap-2">
      <span>
        <iconify-icon icon={STEP_ICON[state]} className={colorClass}></iconify-icon>
      </span>
      <span>{label}</span>
    </li>
  );
}

export function GenerationFlow({
  shopId,
  shopReference,
  shopName,
  shopQueryParam,
  hasPendingProposal,
  onDone,
}: {
  shopId: string;
  shopReference: string;
  shopName: string;
  shopQueryParam: string;
  hasPendingProposal: boolean;
  onDone: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [force, setForce] = useState(false);
  const [periodMode, setPeriodMode] = useState('');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [periodPreview, setPeriodPreview] = useState<PeriodPreview | null>(null);
  const [periodPreviewError, setPeriodPreviewError] = useState<string | null>(null);

  const [progressOpen, setProgressOpen] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [status, setStatus] = useState<GenStatus | null>(null);
  const [bannerVisible, setBannerVisible] = useState(false);
  const pollTokenRef = useRef(0);

  async function refreshPeriodPreview() {
    setPeriodPreviewError(null);
    if (periodMode === 'CUSTOM' && (!customStart || !customEnd)) {
      setPeriodPreview(null);
      return;
    }
    try {
      const params = new URLSearchParams(shopQueryParam);
      if (periodMode) params.set('periodMode', periodMode);
      if (periodMode === 'CUSTOM') {
        params.set('customStart', customStart);
        params.set('customEnd', customEnd);
      }
      const data = await apiFetch<PeriodPreview>(`/reassort/proposal/generate/preview-period?${params.toString()}`);
      setPeriodPreview(data);
    } catch (err) {
      setPeriodPreviewError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    if (confirmOpen) refreshPeriodPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmOpen, periodMode, customStart, customEnd]);

  function openConfirm(forceFlag: boolean) {
    setForce(forceFlag);
    setPeriodMode('');
    setCustomStart('');
    setCustomEnd('');
    setPeriodPreview(null);
    setConfirmOpen(true);
  }

  async function watchRun(id: string) {
    const token = ++pollTokenRef.current;
    setRunId(id);
    setBannerVisible(true);
    const POLL_INTERVAL_MS = 800;
    try {
      while (token === pollTokenRef.current) {
        const s = await apiFetch<GenStatus>(`/reassort/proposal/generate/${encodeURIComponent(id)}/status?${shopQueryParam}`);
        if (token !== pollTokenRef.current) return;
        setStatus(s);
        if (s.status === 'ERROR') throw new Error(s.errorMessage || 'Échec de la génération');
        if (s.status === 'DONE') {
          setBannerVisible(false);
          setRunId(null);
          await onDone();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    } catch (err) {
      if (token !== pollTokenRef.current) return;
      setStatus({ status: 'ERROR', step: 'SALES', errorMessage: err instanceof Error ? err.message : String(err) });
      setBannerVisible(false);
      setRunId(null);
    }
  }

  async function launchGeneration() {
    setConfirmOpen(false);
    setStatus(null);
    setProgressOpen(true);
    const periodOverride =
      periodMode === '' ? undefined : periodMode === 'CUSTOM' ? { periodMode: 'CUSTOM', customStart, customEnd } : { periodMode, customStart: null, customEnd: null };
    try {
      const data = await apiFetch<{ runId: string }>(`/reassort/proposal/generate?${shopQueryParam}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shopReference, shopName, periodOverride }),
      });
      watchRun(data.runId);
    } catch (err) {
      setStatus({ status: 'ERROR', step: 'SALES', errorMessage: err instanceof Error ? err.message : String(err) });
    }
  }

  useEffect(() => {
    if (!shopId) return;
    (async () => {
      try {
        const data = await apiFetch<{ runId: string } | null>(`/reassort/proposal/generate/active?${shopQueryParam}`);
        if (data?.runId) watchRun(data.runId);
      } catch {
        // silencieux : au pire l'utilisateur ne voit pas la bannière et devra relancer manuellement
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shopId]);

  function stepState(step: GenStep): StepState {
    if (!status) return step === 'SALES' ? 'active' : 'pending';
    if (step === 'AI_ADJUSTMENT' && status.step !== 'AI_ADJUSTMENT' && !status.step) return 'pending';
    const currentIdx = STEP_ORDER.indexOf(status.step);
    const idx = STEP_ORDER.indexOf(step);
    if (status.status === 'ERROR') {
      if (idx < currentIdx) return 'done';
      if (idx === currentIdx) return 'error';
      return 'pending';
    }
    if (idx < currentIdx || status.status === 'DONE') return 'done';
    if (idx === currentIdx) return 'active';
    return 'pending';
  }

  const showAiStep = status?.step === 'AI_ADJUSTMENT' || (status && STEP_ORDER.indexOf(status.step) > STEP_ORDER.indexOf('QUANTITIES'));

  function progressText(): string {
    if (!status) return 'Démarrage...';
    if (status.status === 'ERROR') return `Échec de la génération. ${status.errorMessage || 'Erreur inconnue'}`;
    if (status.status === 'DONE') {
      const lineCount = status.proposal?.lines?.length || 0;
      let text = `Génération terminée avec succès. ${lineCount ? lineCount + ' article(s) proposé(s).' : 'Aucun article à proposer pour le moment.'}`;
      if (status.aiUnavailable) {
        text += ` IA non disponible${status.aiErrorMessage ? ' (' + status.aiErrorMessage + ')' : ''} — quantités basées sur le calcul statistique classique uniquement.`;
      }
      return text;
    }
    if (status.step === 'SALES') return "Analyse des ventes du magasin (peut prendre jusqu'à 1-2 minutes si RPOS est sollicité)...";
    if (status.step === 'PARETO') return 'Classement des articles prioritaires (Pareto)...';
    if (status.step === 'QUANTITIES') {
      const total = status.articlesTotal || 0;
      const processed = status.articlesProcessed || 0;
      return `Calcul des quantités : ${processed} / ${total} article(s)${status.lastArticleLabel ? ' — dernier traité : ' + status.lastArticleLabel + ' (' + status.lastArticleEan + ')' : ''}.`;
    }
    if (status.step === 'AI_ADJUSTMENT') {
      const total = status.articlesTotal || 0;
      const processed = status.articlesProcessed || 0;
      if (status.aiUnavailable) {
        return `IA non disponible${status.aiErrorMessage ? ' (' + status.aiErrorMessage + ')' : ''}. Les quantités proposées restent basées sur le calcul statistique classique (ventes réelles), sans ajustement IA.`;
      }
      return `L'IA analyse et ajuste les quantités proposées : ${processed} / ${total} article(s).`;
    }
    return '';
  }

  function progressPct(): number {
    if (!status) return 0;
    if (status.status === 'DONE') return 100;
    if (status.step === 'SALES') return 10;
    if (status.step === 'PARETO') return 25;
    if (status.step === 'QUANTITIES') {
      const total = status.articlesTotal || 0;
      const processed = status.articlesProcessed || 0;
      return total > 0 ? Math.round(30 + (processed / total) * 45) : 30;
    }
    if (status.step === 'AI_ADJUSTMENT') {
      const total = status.articlesTotal || 0;
      const processed = status.articlesProcessed || 0;
      return total > 0 ? Math.round(75 + (processed / total) * 20) : 75;
    }
    return 0;
  }

  const barClass = status?.status === 'DONE' ? 'bg-success' : status?.status === 'ERROR' ? 'bg-danger' : 'bg-primary progress-bar-striped progress-bar-animated';

  return (
    <>
      <button className="btn btn-sm btn-outline-primary" disabled={!!runId} onClick={() => openConfirm(false)}>
        <iconify-icon icon="solar:refresh-circle-bold-duotone" className="align-middle"></iconify-icon> Générer une nouvelle proposition
      </button>
      <button className="btn btn-sm btn-outline-warning" disabled={!!runId} onClick={() => openConfirm(true)}>
        <iconify-icon icon="solar:refresh-circle-bold-duotone" className="align-middle"></iconify-icon> Forcer une nouvelle génération
      </button>

      {bannerVisible && (
        <div className="alert alert-info d-flex justify-content-between align-items-center mt-2 mb-0 small w-100">
          <span>
            <iconify-icon icon="solar:refresh-bold-duotone" className="me-1"></iconify-icon> Une génération de proposition est en cours pour ce magasin.
          </span>
          <button type="button" className="btn btn-sm btn-outline-dark" onClick={() => setProgressOpen(true)}>
            Voir la progression
          </button>
        </div>
      )}

      {confirmOpen && (
        <>
          <div className="modal fade show" style={{ display: 'block' }} tabIndex={-1} role="dialog">
            <div className="modal-dialog modal-dialog-centered" role="document">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title d-flex align-items-center gap-2">
                    <iconify-icon icon="solar:refresh-circle-bold-duotone" className="text-primary fs-24"></iconify-icon>
                    <span>{force ? 'Forcer une nouvelle génération' : 'Générer une nouvelle proposition'}</span>
                  </h5>
                  <button type="button" className="btn-close" onClick={() => setConfirmOpen(false)}></button>
                </div>
                <div className="modal-body">
                  {force && hasPendingProposal && (
                    <div className="alert alert-warning small mb-3">
                      Une proposition est déjà en attente pour ce magasin. La lancer maintenant va <strong>remplacer définitivement</strong> la
                      proposition actuelle par une nouvelle, recalculée avec la configuration à jour (ex : exclusion des articles génériques).
                    </div>
                  )}
                  <p className="mb-3">
                    Lancer une nouvelle analyse des ventes pour <strong>{shopReference && shopName ? `${shopReference} — ${shopName}` : 'ce magasin'}</strong> ?
                  </p>
                  <div className="mb-3">
                    <label className="form-label fw-semibold">Période d'analyse</label>
                    <select className="form-select" value={periodMode} onChange={(e) => setPeriodMode(e.target.value)}>
                      <option value="">Période configurée du magasin (par défaut)</option>
                      <option value="YESTERDAY">Hier seulement</option>
                      <option value="LAST_7_DAYS">7 derniers jours</option>
                      <option value="LAST_30_DAYS">30 derniers jours</option>
                      <option value="LAST_60_DAYS">2 mois</option>
                      <option value="LAST_90_DAYS">3 mois</option>
                      <option value="LAST_120_DAYS">4 mois</option>
                      <option value="LAST_180_DAYS">6 mois</option>
                      <option value="LAST_365_DAYS">1 an</option>
                      <option value="ALL_TIME">Toutes les données disponibles</option>
                      <option value="CUSTOM">Période personnalisée</option>
                    </select>
                    <div className="form-text">Ce choix ne s'applique qu'à cette génération, sans modifier la configuration permanente du magasin.</div>
                  </div>
                  {periodMode === 'CUSTOM' && (
                    <div className="row g-2 mb-3">
                      <div className="col-6">
                        <label className="form-label small">Date de début</label>
                        <input type="date" className="form-control form-control-sm" value={customStart} onChange={(e) => setCustomStart(e.target.value)} />
                      </div>
                      <div className="col-6">
                        <label className="form-label small">Date de fin</label>
                        <input type="date" className="form-control form-control-sm" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} />
                      </div>
                    </div>
                  )}
                  <div className="alert alert-info small mb-3">
                    {periodPreviewError
                      ? `Impossible de calculer la période à l'avance : ${periodPreviewError}`
                      : periodMode === 'CUSTOM' && (!customStart || !customEnd)
                        ? 'Choisissez une date de début et de fin pour voir la période exacte.'
                        : periodPreview
                          ? `Période qui sera analysée : du ${new Date(periodPreview.start).toLocaleDateString('fr-FR')} au ${new Date(periodPreview.end).toLocaleDateString('fr-FR')}${
                              periodPreview.referenceDate
                                ? ' (basée sur la dernière vente connue du magasin, le ' + new Date(periodPreview.referenceDate).toLocaleDateString('fr-FR') + ')'
                                : ''
                            }.`
                          : 'Calcul de la période...'}
                  </div>
                  {periodPreview?.coverageWarning && (
                    <div className="alert alert-warning small mb-3">
                      <strong>
                        <iconify-icon icon="solar:danger-triangle-bold-duotone"></iconify-icon> {periodPreview.coverageWarning.message}
                      </strong>
                    </div>
                  )}
                  <div className="alert alert-light border small mb-0">
                    Le système va analyser les ventes sur la période choisie, classer les articles prioritaires (Pareto) et calculer les
                    quantités à commander. Sur un magasin à fort volume de ventes, cette opération peut prendre de quelques secondes à plusieurs
                    minutes selon la période retenue.
                  </div>
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn btn-outline-secondary" onClick={() => setConfirmOpen(false)}>
                    Annuler
                  </button>
                  <button type="button" className="btn btn-primary" onClick={launchGeneration}>
                    Générer
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show"></div>
        </>
      )}

      {progressOpen && (
        <>
          <div className="modal fade show" style={{ display: 'block' }} tabIndex={-1} role="dialog">
            <div className="modal-dialog modal-dialog-centered" role="document">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">Génération de la proposition</h5>
                  <button type="button" className="btn-close" onClick={() => setProgressOpen(false)}></button>
                </div>
                <div className="modal-body">
                  <ul className="list-group list-group-flush mb-3">
                    <StepRow label={STEP_LABELS.SALES} state={stepState('SALES')} />
                    <StepRow label={STEP_LABELS.PARETO} state={stepState('PARETO')} />
                    <StepRow label={STEP_LABELS.QUANTITIES} state={stepState('QUANTITIES')} />
                    {showAiStep && <StepRow label={STEP_LABELS.AI_ADJUSTMENT} state={stepState('AI_ADJUSTMENT')} />}
                    <StepRow label={STEP_LABELS.DONE} state={stepState('DONE')} />
                  </ul>
                  <div className="progress mb-2" style={{ height: 10 }}>
                    <div className={`progress-bar ${barClass}`} style={{ width: `${progressPct()}%` }}></div>
                  </div>
                  <p className="text-muted small mb-0">{progressText()}</p>
                  {runId && (
                    <p className="text-muted small mb-0 mt-2 fst-italic">
                      Vous pouvez fermer cette fenêtre : la génération continue en arrière-plan, une bannière en haut de page vous permettra de
                      revenir suivre sa progression.
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show"></div>
        </>
      )}
    </>
  );
}
