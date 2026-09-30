import { useState } from 'react';
import type { ProposalLine } from './types';

// Détail complet d'une ligne de proposition (demande du 30/09/2026) : réunit toutes les infos
// autrefois empilées en badges dans les cellules Article/Vente moy./Stock actuel (qui rendaient les
// lignes du tableau de hauteur très inégale) — ouvert au clic sur la ligne, réutilise le patron
// modal Bootstrap déjà en place dans ce fichier (sufficiencyModal, excludedModal, etc.), pas de
// nouveau système de panneau latéral.
export function ArticleDetailModal({
  line,
  readOnly,
  onClose,
  onUnblock,
  onOpenAnalytics,
}: {
  line: ProposalLine;
  readOnly: boolean;
  onClose: () => void;
  onUnblock: (l: ProposalLine, quantity: number) => void;
  onOpenAnalytics: (article: { ean: string; productId: string; label: string }) => void;
}) {
  const [unblocked, setUnblocked] = useState(false);

  const rposOrderStatusLabel =
    line.rposOrderStatus === 2 ? ' — validée' : line.rposOrderStatus === 1 ? ' — en préparation (pas encore validée)' : line.rposOrderStatus === 6 ? ' — annulée' : '';

  return (
    <>
      <div className="modal fade show" style={{ display: 'block' }} tabIndex={-1} role="dialog">
        <div className="modal-dialog modal-dialog-centered modal-lg" role="document">
          <div className="modal-content">
            <div className="modal-header">
              <h5 className="modal-title d-flex align-items-center gap-2">
                {line.label}
                <button
                  type="button"
                  className="btn btn-sm btn-link p-0"
                  title="Voir l'évolution de cet article"
                  onClick={() => onOpenAnalytics({ ean: line.ean, productId: line.productId, label: line.label })}
                >
                  <iconify-icon icon="solar:chart-2-bold-duotone"></iconify-icon>
                </button>
              </h5>
              <button type="button" className="btn-close" onClick={onClose}></button>
            </div>
            <div className="modal-body">
              <div className="text-muted small mb-3">EAN {line.ean}</div>

              {(line.excludedAsAlreadyOrdered || line.excludedAsAlreadyOrderedRpos || line.orderSufficiencyReasoning) && (
                <div className="mb-3">
                  <div className="fw-semibold small text-uppercase text-muted mb-1">Commande</div>
                  {line.excludedAsAlreadyOrdered && (
                    <div className="alert alert-light border small mb-2">
                      <iconify-icon icon="solar:box-bold-duotone" className="me-1"></iconify-icon>
                      Déjà en commande sur cette plateforme (qté {line.quantityInTransit || 0}), pas encore reçue
                      {line.platformOrderReference ? ` — cmd ${line.platformOrderReference}` : ''}
                      {line.platformOrderDate ? ` du ${new Date(line.platformOrderDate).toLocaleDateString('fr-FR')}` : ''}.
                    </div>
                  )}
                  {line.excludedAsAlreadyOrderedRpos && (
                    <div className="alert alert-light border small mb-2">
                      <iconify-icon icon="solar:box-bold-duotone" className="me-1"></iconify-icon>
                      Commandé le {line.rposOrderDate ? new Date(line.rposOrderDate).toLocaleDateString('fr-FR') : '?'}
                      {line.rposOrderReference ? ` (réf. ${line.rposOrderReference})` : ''}
                      {line.rposOrderCount && line.rposOrderCount > 1 ? ` + ${line.rposOrderCount - 1} autre(s)` : ''}
                      {rposOrderStatusLabel} — commande RPOS des 7 derniers jours, hors de cette plateforme.
                      <div className="mt-2">
                        {unblocked ? (
                          <span className="text-success">
                            <iconify-icon icon="solar:check-circle-bold-duotone" className="me-1"></iconify-icon>
                            Débloqué — inclus dans la commande.
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-sm btn-warning"
                            disabled={readOnly}
                            onClick={() => {
                              onUnblock(line, line.quantityIfUnblocked || line.quantitySuggested || 0);
                              setUnblocked(true);
                            }}
                          >
                            <iconify-icon icon="solar:lock-keyhole-unlocked-bold-duotone" className="me-1"></iconify-icon>
                            Débloquer et commander quand même
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                  {line.orderAnomaly && (
                    <div className="alert alert-light border small mb-2">
                      <iconify-icon icon="solar:danger-triangle-bold-duotone" className="me-1"></iconify-icon>
                      {line.orderAnomaly.direction === 'HIGH' ? 'Quantité inhabituellement élevée' : 'Quantité inhabituellement faible'} — habituellement
                      entre {line.orderAnomaly.historicalMin.toFixed(0)} et {line.orderAnomaly.historicalMax.toFixed(0)} (moyenne{' '}
                      {line.orderAnomaly.historicalMean.toFixed(0)}, sur {line.orderAnomaly.sampleSize} commande(s) passée(s)).
                    </div>
                  )}
                  {line.orderSufficiencyReasoning && (
                    <div className="alert alert-light border small mb-0">
                      <iconify-icon
                        icon={line.orderSufficient === false ? 'solar:danger-triangle-bold-duotone' : 'solar:check-circle-bold-duotone'}
                        className="me-1"
                      ></iconify-icon>
                      {line.orderSufficient === false ? 'Commande insuffisante' : 'Commande suffisante'}
                      {!line.excludedAsAlreadyOrderedRpos && line.rposOrderReference
                        ? ` (réf. ${line.rposOrderReference}${line.rposOrderDate ? ` du ${new Date(line.rposOrderDate).toLocaleDateString('fr-FR')}` : ''}${line.rposOrderCount && line.rposOrderCount > 1 ? ` + ${line.rposOrderCount - 1} autre(s)` : ''})`
                        : ''}
                      {' — '}
                      {line.orderSufficiencyReasoning}
                    </div>
                  )}
                </div>
              )}

              {(line.seasonalityAdjusted || line.forecastMethod === 'smoothed' || line.weekdayAdjusted) && (
                <div className="mb-3">
                  <div className="fw-semibold small text-uppercase text-muted mb-1">Prévision</div>
                  {line.seasonalityAdjusted && (
                    <div className="alert alert-light border small mb-2">
                      <iconify-icon icon="solar:calendar-bold-duotone" className="me-1"></iconify-icon>
                      Saisonnalité : ajustée par rapport à la même période l'année dernière (écart{' '}
                      {line.seasonalityDeviationPct !== null && line.seasonalityDeviationPct !== undefined ? line.seasonalityDeviationPct.toFixed(0) + '%' : '?'}).
                    </div>
                  )}
                  {line.forecastMethod === 'smoothed' && (
                    <div className="alert alert-light border small mb-2">
                      <iconify-icon icon="solar:chart-2-bold-duotone" className="me-1"></iconify-icon>
                      Prévision par lissage exponentiel : donne plus de poids aux ventes récentes qu'à une moyenne plate.
                    </div>
                  )}
                  {line.weekdayAdjusted && (
                    <div className="alert alert-light border small mb-0">
                      <iconify-icon icon="solar:calendar-mark-bold-duotone" className="me-1"></iconify-icon>
                      La quantité tient compte du profil de vente par jour de semaine de cet article (ex: samedi plus fort), pas d'une répartition
                      uniforme sur la semaine.
                    </div>
                  )}
                </div>
              )}

              {(line.hadNegativeStock || (line.dlvStock && line.dlvStock > 0)) && (
                <div>
                  <div className="fw-semibold small text-uppercase text-muted mb-1">Stock</div>
                  {line.hadNegativeStock && (
                    <div className="alert alert-light border small mb-2">
                      <iconify-icon icon="solar:danger-triangle-bold-duotone" className="me-1"></iconify-icon>
                      Stock non fiable — ne se corrige que par une intégration de facture ou un inventaire physique côté RPOS.
                    </div>
                  )}
                  {line.dlvStock && line.dlvStock > 0 && (
                    <div className="alert alert-light border small mb-0">
                      <iconify-icon icon="solar:tag-price-bold-duotone" className="me-1"></iconify-icon>
                      {line.dlvStock.toFixed(1)} en DLV — stock retiré du calcul car basculé en DLV (vente à prix réduit sur un EAN séparé).
                    </div>
                  )}
                </div>
              )}

              {!line.excludedAsAlreadyOrdered &&
                !line.excludedAsAlreadyOrderedRpos &&
                !line.orderSufficiencyReasoning &&
                !line.orderAnomaly &&
                !line.seasonalityAdjusted &&
                line.forecastMethod !== 'smoothed' &&
                !line.weekdayAdjusted &&
                !line.hadNegativeStock &&
                !(line.dlvStock && line.dlvStock > 0) && <div className="text-muted small">Aucune alerte particulière pour cet article.</div>}
            </div>
          </div>
        </div>
      </div>
      <div className="modal-backdrop fade show"></div>
    </>
  );
}
