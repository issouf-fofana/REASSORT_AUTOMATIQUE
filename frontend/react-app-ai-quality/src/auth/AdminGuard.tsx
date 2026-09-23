import type { ReactNode } from 'react';
import { useAuth } from './useAuth';

/**
 * Reproduit exactement le garde-fou cosmétique de settings.html (#settings-access-denied) : la
 * vraie sécurité est le middleware requireAdmin côté backend (chaque appel API échouerait de toute
 * façon avec un 403 pour un compte non-ADMIN) — ce composant évite seulement d'afficher un
 * formulaire inutilisable, il ne doit jamais être considéré comme la barrière de sécurité réelle.
 */
export function AdminGuard({ children }: { children: ReactNode }) {
  const { user, isAdmin } = useAuth();

  if (!user || !isAdmin) {
    return (
      <div className="alert alert-danger mt-3">Cette page est réservée aux administrateurs.</div>
    );
  }

  return <>{children}</>;
}
