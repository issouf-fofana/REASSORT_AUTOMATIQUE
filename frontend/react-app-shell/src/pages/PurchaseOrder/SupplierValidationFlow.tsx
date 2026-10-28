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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Bouton "Valider toutes les propositions" à la racine d'un fournisseur (mission "Séparation CC/CD
 * et gestion par fournisseur", 28/10/2026, §7) — crée UNE SEULE commande RPOS regroupant tous les
 * articles éligibles de ce fournisseur, tous rayons confondus (via POST /validate-supplier), à la
 * différence de ValidationFlow.tsx qui ne valide qu'un seul rayon à la fois. Modale alignée sur
 * ValidationFlow.tsx (demande explicite du 28/10/2026 : "il doit etre pareil que ca... pas
 * different") — mêmes champs éditables (référence/commentaire/dates), même résumé articles/total,
 * même style — simplement sans le bloc de regroupement multi-fournisseur décochable par groupe
 * (ici un seul fournisseur est toujours ciblé, rien à décocher par groupe). Réutilise le même
 * pattern de polling asynchrone (POST → runId → GET /proposal/generate/:runId/status), déjà
 * éprouvé en production pour /validate-department.
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

  const [sending, setSending] = useState(false);
  const [progressText, setProgressText] = useState('');
  const [resultHtml, setResultHtml] = useState<{ variant: string; body: string } | null>(null);
  const cancelledRef = useRef(false);

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

  async function submit(validateAfterCreate: boolean) {
    if (!confirmData) return;
    const { decisions } = confirmData;
    setConfirmData(null);
    setSending(true);
    setResultHtml(null);
    setProgressText('Création de la commande sur RPOS...');
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

      const POLL_INTERVAL_MS = 700;
      let data: SupplierOrderResult | null = null;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (cancelledRef.current) return;
        const s = await apiFetch<ValidateRunStatus>(`/reassort/proposal/generate/${encodeURIComponent(runId)}/status?${shopQueryParam}`);
        if (s.step === 'CREATE_ORDER' && s.articlesTotal > 0) {
          setProgressText(
            s.articlesProcessed >= s.articlesTotal
              ? 'Commande créée sur RPOS, envoi des articles...'
              : `Envoi en cours : ${s.lastArticleLabel || '...'}...`,
          );
        } else if (s.step === 'SEND_EMAIL') {
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

      const anyOrderCreated = !!data.order?.reference;
      const hasPartialFailure = anyOrderCreated && data.failed > 0;
      const variant = !anyOrderCreated ? 'danger' : hasPartialFailure ? 'warning' : 'success';
      const failedList = data.failedLines.length
        ? `<ul class="mb-0 mt-2 small">${data.failedLines.map((f) => `<li>${f.label || f.ean} — ${f.reason}</li>`).join('')}</ul>`
        : '';
      const body = anyOrderCreated
        ? `Commande <strong>${data.order?.reference}</strong> créée sur RPOS pour <strong>${supplierName}</strong> — ${data.processed - data.failed} article(s) envoyé(s) sur ${data.totalRequested} proposé(s)${data.failed ? `, ${data.failed} échec(s)` : ''}.${failedList}`
        : `<strong>Échec de création de la commande</strong> pour ${supplierName} — aucun numéro de commande généré.${failedList}`;

      setResultHtml({ variant, body });
      setProgressText('');
      setSending(false);
      onValidated();
    } catch (err) {
      setResultHtml({ variant: 'danger', body: `Erreur : ${err instanceof Error ? err.message : String(err)}` });
      setProgressText('');
      setSending(false);
    }
  }

  return (
    <>
      <button type="button" className="btn btn-sm btn-primary" disabled={sending} onClick={openConfirm}>
        {sending ? (
          <>
            <span className="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true"></span>
            {progressText || 'Validation en cours...'}
          </>
        ) : (
          <>
            <iconify-icon icon="solar:check-circle-bold-duotone" className="align-middle"></iconify-icon>{' '}
            Valider toutes les propositions
          </>
        )}
      </button>

      {resultHtml && (
        <div className={`alert alert-${resultHtml.variant} small mt-2 mb-0`} dangerouslySetInnerHTML={{ __html: resultHtml.body }} />
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
    </>
  );
}
