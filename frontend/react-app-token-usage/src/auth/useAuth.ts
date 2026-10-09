import { useEffect, useState } from 'react';
import type { ReassortUser } from '../api/client';

/**
 * Lit l'utilisateur courant depuis localStorage (posé par reassort-auth.js, déjà chargé avant ce
 * bundle). reassort-auth.js gère déjà la redirection /login si aucun token n'existe (garde exécutée
 * au chargement du script, avant même DOMContentLoaded) — ce hook n'a donc qu'à lire l'état déjà
 * validé, jamais à réimplémenter cette vérification.
 */
export function useAuth() {
  const [user, setUser] = useState<ReassortUser | null>(() => window.reassortGetUser());

  useEffect(() => {
    // reassortGetUser() est déjà stable après le chargement initial (pas d'event de changement de
    // session ailleurs sur le site) : un seul appel au montage suffit, pas de listener nécessaire.
    setUser(window.reassortGetUser());
  }, []);

  return { user, isAdmin: user?.role === 'ADMIN' };
}
