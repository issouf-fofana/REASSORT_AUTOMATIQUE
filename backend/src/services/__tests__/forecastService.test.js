const { forecastAvgWeeklySales, MIN_DAYS_FOR_SMOOTHING } = require('../forecastService');

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
