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
    <div className="card mb-2">
      <div className="card-body">
        <div className="d-flex justify-content-between align-items-start flex-wrap gap-2">
          <div>
            <span className={`badge oa-badge-${a.direction}`}>{DIRECTION_LABEL[a.direction] || a.direction}</span>{' '}
            <span className="badge bg-secondary">{STATUS_LABEL[a.status] || a.status}</span>
          </div>
          <span className="small text-muted">{fmtDate(a.detectedAt)}</span>
        </div>
        <div className="mt-2 fw-semibold">
          {a.label || a.ean} <span className="text-muted small">({a.ean})</span>
        </div>
        <div className="small text-muted mt-1">
          Magasin : {a.shopReference ? `${a.shopReference}${a.shopName ? ' — ' + a.shopName : ''}` : a.rposShopId}
        </div>
        <div className="mt-2">
          Quantité proposée : <strong>{fmtNum(a.newQuantity)}</strong> — habituellement entre <strong>{fmtNum(a.historicalMin)}</strong> et{' '}
          <strong>{fmtNum(a.historicalMax)}</strong> (moyenne {fmtNum(a.historicalMean)}, sur {a.sampleSize} commande(s) passée(s))
        </div>
        {a.contextNote && (
          <div className="small text-muted mt-2">
            <em>Note : {a.contextNote}</em>
          </div>
        )}
        {a.status === 'PENDING' && (
          <div className="mt-3">
            <button type="button" className="btn btn-sm btn-outline-primary" onClick={() => onAction(a.id, 'ACKNOWLEDGED')}>
              Accepter
            </button>{' '}
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
        .oa-badge-HIGH { background-color: #fd7e14; }
        .oa-badge-LOW { background-color: #dc3545; }
      `}</style>

      <div className="card mb-3">
        <div className="card-body">
          <div className="alert alert-light border small mb-0">
            <strong>À quoi ça sert :</strong> chaque fois qu'une quantité proposée pour un article s'écarte significativement de l'historique des
            quantités déjà validées pour ce même article, une anomalie apparaît ici — <strong>trop haute</strong> (risque de surstock) ou{' '}
            <strong>trop basse</strong> (risque de rupture malgré la commande). Une anomalie ne signifie jamais "erreur" : elle signale seulement
            un écart par rapport à l'habitude — une promotion, une reprise d'activité ou un événement particulier peut parfaitement l'expliquer.
            Vérifiez le contexte avant de valider la commande concernée.
          </div>
        </div>
      </div>

      <div className="card mb-3">
        <div className="card-body d-flex flex-wrap gap-2 align-items-center">
          <select className="form-select" style={{ maxWidth: 200 }} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Toutes (sauf traitées)</option>
            <option value="PENDING">À vérifier</option>
            <option value="ACKNOWLEDGED">Acceptées</option>
            <option value="DISMISSED">Ignorées</option>
          </select>
          <span className="small text-muted ms-auto">{rows ? `${rows.length} anomalie(s)` : ''}</span>
        </div>
      </div>

      {error ? (
        <div className="alert alert-danger">{error}</div>
      ) : rows === null ? (
        <div className="text-center text-muted py-4">Chargement...</div>
      ) : rows.length === 0 ? (
        <div className="text-center text-muted py-4">Aucune anomalie pour ce filtre.</div>
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
