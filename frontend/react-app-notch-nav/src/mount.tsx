import { createRoot } from 'react-dom/client';
import { ReassortNotch } from './ReassortNotch';
import './index.css';

// Aperçu isolé (`npm run dev`, hors du vrai site) : reassort-auth.js/global-shop-selector.js n'y
// sont jamais chargés — mocks minimaux pour pouvoir visualiser/itérer sur le notch sans dépendre du
// backend réel. Jamais inclus dans le bundle de production (import.meta.env.DEV, retiré par Vite au
// build) et jamais un substitut au vrai contrat (cf. api/client.ts des autres pages, qui ne
// réimplémentent jamais non plus reassortFetch).
if (import.meta.env.DEV && !window.reassortGetUser) {
  window.reassortGetUser = () => ({ name: 'Admin Démo', role: 'ADMIN' });
  window.reassortLogout = () => console.log('[dev] déconnexion');
  window.reassortIsSingleShopRole = () => false;
}

// Point d'entrée non-module (build IIFE, voir vite.config.ts) : chargé en <script> classique dans
// chacune des 14 pages du site, comme assets/js/layout.js aujourd'hui — jamais un import ES,
// puisqu'aucune de ces 14 pages n'est construite comme un module par ce bundle-ci (chacune a son
// propre build Vite séparé pour son propre contenu de page). Remplace
// #layout-sidebar-slot + #layout-topbar-slot par un seul point de montage, #notch-nav-slot.
function mount() {
  const el = document.getElementById('notch-nav-slot');
  if (!el) return;
  el.className = 'reassort-notch-root';
  createRoot(el).render(<ReassortNotch />);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount);
} else {
  mount();
}
