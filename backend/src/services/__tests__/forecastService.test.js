const {
  forecastAvgWeeklySales, MIN_DAYS_FOR_SMOOTHING,
  computeWeekdayFactors, projectWeekdayWeightedDemand, MIN_WEEKS_FOR_WEEKDAY_PROFILE,
} = require('../forecastService');

describe('forecastAvgWeeklySales', () => {
  test('historique trop court (< 14 jours) : retombe sur la moyenne plate', () => {
    const lines = [{ date: '2026-01-01', quantity: 10 }, { date: '2026-01-05', quantity: 10 }];
    const result = forecastAvgWeeklySales(lines, MIN_DAYS_FOR_SMOOTHING - 1, 0.3);
    expect(result.method).toBe('flat');
    expect(result.alpha).toBeNull();
  });

  test('historique suffisant : utilise le lissage exponentiel', () => {
    const lines = [];
    for (let i = 0; i < 20; i++) {
      lines.push({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, quantity: 5 });
    }
    const result = forecastAvgWeeklySales(lines, 20, 0.3);
    expect(result.method).toBe('smoothed');
    expect(result.alpha).toBe(0.3);
  });

  test('rythme stable : le lissage converge vers la même valeur que la moyenne plate', () => {
    const lines = [];
    for (let i = 0; i < 20; i++) {
      lines.push({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, quantity: 5 });
    }
    const flatAvg = (5 * 20 / 20) * 7; // 35/semaine
    const result = forecastAvgWeeklySales(lines, 20, 0.3);
    expect(result.avgWeeklySales).toBeCloseTo(flatAvg, 0);
  });

  test('accélération récente : le lissage réagit plus vite que la moyenne plate', () => {
    const lines = [];
    for (let i = 0; i < 15; i++) lines.push({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, quantity: 2 });
    for (let i = 15; i < 20; i++) lines.push({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, quantity: 20 });

    const totalQty = 15 * 2 + 5 * 20;
    const flatAvgWeekly = (totalQty / 20) * 7;
    const result = forecastAvgWeeklySales(lines, 20, 0.5);

    // Le lissage doit être plus proche du rythme récent (20/jour = 140/sem) que la moyenne plate.
    expect(result.avgWeeklySales).toBeGreaterThan(flatAvgWeekly);
  });

  test('aucune vente sur la période : renvoie 0 sans planter', () => {
    const result = forecastAvgWeeklySales([], 20, 0.3);
    expect(result.avgWeeklySales).toBe(0);
  });
});

describe('computeWeekdayFactors', () => {
  // Construit N semaines complètes (dimanche à samedi) où seul le samedi (getUTCDay()===6) vend
  // le double des autres jours — 2026-01-03 est un samedi (vérifié : 2026-01-01 = jeudi).
  function buildWeeksWithStrongSaturday(weeks) {
    const lines = [];
    const start = new Date('2026-01-04T00:00:00.000Z'); // dimanche
    for (let i = 0; i < weeks * 7; i++) {
      const d = new Date(start);
      d.setUTCDate(d.getUTCDate() + i);
      const isSaturday = d.getUTCDay() === 6;
      lines.push({ date: d.toISOString().slice(0, 10), quantity: isSaturday ? 20 : 10 });
    }
    return lines;
  }

  test('historique trop court (< 3 semaines) : pas de profil, fallback plat', () => {
    const lines = buildWeeksWithStrongSaturday(MIN_WEEKS_FOR_WEEKDAY_PROFILE - 1);
    const result = computeWeekdayFactors(lines);
    expect(result.method).toBe('flat');
    expect(result.factors).toBeNull();
  });

  test('historique suffisant : détecte le samedi fort (facteur > 1)', () => {
    const lines = buildWeeksWithStrongSaturday(4);
    const result = computeWeekdayFactors(lines);
    expect(result.method).toBe('weekday');
    expect(result.factors).not.toBeNull();
    expect(result.factors[6]).toBeGreaterThan(1); // samedi
    // 6 jours à 10 + 1 samedi à 20 sur 7 jours -> moyenne 11.43 -> facteur jour normal = 10/11.43 ≈ 0.875
    expect(result.factors[1]).toBeCloseTo(0.875, 2); // lundi, en dessous de la moyenne tirée vers le haut par le samedi
  });

  test('les facteurs somment à 7 (moyenne 1 par jour)', () => {
    const lines = buildWeeksWithStrongSaturday(4);
    const result = computeWeekdayFactors(lines);
    const sum = result.factors.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(7, 5);
  });

  test('aucune vente : pas de profil exploitable', () => {
    const result = computeWeekdayFactors([]);
    expect(result.factors).toBeNull();
    expect(result.method).toBe('flat');
  });

  test('rythme parfaitement plat : tous les facteurs valent 1', () => {
    const lines = [];
    const start = new Date('2026-01-04T00:00:00.000Z');
    for (let i = 0; i < 28; i++) {
      const d = new Date(start);
      d.setUTCDate(d.getUTCDate() + i);
      lines.push({ date: d.toISOString().slice(0, 10), quantity: 10 });
    }
    const result = computeWeekdayFactors(lines);
    result.factors.forEach((f) => expect(f).toBeCloseTo(1, 5));
  });
});

describe('projectWeekdayWeightedDemand', () => {
  test('sans profil (null) : répartition uniforme, identique à avgWeeklySales/7 * coverageDays', () => {
    const result = projectWeekdayWeightedDemand(70, 3, null);
    expect(result).toBeCloseTo((70 / 7) * 3, 5);
  });

  test('avec profil : une couverture centrée sur un jour fort donne plus que la moyenne uniforme', () => {
    const factors = [1, 1, 1, 1, 1, 1, 7]; // tout le poids sur samedi (index 6)
    // Démarre un samedi (2026-01-03) : le seul jour couvert (coverageDays=1) est le jour fort.
    const saturday = new Date('2026-01-03T00:00:00.000Z');
    const result = projectWeekdayWeightedDemand(70, 1, factors, saturday);
    const uniform = (70 / 7) * 1;
    expect(result).toBeGreaterThan(uniform);
  });

  test('avec profil : une couverture centrée sur un jour faible donne moins que la moyenne uniforme', () => {
    const factors = [1, 1, 1, 1, 1, 1, 7]; // samedi fort, tous les autres jours à poids réduit
    const sunday = new Date('2026-01-04T00:00:00.000Z'); // dimanche, index 0, facteur 1 (pas le plus faible ici mais < samedi)
    const result = projectWeekdayWeightedDemand(70, 1, factors, sunday);
    const uniform = (70 / 7) * 1;
    expect(result).toBeLessThan((70 / 7) * 7); // sanity : jamais plus que si on couvrait le jour le plus fort
    expect(result).toBeLessThan(uniform * 7);
  });

  test('couverture sur 7 jours pleins : le facteur jour de semaine se neutralise, retombe sur la moyenne', () => {
    const factors = [0.5, 0.7, 1, 1, 1.1, 1.2, 1.5]; // somme = 7
    const anyDay = new Date('2026-01-04T00:00:00.000Z');
    const result = projectWeekdayWeightedDemand(70, 7, factors, anyDay);
    expect(result).toBeCloseTo(70, 5); // une semaine complète = la moyenne hebdomadaire, peu importe le profil
  });
});
