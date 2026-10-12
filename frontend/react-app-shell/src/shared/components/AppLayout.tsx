import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { NotchNav } from './NotchNav';

// Layout englobant chaque page migrée : Sidebar OU NotchNav selon le mode choisi par l'utilisateur
// (bascule reprise de body.nav-collapsed/ #sidebar-visibility-btn sur les pages non-SPA), + Topbar,
// + la page elle-même rendue par <Outlet/> (React Router). Remplace l'injection XHR synchrone de
// layout.js — ici tout est un vrai arbre de composants React, monté une seule fois au chargement
// de la SPA, jamais réinjecté à chaque navigation.
export function AppLayout({ pageTitle }: { pageTitle: string }) {
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
