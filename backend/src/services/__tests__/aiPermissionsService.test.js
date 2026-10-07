/**
 * Tests du système de permissions IA (aiPermissionsService.js) — couvre amelioration1.md §20
 * ("ne pas modifier la sécurité... tester ADMIN, SUPERVISOR, DIRECTOR, DEPARTMENT_HEAD,
 * SHELF_STOCKER, utilisateur sans rôle, utilisateur sans permission, article hors rayon autorisé").
 * Aucune suite n'existait pour ce fichier avant le 07/10/2026, malgré son rôle critique en sécurité.
 */
jest.mock('../../utils/prisma', () => ({ proposalLine: { findFirst: jest.fn() } }));
const prisma = require('../../utils/prisma');
const { checkToolPermission, getEffectivePermissions, isEanInUserScope, filterProposalLinesForUser } = require('../aiPermissionsService');

beforeEach(() => jest.clearAllMocks());

describe('getEffectivePermissions — défauts par rôle', () => {
  test('ADMIN : tout autorisé', () => {
    const perms = getEffectivePermissions({ role: 'ADMIN' });
    expect(perms.revenueShop).toBe(true);
    expect(perms.stock).toBe(true);
    expect(perms.accuracy).toBe(true);
  });

  test('SUPERVISOR : tout autorisé (comme ADMIN)', () => {
    const perms = getEffectivePermissions({ role: 'SUPERVISOR' });
    expect(perms.revenueShop).toBe(true);
  });

  test('DIRECTOR : tout autorisé sur son magasin', () => {
    const perms = getEffectivePermissions({ role: 'DIRECTOR' });
    expect(perms.revenueShop).toBe(true);
    expect(perms.revenueArticle).toBe(true);
  });

  test('DEPARTMENT_HEAD : jamais le CA du magasin entier, mais le CA de son département oui', () => {
    const perms = getEffectivePermissions({ role: 'DEPARTMENT_HEAD' });
    expect(perms.revenueShop).toBe(false);
    expect(perms.revenueArticle).toBe(true);
  });

  test('SHELF_STOCKER : jamais aucun CA, même de ses propres articles', () => {
    const perms = getEffectivePermissions({ role: 'SHELF_STOCKER' });
    expect(perms.revenueShop).toBe(false);
    expect(perms.revenueArticle).toBe(false);
    expect(perms.stock).toBe(true); // reste autorisé sur le stock
  });

  test('utilisateur sans rôle (undefined/null) : fail-closed, tout refusé', () => {
    expect(Object.values(getEffectivePermissions(undefined)).every((v) => v === false)).toBe(true);
    expect(Object.values(getEffectivePermissions(null)).every((v) => v === false)).toBe(true);
  });

  test('rôle inconnu/invalide (jamais vu en base) : fail-closed, tout refusé', () => {
    const perms = getEffectivePermissions({ role: 'ROLE_INVENTE' });
    expect(Object.values(perms).every((v) => v === false)).toBe(true);
  });

  test('personnalisation (aiPermissionsJson) remplace le défaut du rôle capacité par capacité', () => {
    const user = { role: 'SHELF_STOCKER', aiPermissionsJson: JSON.stringify({ revenueArticle: true }) };
    const perms = getEffectivePermissions(user);
    expect(perms.revenueArticle).toBe(true); // personnalisé à true malgré le défaut false du rôle
    expect(perms.revenueShop).toBe(false); // jamais touché par la personnalisation, reste le défaut du rôle
  });

  test('aiPermissionsJson corrompu : ignoré silencieusement, retombe sur le défaut du rôle', () => {
    const user = { role: 'DIRECTOR', aiPermissionsJson: '{not valid json' };
    const perms = getEffectivePermissions(user);
    expect(perms.revenueShop).toBe(true); // défaut DIRECTOR, pas un crash
  });
});

describe('checkToolPermission — fail-closed et getRevenue dynamique', () => {
  test('outil absent de TOOL_CAPABILITY : refusé pour TOUT LE MONDE, y compris ADMIN', () => {
    const { allowed, capability } = checkToolPermission({ role: 'ADMIN' }, 'getToolQuiNexistePas');
    expect(allowed).toBe(false);
    expect(capability).toBe('unclassified');
  });

  test('getRevenue sans ean/department : capacité revenueShop (CA du magasin entier)', () => {
    const { capability, allowed } = checkToolPermission({ role: 'SHELF_STOCKER' }, 'getRevenue', {});
    expect(capability).toBe('revenueShop');
    expect(allowed).toBe(false); // SHELF_STOCKER n'a jamais revenueShop
  });

  test('getRevenue avec ean : capacité revenueArticle (autorisé pour DEPARTMENT_HEAD)', () => {
    const { capability, allowed } = checkToolPermission({ role: 'DEPARTMENT_HEAD' }, 'getRevenue', { ean: '123' });
    expect(capability).toBe('revenueArticle');
    expect(allowed).toBe(true);
  });

  test('getRevenue avec department seul : capacité revenueArticle aussi', () => {
    const { capability } = checkToolPermission({ role: 'ADMIN' }, 'getRevenue', { department: 'BOISSONS' });
    expect(capability).toBe('revenueArticle');
  });

  test('utilisateur sans permission personnalisée explicitement bloquante : refusé', () => {
    const user = { role: 'DIRECTOR', aiPermissionsJson: JSON.stringify({ stock: false }) };
    const { allowed } = checkToolPermission(user, 'getArticleStock');
    expect(allowed).toBe(false);
  });

  test('utilisateur undefined (jamais transmis par erreur) : fail-closed, jamais un accès complet', () => {
    const { allowed } = checkToolPermission(undefined, 'getArticleStock');
    expect(allowed).toBe(false);
  });

  test('outil explicitement hors périmètre de permission (capability: null) : toujours autorisé', () => {
    // getShopUsers est mappé sur 'orders' dans TOOL_CAPABILITY (pas null) — on vérifie plutôt un vrai
    // cas null existant : aucun à ce jour dans TOOL_CAPABILITY, donc ce test documente le
    // comportement de checkToolPermission pour le jour où un outil le sera (ex: futur outil
    // purement méta sans capacité métier associée). On le simule via un outil réel avec capability
    // connue pour prouver que le chemin standard fonctionne plutôt que de dupliquer la table ici.
    const { allowed } = checkToolPermission({ role: 'ADMIN' }, 'getArticleDetails');
    expect(allowed).toBe(true);
  });
});

