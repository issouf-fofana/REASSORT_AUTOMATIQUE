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

// En dessous de ce nombre de semaines complètes de données, le profil par jour de semaine n'a pas
// assez d'historique pour être distingué du bruit (un seul samedi anormalement calme ou fort
// fausserait tout le facteur) : on retombe sur une répartition uniforme (facteur 1 partout).
const MIN_WEEKS_FOR_WEEKDAY_PROFILE = 3;

/**
 * Calcule un facteur multiplicateur par jour de semaine (0=dimanche...6=samedi), relatif à la
 * moyenne journalière de l'article sur la période d'analyse : > 1 si ce jour vend plus que la
 * moyenne (ex: samedi en hyper alimentaire), < 1 s'il vend moins (ex: lundi). Sert à répartir la
 * demande projetée sur les jours RÉELLEMENT couverts par la commande (computeQuantityToOrder)
 * plutôt que de supposer une vente uniforme sur la semaine — une commande passée un jeudi pour
 * couvrir jusqu'à lundi ne traverse pas les mêmes jours qu'une commande couvrant lundi à jeudi,
 * et un magasin dont le samedi pèse 40% de plus que la moyenne sous-estime son besoin si cette
 * commande doit couvrir un samedi.
 *
 * @param {Array<{date: string, quantity: number}>} salesLines - lignes de vente brutes sur la
 *   période d'analyse (même source que forecastAvgWeeklySales ci-dessus).
 * @returns {{ factors: number[]|null, method: 'weekday'|'flat', weeksOfData: number }} factors est
 *   un tableau de 7 nombres (index = jour JS getUTCDay()) sommant à 7 (moyenne 1 par jour), ou null
 *   si l'historique est trop court pour être fiable (fallback : traiter comme facteur 1 partout).
 */
function computeWeekdayFactors(salesLines) {
  const byDay = new Map();
  for (const line of salesLines) {
    const day = new Date(line.date).toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) || 0) + (line.quantity || 0));
  }
  const days = Array.from(byDay.keys()).sort();
  if (days.length === 0) return { factors: null, method: 'flat', weeksOfData: 0 };

  // Comble les jours sans vente à 0 (rupture de stock, magasin fermé...) : les ignorer purement et
  // simplement biaiserait la moyenne par jour de semaine vers le haut pour les jours les moins
  // couverts par l'historique disponible.
  const firstDay = new Date(days[0]);
  const lastDay = new Date(days[days.length - 1]);
  const sumByWeekday = new Array(7).fill(0);
  const countByWeekday = new Array(7).fill(0);
  let totalDays = 0;
  for (let d = new Date(firstDay); d <= lastDay; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    const weekday = d.getUTCDay();
    sumByWeekday[weekday] += byDay.get(key) || 0;
    countByWeekday[weekday] += 1;
    totalDays += 1;
  }

  const weeksOfData = totalDays / 7;
  if (weeksOfData < MIN_WEEKS_FOR_WEEKDAY_PROFILE) return { factors: null, method: 'flat', weeksOfData };

  const avgByWeekday = sumByWeekday.map((sum, i) => (countByWeekday[i] > 0 ? sum / countByWeekday[i] : 0));
  const overallAvg = avgByWeekday.reduce((a, b) => a + b, 0) / 7;
  // overallAvg à 0 : article qui ne s'est jamais vendu sur la période (déjà exclu en amont dans la
  // pratique, avgWeeklySales serait alors 0 aussi) — pas de profil exploitable, facteur 1 partout.
  if (overallAvg <= 0) return { factors: null, method: 'flat', weeksOfData };

  const factors = avgByWeekday.map((avg) => avg / overallAvg);
  return { factors, method: 'weekday', weeksOfData };
}

/**
 * Répartit une demande hebdomadaire moyenne sur un nombre de jours donné, EN COMMENÇANT à partir
 * d'aujourd'hui, en tenant compte du profil par jour de semaine (computeWeekdayFactors) plutôt que
 * de la répartition uniforme implicite de (avgWeeklySales / 7) * coverageDays.
 *
 * @param {number} avgWeeklySales
 * @param {number} coverageDays - nombre de jours à couvrir (cf. computeQuantityToOrder)
 * @param {number[]|null} weekdayFactors - depuis computeWeekdayFactors, ou null (répartition uniforme)
 * @param {Date} [startDate] - premier jour couvert (par défaut aujourd'hui) ; paramétrable pour les tests.
 */
function projectWeekdayWeightedDemand(avgWeeklySales, coverageDays, weekdayFactors, startDate = new Date()) {
  const avgDailySales = avgWeeklySales / 7;
  if (!weekdayFactors) return avgDailySales * coverageDays;

  let total = 0;
  const d = new Date(startDate);
  for (let i = 0; i < coverageDays; i++) {
    total += avgDailySales * weekdayFactors[d.getUTCDay()];
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return total;
}

module.exports = {
  forecastAvgWeeklySales, DEFAULT_ALPHA, MIN_DAYS_FOR_SMOOTHING,
  computeWeekdayFactors, projectWeekdayWeightedDemand, MIN_WEEKS_FOR_WEEKDAY_PROFILE,
};
