/**
 * Tests du mapping d'erreurs Gemini (aiForecastService.js geminiErrorMessage) : un 400
 * API_KEY_INVALID doit produire un message actionnable (clé à recréer), pas le JSON brut.
 */
const { geminiErrorMessage } = require('../aiForecastService');

describe('geminiErrorMessage', () => {
  test('API_KEY_INVALID -> message actionnable (recréer la clé)', () => {
    const msg = geminiErrorMessage(400, '{"error":{"code":400,"message":"API key not valid.","status":"INVALID_ARGUMENT"}}');
    expect(msg).toMatch(/clé API invalide/);
    expect(msg).toMatch(/AI Studio/);
  });

  test('modèle introuvable -> indique le champ modèle à vérifier', () => {
    const msg = geminiErrorMessage(404, 'models/gemini-3.6-flash is not found');
    expect(msg).toMatch(/modèle introuvable/);
    expect(msg).toMatch(/gemini-2.0-flash/);
  });

  test('quota épuisé -> message quota', () => {
    const msg = geminiErrorMessage(429, 'RESOURCE_EXHAUSTED');
    expect(msg).toMatch(/quota/i);
  });

  test('autre erreur -> statut + extrait conservés', () => {
    const msg = geminiErrorMessage(500, 'internal error xyz');
    expect(msg).toMatch(/500/);
    expect(msg).toMatch(/internal error/);
  });
});
