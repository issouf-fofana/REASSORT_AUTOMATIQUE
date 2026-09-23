import { useEffect, useRef, useState } from 'react';
import { apiFetch } from './api/client';
import {
  AI_ROLE_DEFAULTS,
  DEPARTMENT_SCOPED_ROLES,
  ROLE_LABELS,
  SINGLE_SHOP_ROLES,
  shopLabelFor,
  type ReassortUserRecord,
  type Shop,
} from './shared';
import { RoleScopedFields, type RoleScopedState } from './RoleScopedFields';
import { EditUserModal } from './EditUserModal';
import { ResetPasswordModal } from './ResetPasswordModal';

interface LdapResult {
  displayName?: string;
  username: string;
  email: string;
}

const EMPTY_SCOPED_STATE: RoleScopedState = { shopId: '', departments: [], supervisedShopIds: [], aiPermCustom: {} };

function statusCellRenderer(params: any) {
  const u = params.data as ReassortUserRecord;
  const span = document.createElement('span');
  span.className = 'badge py-1 px-2 ' + (u.isActive ? 'bg-success-subtle text-success' : 'bg-secondary-subtle text-secondary');
  span.textContent = u.isActive ? 'Actif' : 'Désactivé';
  return span;
}

function shopCellRenderer(params: any) {
  const u = params.data as ReassortUserRecord;
  const span = document.createElement('span');
  const noShop =
    u.role !== 'ADMIN' &&
    ((u.role === 'SUPERVISOR' && !(u.supervisedShops || []).length) || (u.role !== 'SUPERVISOR' && !u.rposShopReference));
  if (noShop) span.className = 'text-danger';
  span.textContent = shopLabelFor(u);
  return span;
}

