import { AiGuide } from './AiGuide';

// Pas d'AdminGuard : accessible à tout utilisateur authentifié, le contenu s'adapte au rôle
// (roleLabel, pages, actions, capacités) via les endpoints backend eux-mêmes.
export default function App() {
  return <AiGuide />;
}
