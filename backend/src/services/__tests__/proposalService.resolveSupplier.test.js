/**
 * Tests de resolveSupplierForArticle (proposalService.js) — mission "Logique de gestion des
 * fournisseurs et des commandes", 07/10/2026. Couvre la cascade complète CENTRAL → HISTORY →
 * FALLBACK → NONE, et les cas limites validés avec l'utilisateur :
 *   - priorité HISTORY uniquement si le fournisseur historique est encore rattaché à l'article
 *   - FALLBACK = délai de livraison le plus court parmi les fournisseurs actuellement rattachés
 *   - useHistory=false désactive l'étape 2 sans casser le reste de la cascade
 *   - une erreur réseau sur l'historique ne bloque jamais, retombe sur le fallback
 */
jest.mock('../../utils/prisma', () => ({}));
jest.mock('./configService', () => ({ getConfig: jest.fn() }), { virtual: true });
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
jest.mock('../rposClient', () => ({
  getLastPurchaseForProduct: jest.fn(),
  getSupplierOfOrder: jest.fn(),
}));

const rpos = require('../rposClient');
const { resolveSupplierForArticle } = require('../proposalService');

const POS_ID = 'pos16';
const SHOP_ID = 'shop-uuid-1';

const CENTRAL = { id: 'central-uuid', code: '000000', name: 'FOURNISSEUR CENTRALE', delivery_time_days: 0 };
const SUPPLIER_X = { id: 'x-uuid', code: '060299', name: 'S2P SOCOCE Z3', delivery_time_days: 2 };
const SUPPLIER_Y = { id: 'y-uuid', code: '006164', name: 'SOCOCE CLUB SA', delivery_time_days: 0 };
const SUPPLIER_Z = { id: 'z-uuid', code: '099999', name: 'FOURNISSEUR Z', delivery_time_days: 5 };

beforeEach(() => jest.clearAllMocks());

test('article rattaché au central : CENTRAL toujours prioritaire, jamais d\'appel historique', async () => {
  const product = { id: 'prod-1', ean: '100', suppliers: [SUPPLIER_X, CENTRAL] };
  const result = await resolveSupplierForArticle(POS_ID, SHOP_ID, product);
  expect(result).toEqual({ supplier: CENTRAL, origin: 'CENTRAL', deliveryType: 'LC' });
  expect(rpos.getLastPurchaseForProduct).not.toHaveBeenCalled();
});

test('aucun fournisseur du tout : NONE, article non traitable', async () => {
  const product = { id: 'prod-2', ean: '200', suppliers: [] };
  const result = await resolveSupplierForArticle(POS_ID, SHOP_ID, product);
  expect(result).toEqual({ supplier: null, origin: 'NONE', deliveryType: null });
});

test('pas de central, fournisseur historique toujours rattaché : HISTORY sélectionné', async () => {
  const product = { id: 'prod-3', ean: '300', suppliers: [SUPPLIER_X, SUPPLIER_Y] };
  rpos.getLastPurchaseForProduct.mockResolvedValue({ orderReference: 'CMD-123' });
  rpos.getSupplierOfOrder.mockResolvedValue(SUPPLIER_X); // retrouvé par id, toujours dans suppliers

  const result = await resolveSupplierForArticle(POS_ID, SHOP_ID, product);
  expect(result).toEqual({ supplier: SUPPLIER_X, origin: 'HISTORY', deliveryType: 'LD' });
});

test('fournisseur historique trouvé mais PLUS rattaché à l\'article : fallback vers délai le plus court (exemple D/E de la mission)', async () => {
  const product = { id: 'prod-4', ean: '400', suppliers: [SUPPLIER_Y, SUPPLIER_Z] }; // Y=0j, Z=5j
  rpos.getLastPurchaseForProduct.mockResolvedValue({ orderReference: 'CMD-456' });
  rpos.getSupplierOfOrder.mockResolvedValue(SUPPLIER_X); // X n'est plus dans product.suppliers

  const result = await resolveSupplierForArticle(POS_ID, SHOP_ID, product);
  expect(result.origin).toBe('FALLBACK');
  expect(result.supplier).toEqual(SUPPLIER_Y); // délai le plus court (0j < 5j)
  expect(result.deliveryType).toBe('LD');
});

test('aucun historique trouvé (article jamais commandé) : fallback direct', async () => {
  const product = { id: 'prod-5', ean: '500', suppliers: [SUPPLIER_Z, SUPPLIER_Y] };
  rpos.getLastPurchaseForProduct.mockResolvedValue(null);

  const result = await resolveSupplierForArticle(POS_ID, SHOP_ID, product);
  expect(result.origin).toBe('FALLBACK');
  expect(result.supplier).toEqual(SUPPLIER_Y);
});

test('erreur réseau sur la résolution historique : ne bloque jamais, retombe sur fallback', async () => {
  const product = { id: 'prod-6', ean: '600', suppliers: [SUPPLIER_X] };
  rpos.getLastPurchaseForProduct.mockRejectedValue(new Error('Serveur RPOS injoignable'));

  const result = await resolveSupplierForArticle(POS_ID, SHOP_ID, product);
  expect(result.origin).toBe('FALLBACK');
  expect(result.supplier).toEqual(SUPPLIER_X);
});

test('useHistory=false : saute directement au fallback, aucun appel RPOS historique', async () => {
  const product = { id: 'prod-7', ean: '700', suppliers: [SUPPLIER_Y, SUPPLIER_Z] };
  const result = await resolveSupplierForArticle(POS_ID, SHOP_ID, product, { useHistory: false });
  expect(result.origin).toBe('FALLBACK');
  expect(result.supplier).toEqual(SUPPLIER_Y);
  expect(rpos.getLastPurchaseForProduct).not.toHaveBeenCalled();
});

test('un seul fournisseur actuel, pas de central ni historique : fallback trivial sur ce seul fournisseur', async () => {
  const product = { id: 'prod-8', ean: '800', suppliers: [SUPPLIER_Z] };
  rpos.getLastPurchaseForProduct.mockResolvedValue(null);
  const result = await resolveSupplierForArticle(POS_ID, SHOP_ID, product);
  expect(result).toEqual({ supplier: SUPPLIER_Z, origin: 'FALLBACK', deliveryType: 'LD' });
});

test('delivery_time_days manquant sur un fournisseur : jamais prioritaire face à un délai connu', async () => {
  const noDelay = { id: 'nodelay-uuid', code: '111111', name: 'SANS DELAI CONNU', delivery_time_days: undefined };
  const product = { id: 'prod-9', ean: '900', suppliers: [noDelay, SUPPLIER_Z] }; // Z=5j connu
  rpos.getLastPurchaseForProduct.mockResolvedValue(null);
  const result = await resolveSupplierForArticle(POS_ID, SHOP_ID, product);
  expect(result.supplier).toEqual(SUPPLIER_Z); // 5j connu bat "inconnu" (traité comme pire cas)
});
