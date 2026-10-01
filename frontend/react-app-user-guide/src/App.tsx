import { UserGuide } from './UserGuide';

// Visible à tout utilisateur authentifié (lecture) — édition (texte + captures) réservée à ADMIN,
// vérifié à l'intérieur de UserGuide.tsx via window.reassortGetUser().role.
export default function App() {
  return <UserGuide />;
}
