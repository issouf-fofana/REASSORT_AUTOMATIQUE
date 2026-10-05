import { SalesAnalysis } from './SalesAnalysis';

// Pas d'AdminGuard : accessible à tout utilisateur authentifié, cloisonnement par magasin géré
// côté backend (resolveShopId) — un compte DIRECTOR/DEPARTMENT_HEAD/SHELF_STOCKER (un seul
// magasin) voit directement son analyse, un ADMIN/SUPERVISOR choisit via le sélecteur global.
export default function App() {
  return <SalesAnalysis />;
}
