import { apiFetch } from './client';

/**
 * Reproduit saveSystemConfigKey de settings.old.html : PUT /reassort/system-config avec { key,
 * value }. La valeur est TOUJOURS envoyée en chaîne (systemConfig.value est un champ String côté
 * Prisma) — un nombre JS non converti fait échouer l'écriture ("Expected String, provided Float"),
 * bug déjà rencontré sur ADMIN_DASHBOARD_STOCKOUT_ALERT_THRESHOLD/REVISION_CHANGE_THRESHOLD.
 */
export async function saveSystemConfigKey(key: string, value: string): Promise<void> {
  await apiFetch(`/reassort/system-config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value }),
  });
}
