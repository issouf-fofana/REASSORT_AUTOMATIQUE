/**
 * Tests de resolvePeriod (periodService.js) : calcule la fenêtre de ventes effective selon
 * ReassortConfig.periodMode. rpos/prisma mockés (pas d'appel réseau ni de vraie base) pour isoler
 * la logique de résolution de période elle-même.
 */
jest.mock('../rposClient', () => ({
  getLastSaleDate: jest.fn(),
  getEarliestSaleDate: jest.fn(),
}));
jest.mock('../../utils/prisma', () => ({
  salesLine: { findFirst: jest.fn() },
}));

const rpos = require('../rposClient');
const prisma = require('../../utils/prisma');
const { resolvePeriod, MODE_DAYS } = require('../periodService');

const LAST_SALE = '2026-09-20T14:30:00.000Z';

describe('resolvePeriod', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    rpos.getLastSaleDate.mockResolvedValue(LAST_SALE);
  });

  test('LAST_30_DAYS : fenêtre glissante de 30 jours se terminant à la dernière vente réelle', async () => {
    const period = await resolvePeriod('pos1', 'shop1', { periodMode: 'LAST_30_DAYS' });
    const days = (new Date(period.end) - new Date(period.start)) / (24 * 60 * 60 * 1000);
    expect(days).toBeCloseTo(30, 5);
    expect(period.end).toBe(new Date(LAST_SALE).toISOString().slice(0, 19));
  });

  test.each([
    ['LAST_60_DAYS', 60], ['LAST_90_DAYS', 90], ['LAST_120_DAYS', 120],
    ['LAST_180_DAYS', 180], ['LAST_365_DAYS', 365],
  ])('%s : fenêtre glissante de %i jours (nouvelles options du 23/09/2026)', async (mode, expectedDays) => {
    const period = await resolvePeriod('pos1', 'shop1', { periodMode: mode });
    const days = (new Date(period.end) - new Date(period.start)) / (24 * 60 * 60 * 1000);
    expect(days).toBeCloseTo(expectedDays, 5);
    expect(MODE_DAYS[mode]).toBe(expectedDays);
  });

  test('ALL_TIME : remonte jusqu\'à la première vente connue via RPOS (pas un nombre de jours fixe)', async () => {
    const EARLIEST = '2023-01-05T00:00:00.000Z';
    rpos.getEarliestSaleDate.mockResolvedValue(EARLIEST);
    const period = await resolvePeriod('pos1', 'shop1', { periodMode: 'ALL_TIME' });
    expect(rpos.getEarliestSaleDate).toHaveBeenCalledWith('pos1', 'shop1');
    expect(period.start).toBe(new Date(EARLIEST).toISOString().slice(0, 19));
    expect(period.end).toBe(new Date(LAST_SALE).toISOString().slice(0, 19));
  });

  test('ALL_TIME en mode "sans réseau" (ignoreRposStockInCalculation) : utilise la base locale, jamais RPOS', async () => {
    const EARLIEST_LOCAL = '2024-06-01T00:00:00.000Z';
    prisma.salesLine.findFirst.mockResolvedValueOnce({ date: new Date(LAST_SALE) }); // pour lastSaleDate
    prisma.salesLine.findFirst.mockResolvedValueOnce({ date: new Date(EARLIEST_LOCAL) }); // pour earliestSaleDate
    const period = await resolvePeriod('pos1', 'shop1', { periodMode: 'ALL_TIME', ignoreRposStockInCalculation: true });
    expect(rpos.getEarliestSaleDate).not.toHaveBeenCalled();
    expect(rpos.getLastSaleDate).not.toHaveBeenCalled();
    expect(period.start).toBe(new Date(EARLIEST_LOCAL).toISOString().slice(0, 19));
  });

  test('ALL_TIME : si aucune première vente trouvée, retombe sur la dernière vente (période vide plutôt qu\'un crash)', async () => {
    rpos.getEarliestSaleDate.mockResolvedValue(null);
    const period = await resolvePeriod('pos1', 'shop1', { periodMode: 'ALL_TIME' });
    expect(period.start).toBe(period.end);
  });

  test('mode inconnu : retombe silencieusement sur 30 jours (jamais de crash sur une valeur périmée en base)', async () => {
    const period = await resolvePeriod('pos1', 'shop1', { periodMode: 'SOME_OLD_REMOVED_MODE' });
    const days = (new Date(period.end) - new Date(period.start)) / (24 * 60 * 60 * 1000);
    expect(days).toBeCloseTo(30, 5);
  });
});
