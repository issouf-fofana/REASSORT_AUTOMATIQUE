import { useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { NotchNav } from './NotchNav';
import { NAV_GROUPS, flattenEntries, activeEntryId } from '../nav/navConfig';

// Layout englobant chaque page migrée : Sidebar OU NotchNav selon le mode choisi par l'utilisateur
// (bascule reprise de body.nav-collapsed/ #sidebar-visibility-btn sur les pages non-SPA), + Topbar,
// + la page elle-même rendue par <Outlet/> (React Router). Remplace l'injection XHR synchrone de
// layout.js — ici tout est un vrai arbre de composants React, monté une seule fois au chargement
// de la SPA, jamais réinjecté à chaque navigation.
//
// pageTitle dérivé automatiquement de navConfig.ts selon la route active (ajouté le 12/10/2026,
// migration de /project-guide) — plus besoin de le répéter manuellement à chaque <Route>, une
// seule source de vérité pour le libellé affiché dans la sidebar ET dans le titre de la topbar.
export function AppLayout() {
  const location = useLocation();
  const entries = flattenEntries(NAV_GROUPS);
  const activeId = activeEntryId(NAV_GROUPS, location.pathname, location.hash);
  const pageTitle = entries.find((e) => e.id === activeId)?.label || 'Réassort Automatique';

  // Lu une seule fois au montage (pas de réactivité multi-onglets nécessaire pour cette première
  // étape) — même clé localStorage que layout-collapsible.js pour respecter une préférence déjà
  // choisie par l'utilisateur sur les pages non-SPA.
  const [useNotch] = useState(() => {
    try {
      return document.body.classList.contains('nav-collapsed');
    } catch {
      return false;
    }
  });

  return (
    <>
      {useNotch ? <NotchNav /> : <Sidebar />}
      <main className="content">
        <Topbar title={pageTitle} />
        <div className="py-4">
          <div className="container-xxl">
            <Outlet />
          </div>
        </div>
      </main>
    </>
  );
}
