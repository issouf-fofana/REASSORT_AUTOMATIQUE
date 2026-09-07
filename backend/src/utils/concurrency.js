/**
 * Utilitaires de concurrence partagés par les jobs planifiés (audit performance : magasins/serveurs
 * traités en série, aucun verrou anti-chevauchement entre deux exécutions du même cron).
 */

/**
 * Traite `items` par lots de taille `concurrency`, en parallèle au sein de chaque lot. Chaque appel
 * à `handler` ne doit jamais rejeter (catcher ses propres erreurs) sous peine de stopper le lot en
 * cours via Promise.all — les jobs appelants gèrent déjà leurs erreurs par élément individuellement.
 */
async function mapWithConcurrency(items, concurrency, handler) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(handler));
    results.push(...batchResults);
  }
  return results;
}

/**
 * Empêche deux exécutions simultanées d'une même fonction planifiée (ex: le job nocturne qui
 * dépasse son intervalle sur un cycle chargé, ou un déclenchement manuel pendant qu'un cron est
 * déjà en cours) : si un appel est déjà en cours, les appels suivants sont ignorés (avec un log)
 * plutôt que de s'empiler et de doubler la charge RPOS sur les mêmes magasins.
 */
function createJobLock(jobName) {
  let running = false;
  return async function runLocked(fn) {
    if (running) {
      console.warn(`[cron] ${jobName} déjà en cours d'exécution, ce déclenchement est ignoré.`);
      return;
    }
    running = true;
    try {
      await fn();
    } finally {
      running = false;
    }
  };
}

module.exports = { mapWithConcurrency, createJobLock };
