import { useEffect, useState } from 'react';
import { apiFetch } from '../../api/client';

// "Comptes mail" (demande du 25/09/2026) : configuration du compte Outlook/Microsoft Graph utilisé
// pour alerter par email les personnes rattachées à un magasin dès qu'une génération nocturne
// produit une proposition de commande. Layout inspiré de la capture fournie par l'utilisateur
// (carte compte + config repliable + bouton Tester), un seul compte actif géré en V1.
//
// Le refresh token n'est JAMAIS saisi à la main : demande explicite du 25/09/2026 d'éviter le
// copier-coller manuel d'un token. Il est obtenu via le bouton "Connecter Outlook", qui ouvre le
// flux OAuth Microsoft (routes/oauthOutlook.js côté backend) dans un nouvel onglet — Azure redirige
// ensuite vers le backend, qui enregistre le refresh token chiffré directement en base.
interface MailAccount {
  id: string;
  email: string;
  provider: string;
  clientId: string;
  tenantId: string;
  maskedClientSecret: string;
  hasRefreshToken: boolean;
  isActive: boolean;
  lastTestedAt: string | null;
  lastTestSuccess: boolean | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString('fr-FR') : 'jamais';
}

function AccountCard({ account, onChanged }: { account: MailAccount; onChanged: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [email, setEmail] = useState(account.email);
  const [clientId, setClientId] = useState(account.clientId);
  const [tenantId, setTenantId] = useState(account.tenantId);
  const [clientSecret, setClientSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const payload: Record<string, unknown> = { email, clientId, tenantId };
      if (clientSecret) payload.clientSecret = clientSecret;
      await apiFetch(`/reassort/mail-accounts/${account.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      setClientSecret('');
      setSuccess('Enregistré.');
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleActive(next: boolean) {
    try {
      await apiFetch(`/reassort/mail-accounts/${account.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: next }),
      });
      onChanged();
    } catch (err) {
      window.reassortToast('Erreur : ' + (err as Error).message, 'error');
    }
  }

  async function handleDelete() {
    if (!(await window.reassortConfirm('Supprimer ce compte mail ? Les alertes par email cesseront jusqu\'à reconfiguration.'))) return;
    try {
      await apiFetch(`/reassort/mail-accounts/${account.id}`, { method: 'DELETE' });
      onChanged();
    } catch (err) {
      window.reassortToast('Erreur : ' + (err as Error).message, 'error');
    }
  }

  async function handleTest() {
    setTesting(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await window.reassortFetch(`/reassort/mail-accounts/${account.id}/test`, { method: 'POST' });
      const json: { success: boolean; message: string } = await res.json();
      if (!json.success) throw new Error(json.message);
      setSuccess(json.message);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
      onChanged();
    } finally {
      setTesting(false);
    }
  }

  function handleConnectOutlook() {
    const token = window.reassortGetToken() || '';
    const apiBase = (window.REASSORT_BACKEND_URL || `${window.location.protocol}//${window.location.hostname}:3001`) + '/api';
    const url = `${apiBase}/oauth/outlook/start?accountId=${encodeURIComponent(account.id)}&token=${encodeURIComponent(token)}`;
    // Vraie navigation dans un nouvel onglet (pas un fetch) : Azure doit rediriger un navigateur,
    // pas répondre à un appel XHR — l'utilisateur revient ensuite sur cet onglet Paramètres et
    // clique "Actualiser" (ou onChanged()) pour voir hasRefreshToken passer à true.
    window.open(url, '_blank', 'noopener');
  }

  return (
    <div className="card mb-3">
      <div className="card-body">
        <div className="d-flex justify-content-between align-items-start flex-wrap gap-2">
          <div className="d-flex align-items-center gap-2 flex-wrap">
            <h5 className="mb-0">{account.email}</h5>
            <span className="badge bg-secondary">{account.provider}</span>
            {account.isActive && <span className="badge bg-primary">Actif</span>}
            {!account.hasRefreshToken && <span className="badge bg-warning-subtle text-warning">Outlook non connecté</span>}
          </div>
          <div className="d-flex align-items-center gap-2">
            <button type="button" className="btn btn-sm btn-outline-secondary" disabled={testing || !account.hasRefreshToken} onClick={handleTest}>
              <iconify-icon icon="solar:plain-bold-duotone" className="align-middle"></iconify-icon> {testing ? 'Envoi...' : 'Tester'}
            </button>
            <div className="form-check form-switch mb-0">
              <input
                className="form-check-input"
                type="checkbox"
                role="switch"
                checked={account.isActive}
                onChange={(e) => handleToggleActive(e.target.checked)}
              />
            </div>
            <button type="button" className="btn btn-sm btn-outline-danger" onClick={handleDelete}>
              <iconify-icon icon="solar:trash-bin-minimalistic-bold-duotone"></iconify-icon>
            </button>
          </div>
        </div>

        <div className="small text-muted mt-2">
          Dernier test : {fmtDate(account.lastTestedAt)}
          {account.lastTestedAt && (
            <span className={account.lastTestSuccess ? 'text-success ms-2' : 'text-danger ms-2'}>
              {account.lastTestSuccess ? '✓ réussi' : '✗ échoué'}
            </span>
          )}
        </div>
        {account.lastError && <div className="small text-danger mt-1">Dernière erreur : {account.lastError}</div>}

        <button type="button" className="btn btn-outline-dark btn-sm mt-2" onClick={handleConnectOutlook}>
          <iconify-icon icon="solar:letter-bold-duotone" className="align-middle"></iconify-icon>{' '}
          {account.hasRefreshToken ? 'Reconnecter Outlook' : 'Connecter Outlook'}
        </button>

        <button type="button" className="btn btn-link btn-sm px-0 mt-2 d-block" onClick={() => setExpanded(!expanded)}>
          <iconify-icon icon="solar:settings-bold-duotone" className="align-middle"></iconify-icon>{' '}
          {expanded ? 'Masquer' : 'Afficher'} la configuration de connexion
        </button>

        {expanded && (
          <div className="mt-3 pt-3 border-top">
            {error && <div className="alert alert-danger small">{error}</div>}
            {success && <div className="alert alert-success small">{success}</div>}
            <div className="row g-3">
              <div className="col-md-6">
                <label className="form-label small fw-semibold text-uppercase">Email</label>
                <input type="email" className="form-control" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div className="col-md-6">
                <label className="form-label small fw-semibold text-uppercase">Client ID</label>
                <input type="text" className="form-control" value={clientId} onChange={(e) => setClientId(e.target.value)} />
              </div>
              <div className="col-md-6">
                <label className="form-label small fw-semibold text-uppercase">Tenant ID</label>
                <input type="text" className="form-control" value={tenantId} onChange={(e) => setTenantId(e.target.value)} />
              </div>
              <div className="col-md-6">
                <label className="form-label small fw-semibold text-uppercase">Client Secret</label>
                <div className="input-group">
                  <input
                    type={showSecret ? 'text' : 'password'}
                    className="form-control"
                    placeholder={account.maskedClientSecret}
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                  />
                  <button type="button" className="btn btn-outline-secondary" onClick={() => setShowSecret(!showSecret)}>
                    <iconify-icon icon={showSecret ? 'solar:eye-closed-linear' : 'solar:eye-linear'}></iconify-icon>
                  </button>
                </div>
                <div className="form-text">Laisser vide pour conserver la valeur actuelle ({account.maskedClientSecret}).</div>
              </div>
            </div>
            <div className="form-text mt-2">
              Le refresh token n'est jamais saisi ici : utilisez le bouton "{account.hasRefreshToken ? 'Reconnecter' : 'Connecter'} Outlook"
              ci-dessus, qui l'obtient automatiquement via la connexion Microsoft.
            </div>
            <button type="button" className="btn btn-primary mt-3" disabled={saving} onClick={handleSave}>
              {saving ? 'Enregistrement...' : 'Enregistrer'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function NewAccountForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [email, setEmail] = useState('');
  const [clientId, setClientId] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiFetch('/reassort/mail-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, clientId, tenantId, clientSecret }),
      });
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card mb-3">
      <div className="card-header">
        <h5 className="card-title mb-0">Nouveau compte mail (Outlook)</h5>
      </div>
      <div className="card-body">
        {error && <div className="alert alert-danger small">{error}</div>}
        <div className="alert alert-light border small">
          Le refresh token n'est pas demandé ici : une fois le compte créé, cliquez sur "Connecter Outlook" pour l'obtenir via la
          connexion Microsoft (aucun copier-coller manuel).
        </div>
        <form onSubmit={handleCreate}>
          <div className="row g-3">
            <div className="col-md-6">
              <label className="form-label">Email</label>
              <input type="email" className="form-control" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="col-md-6">
              <label className="form-label">Client ID</label>
              <input type="text" className="form-control" required value={clientId} onChange={(e) => setClientId(e.target.value)} />
            </div>
            <div className="col-md-6">
              <label className="form-label">Tenant ID</label>
              <input type="text" className="form-control" required value={tenantId} onChange={(e) => setTenantId(e.target.value)} />
            </div>
            <div className="col-md-6">
              <label className="form-label">Client Secret</label>
              <input
                type="password"
                className="form-control"
                required
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
              />
            </div>
          </div>
          <div className="mt-3 d-flex gap-2">
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Création...' : 'Créer le compte'}
            </button>
            <button type="button" className="btn btn-outline-secondary" onClick={onCancel}>
              Annuler
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function MailSection() {
  const [accounts, setAccounts] = useState<MailAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNewForm, setShowNewForm] = useState(false);

  async function load() {
    try {
      const data = await apiFetch<MailAccount[]>('/reassort/mail-accounts');
      setAccounts(data);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <div>
      <div className="alert alert-light border small mb-3">
        <strong>À quoi ça sert :</strong> le compte mail configuré ici envoie une alerte automatique aux personnes rattachées à un
        magasin dès qu'une génération nocturne produit une proposition de commande à vérifier — avec un lien direct vers la page de
        validation. Connexion via Microsoft Graph (Outlook/Office 365, application Azure AD déjà enregistrée).
      </div>

      <div className="d-flex justify-content-between align-items-center mb-3">
        <h4 className="mb-0">Comptes mail</h4>
        {!showNewForm && (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setShowNewForm(true)}>
            <iconify-icon icon="solar:add-circle-bold-duotone" className="align-middle"></iconify-icon> Ajouter un compte
          </button>
        )}
      </div>

      {error && <div className="alert alert-danger">{error}</div>}

      {showNewForm && (
        <NewAccountForm
          onCreated={() => {
            setShowNewForm(false);
            load();
          }}
          onCancel={() => setShowNewForm(false)}
        />
      )}

      {accounts === null && !error && <div className="text-muted small">Chargement...</div>}
      {accounts && accounts.length === 0 && !showNewForm && (
        <div className="text-center text-muted py-4">Aucun compte mail configuré — les alertes de proposition ne sont pas envoyées.</div>
      )}
      {accounts && accounts.map((a) => <AccountCard account={a} key={a.id} onChanged={load} />)}
    </div>
  );
}
