import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { NAV_GROUPS, activeEntryId } from '../nav/navConfig';
import { useAuth } from '../auth/AuthProvider';

// Reproduit le markup/visuel de assets/partials/sidebar.html (classes Volt : .sidebar, .nav-link,
// .sidebar-heading...) en composant React — remplace l'injection XHR synchrone de layout.js pour
// les pages migrées dans la SPA. État des groupes repliables en localStorage, MÊME clé de préfixe
// que l'ancien mécanisme (sidebar-collapsed-<group>) pour ne jamais perdre la préférence déjà
// enregistrée par un utilisateur sur les pages non-SPA.
const COLLAPSE_KEY_PREFIX = 'sidebar-collapsed-';

function isGroupCollapsed(group: string): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY_PREFIX + group) !== '0';
  } catch {
    return true;
  }
}

function setGroupCollapsed(group: string, collapsed: boolean): void {
  try {
    localStorage.setItem(COLLAPSE_KEY_PREFIX + group, collapsed ? '1' : '0');
  } catch {
    // État non persistant si le stockage est indisponible — jamais bloquant.
  }
}

// Correspondance libellé de groupe -> clé de collapse, reprise de sidebar.html
// (data-collapse-group="reassort"/"admin") — Pilotage et Paramètres restent toujours visibles.
const COLLAPSIBLE_GROUPS: Record<string, string> = {
  'Réassort': 'reassort',
  'Administration': 'admin',
};

export function Sidebar() {
  const { user } = useAuth();
  const location = useLocation();
  const activeId = activeEntryId(NAV_GROUPS, location.pathname, location.hash);
  const [, forceRender] = useState(0);

  const isAdmin = user?.role === 'ADMIN';

  function toggleGroup(group: string) {
    setGroupCollapsed(group, !isGroupCollapsed(group));
    forceRender((n) => n + 1);
  }

  return (
    <nav id="sidebarMenu" className="sidebar d-lg-block bg-gray-800 text-white collapse" data-simplebar>
      <div className="sidebar-inner px-4 pt-3">
        <div className="sidebar-brand d-flex flex-column align-items-center justify-content-center py-3">
          <img src="/assets/images/logo-reassort.png" alt="Réassort Automatique" height={40} />
          <small className="text-white-50 mt-1" style={{ fontSize: '0.7rem' }}>v1.0.0</small>
        </div>
        <ul className="nav flex-column pt-3 pt-md-0">
          {NAV_GROUPS.map((group) => {
            const collapseKey = COLLAPSIBLE_GROUPS[group.label];
            const collapsed = collapseKey ? isGroupCollapsed(collapseKey) : false;
            const visibleEntries = group.entries.filter((e) => !e.adminOnly || isAdmin);
            if (!visibleEntries.length) return null;

            return (
              <li key={group.label} style={{ listStyle: 'none' }}>
                <ul className="nav flex-column" style={{ padding: 0 }}>
                  <li
                    className={`sidebar-heading${collapseKey ? ' sidebar-heading-collapsible' : ''}${collapsed ? ' collapsed' : ''}`}
                    onClick={collapseKey ? () => toggleGroup(collapseKey) : undefined}
                    style={collapseKey ? { cursor: 'pointer' } : undefined}
                  >
                    {group.label}
                  </li>
                  {(!collapseKey || !collapsed) &&
                    visibleEntries.map((entry) => {
                      const Icon = entry.icon;
                      return (
                        <li className="nav-item" key={entry.id}>
                          <Link
                            to={entry.href}
                            className={`nav-link d-flex align-items-center${entry.id === activeId ? ' active' : ''}`}
                          >
                            <span className="sidebar-icon">
                              <Icon className="icon icon-xs me-2" size={16} />
                            </span>
                            <span className="sidebar-text" title={entry.label}>{entry.label}</span>
                          </Link>
                        </li>
                      );
                    })}
                </ul>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
