import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { apiFetch } from '../../shared/api/client';

// Page dédiée de détail d'une rupture. Refonte du 17/10/2026 (demande explicite, sur le modèle
// d'une capture d'écran d'une autre application "Suivi Interventions" : header sombre contrasté +
// badge statut, bandeau d'alerte, 4 tuiles compactes, timeline horizontale début→durée→fin, puis
// sections "Informations générales" / "Métriques temporelles" en grille 2 colonnes) — remplace la
// précédente mise en page à sections empilées (plus proche de la maquette "Analyse de rupture.html"
// initiale), jugée trop longue à parcourir.
//
// Traçabilité demandée explicitement : détection (date/heure début, compteur continu tant
// qu'aucune commande), commande (date/heure de création ET de validation, qui a validé, numéro de
// commande RPOS), délai de livraison restant après commande, perte estimée SÉPARÉMENT avant et
// après la commande (pas une seule perte globale) — et le verdict "magasin fautif" quand aucune
// commande n'a été passée alors que des ventes ont continué d'être constatées (reactionStatus
// MAGASIN_NA_PAS_REAGI, cf. stockoutEpisodeService.js).
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
  rposOrderReference: string | null;
  status: string;
  receptionStatus: string;
  rposOrderValidated: boolean | null;
  supplierName: string | null;
  deliveryType: string | null;
  createdAt: string;
  createdBy: string | null;
  validatedAt: string | null;
  validatedBy: string | null;
  expectedReceptionDate: string | null;
  actualReceptionDate: string | null;
  quantityOrdered: number | null;
};

type ReceptionEvent = { observedAt: string; receptionStatus: string; rposStatus: number };

type ReactionStatus = 'EN_ATTENTE' | 'RETARD' | 'MAGASIN_NA_PAS_REAGI' | 'REAGI' | 'STOCK_PEUT_ETRE_PAS_A_JOUR';

type OrderQuantitySufficiency = { quantityOrdered: number; expectedDemand: number; sufficient: boolean };

type Loss = { qtyPerdue: number | null; caPerdue: number | null };

