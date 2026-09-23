import { AiAssistant } from './AiAssistant';

// Pas d'AdminGuard : cette page est accessible à tout utilisateur authentifié (cloisonnement par
// magasin géré côté backend via resolveShopId), même comportement que ai-assistant.html d'origine.
export default function App() {
  return <AiAssistant />;
}
