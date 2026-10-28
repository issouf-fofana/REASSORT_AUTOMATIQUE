import { useRef, useState } from 'react';
import { apiFetch } from '../../shared/api/client';

interface Decision {
  lineId: string;
  quantity: number;
  excluded: boolean;
  price: number;
  ean?: string;
}

interface SupplierOrderResult {
  supplierId: string | null;
  supplierName: string | null;
  deliveryType: 'LC' | 'LD' | null;
  department: string;
  order: { id: string; reference: string | null } | null;
  processed: number;
  failed: number;
  failedLines: { ean: string; label: string | null; reason: string }[];
  anyFailedGroup: boolean;
  allDepartmentsDone: boolean;
  totalRequested: number;
}

interface ValidateRunStatus {
  status: 'RUNNING' | 'DONE' | 'ERROR';
  step: string;
  articlesTotal: number;
  articlesProcessed: number;
  lastArticleLabel: string | null;
  errorMessage: string | null;
  validateDepartmentResult: SupplierOrderResult | null;
}

type StepState = 'pending' | 'active' | 'done' | 'error';

const STEP_ICON: Record<StepState, string> = {
  pending: 'solar:clock-circle-bold-duotone',
  active: 'solar:refresh-bold-duotone',
  done: 'solar:check-circle-bold-duotone',
  error: 'solar:close-circle-bold-duotone',
};

