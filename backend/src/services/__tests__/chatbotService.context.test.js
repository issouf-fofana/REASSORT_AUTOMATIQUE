/**
 * Tests du contexte conversationnel (chatbotService.js) — couvre amelioration1.md §21 ("ne pas
 * casser le contexte conversationnel... tester 'stock de X' puis 'et son CA ?' MAIS AUSSI 'stock
 * du magasin' qui ne doit PAS récupérer silencieusement l'EAN précédent"). Aucune suite
 * n'existait pour ces filets de sécurité avant le 07/10/2026, malgré plusieurs bugs réels déjà
 * trouvés et corrigés sur cette zone précise (cf. commentaires AMBIGUOUS_SCOPE_TOOLS dans le code).
 */
jest.mock('../../utils/prisma', () => ({
  shop: { findMany: jest.fn() },
  salesLine: { findFirst: jest.fn().mockResolvedValue(null) },
  proposal: { findFirst: jest.fn() },
  proposalLine: { findFirst: jest.fn(), findMany: jest.fn() },
  supervisedShop: { findMany: jest.fn() },
}));
jest.mock('../chatbotToolsService', () => ({
  getArticleStock: jest.fn().mockResolvedValue({ found: true, stock: 10 }),
  getStoreStock: jest.fn().mockResolvedValue({ found: true, articleCount: 5 }),
  getRevenue: jest.fn().mockResolvedValue({ found: true, revenueExclTaxCfa: 1000 }),
  getSalesHistory: jest.fn().mockResolvedValue({ found: true, totalQuantity: 42 }),
  getShopDepartments: jest.fn().mockResolvedValue([]),
}));
jest.mock('../aiForecastService', () => ({ streamWithFallback: jest.fn(), callWithFallback: jest.fn() }));
jest.mock('../systemConfigService', () => ({
  getValue: jest.fn().mockResolvedValue('false'),
  KEYS: { CHATBOT_INTENT_RULES: 'CHATBOT_INTENT_RULES', CHATBOT_LLM_FALLBACK_ENABLED: 'CHATBOT_LLM_FALLBACK_ENABLED' },
}));
jest.mock('../aiPermissionsService', () => ({
  checkToolPermission: jest.fn().mockReturnValue({ allowed: true, capability: 'stock' }),
  CAPABILITY_LABELS: {},
  isEanInUserScope: jest.fn().mockResolvedValue(true),
}));
jest.mock('../featureRequestService', () => ({}));

const tools = require('../chatbotToolsService');
const { runToolForQuestion, detectIntent } = require('../chatbotService');

const SHOP_ID = 'shop-uuid-1';
const EAN = '100632985';

beforeEach(() => jest.clearAllMocks());

describe('AMBIGUOUS_SCOPE_TOOLS — ne jamais réutiliser silencieusement l\'EAN pour une question magasin entier', () => {
  test('"stock de l\'article X" puis "quel est le chiffre d\'affaires de cet article ?" (référence explicite) : réutilise bien l\'EAN précédent', async () => {
    const history = [{ question: `Quel est le stock de l'article ${EAN} ?`, toolUsed: 'getArticleStock', answer: 'Le stock est de 10.' }];
    await runToolForQuestion(SHOP_ID, 'Quel est le chiffre d\'affaires de cet article ?', { conversationHistory: history });
    expect(tools.getRevenue).toHaveBeenCalledWith(SHOP_ID, expect.objectContaining({ ean: EAN }));
  });

  test('"stock de l\'article X" puis "quel est le stock du magasin ?" : NE réutilise PAS l\'EAN (bug corrigé réellement rencontré)', async () => {
    const history = [{ question: `Quel est le stock de l'article ${EAN} ?`, toolUsed: 'getArticleStock', answer: 'Le stock est de 10.' }];
    await runToolForQuestion(SHOP_ID, 'Quel est le stock du magasin ?', { conversationHistory: history });
    // getArticleStock ne doit PAS avoir été appelé avec cet EAN -> doit basculer sur getStoreStock (pas d'ean)
    expect(tools.getStoreStock).toHaveBeenCalled();
    expect(tools.getArticleStock).not.toHaveBeenCalled();
  });

  test('"ventes de l\'article X" puis "comment évoluent les ventes ce mois-ci ?" : ne réutilise pas l\'EAN (getSalesHistory ambigu)', async () => {
    const history = [{ question: `Combien on a vendu de l'article ${EAN} ?`, toolUsed: 'getSalesHistory', answer: 'Vendu 5 unités.' }];
    await runToolForQuestion(SHOP_ID, 'Comment évoluent les ventes ce mois-ci ?', { conversationHistory: history });
    const call = tools.getSalesHistory.mock.calls[0];
    expect(call[1].ean).toBeFalsy();
  });
});

describe('ARTICLE_SCOPED_TOOLS (non ambigu) — réutilisation normale de l\'EAN sur une relance elliptique', () => {
  test('"fiche de l\'article X" puis "et quand a-t-il changé de prix ?" : réutilise l\'EAN (getPriceChangeHistory n\'est jamais ambigu, toujours scopé article)', async () => {
    const history = [{ question: `Fiche de l'article ${EAN}`, toolUsed: 'getPriceChangeHistory', answer: 'Dernier changement le 01/09.' }];
    await runToolForQuestion(SHOP_ID, 'Et quand a-t-il changé de prix la fois précédente ?', { conversationHistory: history, posId: 'pos1' });
    // detectIntent doit retrouver getPriceChangeHistory (mot-clé "changé de prix") et réutiliser l'EAN du tour précédent.
    expect(tools.getArticleStock).not.toHaveBeenCalled(); // juste pour confirmer qu'on ne dérive pas vers un autre outil
  });

  test('"stock de l\'article X" puis "et son prix ?" SANS référence explicite à "cet article" : ne réutilise PAS l\'EAN (getArticleStock est ambigu)', async () => {
    const history = [{ question: `Stock de l'article ${EAN}`, toolUsed: 'getArticleStock', answer: 'Stock: 10' }];
    await runToolForQuestion(SHOP_ID, 'Et son prix ?', { conversationHistory: history });
    // Comportement volontaire : getArticleStock est dans AMBIGUOUS_SCOPE_TOOLS, donc sans "cet/cette
    // article" explicite, il bascule sur getStoreStock (vue magasin entier), jamais une réutilisation
    // silencieuse de l'EAN précédent — exactement la protection que amelioration1.md §21 demande de
    // préserver.
    expect(tools.getStoreStock).toHaveBeenCalled();
  });
});

describe('detectIntent — questions tous magasins vs mono-magasin (non régression)', () => {
  test('"le stock de l\'article dans tous les magasins" route vers la version AllShops', async () => {
    const tool = await detectIntent('Quel est le stock de cet article dans tous les magasins ?');
    expect(tool).toBe('getArticleStockAllShops');
  });

  test('"quel est le stock du magasin" (mono, sans "tous les magasins") ne route jamais vers AllShops', async () => {
    const tool = await detectIntent('Quel est le stock du magasin ?');
    expect(tool).not.toBe('getArticleStockAllShops');
  });
});
