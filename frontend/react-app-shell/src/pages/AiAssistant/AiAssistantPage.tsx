import { AiAssistant } from './AiAssistant';

// Assistant IA — accessible à tout utilisateur authentifié (cloisonnement par magasin géré côté
// backend via resolveShopId), pas d'AdminGuard, comme l'App.tsx d'origine. L'état de conversation
// (?conversation=<id>) reste géré en window.history.pushState/URLSearchParams manuel (code
// d'origine, AiAssistant.tsx) plutôt que refactoré en useSearchParams : fonctionne tel quel dans
// React Router (BrowserRouter ne gère pas le pathname+search en dehors de ses propres appels
// navigate()), même raisonnement que le routage par hash de /settings et /ai-quality — aucune
// collision avec React Router puisque cette page ne déclenche jamais de navigation interne via
// <Link>/navigate() pendant qu'elle gère son propre état d'URL.
export function AiAssistantPage() {
  return <AiAssistant />;
}
