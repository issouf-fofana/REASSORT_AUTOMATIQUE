// Client API : wrapper TypeScript autour de window.reassortFetch, posé par le script de garde
// inline de index.html (reproduction de assets/js/reassort-auth.js, cf. AuthProvider.tsx).
//
// Volontairement PAS une réimplémentation du contrat (auth, base URL, gestion du 401) : une seule
// source de vérité pour ce comportement, partagée avec les pages non encore migrées dans la SPA
// pendant toute la durée de la coexistence (cf. plan de migration, 12/10/2026).
declare global {
  interface Window {
    reassortFetch: (path: string, options?: RequestInit) => Promise<Response>;
    reassortGetToken: () => string | null;
    reassortGetUser: () => ReassortUser | null;
    reassortLogout: () => void;
    reassortIsSingleShopRole: (role: string) => boolean;
    reassortConfirm?: (message: string, options?: { danger?: boolean; okLabel?: string; cancelLabel?: string }) => Promise<boolean>;
    reassortToast: (message: string, type?: 'success' | 'error' | 'info', onClick?: () => void) => void;
  }
}

export interface ReassortUser {
  id?: string;
  name: string;
  email?: string;
  role: string;
  rposShopId?: string | null;
  rposShopReference?: string | null;
  rposShopName?: string | null;
  rposPosId?: string | null;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  message?: string;
}

/**
 * Appelle l'API backend et vérifie `success`, comme le fait déjà chaque appelant sur les pages
 * non-SPA (`if (!json.success) throw new Error(json.message)`). Lève une erreur avec le message
 * serveur si `success` est faux, pour que les composants n'aient qu'à `try/catch`.
 */
export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await window.reassortFetch(path, options);
  const json: ApiResponse<T> = await res.json();
  if (!json.success) {
    throw new Error(json.message || 'Erreur inconnue du serveur');
  }
  return json.data as T;
}
