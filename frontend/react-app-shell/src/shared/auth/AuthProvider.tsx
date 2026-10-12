import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { ReassortUser } from '../api/client';

// AuthProvider — remplace assets/js/reassort-auth.js pour les pages migrées dans la SPA (cf. plan
// de migration, 12/10/2026). Ne fait JAMAIS une seconde garde divergente : le script inline de
// index.html a déjà tranché de façon synchrone (redirection vers /login si aucun token, avant même
// que ce composant ne s'exécute) — ce provider se contente de LIRE l'état déjà validé via
// window.reassortGetUser()/reassortGetToken(), jamais une nouvelle vérification qui pourrait
// diverger de celle du script inline.
interface AuthContextValue {
  user: ReassortUser | null;
  logout: () => void;
  isSingleShopRole: (role: string) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth() doit être utilisé à l\'intérieur de <AuthProvider>.');
  return ctx;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  // Lu une seule fois au montage : le script de garde inline a déjà garanti qu'un token existe
  // (sinon redirection déjà effectuée avant que React ne démarre) — ici il ne reste qu'à lire
  // l'utilisateur associé, jamais à revalider le token lui-même.
  const [user] = useState<ReassortUser | null>(() => window.reassortGetUser());

  // Révèle #root une fois l'auth confirmée — tant que ce composant n'a pas monté, le conteneur
  // reste à opacity:0 (posé par index.html), jamais de flash de contenu protégé avant ce point.
  useEffect(() => {
    const root = document.getElementById('root');
    if (root) root.style.opacity = '1';
  }, []);

  const value: AuthContextValue = {
    user,
    logout: window.reassortLogout,
    isSingleShopRole: window.reassortIsSingleShopRole,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
