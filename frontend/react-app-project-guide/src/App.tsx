import { ProjectGuide } from './ProjectGuide';

// Page 100% statique, accessible à tout utilisateur authentifié (aucune restriction de rôle dans
// la page HTML d'origine, pas d'appel API — contenu chargé depuis window.PROJECT_GUIDE_CONTENT).
export default function App() {
  return <ProjectGuide />;
}
