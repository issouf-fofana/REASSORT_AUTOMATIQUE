import { useEffect, useState } from 'react';
import { apiFetch } from '../api/client';

// Numéro de version affiché sous le logo (sidebar) — lu depuis SystemConfig via une route publique
// (GET /api/app-version, cf. backend/src/routes/publicAssets.js), modifiable depuis Paramètres >
// Réassort (SiteBrandingSection.tsx). Remplace l'ancien texte "v1.0.0" codé en dur ET la tentative
// précédente d'injection au build (__APP_VERSION__, abandonnée le 13/10/2026 — demande explicite :
// "ne fait pas à chaque push sinon il va gonfler... si je suis sûr que c'est bon je met à jour la
// valeur sur le UI") : la valeur vit maintenant en base, changée manuellement par l'ADMIN quand une
// mise à jour est jugée stable, visible immédiatement sans nouveau déploiement du frontend.
export function useAppVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ version: string }>('/app-version')
      .then((data) => {
        if (!cancelled) setVersion(data.version);
      })
      .catch(() => {
        // best-effort : un échec de lecture laisse simplement l'affichage vide, jamais bloquant
        // pour le reste de la sidebar.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return version;
}
