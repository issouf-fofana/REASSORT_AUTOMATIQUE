import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

// Pas de fichier CSS importé ici : le style vient entièrement de volt.css/theme-override.css,
// chargés en <link> classique dans index.html — cohérent avec les 19 pages HTML encore actives,
// pas de nouveau design system (Tailwind etc.) introduit pour cette page migrée.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
