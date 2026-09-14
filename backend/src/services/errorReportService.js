/**
 * Journal des erreurs applicatives (debug global du Conseiller d'amélioration IA).
 *
 * Deux capteurs alimentent la table ErrorReport :
 * - backend : hook server.js sur TOUTES les réponses API 5xx (quel que soit le chemin de code,
 *   routes en try/catch direct ou error handler central) ;
 * - frontend : layout.js (chargé sur CHAQUE page interne) remonte window.onerror et les
 *   promesses rejetées non capturées — donc oui, TOUTES les pages/vues sont couvertes.
 *
 * Écriture en fire-and-forget (jamais bloquante, jamais d'échec propagé) : un système de debug
 * ne doit jamais lui-même casser une requête. Rétention 30j + plafond 5000 lignes (prune).
 */
const prisma = require('../utils/prisma');

const RETENTION_DAYS = 30;
const MAX_ROWS = 5000;

// Regroupe les occurrences d'une "même" erreur : normalise le message (nombres, UUID, EAN,
// timestamps → #) pour que "Échec article 123" et "Échec article 456" forment UN groupe avec
// un compteur — au lieu de N constats identiques.
function normalizeSignature(message) {
  return String(message || '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '#')
    .replace(/\b\d{8,}\b/g, '#')
    .replace(/\b\d+(\.\d+)?\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function groupKey(r) {
  const where = r.source === 'frontend' ? (r.page || '?') : (r.url || '?');
  return `${r.source}|${where}|${normalizeSignature(r.message)}`;
}

// Pure (testée unitairement) : regroupe des lignes ErrorReport en paquets {key, source, page,
// url, signature, sample (message exact + stack), count, firstSeen, lastSeen}, triés par
// compteur décroissant.
function groupErrorReports(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = groupKey(r);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        source: r.source,
        page: r.page || null,
        url: r.url || null,
        method: r.method || null,
        statusCode: r.statusCode ?? null,
        signature: normalizeSignature(r.message),
        sampleMessage: r.message,
        sampleStack: r.stack || null,
        sampleUser: r.userEmail || null,
        sampleShop: r.shopRef || null,
        count: 0,
        firstSeen: r.createdAt,
        lastSeen: r.createdAt,
      });
    }
    const g = groups.get(key);
    g.count += 1;
    if (r.createdAt < g.firstSeen) g.firstSeen = r.createdAt;
    if (r.createdAt > g.lastSeen) { g.lastSeen = r.createdAt; g.sampleStack = r.stack || g.sampleStack; }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

// Persiste un rapport d'erreur. Ne jette JAMAIS (fire-and-forget côté appelants).
async function reportError(data) {
  try {
    const message = String(data.message || '').slice(0, 1000);
    if (!message) return null;
    return await prisma.errorReport.create({
      data: {
        source: data.source,
        page: data.page ? String(data.page).slice(0, 300) : null,
        url: data.url ? String(data.url).slice(0, 500) : null,
        method: data.method || null,
        statusCode: data.statusCode ?? null,
        message,
        stack: data.stack ? String(data.stack).slice(0, 2000) : null,
        userEmail: data.userEmail || null,
        shopRef: data.shopRef || null,
        ip: data.ip || null,
        userAgent: data.userAgent ? String(data.userAgent).slice(0, 500) : null,
      },
    });
  } catch {
    return null;
  }
}

async function pruneErrorReports() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const old = await prisma.errorReport.deleteMany({ where: { createdAt: { lt: cutoff } } });
  let capped = 0;
  const total = await prisma.errorReport.count();
  if (total > MAX_ROWS) {
    const excess = await prisma.errorReport.findMany({
      orderBy: { createdAt: 'asc' },
      take: total - MAX_ROWS,
      select: { id: true },
    });
    capped = (await prisma.errorReport.deleteMany({ where: { id: { in: excess.map((e) => e.id) } } })).count;
  }
  return { deletedOld: old.count, capped };
}

module.exports = { reportError, groupErrorReports, normalizeSignature, pruneErrorReports, RETENTION_DAYS, MAX_ROWS };
