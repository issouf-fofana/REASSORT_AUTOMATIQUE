import { useEffect, useState } from 'react';
import { apiFetch } from './api/client';

interface RecipientUser {
  id: string;
  email: string;
  name: string;
  mailAlertsEnabled: boolean;
}

interface ShopRecipients {
  shop: { reference: string; name: string };
  recipients: RecipientUser[];
}

interface MailRecipientsData {
  shops: ShopRecipients[];
  admins: RecipientUser[];
}

export function MailRecipients() {
  const [data, setData] = useState<MailRecipientsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [onlyEmpty, setOnlyEmpty] = useState(false);
  // Comptes en cours de bascule (demande du 26/09/2026 : "ajouter la possibilité de cocher/décocher
  // par personne") — désactive la case le temps de l'appel pour éviter un double-clic qui enverrait
  // deux requêtes concurrentes sur le même compte.
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const result = await apiFetch<MailRecipientsData>('/reassort/mail-recipients');
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function toggleUser(user: RecipientUser) {
    const nextEnabled = !user.mailAlertsEnabled;
    setSavingIds((prev) => new Set(prev).add(user.id));
    try {
      await window.reassortFetch(`/reassort/mail-recipients/${user.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      // Mise à jour optimiste locale plutôt qu'un rechargement complet : cette même personne peut
      // apparaître dans plusieurs magasins (superviseur) et dans le bloc admin — un seul état à
      // synchroniser partout, sans reperdre le scroll/filtre en cours.
      setData((prev) => {
        if (!prev) return prev;
        const patchUser = (u: RecipientUser) => (u.id === user.id ? { ...u, mailAlertsEnabled: nextEnabled } : u);
        return {
          admins: prev.admins.map(patchUser),
          shops: prev.shops.map((s) => ({ ...s, recipients: s.recipients.map(patchUser) })),
        };
      });
      window.reassortToast(nextEnabled ? `${user.name} recevra à nouveau les alertes.` : `${user.name} ne recevra plus les alertes.`, 'success');
    } catch (err) {
      window.reassortToast(err instanceof Error ? err.message : 'Erreur lors de la mise à jour.', 'error');
    } finally {
      setSavingIds((prev) => {
        const next = new Set(prev);
        next.delete(user.id);
        return next;
      });
    }
  }

  const filteredShops = (data?.shops || []).filter((s) => {
    if (onlyEmpty && s.recipients.length > 0) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      s.shop.reference.toLowerCase().includes(q) ||
      s.shop.name.toLowerCase().includes(q) ||
      s.recipients.some((r) => r.name.toLowerCase().includes(q) || r.email.toLowerCase().includes(q))
    );
  });

  function renderUserCheckbox(user: RecipientUser) {
    return (
      <label
        key={user.id}
        className={`badge border me-1 mb-1 fw-normal d-inline-flex align-items-center gap-1 ${user.mailAlertsEnabled ? 'bg-light text-dark' : 'bg-danger-subtle text-danger text-decoration-line-through'}`}
        style={{ cursor: 'pointer' }}
        title={user.mailAlertsEnabled ? 'Décocher pour exclure cette personne des alertes email' : 'Cocher pour réactiver les alertes email pour cette personne'}
      >
        <input
          type="checkbox"
          checked={user.mailAlertsEnabled}
          disabled={savingIds.has(user.id)}
          onChange={() => toggleUser(user)}
          style={{ marginRight: 4 }}
        />
        {user.name} ({user.email})
      </label>
    );
  }

  return (
    <div className="row">
      <div className="col-12 mb-4">
        <h2 className="h4 mb-1">Destinataires des alertes email</h2>
        <p className="text-muted mb-0">
          Pour chaque magasin, les comptes qui reçoivent l'alerte de nouvelle proposition (rattachement direct + superviseurs).
          Les administrateurs ne sont plus inclus par magasin : ils reçoivent un récap global unique en fin de génération nocturne et de relance (liste ci-dessous).
          Décochez une personne pour l'exclure de toutes les alertes email — cela ne change ni son rôle ni son accès à l'application, uniquement s'il reçoit ces emails automatiques.
        </p>
      </div>

      {error && (
        <div className="col-12">
          <div className="alert alert-danger">{error}</div>
        </div>
      )}

      {loading ? (
        <div className="col-12 text-center text-muted py-5">Chargement...</div>
      ) : data ? (
        <>
          <div className="col-12 mb-4">
            <div className="card">
              <div className="card-body">
                <h3 className="h6 mb-3">Administrateurs — récap global ({data.admins.length})</h3>
                {data.admins.length === 0 ? (
                  <p className="text-muted small mb-0">Aucun administrateur actif.</p>
                ) : (
                  <div>{data.admins.map(renderUserCheckbox)}</div>
                )}
              </div>
            </div>
          </div>

          <div className="col-12 mb-3 d-flex gap-2 flex-wrap align-items-center">
            <input
              type="text"
              className="form-control w-auto flex-grow-1"
              placeholder="Rechercher un magasin ou un destinataire..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ minWidth: 260 }}
            />
            <div className="form-check">
              <input
                type="checkbox"
                className="form-check-input"
                id="onlyEmpty"
                checked={onlyEmpty}
                onChange={(e) => setOnlyEmpty(e.target.checked)}
              />
              <label className="form-check-label" htmlFor="onlyEmpty">
                Magasins sans aucun destinataire
              </label>
            </div>
          </div>

          <div className="col-12">
            <div className="card">
              <div className="card-body p-0">
                <div className="table-responsive">
                  <table className="table table-sm mb-0">
                    <thead>
                      <tr>
                        <th>Magasin</th>
                        <th>Destinataires</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredShops.map((s) => (
                        <tr key={s.shop.reference}>
                          <td className="fw-semibold">{s.shop.reference} — {s.shop.name}</td>
                          <td>
                            {s.recipients.length === 0 ? (
                              <span className="badge bg-danger-subtle text-danger">Aucun destinataire</span>
                            ) : (
                              s.recipients.map(renderUserCheckbox)
                            )}
                          </td>
                        </tr>
                      ))}
                      {filteredShops.length === 0 && (
                        <tr>
                          <td colSpan={2} className="text-center text-muted py-4">Aucun résultat pour ce filtre.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
