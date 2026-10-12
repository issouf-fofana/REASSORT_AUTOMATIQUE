import { useAuth } from '../auth/AuthProvider';

// Reproduit le markup/visuel essentiel de assets/partials/topbar.html (titre de page + menu
// utilisateur/déconnexion) en composant React. Version volontairement réduite pour cette première
// étape du socle (cf. plan de migration, 12/10/2026) — notifications et sélecteur de magasin
// global seront ajoutés avec ShopSelector.tsx dans une étape suivante, pas requis pour valider
// l'approche sur une première page simple sans dépendance au magasin actif.
const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Admin',
  SUPERVISOR: 'Superviseur',
  DIRECTOR: 'Directeur',
  DEPARTMENT_HEAD: 'Chef de département',
  SHELF_STOCKER: 'Rayonniste',
  STORE: 'Magasin',
};

export function Topbar({ title }: { title: string }) {
  const { user, logout } = useAuth();
  const suffix = user ? (user.rposShopName || ROLE_LABELS[user.role] || user.role || '') : '';
  const displayName = user ? user.name + (suffix ? ' — ' + suffix : '') : '';

  return (
    <nav className="navbar navbar-top navbar-expand navbar-dashboard navbar-dark ps-0 pe-2 pb-0">
      <div className="container-fluid px-0">
        <div className="d-flex justify-content-between w-100">
          <div className="d-flex align-items-center" style={{ minWidth: 0, flex: '1 1 auto' }}>
            <div className="d-none d-md-block text-truncate" style={{ minWidth: 0 }}>
              <h4 className="fw-bold text-uppercase mb-0 text-gray-800 text-truncate">{title}</h4>
            </div>
          </div>
          <ul className="navbar-nav align-items-center">
            <li className="nav-item dropdown ms-lg-3">
              <a
                className="nav-link dropdown-toggle pt-1 px-0"
                href="#"
                role="button"
                data-bs-toggle="dropdown"
                aria-haspopup="true"
                aria-expanded="false"
              >
                <div className="media d-flex align-items-center">
                  <span
                    className="avatar rounded-circle bg-gray-800 text-white d-flex align-items-center justify-content-center"
                    style={{ width: 36, height: 36, fontSize: '.9rem' }}
                  >
                    {(user?.name || '?').charAt(0).toUpperCase()}
                  </span>
                  <div className="media-body ms-2 text-dark align-items-center d-none d-lg-block">
                    <span className="mb-0 font-small fw-bold text-gray-900">{displayName || 'Mon compte'}</span>
                  </div>
                </div>
              </a>
              <div className="dropdown-menu dashboard-dropdown dropdown-menu-end mt-2 py-1">
                <a
                  className="dropdown-item d-flex align-items-center text-danger"
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    logout();
                  }}
                >
                  Déconnexion
                </a>
              </div>
            </li>
          </ul>
        </div>
      </div>
    </nav>
  );
}
