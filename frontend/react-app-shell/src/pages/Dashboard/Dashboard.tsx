import { TableauDeBord } from './TableauDeBord';

// Tableau de bord — dernière page de la vague 5 (plan de migration), la racine du site. Pas
// d'AdminGuard : accessible à tout utilisateur authentifié, le cloisonnement par magasin/rôle est
// géré côté backend sur chaque endpoint appelé. N'avait de sens qu'une fois /purchase-order,
// /purchase-list et /ai-quality déjà dans la SPA (vagues 3-4) : les 3 navigations internes de cette
// page (TodayProposalsCard, lien "Voir l'historique", lien "Constats à traiter") ont été converties
// de window.location.href/<a href> vers navigate()/<Link>, sinon elles auraient déclenché un
// rechargement complet de page malgré la fusion — seule différence avec un portage verbatim.
export function Dashboard() {
  return <TableauDeBord />;
}
