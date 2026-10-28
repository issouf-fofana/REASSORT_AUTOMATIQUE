import { useEffect, useState } from 'react';
import { apiFetch } from '../../shared/api/client';
import type { ProposalLine } from './types';

interface AvailableSupplier {
  supplierId: string;
  supplierName: string;
  deliveryType: 'LC' | 'LD' | null;
  isCurrent: boolean;
  isDefault: boolean;
}

// Section "Fournisseur" (mission "Séparation CC/CD et gestion par fournisseur", 28/10/2026,
// objectif 5 : "consulter le fournisseur actuellement associé à l'article, consulter les autres
// fournisseurs disponibles, sélectionner le fournisseur souhaité"). Charge la liste à l'ouverture de
// la modale (pas avant, pour ne pas multiplier les appels sur un tableau de centaines de lignes) ;
// si l'article n'a aucune alternative connue dans ArticleSupplier, n'affiche qu'un rappel discret du
// fournisseur actuel plutôt qu'un sélecteur vide ou désactivé.
function SupplierSection({
  line,
  readOnly,
  onChanged,
}: {
  line: ProposalLine;
  readOnly: boolean;
  onChanged: (updates: Pick<ProposalLine, 'resolvedSupplierId' | 'resolvedSupplierName' | 'deliveryType' | 'supplierResolutionOrigin'>) => void;
}) {
  const [suppliers, setSuppliers] = useState<AvailableSupplier[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [changing, setChanging] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch<{ ean: string; suppliers: AvailableSupplier[] }>(`/reassort/proposal-line/${line.id}/available-suppliers`)
      .then((data) => {
        if (!cancelled) setSuppliers(data.suppliers);
      })
      .catch(() => {
        if (!cancelled) setSuppliers(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [line.id]);

  // Déjà commandé (proposalOrderId renseigné) : le backend refuse PUT .../supplier avec un 409 —
  // autant ne jamais proposer le choix plutôt que de laisser cliquer pour échouer.
  const locked = !!line.proposalOrderId;

  async function handleChange(supplierId: string) {
    if (supplierId === line.resolvedSupplierId) return;
    setChanging(true);
    try {
      const updated = await apiFetch<{ lineId: string; resolvedSupplierId: string; resolvedSupplierName: string | null; deliveryType: 'LC' | 'LD' | null }>(
        `/reassort/proposal-line/${line.id}/supplier`,
        { method: 'PUT', body: JSON.stringify({ supplierId }) },
      );
      onChanged({
        resolvedSupplierId: updated.resolvedSupplierId,
        resolvedSupplierName: updated.resolvedSupplierName,
        deliveryType: updated.deliveryType,
        supplierResolutionOrigin: updated.resolvedSupplierId === line.resolvedSupplierId ? line.supplierResolutionOrigin : 'MANUAL_OVERRIDE',
      });
      window.reassortToast(`Fournisseur changé pour ${updated.resolvedSupplierName || '—'}.`, 'success');
    } catch (err) {
      window.reassortToast('Erreur : ' + (err instanceof Error ? err.message : String(err)), 'error');
    } finally {
      setChanging(false);
    }
  }

  const hasAlternatives = (suppliers?.length || 0) > 1;

  return (
    <div className="mb-3">
      <div className="aidm-section-label">Fournisseur</div>
      <InfoCard icon="solar:shop-bold-duotone" tone="info">
        {line.deliveryType === 'LC' ? 'Fournisseur central (LC)' : line.resolvedSupplierName ? `${line.resolvedSupplierName} (LD)` : 'Aucun fournisseur résolu'}
        {line.supplierResolutionOrigin === 'MANUAL_OVERRIDE' && <span className="text-muted"> — choix manuel</span>}
        {locked && <span className="text-muted"> — déjà commandé, non modifiable.</span>}
        {!locked && !loading && hasAlternatives && !readOnly && (
          <div className="mt-2 d-flex align-items-center gap-2">
            <select
              className="form-select form-select-sm"
              style={{ maxWidth: 280 }}
              disabled={changing}
              value={line.resolvedSupplierId || ''}
              onChange={(e) => handleChange(e.target.value)}
            >
              {suppliers!.map((s) => (
                <option key={s.supplierId} value={s.supplierId}>
                  {s.supplierName}
                  {s.isCurrent ? ' (actuel)' : ''}
                </option>
              ))}
            </select>
            {changing && <span className="spinner-border spinner-border-sm text-secondary" role="status" aria-hidden="true"></span>}
          </div>
        )}
      </InfoCard>
    </div>
  );
}

// Carte d'information avec icône colorée, remplace les anciens `alert alert-light border` plats
// (demande du 01/10/2026, "fait un style plus jolie") — cohérent avec les badges déjà introduits
// dans le tableau (Actions, Stock actuel, Vente moy.), même esprit marine/ambre.
type InfoTone = 'warning' | 'info' | 'success' | 'danger';
const TONE_STYLES: Record<InfoTone, { bg: string; fg: string }> = {
  warning: { bg: '#FDF1DD', fg: '#8A5A00' },
  info: { bg: '#EDF1F7', fg: '#1B2A4A' },
  success: { bg: '#ECFDF5', fg: '#047857' },
  danger: { bg: '#F5EDEC', fg: '#7A4A45' },
};

function InfoCard({ icon, tone, children }: { icon: string; tone: InfoTone; children: React.ReactNode }) {
  const { bg, fg } = TONE_STYLES[tone];
  return (
    <div className="aidm-info-card">
      <div className="aidm-info-icon" style={{ background: bg, color: fg }}>
        <iconify-icon icon={icon}></iconify-icon>
      </div>
      <div className="aidm-info-text">{children}</div>
    </div>
  );
}

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
  onSupplierChanged,
}: {
  line: ProposalLine;
  readOnly: boolean;
  onClose: () => void;
  onUnblock: (l: ProposalLine, quantity: number) => void;
  onOpenAnalytics: (article: { ean: string; productId: string; label: string }) => void;
  onSupplierChanged: (l: ProposalLine, updates: Pick<ProposalLine, 'resolvedSupplierId' | 'resolvedSupplierName' | 'deliveryType' | 'supplierResolutionOrigin'>) => void;
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
              <style>{`
                .aidm-section-label { font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: #8a93a8; margin-bottom: .6rem; }
                .aidm-info-card { display: flex; align-items: flex-start; gap: .75rem; padding: .85rem 1rem; border-radius: 10px; background: #F7F9FC; border: 1px solid #e9ecf2; margin-bottom: .6rem; }
                .aidm-info-card:last-child { margin-bottom: 0; }
                .aidm-info-icon { width: 30px; height: 30px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 1rem; flex-shrink: 0; }
                .aidm-info-text { font-size: .86rem; color: #33415C; line-height: 1.5; }
              `}</style>
              <div className="text-muted small mb-3">EAN {line.ean}</div>

              <SupplierSection line={line} readOnly={readOnly} onChanged={(updates) => onSupplierChanged(line, updates)} />

              {(line.excludedAsAlreadyOrdered || line.excludedAsAlreadyOrderedRpos || line.orderSufficiencyReasoning) && (
                <div className="mb-3">
                  <div className="aidm-section-label">Commande</div>
                  {line.excludedAsAlreadyOrdered && (
                    <InfoCard icon="solar:box-bold-duotone" tone="info">
                      Déjà en commande sur cette plateforme (qté {line.quantityInTransit || 0}), pas encore reçue
                      {line.platformOrderReference ? ` — cmd ${line.platformOrderReference}` : ''}
                      {line.platformOrderDate ? ` du ${new Date(line.platformOrderDate).toLocaleDateString('fr-FR')}` : ''}.
                    </InfoCard>
                  )}
                  {line.excludedAsAlreadyOrderedRpos && (
                    <InfoCard icon="solar:box-bold-duotone" tone="info">
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
                    </InfoCard>
                  )}
                  {line.orderAnomaly && (
                    <InfoCard icon="solar:danger-triangle-bold-duotone" tone="warning">
                      {line.orderAnomaly.direction === 'HIGH' ? 'Quantité inhabituellement élevée' : 'Quantité inhabituellement faible'} — habituellement
                      entre {line.orderAnomaly.historicalMin.toFixed(0)} et {line.orderAnomaly.historicalMax.toFixed(0)} (moyenne{' '}
                      {line.orderAnomaly.historicalMean.toFixed(0)}, sur {line.orderAnomaly.sampleSize} commande(s) passée(s)).
                    </InfoCard>
                  )}
                  {line.orderSufficiencyReasoning && (
                    <InfoCard
                      icon={line.orderSufficient === false ? 'solar:danger-triangle-bold-duotone' : 'solar:check-circle-bold-duotone'}
                      tone={line.orderSufficient === false ? 'warning' : 'success'}
                    >
                      {line.orderSufficient === false ? 'Commande insuffisante' : 'Commande suffisante'}
                      {!line.excludedAsAlreadyOrderedRpos && line.rposOrderReference
                        ? ` (réf. ${line.rposOrderReference}${line.rposOrderDate ? ` du ${new Date(line.rposOrderDate).toLocaleDateString('fr-FR')}` : ''}${line.rposOrderCount && line.rposOrderCount > 1 ? ` + ${line.rposOrderCount - 1} autre(s)` : ''})`
                        : ''}
                      {' — '}
                      {line.orderSufficiencyReasoning}
                    </InfoCard>
                  )}
                </div>
              )}

              {(line.seasonalityAdjusted || line.forecastMethod === 'smoothed' || line.weekdayAdjusted) && (
                <div className="mb-3">
                  <div className="aidm-section-label">Prévision</div>
                  {line.seasonalityAdjusted && (
                    <InfoCard icon="solar:calendar-bold-duotone" tone="info">
                      Saisonnalité : ajustée par rapport à la même période l'année dernière (écart{' '}
                      {line.seasonalityDeviationPct !== null && line.seasonalityDeviationPct !== undefined ? line.seasonalityDeviationPct.toFixed(0) + '%' : '?'}).
                    </InfoCard>
                  )}
                  {line.forecastMethod === 'smoothed' && (
                    <InfoCard icon="solar:chart-2-bold-duotone" tone="info">
                      Prévision par lissage exponentiel : donne plus de poids aux ventes récentes qu'à une moyenne plate.
                    </InfoCard>
                  )}
                  {line.weekdayAdjusted && (
                    <InfoCard icon="solar:calendar-mark-bold-duotone" tone="info">
                      La quantité tient compte du profil de vente par jour de semaine de cet article (ex: samedi plus fort), pas d'une répartition
                      uniforme sur la semaine.
                    </InfoCard>
                  )}
                </div>
              )}

              {(line.hadNegativeStock || (line.dlvStock && line.dlvStock > 0)) && (
                <div>
                  <div className="aidm-section-label">Stock</div>
                  {line.hadNegativeStock && (
                    <InfoCard icon="solar:danger-triangle-bold-duotone" tone="warning">
                      Stock non fiable — ne se corrige que par une intégration de facture ou un inventaire physique côté RPOS.
                    </InfoCard>
                  )}
                  {line.dlvStock && line.dlvStock > 0 && (
                    <InfoCard icon="solar:tag-price-bold-duotone" tone="info">
                      {line.dlvStock.toFixed(1)} en DLV — stock retiré du calcul car basculé en DLV (vente à prix réduit sur un EAN séparé).
                    </InfoCard>
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
