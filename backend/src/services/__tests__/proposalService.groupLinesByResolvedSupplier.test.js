/**
 * Tests de groupLinesByResolvedSupplier (proposalService.js) — mission "Logique de gestion des
 * fournisseurs et des commandes", 08/10/2026. Fonction pure : aucun mock nécessaire pour elle,
 * mais le module entier charge pas mal de dépendances au require — mockées à vide.
 */
jest.mock('../../utils/prisma', () => ({}));
jest.mock('../configService', () => ({ getConfig: jest.fn() }));
jest.mock('../periodService', () => ({ resolvePeriod: jest.fn() }));
jest.mock('../salesFileService', () => ({ readSalesLinesForPeriod: jest.fn() }));
jest.mock('../systemConfigService', () => ({ getValue: jest.fn(), KEYS: {} }));
jest.mock('../forecastService', () => ({ forecastAvgWeeklySales: jest.fn(), computeWeekdayFactors: jest.fn(), projectWeekdayWeightedDemand: jest.fn() }));
jest.mock('../../utils/concurrency', () => ({ mapWithConcurrency: jest.fn() }));
jest.mock('../weeklyPlanService', () => ({ attachProposalToWeeklyPlan: jest.fn() }));
jest.mock('../confidenceService', () => ({ computeConfidenceScore: jest.fn() }));
jest.mock('../anomalyService', () => ({ detectAnomalies: jest.fn() }));
jest.mock('../orderAnomalyService', () => ({}));
jest.mock('../stockMoveAnalysisService', () => ({}));
jest.mock('../improvementService', () => ({ PRIORITY_RANK: {} }));
jest.mock('../aiForecastService', () => ({}));
jest.mock('../rposClient', () => ({}));

const { groupLinesByResolvedSupplier } = require('../proposalService');

test('tous les articles au central : un seul groupe LC', () => {
  const lines = [
    { ean: '1', resolvedSupplierId: 'central-id', resolvedSupplierName: 'FOURNISSEUR CENTRALE', deliveryType: 'LC' },
    { ean: '2', resolvedSupplierId: 'central-id', resolvedSupplierName: 'FOURNISSEUR CENTRALE', deliveryType: 'LC' },
  ];
  const { groups, unresolved } = groupLinesByResolvedSupplier(lines);
  expect(groups).toHaveLength(1);
  expect(groups[0].deliveryType).toBe('LC');
  expect(groups[0].lines).toHaveLength(2);
  expect(unresolved).toHaveLength(0);
});

test('exemple de la mission : LC + 2 fournisseurs LD distincts -> 3 commandes', () => {
  const lines = [
    { ean: 'A', resolvedSupplierId: 'central-id', resolvedSupplierName: 'FOURNISSEUR CENTRALE', deliveryType: 'LC' },
    { ean: 'B', resolvedSupplierId: 'satoci-id', resolvedSupplierName: 'SATOCI', deliveryType: 'LD' },
    { ean: 'C', resolvedSupplierId: 'satoci-id', resolvedSupplierName: 'SATOCI', deliveryType: 'LD' },
    { ean: 'D', resolvedSupplierId: 'wholesaler-id', resolvedSupplierName: 'FOURNISSEUR W', deliveryType: 'LD' },
  ];
  const { groups } = groupLinesByResolvedSupplier(lines);
  expect(groups).toHaveLength(3);
  const central = groups.find((g) => g.deliveryType === 'LC');
  const satoci = groups.find((g) => g.supplierName === 'SATOCI');
  const w = groups.find((g) => g.supplierName === 'FOURNISSEUR W');
  expect(central.lines).toHaveLength(1);
  expect(satoci.lines).toHaveLength(2); // B et C regroupés dans UNE SEULE commande SATOCI
  expect(w.lines).toHaveLength(1);
});

test('central toujours en tête de la liste des groupes, même si un autre fournisseur vient avant dans l\'ordre des lignes', () => {
  const lines = [
    { ean: 'A', resolvedSupplierId: 'satoci-id', resolvedSupplierName: 'SATOCI', deliveryType: 'LD' },
    { ean: 'B', resolvedSupplierId: 'central-id', resolvedSupplierName: 'FOURNISSEUR CENTRALE', deliveryType: 'LC' },
  ];
  const { groups } = groupLinesByResolvedSupplier(lines);
  expect(groups[0].deliveryType).toBe('LC');
  expect(groups[1].deliveryType).toBe('LD');
});

test('article sans fournisseur résolu (origin NONE) : jamais dans un groupe, listé à part', () => {
  const lines = [
    { ean: 'A', resolvedSupplierId: 'central-id', resolvedSupplierName: 'FOURNISSEUR CENTRALE', deliveryType: 'LC' },
    { ean: 'G', resolvedSupplierId: null, resolvedSupplierName: null, deliveryType: null }, // cas G de l'exemple de la mission
  ];
  const { groups, unresolved } = groupLinesByResolvedSupplier(lines);
  expect(groups).toHaveLength(1);
  expect(groups[0].lines).toHaveLength(1);
  expect(unresolved).toHaveLength(1);
  expect(unresolved[0].ean).toBe('G');
});

test('liste vide : aucun groupe, aucun non résolu', () => {
  const { groups, unresolved } = groupLinesByResolvedSupplier([]);
  expect(groups).toEqual([]);
  expect(unresolved).toEqual([]);
});

test('tous non résolus : aucun groupe créé', () => {
  const lines = [
    { ean: 'A', resolvedSupplierId: null },
    { ean: 'B', resolvedSupplierId: null },
  ];
  const { groups, unresolved } = groupLinesByResolvedSupplier(lines);
  expect(groups).toEqual([]);
  expect(unresolved).toHaveLength(2);
});
