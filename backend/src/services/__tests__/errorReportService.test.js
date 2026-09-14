/**
 * Tests du regroupement d'erreurs (errorReportService.js) : même signature malgré des
 * identifiants différents (EAN, UUID, nombres), tri par compteur décroissant.
 */
const { normalizeSignature, groupErrorReports } = require('../errorReportService');

describe('normalizeSignature', () => {
  test('nombres, EAN et UUID deviennent #', () => {
    expect(normalizeSignature('Échec article 100325217 qté 12')).toBe('Échec article # qté #');
    expect(normalizeSignature('Erreur job 23c9d34a-dc11-4a72-907b-2fadfc260538')).toBe('Erreur job #');
  });

  test('tronque à 160 caractères', () => {
    expect(normalizeSignature('x'.repeat(500)).length).toBeLessThanOrEqual(160);
  });
});

describe('groupErrorReports', () => {
  const row = (over) => ({
    source: 'frontend', page: '/purchase-order', url: null, method: null, statusCode: null,
    message: 'm', stack: null, userEmail: null, shopRef: null,
    createdAt: new Date('2026-09-14T10:00:00Z'), ...over,
  });

  test('regroupe les variantes numériques, compte et ordonne', () => {
    const rows = [
      row({ message: 'Échec article 100325217' }),
      row({ message: 'Échec article 100325218' }),
      row({ message: 'Échec article 100325219' }),
      row({ message: 'Autre erreur', page: '/settings' }),
    ];
    const groups = groupErrorReports(rows);
    expect(groups.length).toBe(2);
    expect(groups[0].count).toBe(3);
    expect(groups[0].sampleMessage).toMatch(/Échec article/);
    expect(groups[1].page).toBe('/settings');
  });

  test('sépare backend et frontend même à message égal', () => {
    const rows = [
      row({ message: 'boom' }),
      row({ source: 'backend', page: null, url: 'GET /api/x', message: 'boom' }),
    ];
    expect(groupErrorReports(rows).length).toBe(2);
  });

  test('firstSeen/lastSeen encadrent le groupe', () => {
    const rows = [
      row({ createdAt: new Date('2026-09-14T12:00:00Z') }),
      row({ createdAt: new Date('2026-09-14T09:00:00Z') }),
    ];
    const g = groupErrorReports(rows)[0];
    expect(g.firstSeen.toISOString()).toBe('2026-09-14T09:00:00.000Z');
    expect(g.lastSeen.toISOString()).toBe('2026-09-14T12:00:00.000Z');
  });
});
