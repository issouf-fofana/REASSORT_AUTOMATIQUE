import { PurchaseOrder } from './PurchaseOrder';

// Proposition de commande — page métier la plus utilisée au quotidien, dernière de la vague 4
// (la plus complexe : génération, validation, historique hebdomadaire, panneau Recommandation IA,
// graphique ApexCharts). Pas d'AdminGuard : accessible à tout utilisateur authentifié,
// cloisonnement par magasin/rayon géré côté backend (resolveShopId, filtrage par département pour
// les rôles restreints), comme l'App.tsx d'origine. État d'URL (?shop=&sector=&dept=) géré en
// window.history.pushState/URLSearchParams natif, conservé tel quel — fonctionne déjà dans un
// <BrowserRouter> tant que la page ne déclenche aucune navigation interne concurrente via
// <Link>/navigate() pendant qu'elle gère son propre état (vérifié : aucun window.location.href
// vers une autre route dans ce fichier ni ses sous-composants).
export function PurchaseOrderPage() {
  return <PurchaseOrder />;
}
