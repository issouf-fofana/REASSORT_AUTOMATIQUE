/**
 * Tests de explainProposalQuantity après l'ajout du rafraîchissement RPOS live du stock avant
 * l'explication IA (amelioration1.md §16, corrigé le 07/10/2026) : la proposition en base porte un
 * stock figé à la génération nocturne (stockAtGeneration) — avant d'expliquer la quantité proposée,
 * l'outil doit maintenant tenter RPOS live pour avoir le stock réel, et ne jamais bloquer
 * l'explication si RPOS est injoignable (repli silencieux sur le stock figé).
 */
jest.mock('../../utils/prisma', () => ({
  proposal: { findFirst: jest.fn() },
  proposalLine: { findFirst: jest.fn() },
}));
jest.mock('../rposClient', () => ({ getProductByEan: jest.fn() }));
jest.mock('../stockMoveAnalysisService', () => ({}));
jest.mock('../orderAnomalyService', () => ({ listAnomalies: jest.fn() }));
jest.mock('../aiForecastService', () => ({ analyzeArticleRealtime: jest.fn() }));

const prisma = require('../../utils/prisma');
const rpos = require('../rposClient');
const aiForecastService = require('../aiForecastService');
const { explainProposalQuantity } = require('../chatbotToolsService');

const EAN = '100632985';
const SHOP_ID = 'shop-uuid-1';

beforeEach(() => jest.clearAllMocks());

const baseProposal = {
  id: 'prop-1', rposPosId: 'pos7', rposShopId: SHOP_ID,
  rposShopReference: '035', rposShopName: 'Magasin A',
  safetyStockRatioUsed: 0.5, receptionLeadTimeDaysUsed: 1,
};
const baseLine = {
  ean: EAN, label: 'Coca 1.5L', department: 'BOISSONS',
  stockAtGeneration: 20, quantitySuggested: 12,
};

test('aucune proposition en attente : found false', async () => {
  prisma.proposal.findFirst.mockResolvedValue(null);
  const result = await explainProposalQuantity(SHOP_ID, EAN);
  expect(result.found).toBe(false);
});

test('article absent de la proposition : found false', async () => {
  prisma.proposal.findFirst.mockResolvedValue(baseProposal);
  prisma.proposalLine.findFirst.mockResolvedValue(null);
  const result = await explainProposalQuantity(SHOP_ID, EAN);
  expect(result.found).toBe(false);
});

test('RPOS live disponible : le stock injecté dans la ligne analysée est le stock RPOS, pas celui figé', async () => {
  prisma.proposal.findFirst.mockResolvedValue(baseProposal);
  prisma.proposalLine.findFirst.mockResolvedValue(baseLine);
  rpos.getProductByEan.mockResolvedValue({ ean: EAN, stock: 7 }); // stock réel très différent du figé (20)
  aiForecastService.analyzeArticleRealtime.mockResolvedValue({ quantity: 15, reasoning: 'Stock bas, réassort nécessaire.' });

  const result = await explainProposalQuantity(SHOP_ID, EAN);

  expect(result.found).toBe(true);
  expect(result.stockUsed).toBe(7);
  expect(result.stockSource).toBe('rpos_live');
  expect(result.stockQueriedAt).not.toBeNull();
  // La ligne transmise à l'IA porte bien le stock RPOS live, pas le stock figé à la génération.
  const callArg = aiForecastService.analyzeArticleRealtime.mock.calls[0][0];
  expect(callArg.line.stockAtGeneration).toBe(7);
  expect(result.systemSuggestedQuantity).toBe(12); // reste la quantité système, inchangée
  expect(result.aiRecommendedQuantity).toBe(15);
});

test('RPOS injoignable : repli silencieux sur le stock figé, explication jamais bloquée', async () => {
  prisma.proposal.findFirst.mockResolvedValue(baseProposal);
  prisma.proposalLine.findFirst.mockResolvedValue(baseLine);
  rpos.getProductByEan.mockRejectedValue(new Error('Serveur RPOS "pos7" injoignable'));
  aiForecastService.analyzeArticleRealtime.mockResolvedValue({ quantity: 15, reasoning: 'Explication basée sur stock connu.' });

  const result = await explainProposalQuantity(SHOP_ID, EAN);

  expect(result.found).toBe(true);
  expect(result.stockUsed).toBe(20); // stock figé conservé
  expect(result.stockSource).toBe('local_fallback');
  expect(result.stockQueriedAt).toBeNull();
  const callArg = aiForecastService.analyzeArticleRealtime.mock.calls[0][0];
  expect(callArg.line.stockAtGeneration).toBe(20);
});

test('RPOS répond mais article absent de son catalogue : repli sur le stock figé, pas une erreur', async () => {
  prisma.proposal.findFirst.mockResolvedValue(baseProposal);
  prisma.proposalLine.findFirst.mockResolvedValue(baseLine);
  rpos.getProductByEan.mockResolvedValue(null);
  aiForecastService.analyzeArticleRealtime.mockResolvedValue({ quantity: 15, reasoning: 'ok' });

  const result = await explainProposalQuantity(SHOP_ID, EAN);
  expect(result.found).toBe(true);
  expect(result.stockUsed).toBe(20);
  expect(result.stockSource).toBe('local_fallback');
});

test('pas de serveur RPOS connu (rposPosId null) : repli direct sans tenter RPOS', async () => {
  prisma.proposal.findFirst.mockResolvedValue({ ...baseProposal, rposPosId: null });
  prisma.proposalLine.findFirst.mockResolvedValue(baseLine);
  aiForecastService.analyzeArticleRealtime.mockResolvedValue({ quantity: 15, reasoning: 'ok' });

  const result = await explainProposalQuantity(SHOP_ID, EAN);
  expect(result.found).toBe(true);
  expect(result.stockSource).toBe('local_fallback');
  expect(rpos.getProductByEan).not.toHaveBeenCalled();
});

test('échec de l\'analyse IA (après succès du rafraîchissement stock) : found false, message explicite', async () => {
  prisma.proposal.findFirst.mockResolvedValue(baseProposal);
  prisma.proposalLine.findFirst.mockResolvedValue(baseLine);
  rpos.getProductByEan.mockResolvedValue({ ean: EAN, stock: 7 });
  aiForecastService.analyzeArticleRealtime.mockRejectedValue(new Error('clé API invalide'));

  const result = await explainProposalQuantity(SHOP_ID, EAN);
  expect(result.found).toBe(false);
  expect(result.message).toMatch(/clé API invalide/);
});
