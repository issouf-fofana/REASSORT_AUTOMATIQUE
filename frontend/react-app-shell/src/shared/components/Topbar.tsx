import { useEffect, useRef, useState } from 'react';
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

export function Topbar({ title, onToggleNav }: { title: string; onToggleNav: () => void }) {
  const { user, logout } = useAuth();
  const suffix = user ? (user.rposShopName || ROLE_LABELS[user.role] || user.role || '') : '';
  const displayName = user ? user.name + (suffix ? ' — ' + suffix : '') : '';

  // Dropdown géré en state React pur, PAS data-bs-toggle (bug trouvé le 12/10/2026, "déconnexion
  // ne marche pas sur cette page" — le shell ne charge jamais bootstrap.min.js, contrairement aux
  // 19 autres pages ; data-bs-toggle="dropdown" reste alors totalement inerte, le menu ne s'ouvre
  // jamais). Volontairement pas de nouvelle dépendance au JS Bootstrap ici : cohérent avec l'esprit
  // "vraie SPA React" du shell, où l'interactivité est gérée par React, pas par un script jQuery-like
  // externe à synchroniser avec le cycle de vie des composants.
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  return (
    <nav className="navbar navbar-top navbar-expand navbar-dashboard navbar-dark ps-0 pe-2 pb-0">
      <div className="container-fluid px-0">
        <div className="d-flex justify-content-between w-100">
          <div className="d-flex align-items-center" style={{ minWidth: 0, flex: '1 1 auto' }}>
            {/* Masquer/afficher la sidebar (reprend #sidebar-visibility-btn de topbar.html) — jamais
                porté dans le shell jusqu'ici (bug trouvé le 12/10/2026, signalé par l'utilisateur).
                d-none d-lg-inline-block : sur mobile la sidebar est déjà masquée par Volt, rien à
                basculer, même comportement que l'original. */}
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary d-none d-lg-inline-block me-2 flex-shrink-0"
              title="Masquer/afficher le menu latéral"
              aria-label="Masquer/afficher le menu latéral"
              onClick={onToggleNav}
            >
              <svg className="icon icon-xs" fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
                <path fillRule="evenodd" d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 15a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd"></path>
              </svg>
            </button>
            <div className="d-none d-md-block text-truncate" style={{ minWidth: 0 }}>
              <h4 className="fw-bold text-uppercase mb-0 text-gray-800 text-truncate">{title}</h4>
            </div>
          </div>
          <ul className="navbar-nav align-items-center">
            <li className={`nav-item dropdown ms-lg-3${open ? ' show' : ''}`} ref={menuRef}>
              <a
                className="nav-link dropdown-toggle pt-1 px-0"
                href="#"
                role="button"
                aria-haspopup="true"
                aria-expanded={open}
                onClick={(e) => {
                  e.preventDefault();
                  setOpen((v) => !v);
                }}
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
              <div className={`dropdown-menu dashboard-dropdown dropdown-menu-end mt-2 py-1${open ? ' show' : ''}`}>
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
