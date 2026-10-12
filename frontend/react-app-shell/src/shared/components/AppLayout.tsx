import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { NotchNav } from './NotchNav';
import { NAV_GROUPS, flattenEntries, activeEntryId } from '../nav/navConfig';

const NAV_COLLAPSED_KEY = 'nav-collapsed';

function readNavCollapsed(): boolean {
  try {
    return localStorage.getItem(NAV_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

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

  // Même clé localStorage que layout-collapsible.js (NAV_COLLAPSED_KEY = 'nav-collapsed') pour
  // respecter une préférence déjà choisie par l'utilisateur sur les pages non-SPA — mais lu
  // directement depuis localStorage, pas depuis body.classList.contains('nav-collapsed') : cette
  // classe n'est posée QUE par layout-collapsible.js (jamais chargé dans le shell), donc useNotch
  // restait toujours `false` ici, et aucun bouton ne permettait de la faire passer à `true` non plus
  // (#sidebar-visibility-btn jamais porté dans Topbar.tsx — bug trouvé le 12/10/2026, signalé par
  // l'utilisateur : "il faut ajouter le bouton pour réduire la sidebar"). toggleNav synchronise
  // aussi body.classList pour rester cohérent avec les pages non-SPA partageant la même session.
  const [useNotch, setUseNotch] = useState(readNavCollapsed);

  useEffect(() => {
    document.body.classList.toggle('nav-collapsed', useNotch);
  }, [useNotch]);

  function toggleNav() {
    setUseNotch((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(NAV_COLLAPSED_KEY, next ? '1' : '0');
      } catch {
        // Préférence non persistante si le stockage est indisponible — jamais bloquant.
      }
      return next;
    });
  }

  return (
    <>
      {useNotch ? <NotchNav onToggleNav={toggleNav} /> : <Sidebar />}
      <main className="content">
        <Topbar title={pageTitle} onToggleNav={toggleNav} />
        <div className="py-4">
          <div className="container-xxl">
            <Outlet />
          </div>
        </div>
      </main>
    </>
  );
}
