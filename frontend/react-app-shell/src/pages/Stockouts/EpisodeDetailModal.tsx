import { useEffect, useState } from 'react';
import { apiFetch } from '../../shared/api/client';

// Fiche détaillée d'un épisode de rupture (spec rupture.md §3-§5, 16/10/2026) : chronologie,
// commande associée (si passée APRÈS le début de la rupture, cf. stockoutEpisodeService.js), ventes
// avant/pendant, mouvements de stock. Les 3 délais (réaction / réapprovisionnement / durée totale)
// sont affichés séparément, jamais additionnés — exigence explicite de la spec §4.
type StockMove = {
  date: string;
  typeLabel: string;
  recording: string | null;
  isScrap: boolean;
  quantity: number;
  previousQuantity: number | null;
};

type OrderInfo = {
  id: string;
  status: string;
  receptionStatus: string;
  rposOrderValidated: boolean | null;
  supplierName: string | null;
  deliveryType: string | null;
  createdAt: string;
  expectedReceptionDate: string | null;
  actualReceptionDate: string | null;
  quantityOrdered: number | null;
};

type ReceptionEvent = { observedAt: string; receptionStatus: string; rposStatus: number };

type EpisodeDetail = {
  id: string;
  ean: string;
  label: string | null;
  department: string | null;
  startedAt: string;
  endedAt: string | null;
  status: string;
  durationHours: number;
  causeProposee: string;
  niveauConfiance: string;
  qtyPerdueEstimee: number | null;
  caPerdueEstime: number | null;
  salesBeforeEpisode: { windowDays: number; quantity: number; revenue: number };
  salesDuringEpisode: { quantity: number; revenue: number };
  stockMoves: StockMove[];
  order: OrderInfo | null;
  receptionEvents: ReceptionEvent[];
  reactionDelayHours: number | null;
  replenishmentDelayHours: number | null;
  totalDurationHours: number;
};

const CAUSE_LABELS: Record<string, string> = {
  MAGASIN_REASSORT: 'Magasin / réassort',
  MAGASIN_COMMANDE_NON_VALIDEE: 'Commande non validée',
  AMONT_A_PRECISER: 'Amont — à préciser',
  ECART_STOCK_RAYON: 'Écart stock / rayon',
  INDETERMINEE: 'Indéterminée',
};

const RECEPTION_STATUS_LABELS: Record<string, string> = {
  COMMANDEE: 'Commandée',
  EN_ATTENTE_RECEPTION: 'En attente de réception',
  RECUE_ESTIMEE: 'Reçue (estimée)',
  ANNULEE: 'Annulée',
};

function formatDuration(hours: number | null): string {
  if (hours === null) return '—';
  if (hours < 0) return '—';
  if (hours < 24) return `${Math.round(hours)} h`;
  const days = Math.floor(hours / 24);
  const rest = Math.round(hours % 24);
  return `${days} j ${rest} h`;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('fr-FR');
}

