import { useEffect, useState } from 'react';
import { apiFetch } from './api/client';

interface RecipientUser {
  email: string;
  name: string;
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

  useEffect(() => {
    (async () => {
      try {
        const result = await apiFetch<MailRecipientsData>('/reassort/mail-recipients');
        setData(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

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

  return (
    <div className="row">
      <div className="col-12 mb-4">
        <h2 className="h4 mb-1">Destinataires des alertes email</h2>
        <p className="text-muted mb-0">
          Pour chaque magasin, les comptes qui reçoivent l'alerte de nouvelle proposition (rattachement direct + superviseurs).
          Les administrateurs ne sont plus inclus par magasin : ils reçoivent un récap global unique en fin de génération nocturne (liste ci-dessous).
          Cette liste est calculée automatiquement selon le rôle et le rattachement de chaque compte — pour changer un destinataire, modifiez son compte depuis la page Utilisateurs.
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
                <h3 className="h6 mb-3">Administrateurs — récap nocturne global ({data.admins.length})</h3>
                {data.admins.length === 0 ? (
                  <p className="text-muted small mb-0">Aucun administrateur actif.</p>
                ) : (
                  <ul className="list-inline mb-0">
                    {data.admins.map((a) => (
                      <li key={a.email} className="list-inline-item badge bg-secondary me-2 mb-2 fw-normal">
                        {a.name} ({a.email})
                      </li>
                    ))}
                  </ul>
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
                              s.recipients.map((r) => (
                                <span key={r.email} className="badge bg-light text-dark border me-1 mb-1 fw-normal">
                                  {r.name} ({r.email})
                                </span>
                              ))
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
