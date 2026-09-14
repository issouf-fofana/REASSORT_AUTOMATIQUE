/**
 * Tests de la détection d'anomalies (anomalyService.js, étape 7) : fonctions pures, sans base
 * ni réseau. Figent le comportement des seuils, dont ANOMALY_MIN_DAILY_SALES (configurable
 * depuis Paramètres, défaut 1 unité/jour).
 */
const { detectAnomalies } = require('../anomalyService');

const tenDays = (qty) => Array.from({ length: 10 }, () => ({ quantity: qty }));

describe('detectAnomalies', () => {
  test('explosion des ventes détectée (3 derniers jours très au-dessus du reste)', () => {
    const history = [...tenDays(2).slice(0, 7), { quantity: 15 }, { quantity: 16 }, { quantity: 14 }];
    const { anomalies } = detectAnomalies({ stock: 10, avgWeeklySales: 14, dailyHistory: history });
    expect(anomalies.some((a) => a.type === 'SALES_SPIKE')).toBe(true);
  });

  test('ventes stables : aucune anomalie, tendance STABLE', () => {
    const { anomalies, trend } = detectAnomalies({ stock: 10, avgWeeklySales: 14, dailyHistory: tenDays(2) });
    expect(anomalies).toEqual([]);
    expect(trend.category).toBe('STABLE');
  });

  test('historique trop court : UNKNOWN, jamais de faux signal', () => {
    const { anomalies, trend } = detectAnomalies({ stock: 5, avgWeeklySales: 14, dailyHistory: [{ quantity: 9 }] });
    expect(anomalies).toEqual([]);
    expect(trend.category).toBe('UNKNOWN');
  });

  test('rupture invisible : stock dispo + silence total + rythme habituel >= seuil', () => {
    const zeros = tenDays(0);
    const { anomalies } = detectAnomalies({ stock: 10, avgWeeklySales: 14, dailyHistory: zeros });
    expect(anomalies.some((a) => a.type === 'STOCK_INCONSISTENCY')).toBe(true);
  });

  test('article lent (0.5/jour) : pas de signal au seuil par défaut 1/jour', () => {
    const { anomalies } = detectAnomalies({ stock: 10, avgWeeklySales: 3.5, dailyHistory: tenDays(0) });
    expect(anomalies.some((a) => a.type === 'STOCK_INCONSISTENCY')).toBe(false);
  });

  test('article lent : signalé si le seuil est abaissé à 0.5 (ANOMALY_MIN_DAILY_SALES)', () => {
    const { anomalies } = detectAnomalies({ stock: 10, avgWeeklySales: 3.5, dailyHistory: tenDays(0), minAvgDailySales: 0.5 });
    expect(anomalies.some((a) => a.type === 'STOCK_INCONSISTENCY')).toBe(true);
  });

  test('seuil à 0 : tout silence avec stock est signalé', () => {
    const { anomalies } = detectAnomalies({ stock: 4, avgWeeklySales: 0.7, dailyHistory: tenDays(0), minAvgDailySales: 0 });
    expect(anomalies.some((a) => a.type === 'STOCK_INCONSISTENCY')).toBe(true);
  });
});
