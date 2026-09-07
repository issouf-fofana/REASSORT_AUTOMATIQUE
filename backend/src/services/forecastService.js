/**
 * Prévision de vente moyenne par lissage exponentiel simple (SES), en remplacement de la moyenne
 * plate sur toute la période utilisée jusqu'ici (avgWeeklySales = total / periodDays * 7) :
 * pondère les ventes récentes plus fort que les anciennes, donc réagit plus vite à un changement
 * de rythme de vente (accélération ou ralentissement) sans attendre que la moyenne sur toute la
 * période ne finisse par bouger.
 *
 * Formule (par bucket journalier, du plus ancien au plus récent) :
 *   niveau[0] = quantité[0]
 *   niveau[i] = alpha * quantité[i] + (1 - alpha) * niveau[i-1]
 * Le dernier niveau calculé est la prévision de vente quotidienne courante, ramenée en
 * hebdomadaire pour rester compatible avec le reste du calcul de réassort (computeQuantityToOrder
 * attend un avgWeeklySales).
 */

// En dessous de ce nombre de jours de données, le lissage n'a pas assez d'historique pour être
// fiable (les tout premiers jours dominent le résultat) : on retombe sur la moyenne plate.
const MIN_DAYS_FOR_SMOOTHING = 14;

const DEFAULT_ALPHA = 0.3;

/**
 * @param {Array<{date: string, quantity: number}>} salesLines - lignes de vente brutes (pas
 *   nécessairement agrégées), sur la période d'analyse.
 * @param {number} periodDays - durée de la période d'analyse en jours, pour le fallback moyenne
 *   plate et pour combler les jours sans vente (une rupture de stock de plusieurs jours doit
 *   compter comme des jours à 0, pas être ignorée du tout).
 * @param {number} [alpha] - poids donné à la journée la plus récente (0 à 1), configurable par
 *   magasin (config.forecastAlpha). Plus proche de 1 : colle vite aux ventes récentes. Plus
 *   proche de 0 : lisse davantage, réagit plus lentement.
 * @returns {{ avgWeeklySales: number, method: 'smoothed' | 'flat', alpha: number|null }}
 */
function forecastAvgWeeklySales(salesLines, periodDays, alpha = DEFAULT_ALPHA) {
  const totalQuantity = salesLines.reduce((sum, l) => sum + (l.quantity || 0), 0);
  const flatAvgWeekly = periodDays > 0 ? (totalQuantity / periodDays) * 7 : 0;

  if (periodDays < MIN_DAYS_FOR_SMOOTHING) {
    return { avgWeeklySales: flatAvgWeekly, method: 'flat', alpha: null };
  }

  // Agrège en buckets journaliers complets (jours sans vente inclus à 0), pour que le lissage
  // voie les vraies variations de rythme plutôt qu'une série creuse.
  const byDay = new Map();
  for (const line of salesLines) {
    const day = new Date(line.date).toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) || 0) + (line.quantity || 0));
  }

  const days = Array.from(byDay.keys()).sort();
  if (days.length === 0) return { avgWeeklySales: 0, method: 'flat', alpha: null };

  const firstDay = new Date(days[0]);
  const lastDay = new Date(days[days.length - 1]);
  const dailyQuantities = [];
  for (let d = new Date(firstDay); d <= lastDay; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    dailyQuantities.push(byDay.get(key) || 0);
  }

  let level = dailyQuantities[0];
  for (let i = 1; i < dailyQuantities.length; i++) {
    level = alpha * dailyQuantities[i] + (1 - alpha) * level;
  }

  return { avgWeeklySales: level * 7, method: 'smoothed', alpha };
}

module.exports = { forecastAvgWeeklySales, DEFAULT_ALPHA, MIN_DAYS_FOR_SMOOTHING };
