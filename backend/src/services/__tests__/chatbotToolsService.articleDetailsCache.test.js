/**
 * Tests du cache optionnel de getArticleDetails (amelioration1.md §6, implémenté le 07/10/2026) :
 * un petit cache mémoire (Map + TTL) pour les champs STABLES de la fiche article (identification,
 * prix, conditionnement, fournisseurs), jamais pour le stock (toujours temps réel, rafraîchi
 * séparément même sur un cache-hit) — pour ne pas réintroduire le problème déjà corrigé sur
 * getArticleStock (un stock périmé présenté comme actuel).
 *
 * jest.resetModules() entre chaque test : le cache est une Map au niveau module, partagée entre
 * appels dans le process réel (c'est le but), donc isolée ici pour que chaque test parte à froid.
 */
jest.mock('../../utils/prisma', () => ({}));
jest.mock('../stockMoveAnalysisService', () => ({}));
jest.mock('../orderAnomalyService', () => ({ listAnomalies: jest.fn() }));
jest.mock('../aiForecastService', () => ({}));

const EAN = '100632985';
const SHOP_ID = 'shop-uuid-1';
const POS_ID = 'pos7';

const baseProduct = {
  ean: EAN, label_1: 'Coca 1.5L', selling_price: '750.00', stock: '42.0000',
  shop: { reference: '035', name: 'Magasin A' }, suppliers: [],
};

function loadModuleWithRposMock(rposImpl) {
  jest.resetModules();
  jest.doMock('../rposClient', () => rposImpl);
  // Les autres mocks doivent être redéclarés après resetModules (jest les vide aussi).
  jest.doMock('../../utils/prisma', () => ({}));
  jest.doMock('../stockMoveAnalysisService', () => ({}));
  jest.doMock('../orderAnomalyService', () => ({ listAnomalies: jest.fn() }));
  jest.doMock('../aiForecastService', () => ({}));
  return require('../chatbotToolsService');
}

test('premier appel : aucun cache, tape RPOS, source rpos_live', async () => {
  const getProductByEan = jest.fn().mockResolvedValue(baseProduct);
  const { getArticleDetails } = loadModuleWithRposMock({ getProductByEan });

  const result = await getArticleDetails(POS_ID, SHOP_ID, EAN);
  expect(result.found).toBe(true);
  expect(result.source).toBe('rpos_live');
  expect(result.stock).toBe(42);
  expect(result.stockStatus).toBe('success');
  expect(getProductByEan).toHaveBeenCalledTimes(1);
});

test('second appel immédiat sur le même article : source cache pour les champs stables, mais stock toujours rafraîchi en live (2 appels RPOS au total)', async () => {
  const getProductByEan = jest.fn()
    .mockResolvedValueOnce(baseProduct) // premier appel : remplit le cache
    .mockResolvedValueOnce({ ...baseProduct, stock: '7.0000' }); // second appel : stock différent, rafraîchi
  const { getArticleDetails } = loadModuleWithRposMock({ getProductByEan });

  const first = await getArticleDetails(POS_ID, SHOP_ID, EAN);
  const second = await getArticleDetails(POS_ID, SHOP_ID, EAN);

  expect(first.source).toBe('rpos_live');
  expect(second.source).toBe('cache'); // champs stables (nom, prix...) servis depuis le cache
  expect(second.label1).toBe('Coca 1.5L'); // champ stable identique, venu du cache
  expect(second.stock).toBe(7); // stock, lui, reflète le DEUXIÈME appel RPOS (rafraîchi), pas le cache
  expect(second.stockStatus).toBe('success');
  expect(getProductByEan).toHaveBeenCalledTimes(2); // 1 pour remplir le cache + 1 pour rafraîchir le stock
});

test('cache-hit mais rafraîchissement du stock échoue (RPOS injoignable) : fiche quand même utile, stockStatus signale le problème', async () => {
  const getProductByEan = jest.fn()
    .mockResolvedValueOnce(baseProduct) // remplit le cache
    .mockRejectedValueOnce(new Error('Serveur RPOS "pos7" injoignable')); // rafraîchissement du stock échoue
  const { getArticleDetails } = loadModuleWithRposMock({ getProductByEan });

  await getArticleDetails(POS_ID, SHOP_ID, EAN);
  const second = await getArticleDetails(POS_ID, SHOP_ID, EAN);

  expect(second.found).toBe(true); // la fiche (champs stables) reste renvoyée malgré l'échec du stock
  expect(second.source).toBe('cache');
  expect(second.stockStatus).toBe('rpos_error');
  expect(second.label1).toBe('Coca 1.5L'); // champs stables toujours exploitables
});

test('articles différents : jamais de collision de cache entre deux EAN distincts', async () => {
  const getProductByEan = jest.fn()
    .mockResolvedValueOnce(baseProduct)
    .mockResolvedValueOnce({ ...baseProduct, ean: '999', label_1: 'Autre article', stock: '3.0000' });
  const { getArticleDetails } = loadModuleWithRposMock({ getProductByEan });

  const first = await getArticleDetails(POS_ID, SHOP_ID, EAN);
  const other = await getArticleDetails(POS_ID, SHOP_ID, '999');

  expect(first.label1).toBe('Coca 1.5L');
  expect(other.label1).toBe('Autre article');
  expect(other.source).toBe('rpos_live'); // jamais servi depuis le cache de l'autre article
});

test('article introuvable chez RPOS : jamais mis en cache (rien à cacher)', async () => {
  const getProductByEan = jest.fn().mockResolvedValue(null);
  const { getArticleDetails } = loadModuleWithRposMock({ getProductByEan });

  const result = await getArticleDetails(POS_ID, SHOP_ID, EAN);
  expect(result.found).toBe(false);
});
