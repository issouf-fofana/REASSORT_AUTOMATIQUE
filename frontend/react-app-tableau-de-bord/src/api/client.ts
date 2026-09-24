// Client API : wrapper TypeScript autour de window.reassortFetch (défini par
// assets/js/reassort-auth.js, chargé en <script> classique dans index.html AVANT ce bundle).
//
// Volontairement PAS une réimplémentation du contrat (auth, base URL, gestion du 401) : une seule
// source de vérité pour ce comportement, partagée avec les 19 pages HTML encore actives. Réécrire
// cette logique ici créerait un risque de divergence silencieuse (ex: si reassort-auth.js est
// corrigé plus tard, cette copie resterait périmée sans qu'on s'en aperçoive).
declare global {
  interface Window {
    reassortFetch: (path: string, options?: RequestInit) => Promise<Response>;
    reassortGetToken: () => string | null;
    reassortGetUser: () => ReassortUser | null;
    reassortLogout: () => void;
    reassortIsSingleShopRole: (role: string) => boolean;
    reassortConfirm: (message: string, options?: { danger?: boolean; okLabel?: string; cancelLabel?: string }) => Promise<boolean>;
    reassortToast: (message: string, type?: 'success' | 'error' | 'info') => void;
    reassortMakeShopPickerSearchable?: (select: HTMLSelectElement) => void;
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
 * HTML classiques (`if (!json.success) throw new Error(json.message)`). Lève une erreur avec le
 * message serveur si `success` est faux, pour que les composants n'aient qu'à `try/catch`.
 */
export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await window.reassortFetch(path, options);
  const json: ApiResponse<T> = await res.json();
  if (!json.success) {
    throw new Error(json.message || 'Erreur inconnue du serveur');
  }
  return json.data as T;
}
