/**
 * Tests ciblés sur les 3 outils de stock du chatbot (getArticleStock, getArticleStockAllShops,
 * getStoreStock) après le passage à RPOS-live-first (amelioration1.md §4-5, §10-11, Phase 3-4,
 * 07/10/2026). Couvre exactement les cas que la mission demande en §22 : stock actuel, stock zéro,
 * RPOS timeout/erreur, article inconnu, magasin inconnu, tous magasins. Prisma et rposClient sont
 * mockés : ces fonctions ne doivent jamais toucher une vraie base ou un vrai réseau en test.
 */
jest.mock('../../utils/prisma', () => ({
  shop: { findMany: jest.fn() },
  proposal: { findFirst: jest.fn() },
  proposalLine: { findFirst: jest.fn(), findMany: jest.fn() },
}));
jest.mock('../rposClient', () => ({
  getProductByEan: jest.fn(),
}));
// Dépendances non utilisées par ces 3 fonctions mais importées en tête de fichier — mockées à vide
// pour que require('../chatbotToolsService') ne tente pas de charger de vraies implémentations.
jest.mock('../stockMoveAnalysisService', () => ({}));
jest.mock('../orderAnomalyService', () => ({ listAnomalies: jest.fn() }));
jest.mock('../aiForecastService', () => ({}));

const prisma = require('../../utils/prisma');
const rpos = require('../rposClient');
const { getArticleStock, getArticleStockAllShops, getStoreStock } = require('../chatbotToolsService');

const EAN = '1234567890123';
const SHOP_ID = 'shop-uuid-1';
const POS_ID = 'pos7';

beforeEach(() => jest.clearAllMocks());

describe('getArticleStock — RPOS live en premier', () => {
  test('stock actuel : RPOS répond -> source rpos_live, status success, jamais le local', async () => {
    rpos.getProductByEan.mockResolvedValue({ ean: EAN, label_1: 'Coca 1.5L', stock: 42 });
    const result = await getArticleStock(SHOP_ID, EAN, POS_ID);
    expect(result.found).toBe(true);
    expect(result.stock).toBe(42);
    expect(result.source).toBe('rpos_live');
    expect(result.status).toBe('success');
    expect(prisma.proposal.findFirst).not.toHaveBeenCalled();
  });

  test('stock zéro réel (RPOS répond stock=0) : jamais confondu avec une erreur', async () => {
    rpos.getProductByEan.mockResolvedValue({ ean: EAN, label_1: 'Article rare', stock: 0 });
    const result = await getArticleStock(SHOP_ID, EAN, POS_ID);
    expect(result.found).toBe(true);
    expect(result.stock).toBe(0);
    expect(result.status).toBe('success');
    expect(result.source).toBe('rpos_live');
  });

  test('article inconnu de RPOS (résultat vide, pas d\'exception) : not_found, pas une erreur réseau', async () => {
    rpos.getProductByEan.mockResolvedValue(null);
    prisma.proposal.findFirst.mockResolvedValue(null);
    const result = await getArticleStock(SHOP_ID, EAN, POS_ID);
    expect(result.found).toBe(false);
    expect(result.isNormalNegative).toBe(true);
  });

  test('RPOS injoignable (timeout/exception) + repli local disponible : status rpos_error, jamais stock=0', async () => {
    rpos.getProductByEan.mockRejectedValue(new Error('Serveur RPOS "pos7" injoignable (aucune réponse après 10s)'));
    prisma.proposal.findFirst.mockResolvedValue({ id: 'prop-1', generatedAt: new Date('2026-10-07T04:00:00.000Z') });
    prisma.proposalLine.findFirst.mockResolvedValue({
      ean: EAN, label: 'Coca 1.5L', department: 'BOISSONS', sector: null,
      stockAtGeneration: 17, avgWeeklySales: 10, daysUntilStockout: 5,
      quantitySuggested: 3, aiAdjusted: false, aiReasoning: null, trendCategory: 'STABLE', anomalies: null,
    });
    const result = await getArticleStock(SHOP_ID, EAN, POS_ID);
    expect(result.found).toBe(true);
    expect(result.stock).toBe(17);
    expect(result.source).toBe('local_fallback');
    expect(result.status).toBe('rpos_error');
    expect(result.stock).not.toBe(0); // jamais transformé en 0 par erreur
    expect(result.rposError).toMatch(/injoignable/);
  });

  test('RPOS injoignable ET aucun repli local : found false avec status rpos_error explicite, jamais stock=0', async () => {
    rpos.getProductByEan.mockRejectedValue(new Error('Serveur RPOS "pos7" injoignable'));
    prisma.proposal.findFirst.mockResolvedValue(null);
    const result = await getArticleStock(SHOP_ID, EAN, POS_ID);
    expect(result.found).toBe(false);
    expect(result.status).toBe('rpos_error');
    expect(result.stock).toBeUndefined();
  });

  test('sans posId (ancien appelant) : repli local direct, source local_fallback avec lastSyncAt', async () => {
    prisma.proposal.findFirst.mockResolvedValue({ id: 'prop-1', generatedAt: new Date('2026-10-07T04:00:00.000Z') });
    prisma.proposalLine.findFirst.mockResolvedValue({
      ean: EAN, label: 'Coca 1.5L', department: 'BOISSONS', sector: null,
      stockAtGeneration: 17, avgWeeklySales: 10, daysUntilStockout: 5,
      quantitySuggested: 3, aiAdjusted: false, aiReasoning: null, trendCategory: 'STABLE', anomalies: null,
    });
    const result = await getArticleStock(SHOP_ID, EAN, undefined);
    expect(result.found).toBe(true);
    expect(result.source).toBe('local_fallback');
    expect(result.status).toBe('success');
    expect(result.lastSyncAt).toBe('2026-10-07T04:00:00.000Z');
    expect(rpos.getProductByEan).not.toHaveBeenCalled();
  });
});

