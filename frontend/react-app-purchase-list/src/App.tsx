import { PurchaseList } from './PurchaseList';

// Pas d'AdminGuard : accessible à tout utilisateur authentifié, cloisonnement par magasin/rayon
// géré côté backend (resolveShopId, filtrage par département pour les rôles restreints).
export default function App() {
  return <PurchaseList />;
}
