import { SignIn } from './SignIn';

export default function App() {
  // Déjà connecté -> direct au tableau de bord (comportement de l'ancien auth-signin.html).
  if (localStorage.getItem('reassort_token')) {
    window.location.href = '/';
    return null;
  }
  return <SignIn />;
}
