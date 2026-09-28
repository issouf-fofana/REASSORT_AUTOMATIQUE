import { SalesHistory } from './SalesHistory';

// Ouverte à tous les rôles authentifiés le 28/09/2026 (auparavant réservée ADMIN via AdminGuard —
// bug rapporté : "le rayonniste n'a pas accès aux ventes") : le cloisonnement réel se fait côté
// backend (resolveShopId force le magasin du compte, filterSalesLinesForUser filtre par rayon pour
// DEPARTMENT_HEAD/SHELF_STOCKER, cf. routes/reassort/sales.js) — jamais côté UI, qui n'a jamais été
// la vraie barrière de sécurité (cf. ancien AdminGuard.tsx, conservé pour référence).
export default function App() {
  return <SalesHistory />;
}
