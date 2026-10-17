import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiFetch } from '../../shared/api/client';

// Page dédiée de détail d'une rupture (demande explicite du 17/10/2026, sur le modèle de
// "Analyse de rupture.html" fourni par l'utilisateur) — remplace l'ancienne modale
// (EpisodeDetailModal.tsx, conservée nulle part ailleurs) : même disposition que la maquette
// (header article, KPI, chronologie + commande/suffisance en 2 colonnes, cause, impact, historique)
// mais UNIQUEMENT avec les données réellement calculées côté backend (getEpisodeDetail). Les
// sections de la maquette sans équivalent réel dans ce projet (score fournisseur, patterns
// multi-incidents, "clients impactés", narration IA en texte libre, séparation "Magasin" vs
// "Entrepôt" — pas de données Cyrus, cf. rupture.md) sont retirées plutôt que remplies de valeurs
// inventées.
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

type ReactionStatus = 'EN_ATTENTE' | 'RETARD' | 'MAGASIN_NA_PAS_REAGI' | 'REAGI' | 'STOCK_PEUT_ETRE_PAS_A_JOUR';

type OrderQuantitySufficiency = { quantityOrdered: number; expectedDemand: number; sufficient: boolean };

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

const REACTION_STATUS_META: Record<ReactionStatus, { label: string; tone: 'critical' | 'warning' | 'success' | 'info' }> = {
  REAGI: { label: 'Le magasin a réagi', tone: 'success' },
  EN_ATTENTE: { label: 'En attente de commande (< 24h)', tone: 'info' },
  RETARD: { label: 'Retard de commande (24-48h)', tone: 'warning' },
  MAGASIN_NA_PAS_REAGI: { label: "Le magasin n'a pas réagi (> 48h)", tone: 'critical' },
  STOCK_PEUT_ETRE_PAS_A_JOUR: { label: 'Stock potentiellement pas à jour', tone: 'info' },
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

function formatMoney(value: number | null): string {
  if (value === null) return 'Estimation indisponible';
  return `${Math.round(value).toLocaleString('fr-FR')} CFA`;
}

export function StockoutEpisodePage() {
  const { episodeId } = useParams<{ episodeId: string }>();
  const navigate = useNavigate();
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

  // Chronologie unifiée (rupture, commande, réceptions, fin) triée par date — remplace la timeline
  // figée de la maquette (qui suppose toujours le même enchaînement création/validation/préparation/
  // expédition/réception, des étapes qu'on ne trace pas ici) par ce qu'on sait réellement dater.
  const timelineEvents: { date: string; label: string; desc: string; tone: 'critical' | 'done' | 'pending' }[] = [];
  if (detail) {
    timelineEvents.push({ date: detail.startedAt, label: 'Début de rupture détecté', desc: `Stock passé à 0 pour ${detail.label || detail.ean}.`, tone: 'critical' });
    if (detail.order) {
      timelineEvents.push({
        date: detail.order.createdAt,
        label: 'Commande passée',
        desc: `Délai de réaction : ${formatDuration(detail.reactionDelayHours)}${detail.order.quantityOrdered !== null ? ` — ${detail.order.quantityOrdered} unité(s) demandées` : ''}.`,
        tone: 'done',
      });
      for (const ev of detail.receptionEvents) {
        timelineEvents.push({
          date: ev.observedAt,
          label: 'Mise à jour réception',
          desc: RECEPTION_STATUS_LABELS[ev.receptionStatus] || ev.receptionStatus,
          tone: 'done',
        });
      }
    }
    if (detail.endedAt) {
      timelineEvents.push({ date: detail.endedAt, label: 'Retour en stock', desc: `Durée totale de la rupture : ${formatDuration(detail.totalDurationHours)}.`, tone: 'done' });
    } else {
      timelineEvents.push({ date: '', label: 'Retour en stock', desc: 'Rupture toujours en cours — information indisponible.', tone: 'pending' });
    }
    timelineEvents.sort((a, b) => {
      if (!a.date) return 1;
      if (!b.date) return -1;
      return new Date(a.date).getTime() - new Date(b.date).getTime();
    });
  }

  return (
    <div className="container-fluid py-4">
      <style>{`
        .ep-kpi { border: 1px solid rgba(27,42,74,.08); border-radius: 10px; padding: 16px; height: 100%; display: flex; flex-direction: column; background: #fff; }
        .ep-kpi .label { color: #8591A0; font-size: .68rem; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; margin-bottom: 8px; }
        .ep-kpi .value { color: #1B2A4A; font-size: 1.4rem; font-weight: 700; line-height: 1.1; }
        .ep-kpi .sub { color: #5B6B85; font-size: .72rem; margin-top: auto; padding-top: 6px; }
        .ep-kpi.tone-crit { border-left: 3px solid #b8302c; }
        .ep-kpi.tone-warn { border-left: 3px solid #a86718; }
        .ep-kpi.tone-info { border-left: 3px solid #2f5a85; }
        .ep-section-title { display: flex; align-items: baseline; gap: 12px; margin: 28px 0 12px; }
        .ep-section-title h5 { font-size: .8rem; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: #5B6B85; margin: 0; }
        .ep-section-title .rule { flex: 1; height: 1px; background: #e3e8ec; }
        .ep-card { background: #fff; border: 1px solid rgba(27,42,74,.08); border-radius: 12px; overflow: hidden; }
        .ep-card-head { padding: 14px 20px; border-bottom: 1px solid #eef1f4; font-weight: 700; font-size: .9rem; color: #1B2A4A; display: flex; align-items: center; justify-content: between; gap: 10px; }
        .ep-card-body { padding: 20px; }
        .ep-timeline-item { position: relative; padding-left: 36px; padding-bottom: 20px; }
        .ep-timeline-item:last-child { padding-bottom: 0; }
        .ep-timeline-item::before { content: ""; position: absolute; left: 9px; top: 20px; bottom: -4px; width: 2px; background: #e3e8ec; }
        .ep-timeline-item:last-child::before { display: none; }
        .ep-timeline-marker { position: absolute; left: 0; top: 2px; width: 18px; height: 18px; border-radius: 50%; border: 2px solid #c6d0d8; background: #fff; }
        .ep-timeline-marker.done { background: #0e5964; border-color: #0e5964; }
        .ep-timeline-marker.critical { background: #b8302c; border-color: #b8302c; }
        .ep-timeline-marker.pending { border-style: dashed; }
        .ep-badge { display: inline-flex; align-items: center; gap: 6px; padding: 5px 12px; border-radius: 999px; font-size: .78rem; font-weight: 600; }
        .ep-badge.tone-critical { background: #fbe6e4; color: #8a221e; }
        .ep-badge.tone-warning { background: #faecd3; color: #7a4910; }
        .ep-badge.tone-success { background: #e0efe4; color: #2d6a3f; }
        .ep-badge.tone-info { background: #e2ecf5; color: #2f5a85; }
        .ep-calc-row { display: flex; justify-content: space-between; padding: 7px 0; border-bottom: 1px dashed #e3e8ec; font-size: .82rem; }
        .ep-calc-row:last-child { border-bottom: none; }
        .ep-calc-row.total { border-top: 1px solid #c6d0d8; border-bottom: none; margin-top: 4px; padding-top: 10px; font-weight: 700; }
      `}</style>

      <div className="d-flex align-items-center gap-2 mb-3">
        <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => navigate(-1)}>
          <iconify-icon icon="solar:arrow-left-linear" className="align-middle"></iconify-icon> Retour
        </button>
        <nav className="small text-muted">Réassort / Ruptures de stock / {detail ? (detail.label || detail.ean) : '...'}</nav>
      </div>

      {error ? (
        <div className="alert alert-danger">Erreur : {error}</div>
      ) : detail === null ? (
        <div className="text-muted small">Chargement des données de rupture...</div>
      ) : (
        <>
          {/* Header article */}
          <section className="ep-card mb-4" style={{ borderTop: '3px solid #b8302c' }}>
            <div className="ep-card-body">
              <div className="row g-4 align-items-start">
                <div className="col-12 col-lg-8">
                  <div className="d-flex align-items-center gap-2 mb-2 small text-muted" style={{ fontFamily: 'monospace' }}>
                    <span className="badge bg-light text-dark border">{detail.ean}</span>
                  </div>
                  <h2 className="mb-3">{detail.label || detail.ean}</h2>
                  <dl className="row mb-0 small">
                    <dt className="col-6 col-md-3 text-muted text-uppercase" style={{ fontSize: '.68rem' }}>Rayon</dt>
                    <dd className="col-6 col-md-3">{detail.department || 'Sans rayon'}</dd>
                    <dt className="col-6 col-md-3 text-muted text-uppercase" style={{ fontSize: '.68rem' }}>Secteur</dt>
                    <dd className="col-6 col-md-3">{detail.sector || 'Sans secteur'}</dd>
                  </dl>
                </div>
                <div className="col-12 col-lg-4 text-lg-end">
                  <span className={`ep-badge tone-${detail.status === 'EN_COURS' ? 'critical' : 'success'}`}>
                    {detail.status === 'EN_COURS' ? 'Rupture active' : 'Résolue'}
                  </span>
                  <div className="mt-3">
                    <div className="text-muted text-uppercase" style={{ fontSize: '.68rem', fontWeight: 600 }}>Durée totale de rupture</div>
                    <div style={{ fontSize: '1.4rem', fontWeight: 700, color: detail.status === 'EN_COURS' ? '#b8302c' : '#1B2A4A' }}>
                      {formatDuration(detail.totalDurationHours)}
                    </div>
                    <div className="small text-muted" style={{ fontFamily: 'monospace' }}>Depuis le {formatDateTime(detail.startedAt)}</div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* KPI row */}
          <div className="row row-cols-2 row-cols-md-4 g-3 mb-2">
            <div className="col">
              <div className="ep-kpi tone-warn">
                <div className="label">Rupture avant commande</div>
                <div className="value">{formatDuration(detail.reactionDelayHours)}</div>
                <div className="sub">Entre détection et commande</div>
              </div>
            </div>
            <div className="col">
              <div className="ep-kpi tone-crit">
                <div className="label">Rupture après commande</div>
                <div className="value">{formatDuration(detail.replenishmentDelayHours)}</div>
                <div className="sub">Entre commande et réception</div>
              </div>
            </div>
            <div className="col">
              <div className="ep-kpi tone-info">
                <div className="label">CA perdu estimé</div>
                <div className="value" style={{ fontSize: '1.1rem' }}>{formatMoney(detail.caPerdueEstime)}</div>
                <div className="sub">{detail.qtyPerdueEstimee !== null ? `${Math.round(detail.qtyPerdueEstimee)} unité(s) perdues` : ' '}</div>
              </div>
            </div>
            <div className="col">
              <div className="ep-kpi">
                <div className="label">Quantité commandée</div>
                <div className="value">{detail.order?.quantityOrdered ?? '—'}</div>
                <div className="sub">{detail.order ? 'Commande associée' : 'Aucune commande'}</div>
              </div>
            </div>
          </div>

          {reactionMeta && (
            <div className="mb-4">
              <span className={`ep-badge tone-${reactionMeta.tone}`}>
                <iconify-icon icon="solar:bell-bold-duotone"></iconify-icon> {reactionMeta.label}
              </span>
              <span className="text-muted small ms-2">Cause probable : {CAUSE_LABELS[detail.causeProposee] || detail.causeProposee} ({detail.niveauConfiance.toLowerCase()})</span>
            </div>
          )}

          {/* Chronologie + Commande/Suffisance */}
          <div className="row g-3 mb-2">
            <div className="col-12 col-lg-7">
              <section className="ep-card h-100">
                <div className="ep-card-head">Chronologie des événements</div>
                <div className="ep-card-body">
                  {timelineEvents.map((ev, i) => (
                    <div className="ep-timeline-item" key={i}>
                      <span className={`ep-timeline-marker ${ev.tone}`}></span>
                      <div className="small text-muted" style={{ fontFamily: 'monospace' }}>{ev.date ? formatDateTime(ev.date) : '— —'}</div>
                      <div className="fw-semibold">{ev.label}</div>
                      <div className="small text-muted">{ev.desc}</div>
                    </div>
                  ))}
                </div>
              </section>
            </div>

            <div className="col-12 col-lg-5 d-flex flex-column gap-3">
              <section className="ep-card">
                <div className="ep-card-head">Commande associée</div>
                <div className="ep-card-body">
                  {!detail.order ? (
                    <p className="text-muted small mb-0">Aucune commande identifiée depuis le début de la rupture.</p>
                  ) : (
                    <dl className="row small mb-0">
                      <dt className="col-6 text-muted">Créée le</dt><dd className="col-6" style={{ fontFamily: 'monospace' }}>{formatDateTime(detail.order.createdAt)}</dd>
                      <dt className="col-6 text-muted">Qté commandée</dt><dd className="col-6">{detail.order.quantityOrdered ?? '—'}</dd>
                      <dt className="col-6 text-muted">Statut réception</dt><dd className="col-6">{RECEPTION_STATUS_LABELS[detail.order.receptionStatus] || detail.order.receptionStatus}</dd>
                      <dt className="col-6 text-muted">Réception prévue</dt><dd className="col-6">{formatDateTime(detail.order.expectedReceptionDate)}</dd>
                      <dt className="col-6 text-muted">Réception réelle</dt><dd className="col-6">{formatDateTime(detail.order.actualReceptionDate)}</dd>
                      <dt className="col-6 text-muted">Fournisseur</dt><dd className="col-6">{detail.order.supplierName || '—'}</dd>
                    </dl>
                  )}
                </div>
              </section>

              {detail.orderQuantitySufficiency && (
                <section className="ep-card">
                  <div className="ep-card-head">Suffisance de la commande</div>
                  <div className="ep-card-body">
                    <div className={`ep-badge tone-${detail.orderQuantitySufficiency.sufficient ? 'success' : 'warning'} mb-3`}>
                      {detail.orderQuantitySufficiency.sufficient ? 'Quantité suffisante' : 'Quantité probablement insuffisante'}
                    </div>
                    <div className="ep-calc-row"><span className="text-muted">Commandé</span><span style={{ fontFamily: 'monospace' }}>{detail.orderQuantitySufficiency.quantityOrdered} u</span></div>
                    <div className="ep-calc-row total"><span>Demande estimée (période)</span><span style={{ fontFamily: 'monospace' }}>{Math.round(detail.orderQuantitySufficiency.expectedDemand)} u</span></div>
                  </div>
                </section>
              )}
            </div>
          </div>

          {/* Cause */}
          <div className="ep-section-title"><h5>Cause de la rupture</h5><span className="rule"></span></div>
          <section className="ep-card mb-2">
            <div className="ep-card-body d-flex align-items-center justify-content-between flex-wrap gap-3">
              <div>
                <div className="text-muted text-uppercase mb-1" style={{ fontSize: '.68rem', fontWeight: 600 }}>Diagnostic (sans données entrepôt)</div>
                <div style={{ fontSize: '1.15rem', fontWeight: 700, color: '#1B2A4A' }}>{CAUSE_LABELS[detail.causeProposee] || detail.causeProposee}</div>
              </div>
              <span className="ep-badge tone-info">Confiance : {detail.niveauConfiance.toLowerCase()}</span>
            </div>
          </section>

          {/* Impact commercial */}
          <div className="ep-section-title"><h5>Impact commercial estimé</h5><span className="rule"></span></div>
          <section className="ep-card mb-2">
            <div className="ep-card-body">
              <div className="row row-cols-2 row-cols-md-4 g-3 mb-3">
                <div className="col">
                  <div className="text-muted text-uppercase" style={{ fontSize: '.68rem', fontWeight: 600 }}>CA perdu estimé</div>
                  <div style={{ fontSize: '1.2rem', fontWeight: 700, color: '#b8302c' }}>{formatMoney(detail.caPerdueEstime)}</div>
                </div>
                <div className="col">
                  <div className="text-muted text-uppercase" style={{ fontSize: '.68rem', fontWeight: 600 }}>Unités perdues (estimées)</div>
                  <div style={{ fontSize: '1.2rem', fontWeight: 700 }}>{detail.qtyPerdueEstimee !== null ? Math.round(detail.qtyPerdueEstimee) : '—'}</div>
                </div>
                <div className="col">
                  <div className="text-muted text-uppercase" style={{ fontSize: '.68rem', fontWeight: 600 }}>Ventes avant ({detail.salesBeforeEpisode.windowDays}j)</div>
                  <div style={{ fontSize: '1.2rem', fontWeight: 700 }}>{detail.salesBeforeEpisode.quantity} u</div>
                </div>
                <div className="col">
                  <div className="text-muted text-uppercase" style={{ fontSize: '.68rem', fontWeight: 600 }}>Ventes pendant la rupture</div>
                  <div style={{ fontSize: '1.2rem', fontWeight: 700 }}>{detail.salesDuringEpisode.quantity} u</div>
                </div>
              </div>
              <div className="small text-muted" style={{ background: '#f8fafb', padding: '12px 14px', borderRadius: 6, borderLeft: '2px solid #2f5a85' }}>
                Méthode : vente moyenne du même jour de semaine sur les 8 semaines comparables précédentes (minimum 4 semaines avec historique), moins les ventes réellement réalisées pendant la rupture.
                {detail.caPerdueEstime === null && ' Historique de ventes insuffisant pour cet article : estimation indisponible.'}
              </div>
            </div>
          </section>

          {/* Historique / traçabilité */}
          <div className="ep-section-title"><h5>Historique et traçabilité</h5><span className="rule"></span></div>
          <section className="ep-card mb-4">
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
