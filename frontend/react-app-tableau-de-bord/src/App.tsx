import { TableauDeBord } from './TableauDeBord';

// Pas d'AdminGuard : accessible à tout utilisateur authentifié (comme index.html), le vrai
// cloisonnement par magasin/rôle est géré côté backend sur chaque endpoint appelé.
export default function App() {
  return <TableauDeBord />;
}
