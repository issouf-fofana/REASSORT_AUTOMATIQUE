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
  span.className =
    'badge rounded-pill py-1 px-2 ' + (u.isActive ? 'bg-success-subtle text-success' : 'bg-secondary-subtle text-secondary');
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
  // Formulaire de création déplacé dans une modale (demande du 25/09/2026 : "il ne faut pas afficher
  // le formulaire par défaut") — ouverte via le bouton "Nouveau compte" au lieu d'occuper en
  // permanence un tiers de la page à côté du tableau.
  const [createOpen, setCreateOpen] = useState(false);

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

  // Colonne Action compactée en menu ⋮ (demande du 25/09/2026 : les 3 boutons côte à côte
  // débordaient du tableau). Le dropdown Bootstrap standard (data-bs-toggle="dropdown") ne
  // s'affichait pas : AG Grid clippe ses cellules via un ancêtre (.ag-center-cols-clipper,
  // overflow:hidden nécessaire à la virtualisation du scroll) que Popper.js ne peut pas
  // contourner — le menu s'ouvrait mais restait invisible, coupé par ce conteneur. Remplacé par un
  // menu géré à la main en position:fixed (positionné via getBoundingClientRect au clic), qui
  // échappe complètement à cet overflow puisqu'il n'est plus un enfant en flux normal de la grille.
  // Composant AG Grid en classe (init/getGui/destroy) plutôt qu'une simple fonction : la fonction
  // seule n'offre aucun point d'accroche pour nettoyer le menu ajouté à <body> (voir plus bas) quand
  // AG Grid recycle/détruit la cellule (scroll, pagination, tri...) — sans destroy(), une ligne
  // quittant l'écran laissait son menu orphelin dans le DOM indéfiniment.
  class ActionsCellRenderer {
    eGui!: HTMLElement;
    menuEl?: HTMLElement;
    closeMenuFn?: () => void;

    init(params: any) {
    const u = params.data as ReassortUserRecord;
    const wrap = document.createElement('div');
    wrap.className = 'ul-actions-dropdown';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'btn btn-sm btn-outline-secondary';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.innerHTML = '<iconify-icon icon="solar:menu-dots-bold"></iconify-icon>';

    const menu = document.createElement('div');
    menu.className = 'ul-actions-menu';
    menu.style.display = 'none';

    function closeMenu() {
      menu.style.display = 'none';
      toggle.setAttribute('aria-expanded', 'false');
      document.removeEventListener('mousedown', onOutsideClick);
      window.removeEventListener('scroll', closeMenu, true);
    }
    function onOutsideClick(e: MouseEvent) {
      if (!menu.contains(e.target as Node) && e.target !== toggle) closeMenu();
    }
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = menu.style.display !== 'none';
      // Une seule instance de menu ouverte à la fois : ferme tout autre menu de la grille déjà
      // ouvert avant d'ouvrir celui-ci (sinon plusieurs menus pourraient rester affichés en même
      // temps en cliquant successivement sur plusieurs lignes).
      document.querySelectorAll<HTMLElement>('.ul-actions-menu').forEach((m) => (m.style.display = 'none'));
      if (isOpen) {
        closeMenu();
        return;
      }
      const rect = toggle.getBoundingClientRect();
      menu.style.display = 'block';
      menu.style.top = rect.bottom + 4 + 'px';
      menu.style.left = Math.max(8, rect.right - 200) + 'px';
      toggle.setAttribute('aria-expanded', 'true');
      document.addEventListener('mousedown', onOutsideClick);
      window.addEventListener('scroll', closeMenu, true);
    });

    const editItem = document.createElement('button');
    editItem.type = 'button';
    editItem.className = 'ul-actions-menu-item';
    editItem.innerHTML = '<iconify-icon icon="solar:pen-bold-duotone" class="me-2"></iconify-icon>Modifier';
    editItem.addEventListener('click', () => {
      closeMenu();
      openActionsFor(u).edit();
    });

    const toggleItem = document.createElement('button');
    toggleItem.type = 'button';
    toggleItem.className = 'ul-actions-menu-item';
    toggleItem.innerHTML = u.isActive
      ? '<iconify-icon icon="solar:lock-bold-duotone" class="me-2"></iconify-icon>Désactiver'
      : '<iconify-icon icon="solar:lock-unlocked-bold-duotone" class="me-2"></iconify-icon>Réactiver';
    toggleItem.addEventListener('click', async () => {
      closeMenu();
      toggleItem.disabled = true;
      try {
        await apiFetch(`/users/${u.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isActive: !u.isActive }),
        });
        loadUsers();
      } catch {
        toggleItem.disabled = false;
      }
    });

    menu.appendChild(editItem);
    menu.appendChild(toggleItem);

    // Un compte Active Directory (ldapManaged) a son mot de passe géré par l'annuaire, jamais par
    // cette plateforme — "Réinitialiser le mot de passe" n'a de sens que pour un compte local
    // (demande du 25/09/2026 : ne pas proposer l'action pour les comptes AD).
    if (!u.ldapManaged) {
      const resetItem = document.createElement('button');
      resetItem.type = 'button';
      resetItem.className = 'ul-actions-menu-item';
      resetItem.innerHTML = '<iconify-icon icon="solar:key-bold-duotone" class="me-2"></iconify-icon>Réinitialiser le mot de passe';
      resetItem.addEventListener('click', () => {
        closeMenu();
        openActionsFor(u).reset();
      });
      menu.appendChild(resetItem);
    }

    wrap.appendChild(toggle);
    // Ajouté à <body> plutôt qu'à `wrap` : position:fixed n'échapperait pas à un overflow:hidden
    // ancêtre s'il restait un enfant DOM de la cellule AG Grid — nécessaire ici puisque
    // .ag-center-cols-clipper clippe toujours ses enfants en flux normal, quel que soit leur CSS
    // position individuel. Retiré explicitement dans destroy() ci-dessous pour ne pas laisser de
    // nœud orphelin quand AG Grid recycle cette cellule.
    document.body.appendChild(menu);

    this.eGui = wrap;
    this.menuEl = menu;
    this.closeMenuFn = closeMenu;
    }

    getGui() {
      return this.eGui;
    }

    destroy() {
      this.closeMenuFn?.();
      this.menuEl?.remove();
    }
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
          width: 80,
          sortable: false,
          filter: false,
          cellRenderer: ActionsCellRenderer,
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
      setCreateOpen(false);
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
        /* AG Grid pose overflow:hidden sur ses cellules par défaut, ce qui coupait le menu ⋮ dès
           qu'il dépassait la hauteur de la ligne — .ag-cell l'autorise explicitement à déborder
           uniquement pour cette colonne (ne touche pas aux autres cellules, qui gardent leur
           troncature normale via ellipsis). */
        .ul-actions-menu {
          position: fixed;
          min-width: 220px;
          background: #ffffff;
          border: 1px solid #e2e4e7;
          border-radius: 10px;
          box-shadow: 0 8px 24px rgba(20, 20, 20, .12);
          padding: .4rem;
          z-index: 2000;
        }
        .ul-actions-menu-item {
          display: flex; align-items: center;
          width: 100%; text-align: left; border: none; background: transparent;
          font-size: .85rem; padding: .5rem .6rem; border-radius: 6px;
          color: #17181a; cursor: pointer;
        }
        .ul-actions-menu-item:hover { background: #f5f5f5; }
        .ul-actions-menu-item:disabled { opacity: .5; cursor: not-allowed; }

        .ul-header { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem; margin-bottom: 1.5rem; }
        .ul-header h2 { font-size: 1.5rem; font-weight: 700; margin: 0; letter-spacing: -.01em; }
        .ul-header p { color: #6c757d; font-size: .87rem; margin: .25rem 0 0; }

        .ul-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 1.5rem; }
        @media (max-width: 900px) { .ul-stats { grid-template-columns: repeat(2, 1fr); } }
        .ul-stat-card {
          display: flex; align-items: center; gap: .85rem;
          background: #ffffff; border: 1px solid #ececec; border-radius: 14px;
          padding: 1.1rem 1.25rem;
        }
        .ul-stat-icon {
          width: 42px; height: 42px; border-radius: 11px; flex-shrink: 0;
          display: flex; align-items: center; justify-content: center; font-size: 1.25rem;
        }
        .ul-stat-icon-total { background: #f1f2f4; color: #17181a; }
        .ul-stat-icon-admin { background: #eef2ff; color: #4338ca; }
        .ul-stat-icon-supervisor { background: #fdf0e3; color: #b9770e; }
        .ul-stat-icon-shop { background: #eafaf1; color: #1e7e34; }
        .ul-stat-value { font-size: 1.55rem; font-weight: 700; line-height: 1.1; color: #17181a; letter-spacing: -.01em; }
        .ul-stat-label { font-size: .78rem; color: #9198a1; margin-top: .1rem; }

        .ul-table-card { background: #ffffff; border: 1px solid #ececec; border-radius: 14px; overflow: hidden; }
        .ul-table-toolbar { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: .75rem; padding: 1.1rem 1.35rem; border-bottom: 1px solid #f0f0f0; }
        .ul-table-toolbar h4 { margin: 0; font-size: 1.05rem; font-weight: 700; }
      `}</style>

      <div className="ul-header">
        <div>
          <h2>Utilisateurs</h2>
          <p>Gérez les comptes ayant accès à la plateforme et leurs permissions.</p>
        </div>
        <button type="button" className="btn btn-dark" onClick={() => setCreateOpen(true)}>
          <iconify-icon icon="solar:user-plus-bold-duotone" className="align-middle me-1"></iconify-icon>
          Nouveau compte
        </button>
      </div>

      <div className="ul-stats">
        <div className="ul-stat-card">
          <div className="ul-stat-icon ul-stat-icon-total">
            <iconify-icon icon="solar:users-group-rounded-bold-duotone"></iconify-icon>
          </div>
          <div>
            <div className="ul-stat-value">{users.length}</div>
            <div className="ul-stat-label">Comptes au total</div>
          </div>
        </div>
        <div className="ul-stat-card">
          <div className="ul-stat-icon ul-stat-icon-admin">
            <iconify-icon icon="solar:shield-star-bold-duotone"></iconify-icon>
          </div>
          <div>
            <div className="ul-stat-value">{admin}</div>
            <div className="ul-stat-label">Administrateurs</div>
          </div>
        </div>
        <div className="ul-stat-card">
          <div className="ul-stat-icon ul-stat-icon-supervisor">
            <iconify-icon icon="solar:eye-scan-bold-duotone"></iconify-icon>
          </div>
          <div>
            <div className="ul-stat-value">{supervisor}</div>
            <div className="ul-stat-label">Superviseurs</div>
          </div>
        </div>
        <div className="ul-stat-card">
          <div className="ul-stat-icon ul-stat-icon-shop">
            <iconify-icon icon="solar:shop-bold-duotone"></iconify-icon>
          </div>
          <div>
            <div className="ul-stat-value">{shopAccounts}</div>
            <div className="ul-stat-label">Comptes magasin</div>
          </div>
        </div>
      </div>

      <div className="ul-table-card">
        <div className="ul-table-toolbar">
          <h4>Comptes existants</h4>
          <div className="d-flex gap-2 align-items-center flex-wrap">
            <button className="btn btn-sm btn-outline-dark" title="Export CSV, ouvrable directement dans Excel" onClick={handleExportCsv}>
              <iconify-icon icon="solar:file-download-bold-duotone" className="align-middle"></iconify-icon> Exporter (CSV)
            </button>
            <button className="btn btn-sm btn-outline-secondary" onClick={loadUsers}>
              <iconify-icon icon="solar:refresh-bold-duotone" className="align-middle"></iconify-icon> Actualiser
            </button>
            <div ref={toolbarRef} className="d-flex gap-2"></div>
          </div>
        </div>
        <div ref={gridDivRef} id="users-grid"></div>
      </div>

      {createOpen && (
        <>
          <div className="modal fade show" style={{ display: 'block' }} tabIndex={-1} role="dialog">
            <div className="modal-dialog modal-lg" role="document">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">Nouveau compte</h5>
                  <button
                    type="button"
                    className="btn-close"
                    onClick={() => {
                      setCreateOpen(false);
                      resetCreateForm();
                    }}
                  ></button>
                </div>
                <div className="modal-body">
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
                  <form id="new-user-form" onSubmit={handleCreateSubmit}>
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
                  </form>
                </div>
                <div className="modal-footer">
                  <button
                    type="button"
                    className="btn btn-outline-secondary"
                    onClick={() => {
                      setCreateOpen(false);
                      resetCreateForm();
                    }}
                  >
                    Annuler
                  </button>
                  <button type="submit" form="new-user-form" className="btn btn-dark" disabled={submitting}>
                    {submitting ? 'Création...' : 'Créer le compte'}
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show"></div>
        </>
      )}

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