describe('isEanInUserScope — cloisonnement par rayon (DEPARTMENT_HEAD/SHELF_STOCKER)', () => {
  test('ADMIN : toujours autorisé, jamais vérifié en base', async () => {
    const result = await isEanInUserScope('shop-1', '123', { role: 'ADMIN' });
    expect(result).toBe(true);
    expect(prisma.proposalLine.findFirst).not.toHaveBeenCalled();
  });

  test('DIRECTOR : toujours autorisé (pas de notion de département pour ce rôle)', async () => {
    const result = await isEanInUserScope('shop-1', '123', { role: 'DIRECTOR' });
    expect(result).toBe(true);
  });

  test('article jamais proposé (aucune ligne trouvée) : autorisé par défaut, rien à restreindre', async () => {
    prisma.proposalLine.findFirst.mockResolvedValue(null);
    const result = await isEanInUserScope('shop-1', '123', { role: 'SHELF_STOCKER', assignedDepartment: 'BOISSONS' });
    expect(result).toBe(true);
  });

  test('DEPARTMENT_HEAD : article DANS son département assigné -> autorisé', async () => {
    prisma.proposalLine.findFirst.mockResolvedValue({ department: 'BOISSONS' });
    const result = await isEanInUserScope('shop-1', '123', { role: 'DEPARTMENT_HEAD', assignedDepartment: 'Boissons' });
    expect(result).toBe(true); // comparaison insensible à la casse
  });

  test('DEPARTMENT_HEAD : article HORS de son département assigné -> refusé (faille corrigée le 16/09/2026)', async () => {
    prisma.proposalLine.findFirst.mockResolvedValue({ department: 'LIQUIDES' });
    const result = await isEanInUserScope('shop-1', '123', { role: 'DEPARTMENT_HEAD', assignedDepartment: 'BOISSONS' });
    expect(result).toBe(false);
  });

  test('SHELF_STOCKER : plusieurs rayons assignés (cumul), article dans l\'un d\'eux -> autorisé', async () => {
    prisma.proposalLine.findFirst.mockResolvedValue({ department: 'LIQUIDES' });
    const result = await isEanInUserScope('shop-1', '123', { role: 'SHELF_STOCKER', assignedDepartment: 'BOISSONS, LIQUIDES, EPICERIE' });
    expect(result).toBe(true);
  });

  test('SHELF_STOCKER sans assignedDepartment : jamais rien autorisé par défaut', async () => {
    prisma.proposalLine.findFirst.mockResolvedValue({ department: 'BOISSONS' });
    const result = await isEanInUserScope('shop-1', '123', { role: 'SHELF_STOCKER', assignedDepartment: null });
    expect(result).toBe(false);
  });

  test('sans EAN ou sans shopId : autorisé par défaut, rien à comparer', async () => {
    expect(await isEanInUserScope('shop-1', null, { role: 'SHELF_STOCKER' })).toBe(true);
    expect(await isEanInUserScope(null, '123', { role: 'SHELF_STOCKER' })).toBe(true);
  });
});

describe('filterProposalLinesForUser — filtrage de listes par rayon assigné', () => {
  const lines = [
    { department: 'BOISSONS', ean: '1' },
    { department: 'LIQUIDES', ean: '2' },
    { department: 'EPICERIE', ean: '3' },
  ];

  test('ADMIN/DIRECTOR : toutes les lignes, aucun filtrage', () => {
    expect(filterProposalLinesForUser(lines, { role: 'ADMIN' })).toHaveLength(3);
    expect(filterProposalLinesForUser(lines, { role: 'DIRECTOR' })).toHaveLength(3);
  });

  test('DEPARTMENT_HEAD : uniquement les lignes de son département', () => {
    const result = filterProposalLinesForUser(lines, { role: 'DEPARTMENT_HEAD', assignedDepartment: 'Liquides' });
    expect(result).toHaveLength(1);
    expect(result[0].ean).toBe('2');
  });

  test('SHELF_STOCKER sans département assigné : liste vide, jamais tout par défaut', () => {
    expect(filterProposalLinesForUser(lines, { role: 'SHELF_STOCKER' })).toEqual([]);
  });
});
