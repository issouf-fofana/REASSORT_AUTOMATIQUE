import { useEffect, useState } from 'react';
import { apiFetch } from './api/client';
import type { OrderAnomaly } from './types';

const STATUS_LABEL: Record<string, string> = { PENDING: 'À vérifier', ACKNOWLEDGED: 'Acceptée', DISMISSED: 'Ignorée' };
const DIRECTION_LABEL: Record<string, string> = {
  HIGH: 'Quantité inhabituellement élevée (risque de surstock)',
  LOW: 'Quantité inhabituellement faible (risque de rupture)',
};

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString('fr-FR') : '—';
}
function fmtNum(n: number): number {
  return Math.round(n * 10) / 10;
}

function AnomalyCard({ a, onAction }: { a: OrderAnomaly; onAction: (id: string, status: 'ACKNOWLEDGED' | 'DISMISSED') => void }) {
  return (
    <div className="oa-card">
      <div className={`oa-card-icon oa-card-icon-${a.direction}`}>
        <iconify-icon icon={a.direction === 'HIGH' ? 'solar:double-alt-arrow-up-bold-duotone' : 'solar:double-alt-arrow-down-bold-duotone'}></iconify-icon>
      </div>
      <div className="oa-card-body">
        <div className="d-flex justify-content-between align-items-start flex-wrap gap-2 mb-1">
          <div className="d-flex flex-wrap gap-2 align-items-center">
            <span className={`oa-direction-badge oa-direction-${a.direction}`}>{DIRECTION_LABEL[a.direction] || a.direction}</span>
            <span className="oa-status-badge">{STATUS_LABEL[a.status] || a.status}</span>
          </div>
          <span className="oa-date">{fmtDate(a.detectedAt)}</span>
        </div>
        <div className="oa-article">
          {a.label || a.ean} <span className="oa-ean">({a.ean})</span>
        </div>
        <div className="oa-shop">
          Magasin : {a.shopReference ? `${a.shopReference}${a.shopName ? ' — ' + a.shopName : ''}` : a.rposShopId}
        </div>
        <div className="oa-figures">
          Quantité proposée : <strong>{fmtNum(a.newQuantity)}</strong> — habituellement entre <strong>{fmtNum(a.historicalMin)}</strong> et{' '}
          <strong>{fmtNum(a.historicalMax)}</strong> (moyenne {fmtNum(a.historicalMean)}, sur {a.sampleSize} commande(s) passée(s))
        </div>
        {a.contextNote && <div className="oa-note">Note : {a.contextNote}</div>}
        {a.status === 'PENDING' && (
          <div className="mt-3">
            <button type="button" className="btn btn-sm btn-outline-dark me-2" onClick={() => onAction(a.id, 'ACKNOWLEDGED')}>
              Accepter
            </button>
            <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => onAction(a.id, 'DISMISSED')}>
              Ignorer
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function OrderAnomalies() {
  const [status, setStatus] = useState('');
  const [rows, setRows] = useState<OrderAnomaly[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<{ id: string; status: 'ACKNOWLEDGED' | 'DISMISSED' } | null>(null);
  const [noteText, setNoteText] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);

  async function loadList() {
    setError(null);
    try {
      const q = status ? `?status=${encodeURIComponent(status)}` : '';
      let data = await apiFetch<OrderAnomaly[]>(`/reassort/order-anomalies${q}`);
      // "Toutes (sauf traitées)" par défaut : sans filtre explicite, on masque les DISMISSED pour ne
      // pas noyer les vraies anomalies à vérifier sous les fausses alertes déjà closes.
      if (!status) data = data.filter((a) => a.status !== 'DISMISSED');
      setRows(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  function openNoteModal(id: string, actionStatus: 'ACKNOWLEDGED' | 'DISMISSED') {
    setPendingAction({ id, status: actionStatus });
    setNoteText('');
    setNoteError(null);
  }

  async function confirmNote() {
    if (!pendingAction) return;
    setNoteError(null);
    try {
      await apiFetch(`/reassort/order-anomalies/${pendingAction.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: pendingAction.status, contextNote: noteText.trim() || null }),
      });
      setPendingAction(null);
      await loadList();
    } catch (err) {
      setNoteError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div>
      <style>{`
        .oa-intro {
          background: #fafafa; border: 1px solid #ececec; border-radius: 12px;
          padding: 1.1rem 1.35rem; margin-bottom: 1.5rem; font-size: .87rem; color: #444444; line-height: 1.6;
        }
        .oa-intro strong { color: #000000; }

        .oa-toolbar { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; margin-bottom: 1.5rem; }
        .oa-toolbar select { max-width: 220px; }
        .oa-toolbar-count { color: #9198a1; font-size: .82rem; margin-left: auto; }

        .oa-card {
          display: flex; gap: 1rem;
          background: #ffffff; border: 1px solid #ececec; border-radius: 14px;
          padding: 1.15rem 1.35rem; margin-bottom: 1rem;
          box-shadow: 0 1px 2px rgba(20, 20, 20, .03);
          transition: box-shadow .2s ease, border-color .2s ease;
        }
        .oa-card:hover { box-shadow: 0 4px 16px rgba(20, 20, 20, .06); border-color: #e2e4e7; }
        .oa-card-icon {
          width: 38px; height: 38px; border-radius: 10px; flex-shrink: 0;
          display: flex; align-items: center; justify-content: center; font-size: 1.2rem;
        }
        .oa-card-icon-HIGH { background: #fdf0e3; color: #d68910; }
        .oa-card-icon-LOW { background: #fdecea; color: #c0392b; }
        .oa-card-body { min-width: 0; flex: 1; }

        .oa-direction-badge { font-size: .7rem; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; padding: .25rem .65rem; border-radius: 999px; }
        .oa-direction-HIGH { background: #fdf0e3; color: #b9770e; }
        .oa-direction-LOW { background: #fdecea; color: #c0392b; }
        .oa-status-badge { font-size: .7rem; font-weight: 600; text-transform: uppercase; letter-spacing: .03em; color: #6c757d; background: #f1f2f4; padding: .25rem .65rem; border-radius: 999px; }
        .oa-date { font-size: .78rem; color: #9198a1; }

        .oa-article { font-weight: 700; font-size: .95rem; color: #17181a; margin-top: .5rem; }
        .oa-ean { color: #9198a1; font-size: .82rem; font-weight: 400; }
        .oa-shop { font-size: .82rem; color: #6c757d; margin-top: .2rem; }
        .oa-figures { font-size: .88rem; color: #2c2d30; margin-top: .6rem; }
        .oa-note { font-size: .82rem; color: #6c757d; font-style: italic; margin-top: .6rem; }
      `}</style>

      <div className="oa-intro">
        <strong>À quoi ça sert :</strong> chaque fois qu'une quantité proposée pour un article s'écarte significativement de l'historique des
        quantités déjà validées pour ce même article, une anomalie apparaît ici — <strong>trop haute</strong> (risque de surstock) ou{' '}
        <strong>trop basse</strong> (risque de rupture malgré la commande). Une anomalie ne signifie jamais "erreur" : elle signale seulement
        un écart par rapport à l'habitude — une promotion, une reprise d'activité ou un événement particulier peut parfaitement l'expliquer.
        Vérifiez le contexte avant de valider la commande concernée.
      </div>

      <div className="oa-toolbar">
        <select className="form-select" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Toutes (sauf traitées)</option>
          <option value="PENDING">À vérifier</option>
          <option value="ACKNOWLEDGED">Acceptées</option>
          <option value="DISMISSED">Ignorées</option>
        </select>
        <span className="oa-toolbar-count">{rows ? `${rows.length} anomalie(s)` : ''}</span>
      </div>

      {error ? (
        <div className="alert alert-danger">{error}</div>
      ) : rows === null ? (
        <div className="text-center text-muted py-4">Chargement...</div>
      ) : rows.length === 0 ? (
        <div className="text-center text-muted py-5">
          <iconify-icon icon="solar:check-circle-bold-duotone" style={{ fontSize: '2rem', color: '#c9ccd1' }}></iconify-icon>
          <div className="mt-2">Aucune anomalie pour ce filtre.</div>
        </div>
      ) : (
        rows.map((a) => <AnomalyCard a={a} onAction={openNoteModal} key={a.id} />)
      )}

      {pendingAction && (
        <>
          <div className="modal fade show" style={{ display: 'block' }} tabIndex={-1} role="dialog">
            <div className="modal-dialog" role="document">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">
                    {pendingAction.status === 'ACKNOWLEDGED' ? 'Accepter cette anomalie' : 'Ignorer cette anomalie'}
                  </h5>
                  <button type="button" className="btn-close" onClick={() => setPendingAction(null)}></button>
                </div>
                <div className="modal-body">
                  <label className="form-label fw-semibold">
                    {pendingAction.status === 'ACKNOWLEDGED' ? "Pourquoi cet écart est-il justifié ? (optionnel)" : 'Motif (optionnel)'}
                  </label>
                  <textarea
                    className="form-control"
                    rows={3}
                    placeholder="Ex: promotion confirmée, reprise d'activité..."
                    value={noteText}
                    onChange={(e) => setNoteText(e.target.value)}
                  ></textarea>
                  {noteError && <div className="alert alert-danger mt-2">{noteError}</div>}
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn btn-outline-secondary" onClick={() => setPendingAction(null)}>
                    Annuler
                  </button>
                  <button type="button" className="btn btn-primary" onClick={confirmNote}>
                    Confirmer
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show"></div>
        </>
      )}
    </div>
  );
}
