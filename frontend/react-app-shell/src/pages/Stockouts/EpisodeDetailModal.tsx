import { useEffect, useState } from 'react';
import { apiFetch } from '../../shared/api/client';

// Fiche détaillée d'un épisode de rupture (spec rupture.md §3-§5, 16/10/2026) : chronologie,
// commande associée (si passée APRÈS le début de la rupture, cf. stockoutEpisodeService.js), ventes
// avant/pendant, mouvements de stock. Les 3 délais (réaction / réapprovisionnement / durée totale)
// sont affichés séparément, jamais additionnés — exigence explicite de la spec §4.
//
// Refonte visuelle + reactionStatus ajoutés le 16/10/2026 (demande explicite : "je n'ai pas le
// temps de rupture... combien de pert la rupture ma couté, est c que le magasin a reagi au moment
// de la rupture... et revoir le style fais pro") — cartes KPI en tête (durée, perte estimée, statut
// de réaction visible d'un coup d'œil), CA perdu désormais calculé en temps réel côté backend même
// pour un épisode toujours EN_COURS (avant : seulement calculé à la résolution de l'épisode).
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

type ReactionStatus = 'EN_ATTENTE' | 'RETARD' | 'MAGASIN_NA_PAS_REAGI' | 'REAGI';

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
  reactionStatus: ReactionStatus;
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

// Statut de réaction du magasin — règle explicite : < 24h = délai normal, 24-48h = en retard,
// > 48h sans commande = confirmé, le magasin n'a pas réagi (cf. stockoutEpisodeService.js).
const REACTION_STATUS_META: Record<ReactionStatus, { label: string; badge: string; icon: string }> = {
  REAGI: { label: 'Le magasin a réagi', badge: 'reassort-badge-soft-success', icon: 'solar:check-circle-bold-duotone' },
  EN_ATTENTE: { label: 'En attente de commande (< 24h)', badge: 'reassort-badge-neutral', icon: 'solar:clock-circle-bold-duotone' },
  RETARD: { label: 'Retard de commande (24-48h)', badge: 'reassort-badge-soft-warning', icon: 'solar:danger-triangle-bold-duotone' },
  MAGASIN_NA_PAS_REAGI: { label: "Le magasin n'a pas réagi (> 48h)", badge: 'reassort-badge-soft-danger', icon: 'solar:close-circle-bold-duotone' },
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

function formatMoney(value: number | null): string {
  if (value === null) return 'Estimation indisponible';
  return `${Math.round(value).toLocaleString('fr-FR')} CFA`;
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

  const reactionMeta = detail ? REACTION_STATUS_META[detail.reactionStatus] : null;

  return (
    <>
      <style>{`
        .stockout-modal-kpi { border: 1px solid rgba(27,42,74,.08); border-radius: 10px; padding: 14px 16px; height: 100%; }
        .stockout-modal-kpi .label { color: #5B6B85; font-size: .78rem; font-weight: 600; text-transform: uppercase; letter-spacing: .02em; }
        .stockout-modal-kpi .value { color: #1B2A4A; font-size: 1.25rem; font-weight: 700; margin-top: 2px; }
        .stockout-modal-section-title { color: #1B2A4A; font-weight: 700; font-size: .9rem; text-transform: uppercase; letter-spacing: .03em; margin-bottom: 10px; }
      `}</style>
      {/* Les classes "reassort-badge-*" (reassort-badge-soft-danger, etc.) ne sont PAS définies en
          CSS global du projet — déclarées une seule fois au niveau de la page dans Stockouts.tsx
          (composant parent), pas ici, pour ne pas dupliquer ce bloc dans chaque sous-composant qui
          les utilise (StockoutShopDetail.tsx, cette modale...). Bug réel trouvé le 16/10/2026 : le
          badge existait bien dans le DOM mais restait invisible sans cette règle quelque part dans
          l'arbre. */}
      <div className="modal fade show" style={{ display: 'block' }} tabIndex={-1} role="dialog">
        <div className="modal-dialog modal-dialog-centered modal-lg modal-dialog-scrollable" role="document">
          <div className="modal-content">
            <div className="modal-header">
              <div>
                <h5 className="modal-title mb-1">{detail ? (detail.label || detail.ean) : 'Détail de la rupture'}</h5>
                {detail && <div className="text-muted small">{detail.department || 'Sans rayon'} · EAN {detail.ean}</div>}
              </div>
              <button type="button" className="btn-close" onClick={onClose}></button>
            </div>
            <div className="modal-body">
              {error ? (
                <div className="alert alert-danger">Erreur : {error}</div>
              ) : detail === null ? (
                <p className="text-muted text-center py-4">Chargement...</p>
              ) : (
                <>
                  {/* Cartes KPI — l'essentiel visible d'un coup d'œil, sans avoir à lire le texte. */}
                  <div className="row g-3 mb-4">
                    <div className="col-6 col-md-3">
                      <div className="stockout-modal-kpi">
                        <div className="label">Statut</div>
                        <div className="value">{detail.status === 'EN_COURS' ? 'En cours' : 'Résolue'}</div>
                      </div>
                    </div>
                    <div className="col-6 col-md-3">
                      <div className="stockout-modal-kpi">
                        <div className="label">Durée</div>
                        <div className="value">{formatDuration(detail.totalDurationHours)}</div>
                      </div>
                    </div>
                    <div className="col-6 col-md-3">
                      <div className="stockout-modal-kpi">
                        <div className="label">CA perdu estimé</div>
                        <div className="value">{formatMoney(detail.caPerdueEstime)}</div>
                      </div>
                    </div>
                    <div className="col-6 col-md-3">
                      <div className="stockout-modal-kpi">
                        <div className="label">Quantité perdue</div>
                        <div className="value">{detail.qtyPerdueEstimee !== null ? `${Math.round(detail.qtyPerdueEstimee)} u.` : '—'}</div>
                      </div>
                    </div>
                  </div>

                  {/* Statut de réaction du magasin — mis en avant, c'est la question la plus
                      actionnable ("le magasin a-t-il réagi ?"). */}
                  {reactionMeta && (
                    <div className="d-flex align-items-center gap-2 mb-4">
                      <span className={`badge ${reactionMeta.badge} py-2 px-3 d-inline-flex align-items-center gap-2`} style={{ fontSize: '.85rem' }}>
                        <iconify-icon icon={reactionMeta.icon}></iconify-icon>
                        {reactionMeta.label}
                      </span>
                      <span className="text-muted small">Cause probable : {CAUSE_LABELS[detail.causeProposee] || detail.causeProposee}</span>
                    </div>
                  )}

                  <div className="stockout-modal-section-title">Chronologie</div>
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

                  <div className="stockout-modal-section-title">Commande associée</div>
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

                  <div className="stockout-modal-section-title">Ventes</div>
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

                  <div className="stockout-modal-section-title">Mouvements de stock récents</div>
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
