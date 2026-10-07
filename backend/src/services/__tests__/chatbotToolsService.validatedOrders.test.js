/**
 * Tests de getValidatedOrders après l'ajout de source/status/queriedAt (amelioration1.md §12-14,
 * 07/10/2026) : distingue maintenant explicitement "RPOS injoignable pendant l'enrichissement des
 * commandes" de "aucun serveur RPOS connu" et "succès", là où avant les deux premiers cas étaient
 * indiscernables (champs RPOS à null dans les deux cas, sans aucun signal de la cause).
 */
jest.mock('../../utils/prisma', () => ({ proposalOrder: { findMany: jest.fn() } }));
jest.mock('../rposClient', () => ({ getSupplierOrders: jest.fn() }));
jest.mock('../stockMoveAnalysisService', () => ({}));
jest.mock('../orderAnomalyService', () => ({ listAnomalies: jest.fn() }));
jest.mock('../aiForecastService', () => ({}));

const prisma = require('../../utils/prisma');
const rpos = require('../rposClient');
const { getValidatedOrders } = require('../chatbotToolsService');

const SHOP_ID = 'shop-uuid-1';
const POS_ID = 'pos7';

beforeEach(() => jest.clearAllMocks());

const platformOrder = {
  department: 'BOISSONS', rposOrderReference: 'CMD-123', createdAt: new Date('2026-10-01'), receptionStatus: 'PENDING',
};

test('aucune commande validée sur la période : found true, isNormalNegative', async () => {
  prisma.proposalOrder.findMany.mockResolvedValue([]);
  const result = await getValidatedOrders(POS_ID, SHOP_ID, { days: 30 });
  expect(result.found).toBe(true);
  expect(result.count).toBe(0);
  expect(result.isNormalNegative).toBe(true);
});

test('RPOS répond normalement : status success, détail enrichi', async () => {
  prisma.proposalOrder.findMany.mockResolvedValue([platformOrder]);
  rpos.getSupplierOrders.mockResolvedValue({
    results: [{ reference: 'CMD-123', status_display: 'Validée', supplier: { name: 'Fournisseur A', code: '001' } }],
  });
  const result = await getValidatedOrders(POS_ID, SHOP_ID, { days: 30 });
  expect(result.status).toBe('success');
  expect(result.source).toBe('rpos_live');
  expect(result.orders[0].rposStatus).toBe('Validée');
  expect(result.rposError).toBeUndefined();
});

test('RPOS injoignable pendant l\'enrichissement : status rpos_error, jamais confondu avec "pas de commande"', async () => {
  prisma.proposalOrder.findMany.mockResolvedValue([platformOrder]);
  rpos.getSupplierOrders.mockRejectedValue(new Error('Serveur RPOS "pos7" injoignable'));
  const result = await getValidatedOrders(POS_ID, SHOP_ID, { days: 30 });
  expect(result.found).toBe(true); // la vue plateforme reste renvoyée
  expect(result.status).toBe('rpos_error');
  expect(result.rposError).toMatch(/injoignable/);
  expect(result.orders[0].rposStatus).toBeNull(); // champs RPOS absents, mais explicitement à cause d'une erreur
});

test('pas de serveur RPOS connu (posId absent) : status not_found, jamais tenté', async () => {
  prisma.proposalOrder.findMany.mockResolvedValue([platformOrder]);
  const result = await getValidatedOrders(undefined, SHOP_ID, { days: 30 });
  expect(result.status).toBe('not_found');
  expect(rpos.getSupplierOrders).not.toHaveBeenCalled();
});