describe('getArticleStockAllShops — RPOS live par magasin, jamais 0 = erreur', () => {
  test('magasin inconnu / aucun magasin accessible', async () => {
    const result = await getArticleStockAllShops([], EAN);
    expect(result.found).toBe(false);
  });

  test('tous les magasins répondent via RPOS live : shops avec source rpos_live, pas de failedShops', async () => {
    prisma.shop.findMany.mockResolvedValue([
      { rposShopId: 'shop-1', rposPosId: 'pos1', reference: '035', name: 'Magasin A' },
      { rposShopId: 'shop-2', rposPosId: 'pos2', reference: '110', name: 'Magasin B' },
    ]);
    rpos.getProductByEan
      .mockResolvedValueOnce({ ean: EAN, label_1: 'Coca 1.5L', stock: 10 })
      .mockResolvedValueOnce({ ean: EAN, label_1: 'Coca 1.5L', stock: 0 });

    const result = await getArticleStockAllShops(['shop-1', 'shop-2'], EAN);
    expect(result.found).toBe(true);
    expect(result.shopCount).toBe(2);
    expect(result.totalStockUnits).toBe(10); // 10 + 0, jamais confondu avec une erreur
    expect(result.shops.every((s) => s.source === 'rpos_live' && s.status === 'success')).toBe(true);
    expect(result.failedShops).toBeUndefined();
  });

  test('un magasin RPOS injoignable, repli local disponible pour lui : failedShops absent, stock de repli jamais 0', async () => {
    prisma.shop.findMany.mockResolvedValue([
      { rposShopId: 'shop-1', rposPosId: 'pos1', reference: '035', name: 'Magasin A' },
      { rposShopId: 'shop-2', rposPosId: 'pos2', reference: '110', name: 'Magasin B' },
    ]);
    rpos.getProductByEan
      .mockResolvedValueOnce({ ean: EAN, label_1: 'Coca 1.5L', stock: 10 })
      .mockRejectedValueOnce(new Error('Serveur RPOS "pos2" injoignable'));
    prisma.proposal.findFirst.mockResolvedValue({ id: 'prop-2', generatedAt: new Date('2026-10-07T04:00:00.000Z') });
    prisma.proposalLine.findFirst.mockResolvedValue({ label: 'Coca 1.5L', stockAtGeneration: 8, avgWeeklySales: 5, daysUntilStockout: 3 });

    const result = await getArticleStockAllShops(['shop-1', 'shop-2'], EAN);
    expect(result.found).toBe(true);
    expect(result.shopCount).toBe(2);
    const shopB = result.shops.find((s) => s.rposShopId === 'shop-2');
    expect(shopB.source).toBe('local_fallback');
    expect(shopB.status).toBe('rpos_error');
    expect(shopB.stock).toBe(8);
    expect(result.failedShops).toBeUndefined(); // un repli trouvé : pas un échec total pour ce magasin
  });

  test('un magasin RPOS injoignable SANS repli local : listé dans failedShops, jamais stock=0', async () => {
    prisma.shop.findMany.mockResolvedValue([
      { rposShopId: 'shop-1', rposPosId: 'pos1', reference: '035', name: 'Magasin A' },
    ]);
    rpos.getProductByEan.mockRejectedValue(new Error('Serveur RPOS "pos1" injoignable'));
    prisma.proposal.findFirst.mockResolvedValue(null);

    const result = await getArticleStockAllShops(['shop-1'], EAN);
    expect(result.found).toBe(false);
    expect(result.failedShops).toEqual([{ shopId: 'shop-1', shopReference: '035', reason: 'Serveur RPOS "pos1" injoignable' }]);
  });

  test('article introuvable sur tous les magasins (RPOS répond, catalogue vide) : not_found, pas une erreur', async () => {
    prisma.shop.findMany.mockResolvedValue([
      { rposShopId: 'shop-1', rposPosId: 'pos1', reference: '035', name: 'Magasin A' },
    ]);
    rpos.getProductByEan.mockResolvedValue(null);
    prisma.proposal.findFirst.mockResolvedValue(null);

    const result = await getArticleStockAllShops(['shop-1'], EAN);
    expect(result.found).toBe(false);
    expect(result.failedShops).toBeUndefined();
  });
});

describe('getStoreStock — local par nature, mais porte sa fraîcheur', () => {
  test('aucune proposition générée : found false explicite', async () => {
    prisma.proposal.findFirst.mockResolvedValue(null);
    const result = await getStoreStock(SHOP_ID, {});
    expect(result.found).toBe(false);
  });

  test('stock du magasin : source local + dataAgeMinutes calculé depuis generatedAt', async () => {
    const generatedAt = new Date(Date.now() - 90 * 60 * 1000); // il y a 90 minutes
    prisma.proposal.findFirst.mockResolvedValue({ id: 'prop-1', generatedAt });
    prisma.proposalLine.findMany.mockResolvedValue([
      { ean: EAN, label: 'Coca 1.5L', department: 'BOISSONS', stockAtGeneration: 10, avgWeeklySales: 5, daysUntilStockout: 7 },
    ]);
    const result = await getStoreStock(SHOP_ID, {});
    expect(result.found).toBe(true);
    expect(result.source).toBe('local');
    expect(result.lastSyncAt).toBe(generatedAt.toISOString());
    expect(result.dataAgeMinutes).toBeGreaterThanOrEqual(89);
    expect(result.dataAgeMinutes).toBeLessThanOrEqual(91);
  });
});