export function UsersPage() {
  const [shops, setShops] = useState<Shop[]>([]);
  const [users, setUsers] = useState<ReassortUserRecord[]>([]);

  const gridDivRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const gridApiRef = useRef<any>(null);

  const [editTarget, setEditTarget] = useState<ReassortUserRecord | null>(null);
  const [resetTarget, setResetTarget] = useState<ReassortUserRecord | null>(null);

  // --- Formulaire de création ---
  const [mode, setMode] = useState<'local' | 'ldap'>('local');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('DIRECTOR');
  const [scoped, setScoped] = useState<RoleScopedState>(EMPTY_SCOPED_STATE);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [ldapQuery, setLdapQuery] = useState('');
  const [ldapResults, setLdapResults] = useState<LdapResult[] | null>(null);
  const [selectedLdapUser, setSelectedLdapUser] = useState<LdapResult | null>(null);
  const ldapTimerRef = useRef<number | null>(null);

  function openActionsFor(u: ReassortUserRecord) {
    return { edit: () => setEditTarget(u), reset: () => setResetTarget(u) };
  }

  function actionsCellRenderer(params: any) {
    const u = params.data as ReassortUserRecord;
    const wrap = document.createElement('div');
    wrap.className = 'd-flex gap-1';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn btn-sm btn-outline-dark';
    editBtn.textContent = 'Modifier';
    editBtn.addEventListener('click', () => openActionsFor(u).edit());

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'btn btn-sm btn-outline-secondary';
    toggleBtn.textContent = u.isActive ? 'Désactiver' : 'Réactiver';
    toggleBtn.addEventListener('click', async () => {
      toggleBtn.disabled = true;
      try {
        await apiFetch(`/users/${u.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isActive: !u.isActive }),
        });
        loadUsers();
      } catch {
        toggleBtn.disabled = false;
      }
    });

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'btn btn-sm btn-outline-primary';
    resetBtn.textContent = 'Réinitialiser le mot de passe';
    resetBtn.addEventListener('click', () => openActionsFor(u).reset());

    wrap.appendChild(editBtn);
    wrap.appendChild(toggleBtn);
    wrap.appendChild(resetBtn);
    return wrap;
  }

  function ensureGrid() {
    if (gridApiRef.current) return gridApiRef.current;
    if (!gridDivRef.current) return null;
    gridApiRef.current = window.agGrid.createGrid(gridDivRef.current, {
      theme: window.REASSORT_AG_GRID_THEME_SOFT,
      columnDefs: [
        { headerName: 'Nom', field: 'name', flex: 1, minWidth: 150, filter: 'agTextColumnFilter' },
        { headerName: 'Email', field: 'email', flex: 1, minWidth: 200, filter: 'agTextColumnFilter' },
        {
          headerName: 'Rôle',
          field: 'role',
          width: 180,
          filter: 'agTextColumnFilter',
          valueFormatter: (p: any) => ROLE_LABELS[p.value] || p.value,
        },
        {
          headerName: 'Magasin',
          width: 220,
          filter: 'agTextColumnFilter',
          cellRenderer: shopCellRenderer,
          valueGetter: (p: any) => shopLabelFor(p.data),
        },
        {
          headerName: 'Statut',
          width: 110,
          filter: 'agTextColumnFilter',
          cellRenderer: statusCellRenderer,
          valueGetter: (p: any) => (p.data.isActive ? 'Actif' : 'Désactivé'),
        },
        {
          headerName: 'Action',
          width: 340,
          sortable: false,
          filter: false,
          cellRenderer: actionsCellRenderer,
          valueGetter: () => '',
        },
      ],
      rowData: [],
      localeText: window.AG_GRID_LOCALE_FR,
      domLayout: 'autoHeight',
      pagination: true,
      paginationPageSize: 50,
      paginationPageSizeSelector: [25, 50, 100, 200],
      animateRows: false,
      getRowId: (params: any) => params.data.id,
    });
    if (toolbarRef.current) {
      window.reassortAgGridToolbar(gridApiRef.current, toolbarRef.current);
    }
    return gridApiRef.current;
  }

  async function loadUsers() {
    const api = ensureGrid();
    if (!api) return;
    api.setGridOption('rowData', []);
    try {
      const data = await apiFetch<ReassortUserRecord[]>('/users');
      setUsers(data);
      api.setGridOption('rowData', data);
    } catch (err) {
      console.error('[users] Erreur lors du chargement des comptes:', err);
    }
  }

  useEffect(() => {
    (async () => {
      try {
        const data = await apiFetch<Shop[]>('/reassort/shops');
        setShops(data);
      } catch {
        // liste de magasins optionnelle pour l'affichage, laisse les selects vides
      }
    })();
    loadUsers();
    return () => {
      if (gridApiRef.current) {
        gridApiRef.current.destroy();
        gridApiRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleExportCsv() {
    if (!gridApiRef.current) return;
    gridApiRef.current.exportDataAsCsv({ fileName: `utilisateurs-${new Date().toISOString().slice(0, 10)}.csv` });
  }

  function handleLdapQueryChange(value: string) {
    setLdapQuery(value);
    if (ldapTimerRef.current) window.clearTimeout(ldapTimerRef.current);
    if (value.trim().length < 2) {
      setLdapResults(null);
      return;
    }
    ldapTimerRef.current = window.setTimeout(async () => {
      setLdapResults(null);
      try {
        const data = await apiFetch<LdapResult[]>(`/users/ldap/search?q=${encodeURIComponent(value.trim())}`);
        setLdapResults(data);
      } catch (err) {
        setLdapResults([]);
        setError('Erreur LDAP : ' + (err instanceof Error ? err.message : String(err)));
      }
    }, 400);
  }

  function selectLdapUser(u: LdapResult) {
    setSelectedLdapUser(u);
    setName(u.displayName || u.username);
    setEmail(u.email);
    setLdapResults(null);
    setLdapQuery('');
  }

  function resetCreateForm() {
    setMode('local');
    setName('');
    setEmail('');
    setPassword('');
    setRole('DIRECTOR');
    setScoped(EMPTY_SCOPED_STATE);
    setSelectedLdapUser(null);
    setLdapQuery('');
    setLdapResults(null);
  }

  async function handleCreateSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (mode === 'ldap' && !selectedLdapUser) {
      setError("Recherchez et sélectionnez un compte dans l'annuaire Active Directory.");
      return;
    }

    const payload: Record<string, unknown> = { name, email, role };
    if (mode === 'ldap') {
      payload.ldapManaged = true;
    } else {
      payload.password = password;
    }

    if (SINGLE_SHOP_ROLES.has(role)) {
      const shop = shops.find((s) => s.id === scoped.shopId);
      if (shop) {
        payload.rposShopId = shop.id;
        payload.rposShopReference = shop.reference;
        payload.rposShopName = shop.name;
        payload.rposPosId = shop.posId;
      }
    }
    if (DEPARTMENT_SCOPED_ROLES.has(role)) {
      payload.assignedDepartment = scoped.departments.join(',');
      if (!payload.assignedDepartment) {
        setError('Sélectionnez au moins un rayon assigné.');
        return;
      }
    }
    if (role !== 'ADMIN') {
      const defaults = AI_ROLE_DEFAULTS[role] || AI_ROLE_DEFAULTS.DIRECTOR;
      const custom: Record<string, boolean> = {};
      for (const [key, checked] of Object.entries(scoped.aiPermCustom)) {
        if (checked !== !!defaults[key]) custom[key] = checked;
      }
      if (Object.keys(custom).length) payload.aiPermissionsJson = custom;
    }
    if (role === 'SUPERVISOR') {
      const supervisedShops = scoped.supervisedShopIds
        .map((id) => shops.find((s) => s.id === id))
        .filter((s): s is Shop => !!s)
        .map((s) => ({ rposShopId: s.id, rposShopReference: s.reference, rposShopName: s.name, rposPosId: s.posId }));
      if (supervisedShops.length === 0) {
        setError('Sélectionnez au moins un magasin à superviser.');
        return;
      }
      payload.supervisedShops = supervisedShops;
    }

    setSubmitting(true);
    try {
      await apiFetch('/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      resetCreateForm();
      loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const admin = users.filter((u) => u.role === 'ADMIN').length;
  const supervisor = users.filter((u) => u.role === 'SUPERVISOR').length;
  const shopAccounts = users.filter((u) => ['DIRECTOR', 'DEPARTMENT_HEAD', 'SHELF_STOCKER', 'STORE'].includes(u.role)).length;

  return (
    <div>
      <style>{`
        #users-grid { width: 100%; }
        .ul-metric-row { display: flex; flex-wrap: wrap; border-bottom: 1px solid var(--bs-border-color, #dee2e6); }
        .ul-metric-row-item { flex: 1 1 140px; padding: 1rem 1.5rem 1rem 1.5rem; border-right: 1px solid var(--bs-border-color, #dee2e6); }
        .ul-metric-row-item:last-child { border-right: none; }
        .ul-metric-label { font-size: .8125rem; color: var(--bs-secondary-color, #6c757d); margin: 0 0 .35rem; }
        .ul-metric-value { font-size: 1.5rem; font-weight: 600; line-height: 1.15; font-variant-numeric: tabular-nums; margin: 0; }
        @media (max-width: 767px) {
          .ul-metric-row-item { border-right: none; border-bottom: 1px solid var(--bs-border-color, #dee2e6); }
        }
      `}</style>

      <div className="row">
        <div className="col-xl-4">
          <div className="card">
            <div className="card-header">
              <h4 className="card-title">Nouveau compte</h4>
            </div>
            <div className="card-body">
              <div className="mb-3">
                <div className="btn-group w-100" role="group">
                  <input
                    type="radio"
                    className="btn-check"
                    name="new-user-mode"
                    id="new-user-mode-local"
                    checked={mode === 'local'}
                    onChange={() => setMode('local')}
                  />
                  <label className="btn btn-outline-secondary" htmlFor="new-user-mode-local">
                    Compte local
                  </label>
                  <input
                    type="radio"
                    className="btn-check"
                    name="new-user-mode"
                    id="new-user-mode-ldap"
                    checked={mode === 'ldap'}
                    onChange={() => setMode('ldap')}
                  />
                  <label className="btn btn-outline-secondary" htmlFor="new-user-mode-ldap">
                    Compte Active Directory
                  </label>
                </div>
              </div>
              {error && <div className="alert alert-danger">{error}</div>}
              <form onSubmit={handleCreateSubmit}>
                {mode === 'ldap' && (
                  <div className="mb-3">
                    <label className="form-label">Rechercher dans l'annuaire (nom ou identifiant)</label>
                    <input
                      type="text"
                      className="form-control"
                      placeholder="ex: jdupont ou Dupont"
                      value={ldapQuery}
                      onChange={(e) => handleLdapQueryChange(e.target.value)}
                    />
                    <div className="list-group mt-2" style={{ maxHeight: 260, overflowY: 'auto' }}>
                      {ldapResults === null && ldapQuery.trim().length >= 2 && (
                        <div className="text-muted small p-2">Recherche...</div>
                      )}
                      {ldapResults?.length === 0 && <div className="text-muted small p-2">Aucun résultat.</div>}
                      {ldapResults?.map((u, i) => (
                        <button
                          key={i}
                          type="button"
                          className="list-group-item list-group-item-action"
                          onClick={() => selectLdapUser(u)}
                        >
                          <strong>{u.displayName}</strong> — {u.username} ({u.email})
                        </button>
                      ))}
                    </div>
                    {selectedLdapUser && (
                      <div className="alert alert-secondary small mt-2">
                        Sélectionné : {selectedLdapUser.displayName || selectedLdapUser.username} ({selectedLdapUser.email})
                      </div>
                    )}
                  </div>
                )}
                {mode === 'local' && (
                  <div>
                    <div className="mb-3">
                      <label className="form-label">Nom</label>
                      <input type="text" className="form-control" required value={name} onChange={(e) => setName(e.target.value)} />
                    </div>
                    <div className="mb-3">
                      <label className="form-label">Email</label>
                      <input type="email" className="form-control" required value={email} onChange={(e) => setEmail(e.target.value)} />
                    </div>
                    <div className="mb-3">
                      <label className="form-label">Mot de passe</label>
                      <input
                        type="password"
                        className="form-control"
                        required
                        minLength={6}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                      />
                    </div>
                  </div>
                )}
                <div className="mb-3">
                  <label className="form-label">Rôle</label>
                  <select className="form-select" value={role} onChange={(e) => setRole(e.target.value)}>
                    <option value="SHELF_STOCKER">Rayonniste (un ou plusieurs rayons)</option>
                    <option value="DEPARTMENT_HEAD">Chef de département (un département)</option>
                    <option value="DIRECTOR">Directeur (un magasin entier)</option>
                    <option value="SUPERVISOR">Superviseur (plusieurs magasins choisis)</option>
                    <option value="ADMIN">Administrateur (tous les magasins + configuration)</option>
                  </select>
                </div>
                <RoleScopedFields idPrefix="new" role={role} shops={shops} state={scoped} onChange={setScoped} />
                <button type="submit" className="btn btn-primary w-100" disabled={submitting}>
                  Créer le compte
                </button>
              </form>
            </div>
          </div>
        </div>

        <div className="col-xl-8">
          <div className="card">
            <div className="d-flex card-header justify-content-between align-items-center">
              <h4 className="card-title">Comptes existants</h4>
              <div className="d-flex gap-2">
                <button className="btn btn-sm btn-outline-dark" title="Export CSV, ouvrable directement dans Excel" onClick={handleExportCsv}>
                  <iconify-icon icon="solar:file-download-bold-duotone" className="align-middle"></iconify-icon> Exporter (CSV)
                </button>
                <button className="btn btn-sm btn-outline-primary" onClick={loadUsers}>
                  Actualiser
                </button>
                <div ref={toolbarRef} className="d-flex gap-2"></div>
              </div>
            </div>
            {users.length > 0 && (
              <div className="ul-metric-row">
                <div className="ul-metric-row-item">
                  <p className="ul-metric-label">Comptes au total</p>
                  <p className="ul-metric-value">{users.length}</p>
                </div>
                <div className="ul-metric-row-item">
                  <p className="ul-metric-label">Administrateurs</p>
                  <p className="ul-metric-value">{admin}</p>
                </div>
                <div className="ul-metric-row-item">
                  <p className="ul-metric-label">Superviseurs</p>
                  <p className="ul-metric-value">{supervisor}</p>
                </div>
                <div className="ul-metric-row-item">
                  <p className="ul-metric-label">Comptes magasin</p>
                  <p className="ul-metric-value">{shopAccounts}</p>
                </div>
              </div>
            )}
            <div className="card-body p-0">
              <div ref={gridDivRef} id="users-grid"></div>
            </div>
          </div>
        </div>
      </div>

      {editTarget && (
        <EditUserModal
          user={editTarget}
          shops={shops}
          onClose={() => setEditTarget(null)}
          onSaved={() => {
            setEditTarget(null);
            loadUsers();
          }}
        />
      )}
      {resetTarget && <ResetPasswordModal user={resetTarget} onClose={() => setResetTarget(null)} />}
    </div>
  );
}
