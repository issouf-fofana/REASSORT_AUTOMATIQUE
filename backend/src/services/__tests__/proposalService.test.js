/**
 * Tests du cœur de calcul de réassort (proposalService.js) : quantité à commander et
 * classement Pareto. Fonctions pures, testées sans base de données ni appel réseau.
 *
 * Priorité donnée à computeQuantityToOrder car c'est la fonction directement en cause dans le
 * bug critique corrigé début septembre 2026 (colisage RPOS mal envoyé, cf. rposClient.js) : le
 * calcul lui-même était déjà correct, mais rien ne garantissait de le rester à un futur
 * changement — ces tests figent le comportement attendu.
 */
const { computeQuantityToOrder, computeParetoFromLines, computeCoverageDaysFromOrderDays } = require('../proposalService');

describe('computeQuantityToOrder', () => {
  test('besoin positif, arrondi exact au colisage (cas nominal)', () => {
    // vente 70/sem, stock sécurité 50% = 35, stock actuel 0, rien en commande
    // besoin = 70 + 35 - 0 - 0 = 105, colisage 12 -> ceil(105/12)=9 -> 9*12=108
    const qty = computeQuantityToOrder(70, 0, 0, 12, 0.5, 1, false);
    expect(qty).toBe(108);
  });

  test('arrondit toujours vers le HAUT, jamais vers le bas (ne jamais sous-livrer)', () => {
    // besoin = 13, colisage 12 -> doit donner 24 (2 colis), jamais 12 (1 colis, sous-livrerait)
    const qty = computeQuantityToOrder(13, 0, 0, 12, 0, 1, false);
    expect(qty).toBe(24);
    expect(qty).toBeGreaterThanOrEqual(13);
  });

  test('besoin déjà couvert par le stock : ne propose rien (jamais négatif)', () => {
    const qty = computeQuantityToOrder(10, 100, 0, 1, 0.5, 1, false);
    expect(qty).toBe(0);
  });

  test('déduit la quantité déjà en commande du besoin', () => {
    // besoin brut = 70 + 35 = 105, moins 105 déjà en commande = 0
    const qty = computeQuantityToOrder(70, 0, 105, 12, 0.5, 1, false);
    expect(qty).toBe(0);
  });

  test('colisage 1 (vendu à l\'unité) : résultat = besoin arrondi à l\'entier supérieur', () => {
    const qty = computeQuantityToOrder(10, 0, 0, 1, 0, 1, false);
    expect(qty).toBe(10);
  });

  test('colisage absent (undefined/0) retombe sur 1, jamais de division par zéro', () => {
    expect(() => computeQuantityToOrder(10, 0, 0, 0, 0, 1, false)).not.toThrow();
    expect(computeQuantityToOrder(10, 0, 0, 0, 0, 1, false)).toBe(10);
    expect(computeQuantityToOrder(10, 0, 0, undefined, 0, 1, false)).toBe(10);
  });

  test('useReceptionLeadTime=true couvre le délai de réception au lieu d\'une semaine fixe', () => {
    // vente 70/sem = 10/jour, délai de réception 3 jours -> besoin = 10*3 = 30 (sans stock sécurité)
    const qty = computeQuantityToOrder(70, 0, 0, 1, 0, 3, true);
    expect(qty).toBe(30);
  });

  test('useReceptionLeadTime=false ignore receptionLeadTimeDays, toujours 7 jours', () => {
    const qtyWithLeadTimeIgnored = computeQuantityToOrder(70, 0, 0, 1, 0, 3, false);
    const qtyDefaultWeek = computeQuantityToOrder(70, 0, 0, 1, 0, null, false);
    expect(qtyWithLeadTimeIgnored).toBe(qtyDefaultWeek);
    expect(qtyWithLeadTimeIgnored).toBe(70);
  });

  test('stock négatif augmente le besoin au lieu de le réduire', () => {
    const qtyStockZero = computeQuantityToOrder(70, 0, 0, 1, 0, 1, false);
    const qtyStockNegative = computeQuantityToOrder(70, -20, 0, 1, 0, 1, false);
    expect(qtyStockNegative).toBe(qtyStockZero + 20);
  });

  test('coverageDaysOverride prime sur receptionLeadTimeDays/useReceptionLeadTime (03/11/2026, jours de commande)', () => {
    // vente 70/sem = 10/jour, override à 2 jours -> besoin = 20, quels que soient les 2 params ignorés
    const qty = computeQuantityToOrder(70, 0, 0, 1, 0, 99, true, null, 2);
    expect(qty).toBe(20);
  });

  test('coverageDaysOverride=null (par défaut) ne change rien au comportement existant', () => {
    const qtyWithoutOverride = computeQuantityToOrder(70, 0, 0, 1, 0, 3, true);
    const qtyExplicitNull = computeQuantityToOrder(70, 0, 0, 1, 0, 3, true, null, null);
    expect(qtyWithoutOverride).toBe(qtyExplicitNull);
  });
});

