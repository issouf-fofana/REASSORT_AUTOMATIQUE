import { useState } from 'react';
import { apiFetch } from '../../shared/api/client';

/**
 * Valide sur RPOS une commande de rayon déjà créée et restée "en préparation" (mission "Valider
 * une commande en préparation plutôt que d'en créer une nouvelle", 29/10/2026 — demande explicite :
 * "quand il detect qu'une commande est en preparation, il doit pouvoir validé cette commande... pas
 * cree un nouveau"). Distinct de ValidationFlow.tsx (qui CRÉE une nouvelle ProposalOrder) : ici la
 * commande RPOS existe déjà (statut 1, "en préparation"), il s'agit juste de la faire passer en
 * statut 2 ("en attente de livraison", transmise à l'entrepôt) via POST /orders/:id/validate — même
 * route déjà utilisée par la page Commandes (PurchaseList.tsx), ouverte à tout rôle ayant accès à
 * la proposition depuis le 29/10/2026 (requireAdmin retiré côté backend).
 */
export function ValidateExistingOrderButton({
  rposOrderId,
  rposOrderReference,
  shopQueryParam,
  onValidated,
}: {
  rposOrderId: string;
  rposOrderReference: string | null;
  shopQueryParam: string;
  onValidated: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setConfirming(false);
    setSending(true);
    setError(null);
    try {
      await apiFetch(`/reassort/orders/${encodeURIComponent(rposOrderId)}/validate?${shopQueryParam}`, {
        method: 'POST',
      });
      onValidated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <button type="button" className="btn btn-sm btn-success" disabled={sending} onClick={() => setConfirming(true)}>
        {sending ? (
          <>
            <span className="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true"></span>
            Validation en cours...
          </>
        ) : (
          <>
            <iconify-icon icon="solar:check-circle-bold-duotone" className="align-middle"></iconify-icon>{' '}
            Valider cette commande sur RPOS
          </>
        )}
      </button>

      {error && <div className="alert alert-danger small mt-2 mb-0">Erreur : {error}</div>}

      {confirming && (
        <>
          <div className="modal fade show" style={{ display: 'block' }} tabIndex={-1} role="dialog">
            <div className="modal-dialog modal-dialog-centered" role="document">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">Valider la commande {rposOrderReference || rposOrderId}</h5>
                  <button type="button" className="btn-close" onClick={() => setConfirming(false)}></button>
                </div>
                <div className="modal-body">
                  <p className="mb-0">
                    Cette commande est déjà créée sur RPOS et actuellement <strong>en préparation</strong>. La
                    valider la transmet à l'entrepôt (statut « en attente de livraison ») — elle ne sera plus
                    modifiable ni supprimable depuis RPOS après cette action.
                  </p>
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn btn-outline-secondary" onClick={() => setConfirming(false)}>
                    Annuler
                  </button>
                  <button type="button" className="btn btn-success" onClick={submit}>
                    Valider sur RPOS
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