export function EpisodeDetailModal({ episodeId, onClose }: { episodeId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<EpisodeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    apiFetch<EpisodeDetail>(`/reassort/stockout-episodes/${episodeId}`)
      .then((data) => { if (!cancelled) setDetail(data); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [episodeId]);

  return (
    <>
      <div className="modal fade show" style={{ display: 'block' }} tabIndex={-1} role="dialog">
        <div className="modal-dialog modal-dialog-centered modal-lg modal-dialog-scrollable" role="document">
          <div className="modal-content">
            <div className="modal-header">
              <h5 className="modal-title">
                {detail ? (detail.label || detail.ean) : 'Détail de la rupture'}
              </h5>
              <button type="button" className="btn-close" onClick={onClose}></button>
            </div>
            <div className="modal-body">
              {error ? (
                <div className="alert alert-danger">Erreur : {error}</div>
              ) : detail === null ? (
                <p className="text-muted text-center py-4">Chargement...</p>
              ) : (
                <>
                  <div className="row g-3 mb-4">
                    <div className="col-6 col-md-3">
                      <div className="text-muted small">Rayon</div>
                      <div className="fw-semibold">{detail.department || '—'}</div>
                    </div>
                    <div className="col-6 col-md-3">
                      <div className="text-muted small">Statut</div>
                      <div className="fw-semibold">{detail.status === 'EN_COURS' ? 'En cours' : 'Résolue'}</div>
                    </div>
                    <div className="col-6 col-md-3">
                      <div className="text-muted small">Durée totale</div>
                      <div className="fw-semibold">{formatDuration(detail.totalDurationHours)}</div>
                    </div>
                    <div className="col-6 col-md-3">
                      <div className="text-muted small">Cause probable</div>
                      <div className="fw-semibold">{CAUSE_LABELS[detail.causeProposee] || detail.causeProposee}</div>
                    </div>
                  </div>

                  <h6 className="mb-2">Chronologie</h6>
                  <table className="table table-sm align-middle mb-4">
                    <tbody>
                      <tr>
                        <td className="text-muted">Début de la rupture</td>
                        <td>{formatDateTime(detail.startedAt)}</td>
                        <td className="text-muted small">Début</td>
                      </tr>
                      {detail.order && (
                        <tr>
                          <td className="text-muted">Passation de la commande</td>
                          <td>{formatDateTime(detail.order.createdAt)}</td>
                          <td className="text-muted small">Délai de réaction : {formatDuration(detail.reactionDelayHours)}</td>
                        </tr>
                      )}
                      {detail.order?.actualReceptionDate && (
                        <tr>
                          <td className="text-muted">Réception en magasin (estimée)</td>
                          <td>{formatDateTime(detail.order.actualReceptionDate)}</td>
                          <td className="text-muted small">Délai de réappro. : {formatDuration(detail.replenishmentDelayHours)}</td>
                        </tr>
                      )}
                      {detail.endedAt && (
                        <tr>
                          <td className="text-muted">Retour à la disponibilité</td>
                          <td>{formatDateTime(detail.endedAt)}</td>
                          <td className="text-muted small">Durée totale : {formatDuration(detail.totalDurationHours)}</td>
                        </tr>
                      )}
                    </tbody>
                  </table>

                  <h6 className="mb-2">Commande associée</h6>
                  {!detail.order ? (
                    <p className="text-muted small mb-4">Aucune commande identifiée depuis le début de la rupture.</p>
                  ) : (
                    <table className="table table-sm align-middle mb-4">
                      <tbody>
                        <tr><td className="text-muted">Quantité commandée</td><td>{detail.order.quantityOrdered ?? '—'}</td></tr>
                        <tr><td className="text-muted">Statut de réception</td><td>{RECEPTION_STATUS_LABELS[detail.order.receptionStatus] || detail.order.receptionStatus}</td></tr>
                        <tr><td className="text-muted">Date de réception prévue</td><td>{formatDateTime(detail.order.expectedReceptionDate)}</td></tr>
                        <tr><td className="text-muted">Fournisseur</td><td>{detail.order.supplierName || '—'} {detail.order.deliveryType ? `(${detail.order.deliveryType})` : ''}</td></tr>
                      </tbody>
                    </table>
                  )}

                  <h6 className="mb-2">Ventes</h6>
                  <div className="row g-3 mb-4">
                    <div className="col-6">
                      <div className="text-muted small">Avant la rupture ({detail.salesBeforeEpisode.windowDays}j)</div>
                      <div className="fw-semibold">{detail.salesBeforeEpisode.quantity} unités — {Math.round(detail.salesBeforeEpisode.revenue).toLocaleString('fr-FR')} CFA</div>
                    </div>
                    <div className="col-6">
                      <div className="text-muted small">Pendant la rupture</div>
                      <div className="fw-semibold">{detail.salesDuringEpisode.quantity} unités — {Math.round(detail.salesDuringEpisode.revenue).toLocaleString('fr-FR')} CFA</div>
                    </div>
                  </div>

                  {(detail.qtyPerdueEstimee !== null || detail.caPerdueEstime !== null) && (
                    <div className="alert alert-light border mb-4">
                      <strong>Impact estimé :</strong> {detail.qtyPerdueEstimee !== null ? `${Math.round(detail.qtyPerdueEstimee)} unités perdues, ` : ''}
                      {detail.caPerdueEstime !== null ? `${Math.round(detail.caPerdueEstime).toLocaleString('fr-FR')} CFA de CA potentiellement perdu` : 'estimation indisponible'}.
                    </div>
                  )}

                  <h6 className="mb-2">Mouvements de stock récents</h6>
                  <div className="table-responsive">
                    <table className="table table-sm align-middle mb-0">
                      <thead className="bg-light-subtle">
                        <tr>
                          <th>Date</th>
                          <th>Type</th>
                          <th>Quantité</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.stockMoves.length === 0 ? (
                          <tr><td colSpan={3} className="text-center text-muted py-3">Aucun mouvement enregistré sur la période.</td></tr>
                        ) : (
                          detail.stockMoves.slice(0, 20).map((m, i) => (
                            <tr key={i}>
                              <td>{formatDateTime(m.date)}</td>
                              <td>{m.typeLabel}{m.isScrap ? ' (casse)' : ''}</td>
                              <td>{m.quantity}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
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
