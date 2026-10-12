import { useEffect, useState } from 'react';
import { apiFetch } from '../api/client';
import { useAuth } from '../auth/AuthProvider';

const SEEN_KEY_PREFIX = 'reassort_seen_app_version_';

function seenKey(userId: string | undefined): string | null {
  return userId ? SEEN_KEY_PREFIX + userId : null;
}

function readSeenVersion(userId: string | undefined): string | null {
  const key = seenKey(userId);
  if (!key) return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSeenVersion(userId: string | undefined, version: string): void {
  const key = seenKey(userId);
  if (!key) return;
  try {
    localStorage.setItem(key, version);
  } catch {
    // Non persistant si le stockage est indisponible — la pop-up réapparaîtra simplement à la
    // prochaine page, jamais bloquant.
  }
}

export interface AppVersionNotice {
  version: string;
  notes: string;
}

/**
 * Pop-up "nouvelle version disponible" (demande du 13/10/2026 : "les user quand ils vont se
 * connecter ils doivent voir la notif sur l'écran pour une nouvelle version est dispo avec les
 * correctifs"). Compare la version publique courante (GET /api/app-version) à la dernière version
 * que CE compte a déjà vue (localStorage, clé par utilisateur — même pattern que
 * reassort_active_shop_<userId> dans global-shop-selector.js, pour ne jamais faire fuiter cet état
 * entre deux comptes partageant le même navigateur). Première connexion d'un compte (aucune entrée
 * en localStorage) : enregistre la version courante SANS afficher de pop-up — on ne veut pas
 * saluer un nouvel utilisateur avec un historique de correctifs qui ne le concerne pas, seulement
 * prévenir des changements survenus APRÈS sa première visite.
 */
export function useAppVersionNotice(): { notice: AppVersionNotice | null; dismiss: () => void } {
  const { user } = useAuth();
  const [notice, setNotice] = useState<AppVersionNotice | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    apiFetch<{ version: string; notes: string | null }>('/app-version')
      .then((data) => {
        if (cancelled || !data.version) return;
        const seen = readSeenVersion(user.id);
        if (seen === null) {
          // Première visite de ce compte sur ce navigateur : amorce silencieusement, pas de pop-up.
          writeSeenVersion(user.id, data.version);
          return;
        }
        if (seen !== data.version) {
          setNotice({ version: data.version, notes: data.notes || '' });
        }
      })
      .catch(() => {
        // best-effort : un échec de lecture ne doit jamais bloquer le chargement de la page pour
        // une simple pop-up d'information.
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  function dismiss() {
    if (notice) writeSeenVersion(user?.id, notice.version);
    setNotice(null);
  }

  return { notice, dismiss };
}