// Même composant/animation que ValidationFlow.tsx (StepRow) — dupliqué ici plutôt qu'exporté de
// l'autre fichier pour garder les deux composants indépendants (ValidationFlow n'exporte rien
// d'autre que son propre composant principal aujourd'hui).
function StepRow({ label, state }: { label: string; state: StepState }) {
  const colorClass = state === 'pending' ? 'text-muted' : state === 'active' ? 'text-primary' : state === 'done' ? 'text-success' : 'text-danger';
  const animClass = state === 'active' ? 'reassort-step-spin' : state === 'done' || state === 'error' ? 'reassort-step-pop' : '';
  return (
    <li className={`list-group-item d-flex align-items-center gap-2 ${state === 'active' ? 'bg-light' : ''}`}>
      <span style={{ fontSize: '1.2rem', lineHeight: 1 }}>
        <iconify-icon key={state} icon={STEP_ICON[state]} className={`${colorClass} ${animClass}`}></iconify-icon>
      </span>
      <span className={state === 'active' ? 'fw-semibold' : ''}>{label}</span>
    </li>
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Bouton "Valider toutes les propositions" à la racine d'un fournisseur (mission "Séparation CC/CD
 * et gestion par fournisseur", 28/10/2026, §7) — crée UNE SEULE commande RPOS regroupant tous les
 * articles éligibles de ce fournisseur, tous rayons confondus (via POST /validate-supplier), à la
 * différence de ValidationFlow.tsx qui ne valide qu'un seul rayon à la fois. Modale de confirmation
 * ET modale de progression alignées sur ValidationFlow.tsx (demande explicite du 28/10/2026 : "il
 * doit etre pareil que ca... pas different" puis "quand je clique sur cree il m'affiche pas la vue
 * de progression") — même étapes animées (StepRow), même barre de progression, seulement sans les
 * étapes "Récupération des articles"/"Classement par fournisseur" (propres au scope d'un RAYON,
 * déjà résolues côté backend ici sans étape distincte à montrer puisqu'un seul fournisseur est
 * ciblé dès le départ). Réutilise le même pattern de polling asynchrone (POST → runId →
 * GET /proposal/generate/:runId/status), déjà éprouvé en production pour /validate-department.
 */
export function SupplierValidationFlow({
  proposalId,
  decisionsProvider,
  supplierId,
  supplierName,
  deliveryType,
  shopName,
  shopQueryParam,
  onValidated,
}: {
  proposalId: string;
  // Toutes les décisions (quantité/exclusion) des lignes DE CE FOURNISSEUR, tous rayons confondus —
  // le backend filtre lui-même par resolvedSupplierId, ce provider ne doit donc fournir QUE les
  // décisions pertinentes pour ce fournisseur (cf. appelant dans PurchaseOrder.tsx).
  decisionsProvider: () => Decision[];
  supplierId: string;
  supplierName: string | null;
  deliveryType: 'LC' | 'LD' | null;
  shopName: string;
  shopQueryParam: string;
  onValidated: () => void;
}) {
  const [confirmData, setConfirmData] = useState<{ decisions: Decision[]; count: number; total: number } | null>(null);
  const [reference, setReference] = useState('Proposition réassort');
  const [comment, setComment] = useState('');
  const [orderDate, setOrderDate] = useState(() => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
  });
  const [deliveryDate, setDeliveryDate] = useState(() => {
    const tomorrow = new Date(Date.now() + 86400000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`;
  });

  const [progressOpen, setProgressOpen] = useState(false);
  const [progressMinimized, setProgressMinimized] = useState(false);
  const [sending, setSending] = useState(false);
  const [createStepState, setCreateStepState] = useState<StepState>('pending');
  const [sendStepState, setSendStepState] = useState<StepState>('pending');
  const [validateStepState, setValidateStepState] = useState<StepState>('pending');
  const [pdfStepState, setPdfStepState] = useState<StepState>('pending');
  const [mailStepState, setMailStepState] = useState<StepState>('pending');
  const [mailSentStepState, setMailSentStepState] = useState<StepState>('pending');
  const [doneStepState, setDoneStepState] = useState<StepState>('pending');
  const [showValidateStep, setShowValidateStep] = useState(false);
  const [progressPct, setProgressPct] = useState(0);
  const [progressText, setProgressText] = useState('En attente...');
  const [progressBarClass, setProgressBarClass] = useState('');
  const [canClose, setCanClose] = useState(false);
  const [resultHtml, setResultHtml] = useState<{ variant: string; body: string } | null>(null);
  const cancelledRef = useRef(false);
  const shouldReloadOnCloseRef = useRef(false);

  function openConfirm() {
    const decisions = decisionsProvider();
    const selected = decisions.filter((d) => !d.excluded);
    if (selected.length === 0) {
      setResultHtml({ variant: 'warning', body: 'Aucun article sélectionné pour ce fournisseur.' });
      return;
    }
    setResultHtml(null);
    const total = selected.reduce((sum, d) => sum + d.price * d.quantity, 0);
    setConfirmData({ decisions, count: selected.length, total });
  }

  function resetSteps(validateAfterCreate: boolean) {
    setCreateStepState('active');
    setSendStepState('pending');
    setShowValidateStep(validateAfterCreate);
    setValidateStepState('pending');
    setPdfStepState('pending');
    setMailStepState('pending');
    setMailSentStepState('pending');
    setDoneStepState('pending');
    setProgressPct(0);
    setProgressBarClass('');
    setProgressText('Création de la commande sur RPOS...');
    setCanClose(false);
    setResultHtml(null);
  }

  function handleCloseProgress() {
    setProgressOpen(false);
    setProgressMinimized(false);
    if (shouldReloadOnCloseRef.current) {
      shouldReloadOnCloseRef.current = false;
      onValidated();
    }
  }

  function handleBackdropClick() {
    if (sending) {
      setProgressMinimized(true);
      return;
    }
    handleCloseProgress();
  }

  async function submit(validateAfterCreate: boolean) {
    if (!confirmData) return;
    const { decisions } = confirmData;
    setConfirmData(null);
    setSending(true);
    resetSteps(validateAfterCreate);
    setProgressOpen(true);
    setProgressMinimized(false);
    cancelledRef.current = false;

    try {
      const { runId } = await apiFetch<{ runId: string }>(`/reassort/proposal/${proposalId}/validate-supplier?${shopQueryParam}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplierId, deliveryType, orderDate, deliveryDate,
          externalReference: reference, comment, decisions, validateAfterCreate,
        }),
      });

      setSendStepState('active');
      setProgressText(`Envoi des articles de ${supplierName}...`);

      const POLL_INTERVAL_MS = 700;
      let data: SupplierOrderResult | null = null;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (cancelledRef.current) return;
        const s = await apiFetch<ValidateRunStatus>(`/reassort/proposal/generate/${encodeURIComponent(runId)}/status?${shopQueryParam}`);
        if (s.step === 'CREATE_ORDER' && s.articlesTotal > 0) {
          setProgressPct(s.articlesTotal ? Math.round((s.articlesProcessed / s.articlesTotal) * 60) : 0);
          setProgressText(
            s.articlesProcessed >= s.articlesTotal
              ? 'Commande créée sur RPOS, envoi des articles...'
              : `Envoi en cours : ${s.lastArticleLabel || '...'}...`,
          );
        } else if (s.step === 'SEND_EMAIL') {
          setCreateStepState('done');
          setSendStepState('done');
          if (validateAfterCreate) setValidateStepState('done');
          setProgressPct(70);
          setProgressText("Envoi de l'email récapitulatif...");
        }
        if (s.status === 'ERROR') throw new Error(s.errorMessage || 'Échec de la validation');
        if (s.status === 'DONE') {
          data = s.validateDepartmentResult;
          break;
        }
        await sleep(POLL_INTERVAL_MS);
      }
      if (!data) throw new Error('Réponse de validation vide');

      setCreateStepState('done');
      setSendStepState('done');
      if (validateAfterCreate) setValidateStepState(data.order ? 'done' : 'error');

      const anyOrderCreated = !!data.order?.reference;
      if (anyOrderCreated) {
        setPdfStepState('active');
        setProgressText('Préparation du bon de commande (PDF)...');
        await sleep(400);
        setPdfStepState('done');

        setMailStepState('active');
        setProgressText("Envoi de l'email récapitulatif...");
        await sleep(400);
        setMailStepState('done');

        setMailSentStepState('active');
        await sleep(300);
        setMailSentStepState('done');
      } else {
        setPdfStepState('error');
        setMailStepState('error');
        setMailSentStepState('error');
      }

      setDoneStepState('done');
      setProgressPct(100);
      setProgressBarClass('bg-success');
      setCanClose(true);

      const hasPartialFailure = anyOrderCreated && data.failed > 0;
      const variant = !anyOrderCreated ? 'danger' : hasPartialFailure ? 'warning' : 'success';
      const failedList = data.failedLines.length
        ? `<ul class="mb-0 mt-2 small">${data.failedLines.map((f) => `<li>${f.label || f.ean} — ${f.reason}</li>`).join('')}</ul>`
        : '';
      const body = anyOrderCreated
        ? `Commande <strong>${data.order?.reference}</strong> créée sur RPOS pour <strong>${supplierName}</strong> — ${data.processed - data.failed} article(s) envoyé(s) sur ${data.totalRequested} proposé(s)${data.failed ? `, ${data.failed} échec(s)` : ''}.${failedList}`
        : `<strong>Échec de création de la commande</strong> pour ${supplierName} — aucun numéro de commande généré.${failedList}`;

      setResultHtml({ variant, body });
      setProgressText(`Commande ${supplierName} traitée.`);
      setSending(false);
      shouldReloadOnCloseRef.current = true;
    } catch (err) {
      setCreateStepState('error');
      setProgressBarClass('bg-danger');
      setProgressText(`Erreur: ${err instanceof Error ? err.message : String(err)}`);
      setCanClose(true);
      setSending(false);
      setResultHtml({ variant: 'danger', body: `Erreur : ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  return (
    <>
      <style>{`
        @keyframes reassort-step-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .reassort-step-spin { display: inline-block; animation: reassort-step-spin 1s linear infinite; }
        @keyframes reassort-step-pop { 0% { transform: scale(0.4); opacity: 0; } 60% { transform: scale(1.15); opacity: 1; } 100% { transform: scale(1); } }
        .reassort-step-pop { display: inline-block; animation: reassort-step-pop 0.35s ease-out; }
      `}</style>

      <button type="button" className="btn btn-sm btn-primary" disabled={sending} onClick={openConfirm}>
        {sending ? (
          <>
            <span className="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true"></span>
            Validation en cours...
          </>
        ) : (
          <>
            <iconify-icon icon="solar:check-circle-bold-duotone" className="align-middle"></iconify-icon>{' '}
            Valider toutes les propositions
          </>
        )}
      </button>

      {progressOpen && progressMinimized && (
        <button
          type="button"
          className="btn btn-sm btn-outline-primary position-fixed"
          style={{ bottom: 20, right: 20, zIndex: 1060 }}
          onClick={() => setProgressMinimized(false)}
        >
          <iconify-icon icon="solar:cart-check-bold-duotone"></iconify-icon> Envoi en cours — {supplierName} ({progressPct}%)
        </button>
      )}

      {confirmData && (
        <>
          <div className="modal fade show" style={{ display: 'block' }} tabIndex={-1} role="dialog">
            <div className="modal-dialog modal-dialog-centered modal-lg" role="document">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title d-flex align-items-center gap-2">
                    <iconify-icon icon="solar:cart-check-bold-duotone" className="text-primary fs-24"></iconify-icon>
                    Confirmer l'envoi à RPOS
                  </h5>
                  <button type="button" className="btn-close" onClick={() => setConfirmData(null)}></button>
                </div>
                <div className="modal-body">
                  <div className="mb-3">
                    <div className="fw-semibold">Commande à envoyer</div>
                    <div className="mb-2">
                      <label className="form-label small">Référence</label>
                      <input type="text" className="form-control form-control-sm" value={reference} onChange={(e) => setReference(e.target.value)} />
                    </div>
                    <div className="mb-2">
                      <label className="form-label small">Commentaire</label>
                      <input type="text" className="form-control form-control-sm" value={comment} onChange={(e) => setComment(e.target.value)} />
                    </div>
                    <div className="row g-2">
                      <div className="col-6">
                        <label className="form-label small">Date commande</label>
                        <input type="datetime-local" className="form-control form-control-sm" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
                      </div>
                      <div className="col-6">
                        <label className="form-label small">Date livraison</label>
                        <input type="date" className="form-control form-control-sm" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} />
                      </div>
                    </div>
                    <div className="text-muted small mt-1">
                      "{reference}" — magasin <strong>{shopName || 'votre magasin'}</strong>
                    </div>
                  </div>
                  <div className="mb-3">
                    <div className="fw-semibold">
                      {confirmData.count} article(s) sélectionné(s)
                    </div>
                    <div className="text-muted small">Total : <strong>{confirmData.total.toLocaleString('fr-FR')} CFA</strong></div>
                    <div className="alert alert-info small mt-2 mb-0">
                      <iconify-icon icon="solar:info-circle-bold-duotone"></iconify-icon> Seul le fournisseur{' '}
                      <strong>{supplierName}</strong> ({deliveryType === 'LC' ? 'Livraison Centrale' : 'Livraison Directe'}) sera
                      validé — une seule commande RPOS regroupant tous ses articles éligibles ({confirmData.count} article(s)),
                      quel que soit leur rayon d'origine. Les autres fournisseurs de cette proposition restent modifiables et
                      pourront être validés séparément.
                    </div>
                  </div>
                  <div>
                    <div className="fw-semibold">Choisir le niveau d'envoi</div>
                    <div className="text-muted small">
                      <strong>Créer uniquement</strong> : commande laissée "en préparation" sur RPOS, non prise en compte par l'entrepôt (phase de
                      test, encore supprimable).
                      <br />
                      <strong>Créer et valider</strong> : la commande est en plus transmise à l'entrepôt.
                    </div>
                  </div>
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn btn-outline-secondary" onClick={() => setConfirmData(null)}>
                    Annuler
                  </button>
                  <button type="button" className="btn btn-outline-primary" onClick={() => submit(false)}>
                    Créer sur RPOS
                  </button>
                  <button type="button" className="btn btn-success" onClick={() => submit(true)}>
                    Créer et valider sur RPOS
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show"></div>
        </>
      )}

      {progressOpen && !progressMinimized && (
        <>
          <div
            className="modal fade show"
            style={{ display: 'block' }}
            tabIndex={-1}
            role="dialog"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget && resultHtml?.variant !== 'warning') handleBackdropClick();
            }}
          >
            <div className="modal-dialog modal-dialog-centered" role="document" onMouseDown={(e) => e.stopPropagation()}>
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">Envoi de la commande à RPOS — {supplierName}</h5>
                  <div className="d-flex align-items-center gap-2">
                    {sending && (
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-secondary"
                        onClick={() => setProgressMinimized(true)}
                        title="Continuer en arrière-plan"
                      >
                        <iconify-icon icon="solar:minimize-square-bold-duotone"></iconify-icon> Réduire
                      </button>
                    )}
                    {canClose && resultHtml?.variant !== 'warning' && (
                      <button type="button" className="btn-close" onClick={handleCloseProgress}></button>
                    )}
                  </div>
                </div>
                <div className="modal-body">
                  <ul className="list-group list-group-flush mb-3">
                    <StepRow label="Création de la commande sur RPOS" state={createStepState} />
                    <StepRow label="Envoi des articles" state={sendStepState} />
                    {showValidateStep && <StepRow label="Validation de la commande sur RPOS" state={validateStepState} />}
                    <StepRow label="Préparation du bon de commande (PDF)" state={pdfStepState} />
                    <StepRow label="Envoi de l'email récapitulatif" state={mailStepState} />
                    <StepRow label="Email envoyé aux destinataires" state={mailSentStepState} />
                    <StepRow label="Terminé" state={doneStepState} />
                  </ul>
                  <div className="progress mb-2" style={{ height: 10 }}>
                    <div className={`progress-bar ${progressBarClass}`} style={{ width: `${progressPct}%` }}></div>
                  </div>
                  <p className="text-muted small mb-0">{progressText}</p>
                  {resultHtml && (
                    <div className={`alert alert-${resultHtml.variant} mt-3 mb-0`} dangerouslySetInnerHTML={{ __html: resultHtml.body }}></div>
                  )}
                </div>
                {resultHtml?.variant === 'warning' && (
                  <div className="modal-footer">
                    <button type="button" className="btn btn-warning" onClick={handleCloseProgress}>
                      J'ai compris, fermer
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show"></div>
        </>
      )}
    </>
  );
}