type EpisodeDetail = {
  id: string;
  ean: string;
  label: string | null;
  department: string | null;
  sector?: string | null;
  rposShopId: string;
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
  orderQuantitySufficiency: OrderQuantitySufficiency | null;
  lossBeforeOrder: Loss | null;
  lossAfterOrder: Loss | null;
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

const REACTION_STATUS_META: Record<ReactionStatus, { label: string; tone: 'critical' | 'warning' | 'success' | 'info'; verdict: string }> = {
  REAGI: { label: 'Le magasin a réagi', tone: 'success', verdict: 'Une commande a été passée — magasin non fautif pour la période après réaction.' },
  EN_ATTENTE: { label: 'En attente de commande (< 24h)', tone: 'info', verdict: 'Délai normal, pas encore de jugement possible.' },
  RETARD: { label: 'Retard de commande (24-48h)', tone: 'warning', verdict: 'Retard constaté, pas encore confirmé fautif.' },
  MAGASIN_NA_PAS_REAGI: { label: "Le magasin n'a pas réagi (> 48h)", tone: 'critical', verdict: 'Aucune commande passée après 48h de rupture avec ventes constatées — magasin fautif.' },
  STOCK_PEUT_ETRE_PAS_A_JOUR: { label: 'Stock potentiellement pas à jour', tone: 'info', verdict: "Aucune vente ni commande depuis le début — le stock à 0 n'est peut-être pas réel, pas de jugement possible." },
};

function formatDuration(hours: number | null): string {
  if (hours === null || hours < 0) return '—';
  if (hours < 24) return `${Math.round(hours)} h`;
  const days = Math.floor(hours / 24);
  const rest = Math.round(hours % 24);
  return `${days} j ${rest} h`;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('fr-FR');
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('fr-FR');
}

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function formatMoney(value: number | null): string {
  if (value === null) return '—';
  return `${Math.round(value).toLocaleString('fr-FR')} CFA`;
}

export function StockoutEpisodePage() {
  const { episodeId } = useParams<{ episodeId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // URL exacte (avec secteur/rayon) d'où on est arrivé, passée par StockoutShopDetail.tsx au clic
  // sur l'article — demande explicite du 17/10/2026 : "quand je fait un retour il m'nevoi sur les
  // Secteurs au debut or il doit m'envoyer dans les rayon". navigate(-1) seul ne suffit pas non
  // plus : ouverture directe (lien partagé, rechargement) = pas d'historique React dans l'onglet.
  const backTo = searchParams.get('from');
  const [detail, setDetail] = useState<EpisodeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!episodeId) return;
    let cancelled = false;
    setDetail(null);
    setError(null);
    apiFetch<EpisodeDetail>(`/reassort/stockout-episodes/${episodeId}`)
      .then((data) => { if (!cancelled) setDetail(data); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [episodeId]);

  const reactionMeta = detail ? REACTION_STATUS_META[detail.reactionStatus] : null;
  const isLongDuration = detail ? detail.totalDurationHours >= 48 : false;

  return (
    <div className="container-fluid py-4">
      <style>{`
        .ep2-crumb-back { background: #fff; border: 1px solid rgba(27,42,74,.15); color: #1B2A4A; font-size: .82rem; font-weight: 600; display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; border-radius: 8px; margin-bottom: 12px; }
        .ep2-crumb-back:hover { background: #EDF1F7; }
        .ep2-alert { background: #FDF1DD; border: 1px solid rgba(168,103,24,.25); color: #7a4910; border-radius: 10px; padding: 12px 16px; display: flex; align-items: center; gap: 10px; font-size: .85rem; margin-bottom: 16px; }
        .ep2-header { background: #1B2A4A; border-radius: 14px; padding: 22px 26px; color: #fff; margin-bottom: 14px; position: relative; overflow: hidden; }
        .ep2-header-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
        .ep2-header .eyebrow { font-size: .7rem; letter-spacing: .06em; text-transform: uppercase; color: #9FB0CC; font-weight: 600; margin-bottom: 4px; }
        .ep2-header h2 { font-size: 1.5rem; font-weight: 700; margin: 0 0 4px; color: #fff; }
        .ep2-header .meta { font-size: .82rem; color: #C9D2E3; }
        .ep2-status-badge { display: inline-flex; align-items: center; gap: 6px; padding: 5px 14px; border-radius: 999px; font-size: .78rem; font-weight: 600; white-space: nowrap; }
        .ep2-status-badge.active { background: rgba(224,87,76,.22); color: #FF9D94; }
        .ep2-status-badge.resolved { background: rgba(76,175,130,.22); color: #7FE0A8; }
        .ep2-tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-top: 18px; }
        @media (max-width: 860px) { .ep2-tiles { grid-template-columns: repeat(2, 1fr); } }
        .ep2-tile { background: rgba(255,255,255,.06); border-radius: 10px; padding: 12px 14px; }
        .ep2-tile .lbl { font-size: .66rem; text-transform: uppercase; letter-spacing: .04em; color: #9FB0CC; margin-bottom: 4px; }
        .ep2-tile .val { font-size: 1.1rem; font-weight: 700; }
        .ep2-tile .val.warn { color: #FFC164; }
        .ep2-tile .sub { font-size: .68rem; color: #9FB0CC; margin-top: 2px; }

        .ep2-timeline { background: #fff; border: 1px solid rgba(27,42,74,.08); border-radius: 12px; padding: 18px 20px; margin-bottom: 14px; display: flex; align-items: center; gap: 0; }
        .ep2-timeline-pt { display: flex; flex-direction: column; gap: 2px; min-width: 120px; }
        .ep2-timeline-pt.end { text-align: right; align-items: flex-end; }
        .ep2-timeline-pt .lbl { font-size: .66rem; text-transform: uppercase; letter-spacing: .04em; color: #8591A0; font-weight: 600; }
        .ep2-timeline-pt .date { font-size: .85rem; color: #1B2A4A; font-weight: 600; }
        .ep2-timeline-pt .time { font-size: .95rem; font-weight: 700; }
        .ep2-timeline-mid { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 0 16px; }
        .ep2-timeline-mid .arrow { color: #C6D0D8; font-size: 1.1rem; }
        .ep2-timeline-mid .dur { font-size: 1.15rem; font-weight: 700; color: #b8302c; }
        .ep2-timeline-mid .sub { font-size: .68rem; color: #8591A0; }

        .ep2-card { background: #fff; border: 1px solid rgba(27,42,74,.08); border-radius: 12px; height: 100%; }
        .ep2-card-head { padding: 12px 18px; border-bottom: 1px solid #eef1f4; font-weight: 700; font-size: .82rem; color: #1B2A4A; display: flex; align-items: center; gap: 8px; text-transform: uppercase; letter-spacing: .03em; }
        .ep2-card-body { padding: 16px 18px; }
        .ep2-field dt { font-size: .68rem; text-transform: uppercase; letter-spacing: .04em; color: #8591A0; font-weight: 600; margin-bottom: 2px; }
        .ep2-field dd { font-size: .85rem; color: #1B2A4A; font-weight: 600; margin: 0 0 12px; }
        .ep2-field dd.accent { color: #2f5a85; }
        .ep2-field dd.money { color: #b8302c; }
        .ep2-badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 11px; border-radius: 999px; font-size: .74rem; font-weight: 600; }
        .ep2-badge.tone-critical { background: #fbe6e4; color: #8a221e; }
        .ep2-badge.tone-warning { background: #faecd3; color: #7a4910; }
        .ep2-badge.tone-success { background: #e0efe4; color: #2d6a3f; }
        .ep2-badge.tone-info { background: #e2ecf5; color: #2f5a85; }
        .ep2-verdict { border-radius: 10px; padding: 12px 14px; font-size: .82rem; margin-top: 10px; }
        .ep2-verdict.tone-critical { background: #fbe6e4; color: #8a221e; }
        .ep2-verdict.tone-warning { background: #faecd3; color: #7a4910; }
        .ep2-verdict.tone-success { background: #e0efe4; color: #2d6a3f; }
        .ep2-verdict.tone-info { background: #e2ecf5; color: #2f5a85; }
        .ep2-loss-split { display: flex; gap: 10px; }
        .ep2-loss-split > div { flex: 1; border-radius: 8px; padding: 10px 12px; background: #f8fafb; }
        .ep2-loss-split .lbl { font-size: .66rem; text-transform: uppercase; color: #8591A0; font-weight: 600; margin-bottom: 2px; }
        .ep2-loss-split .val { font-size: .95rem; font-weight: 700; color: #1B2A4A; }
      `}</style>

      <button
        type="button"
        className="ep2-crumb-back"
        onClick={() => navigate(backTo || '/stockouts')}
      >
        <iconify-icon icon="solar:arrow-left-linear"></iconify-icon> Retour aux ruptures
      </button>

      {error ? (
        <div className="alert alert-danger">Erreur : {error}</div>
      ) : detail === null ? (
        <div className="text-muted small">Chargement des données de rupture...</div>
      ) : (
        <>
          {isLongDuration && (
            <div className="ep2-alert">
              <iconify-icon icon="solar:danger-triangle-bold-duotone" style={{ fontSize: '18px' }}></iconify-icon>
              Durée inhabituelle détectée — cette rupture dépasse 48h ({formatDuration(detail.totalDurationHours)}). Vérifiez si une commande a été passée.
            </div>
          )}

          {/* Header */}
          <div className="ep2-header">
            <div className="ep2-header-top">
              <div>
                <div className="eyebrow">Rupture n° {detail.ean}</div>
                <h2>{detail.label || detail.ean}</h2>
                <div className="meta">{detail.department || 'Sans rayon'} · {detail.sector || 'Sans secteur'}</div>
              </div>
              <span className={`ep2-status-badge ${detail.status === 'EN_COURS' ? 'active' : 'resolved'}`}>
                <iconify-icon icon={detail.status === 'EN_COURS' ? 'solar:alert-bold' : 'solar:check-circle-bold'}></iconify-icon>
                {detail.status === 'EN_COURS' ? 'Rupture active' : 'Résolue'}
              </span>
            </div>

            <div className="ep2-tiles">
              <div className="ep2-tile">
                <div className="lbl">Détectée le</div>
                <div className="val" style={{ fontSize: '.95rem' }}>{formatDate(detail.startedAt)}</div>
                <div className="sub">{formatTime(detail.startedAt)}</div>
              </div>
              <div className="ep2-tile">
                <div className={`val ${isLongDuration ? 'warn' : ''}`}>{formatDuration(detail.totalDurationHours)}</div>
                <div className="lbl" style={{ marginTop: 4 }}>Durée totale</div>
                <div className="sub">{detail.status === 'EN_COURS' ? 'Compteur toujours actif' : 'Rupture terminée'}</div>
              </div>
              <div className="ep2-tile">
                <div className="val">{formatMoney(detail.caPerdueEstime)}</div>
                <div className="lbl" style={{ marginTop: 4 }}>CA perdu estimé</div>
                <div className="sub">{detail.qtyPerdueEstimee !== null ? `${Math.round(detail.qtyPerdueEstimee)} unité(s)` : 'Estimation indisponible'}</div>
              </div>
              <div className="ep2-tile">
                <div className="val">{detail.order ? (detail.order.quantityOrdered ?? '—') : '—'}</div>
                <div className="lbl" style={{ marginTop: 4 }}>Quantité commandée</div>
                <div className="sub">{detail.order ? detail.order.rposOrderReference || `Commande ${detail.order.id.slice(0, 8)}` : 'Aucune commande'}</div>
              </div>
            </div>
          </div>

          {/* Timeline horizontale début → durée → fin */}
          <div className="ep2-timeline">
            <div className="ep2-timeline-pt">
              <span className="lbl">Début de rupture</span>
              <span className="date">{formatDate(detail.startedAt)}</span>
              <span className="time" style={{ color: '#2f5a85' }}>{formatTime(detail.startedAt)}</span>
            </div>
            <div className="ep2-timeline-mid">
              <iconify-icon icon="solar:arrow-right-linear" className="arrow"></iconify-icon>
              <span className="dur">{formatDuration(detail.totalDurationHours)}</span>
              <span className="sub">{detail.durationHours ? `${Math.round(detail.durationHours * 60)} minutes` : ''}</span>
            </div>
            <div className="ep2-timeline-pt end">
              <span className="lbl">Fin de rupture</span>
              <span className="date">{detail.endedAt ? formatDate(detail.endedAt) : 'En cours'}</span>
              <span className="time" style={{ color: detail.endedAt ? '#2d6a3f' : '#b8302c' }}>{detail.endedAt ? formatTime(detail.endedAt) : '—'}</span>
            </div>
          </div>

          {/* Informations générales + Métriques temporelles */}
          <div className="row g-3 mb-3">
            <div className="col-12 col-lg-6">
              <section className="ep2-card">
                <div className="ep2-card-head"><iconify-icon icon="solar:document-text-bold-duotone"></iconify-icon> Informations générales</div>
                <div className="ep2-card-body">
                  <dl className="row mb-0 ep2-field">
                    <div className="col-6"><dt>Article</dt><dd>{detail.label || detail.ean}</dd></div>
                    <div className="col-6"><dt>EAN</dt><dd style={{ fontFamily: 'monospace', fontSize: '.78rem' }}>{detail.ean}</dd></div>
                    <div className="col-6"><dt>Rayon</dt><dd>{detail.department || 'Sans rayon'}</dd></div>
                    <div className="col-6"><dt>Secteur</dt><dd>{detail.sector || 'Sans secteur'}</dd></div>
                    <div className="col-6"><dt>Cause probable</dt><dd>{CAUSE_LABELS[detail.causeProposee] || detail.causeProposee}</dd></div>
                    <div className="col-6"><dt>Confiance</dt><dd>{detail.niveauConfiance.toLowerCase()}</dd></div>
                  </dl>
                </div>
              </section>
            </div>
            <div className="col-12 col-lg-6">
              <section className="ep2-card">
                <div className="ep2-card-head"><iconify-icon icon="solar:clock-circle-bold-duotone"></iconify-icon> Métriques temporelles</div>
                <div className="ep2-card-body">
                  <dl className="row mb-0 ep2-field">
                    <div className="col-6"><dt>Rupture avant commande</dt><dd className="accent">{formatDuration(detail.reactionDelayHours)}</dd></div>
                    <div className="col-6"><dt>Rupture après commande</dt><dd className="money">{formatDuration(detail.replenishmentDelayHours)}</dd></div>
                    <div className="col-6"><dt>Perte avant commande</dt><dd>{formatMoney(detail.lossBeforeOrder?.caPerdue ?? null)}</dd></div>
                    <div className="col-6"><dt>Perte après commande</dt><dd>{formatMoney(detail.lossAfterOrder?.caPerdue ?? null)}</dd></div>
                  </dl>
                </div>
              </section>
            </div>
          </div>

          {/* Détection / Commande / Prise en charge — toute la traçabilité demandée */}
          <section className="ep2-card mb-3">
            <div className="ep2-card-head"><iconify-icon icon="solar:magnifer-bold-duotone"></iconify-icon> Détection / Commande / Prise en charge</div>
            <div className="ep2-card-body">
              <div className="row g-4">
                <div className="col-12 col-md-4">
                  <div className="text-muted text-uppercase mb-1" style={{ fontSize: '.68rem', fontWeight: 600 }}>Détection de la rupture</div>
                  <div style={{ fontWeight: 700, color: '#1B2A4A' }}>{formatDateTime(detail.startedAt)}</div>
                  <div className="small text-muted">Stock passé à 0 — compteur {detail.status === 'EN_COURS' ? 'toujours actif' : 'arrêté à la réception'}.</div>
                </div>
                <div className="col-12 col-md-4">
                  <div className="text-muted text-uppercase mb-1" style={{ fontSize: '.68rem', fontWeight: 600 }}>Commande passée</div>
                  {detail.order ? (
                    <>
                      <div style={{ fontWeight: 700, color: '#1B2A4A' }}>{formatDateTime(detail.order.createdAt)}</div>
                      <div className="small text-muted">N° {detail.order.rposOrderReference || detail.order.id.slice(0, 10)}</div>
                      <div className="small text-muted">Créée par {detail.order.createdBy || 'inconnu'}</div>
                      {detail.order.validatedAt ? (
                        <div className="small text-muted">Validée le {formatDateTime(detail.order.validatedAt)}{detail.order.validatedBy ? ` par ${detail.order.validatedBy}` : ''}</div>
                      ) : (
                        <div className="small text-muted">Pas encore validée</div>
                      )}
                    </>
                  ) : (
                    <div className="small text-muted">Aucune commande passée depuis le début de la rupture.</div>
                  )}
                </div>
                <div className="col-12 col-md-4">
                  <div className="text-muted text-uppercase mb-1" style={{ fontSize: '.68rem', fontWeight: 600 }}>Livraison</div>
                  {detail.order ? (
                    <>
                      <div style={{ fontWeight: 700, color: '#1B2A4A' }}>{detail.order.actualReceptionDate ? formatDateTime(detail.order.actualReceptionDate) : 'En attente'}</div>
                      <div className="small text-muted">
                        {detail.order.actualReceptionDate
                          ? `Reçue — ${RECEPTION_STATUS_LABELS[detail.order.receptionStatus] || detail.order.receptionStatus}`
                          : detail.order.expectedReceptionDate
                            ? `Prévue le ${formatDate(detail.order.expectedReceptionDate)}`
                            : 'Date prévue inconnue'}
                      </div>
                    </>
                  ) : (
                    <div className="small text-muted">—</div>
                  )}
                </div>
              </div>

              {reactionMeta && (
                <div className={`ep2-verdict tone-${reactionMeta.tone}`}>
                  <strong>{reactionMeta.label}.</strong> {reactionMeta.verdict}
                </div>
              )}

              {detail.order && (
                <div className="ep2-loss-split mt-3">
                  <div>
                    <div className="lbl">CA perdu avant commande</div>
                    <div className="val">{formatMoney(detail.lossBeforeOrder?.caPerdue ?? null)}</div>
                  </div>
                  <div>
                    <div className="lbl">CA perdu après commande</div>
                    <div className="val">{formatMoney(detail.lossAfterOrder?.caPerdue ?? null)}</div>
                  </div>
                </div>
              )}

              {detail.orderQuantitySufficiency && (
                <div className={`ep2-badge tone-${detail.orderQuantitySufficiency.sufficient ? 'success' : 'warning'} mt-3`}>
                  Quantité commandée ({detail.orderQuantitySufficiency.quantityOrdered} u) {detail.orderQuantitySufficiency.sufficient ? 'suffisante' : 'probablement insuffisante'} face à ~{Math.round(detail.orderQuantitySufficiency.expectedDemand)} u estimées sur la période.
                </div>
              )}
            </div>
          </section>

          {/* Historique des mouvements */}
          <section className="ep2-card mb-4">
            <div className="ep2-card-head"><iconify-icon icon="solar:history-bold-duotone"></iconify-icon> Mouvements de stock récents</div>
            <div className="table-responsive">
              <table className="table align-middle mb-0 table-hover table-centered">
                <thead className="bg-light-subtle">
                  <tr>
                    <th>Date / heure</th>
                    <th>Type</th>
                    <th className="text-end">Quantité</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.stockMoves.length === 0 ? (
                    <tr><td colSpan={3} className="text-center text-muted py-4">Aucun mouvement enregistré sur la période.</td></tr>
                  ) : (
                    detail.stockMoves.slice(0, 40).map((m, i) => (
                      <tr key={i}>
                        <td style={{ fontFamily: 'monospace', fontSize: '.8rem' }}>{formatDateTime(m.date)}</td>
                        <td>{m.typeLabel}{m.isScrap ? ' (casse)' : ''}</td>
                        <td className="text-end" style={{ fontFamily: 'monospace' }}>{m.quantity}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