describe('computeCoverageDaysFromOrderDays', () => {
  function date(isoWeekday) {
    // 2026-11-02 = lundi (ISO) ; isoWeekday 1=lundi ... 7=dimanche, pour écrire les tests en clair.
    const base = new Date('2026-11-02T10:00:00Z');
    base.setDate(base.getDate() + (isoWeekday - 1));
    return base;
  }

  test('orderDays vide ou absent -> null (repli sur le comportement par défaut de l\'appelant)', () => {
    expect(computeCoverageDaysFromOrderDays([])).toBeNull();
    expect(computeCoverageDaysFromOrderDays(null)).toBeNull();
    expect(computeCoverageDaysFromOrderDays(undefined)).toBeNull();
  });

  test('un seul jour de commande par semaine -> toujours 7 jours', () => {
    expect(computeCoverageDaysFromOrderDays(['MARDI'], date(2))).toBe(7); // généré un mardi
    expect(computeCoverageDaysFromOrderDays(['MARDI'], date(5))).toBe(7); // généré un vendredi
  });

  test('cas de l\'utilisateur (03/11/2026) : commande samedi/mardi/jeudi', () => {
    const orderDays = ['SAMEDI', 'MARDI', 'JEUDI'];
    expect(computeCoverageDaysFromOrderDays(orderDays, date(6))).toBe(3); // samedi -> mardi (dimanche, lundi, mardi)
    expect(computeCoverageDaysFromOrderDays(orderDays, date(2))).toBe(2); // mardi -> jeudi (mercredi, jeudi)
    expect(computeCoverageDaysFromOrderDays(orderDays, date(4))).toBe(2); // jeudi -> samedi (vendredi, samedi)
  });

  test('deux jours de commande réguliers (lundi/jeudi) -> écarts 3/4 jours', () => {
    const orderDays = ['LUNDI', 'JEUDI'];
    expect(computeCoverageDaysFromOrderDays(orderDays, date(1))).toBe(3); // lundi -> jeudi
    expect(computeCoverageDaysFromOrderDays(orderDays, date(4))).toBe(4); // jeudi -> lundi suivant
  });

  test('généré un jour SANS commande (hors cycle) : couvre jusqu\'au prochain jour de commande', () => {
    // cycle lundi/jeudi, génération un mercredi -> prochaine commande jeudi, la fonction raisonne
    // depuis ce jour de commande le plus proche (jeudi) jusqu'au suivant (lundi) : 4 jours.
    expect(computeCoverageDaysFromOrderDays(['LUNDI', 'JEUDI'], date(3))).toBe(4);
  });

  test('libellés insensibles à la casse, jours invalides ignorés', () => {
    expect(computeCoverageDaysFromOrderDays(['lundi', 'JEUDI'], date(1))).toBe(3);
    expect(computeCoverageDaysFromOrderDays(['LUNDI', 'PAS_UN_JOUR'], date(1))).toBe(7);
  });
});

describe('computeParetoFromLines', () => {
  function line(ean, quantity, totalExclTax, date = '2026-01-01T10:00:00Z') {
    return { ean, quantity: String(quantity), total_excl_tax: String(totalExclTax), date, label_1: `Article ${ean}` };
  }

  test('sélectionne les articles qui cumulent jusqu\'au seuil Pareto, triés par CA décroissant', () => {
    const lines = [
      line('1', 1, 800), // 80% du CA total
      line('2', 1, 150), // 15%
      line('3', 1, 50),  // 5%
    ];
    const { priorityArticles, totalArticlesWithSales } = computeParetoFromLines(lines, 0.8, 7, { enabled: false });
    expect(totalArticlesWithSales).toBe(3);
    // Le premier article (80% CA) atteint déjà le seuil de 80% à lui seul : Pareto s'arrête là.
    expect(priorityArticles.map((a) => a.code)).toEqual(['1']);
  });

  test('ignore les codes génériques (non purement numériques)', () => {
    const lines = [line('POIDS', 1, 500), line('12345', 1, 500)];
    const { totalArticlesWithSales } = computeParetoFromLines(lines, 0.8, 7, { enabled: false });
    expect(totalArticlesWithSales).toBe(1);
  });

  test('exclut du calcul de CA les lignes à CA négatif (retours/annulations)', () => {
    const lines = [line('1', 1, 100), line('1', -1, -100)];
    const { priorityArticles } = computeParetoFromLines(lines, 0.8, 7, { enabled: false });
    // Le CA net de l'article est 0 : filtré (caHt > 0 requis), ne doit apparaître nulle part.
    expect(priorityArticles.find((a) => a.code === '1')).toBeUndefined();
  });

  test('avg_weekly_quantity = quantité totale ramenée à une semaine sur la période analysée', () => {
    const lines = [line('1', 20, 500)]; // 20 unités vendues sur 10 jours
    const { priorityArticles } = computeParetoFromLines(lines, 0.8, 10, { enabled: false });
    // (20 / 10 jours) * 7 = 14 / semaine
    expect(priorityArticles[0].avg_weekly_quantity).toBeCloseTo(14);
    expect(priorityArticles[0].forecast_method).toBe('flat');
  });

  test('daily_history agrège les ventes par jour, triées chronologiquement', () => {
    const lines = [
      line('1', 5, 100, '2026-01-02T08:00:00Z'),
      line('1', 3, 60, '2026-01-01T08:00:00Z'),
      line('1', 2, 40, '2026-01-01T18:00:00Z'), // même jour que la ligne précédente : doit s'additionner
    ];
    const { priorityArticles } = computeParetoFromLines(lines, 0.8, 2, { enabled: false });
    const history = priorityArticles[0].daily_history;
    expect(history).toEqual([
      { date: '2026-01-01', quantity: 5 },
      { date: '2026-01-02', quantity: 5 },
    ]);
  });
});
