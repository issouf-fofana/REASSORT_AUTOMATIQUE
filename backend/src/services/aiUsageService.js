/**
 * Consultation de la consommation de tokens IA (demande du 21/09/2026 : "j'ai l'impression qui finit
 * assez rapidement... il doit voir l'utilisation et ce qui reste, sur une période, globale") —
 * agrège AiUsageLog (une ligne par appel réel, écrite par aiForecastService.recordAiUsage).
 */
const prisma = require('../utils/prisma');

/**
 * Résumé d'usage sur une période donnée (par défaut les 30 derniers jours), pour tous les
 * fournisseurs ou un seul si précisé — total de tokens + décomposition par fournisseur/contexte,
 * pour voir non seulement CE QUI a été consommé mais QUEL usage de la plateforme (chatbot, prévision
 * batch...) en consomme le plus.
 */
async function getUsageSummary({ days = 30, provider } = {}) {
  const dateStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const where = { createdAt: { gte: dateStart }, ...(provider ? { provider } : {}) };

  const logs = await prisma.aiUsageLog.findMany({ where, select: { provider: true, context: true, promptTokens: true, completionTokens: true, totalTokens: true, createdAt: true } });

  const totalPromptTokens = logs.reduce((s, l) => s + l.promptTokens, 0);
  const totalCompletionTokens = logs.reduce((s, l) => s + l.completionTokens, 0);
  const totalTokens = logs.reduce((s, l) => s + l.totalTokens, 0);

  const byProvider = new Map();
  const byContext = new Map();
  const byDay = new Map();
  for (const log of logs) {
    const p = byProvider.get(log.provider) || { provider: log.provider, callCount: 0, totalTokens: 0 };
    p.callCount += 1;
    p.totalTokens += log.totalTokens;
    byProvider.set(log.provider, p);

    const ctxKey = log.context || '(non renseigné)';
    const c = byContext.get(ctxKey) || { context: ctxKey, callCount: 0, totalTokens: 0 };
    c.callCount += 1;
    c.totalTokens += log.totalTokens;
    byContext.set(ctxKey, c);

    const dayKey = log.createdAt.toISOString().slice(0, 10);
    byDay.set(dayKey, (byDay.get(dayKey) || 0) + log.totalTokens);
  }

  return {
    days,
    provider: provider || null,
    callCount: logs.length,
    totalPromptTokens,
    totalCompletionTokens,
    totalTokens,
    byProvider: Array.from(byProvider.values()).sort((a, b) => b.totalTokens - a.totalTokens),
    byContext: Array.from(byContext.values()).sort((a, b) => b.totalTokens - a.totalTokens),
    // Trié chronologiquement (pas par volume) : sert à tracer une courbe d'évolution jour par jour.
    dailyHistory: Array.from(byDay.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([date, tokens]) => ({ date, tokens })),
  };
}

/** Usage total depuis toujours (pas de fenêtre de date) — pour la vue "global" demandée explicitement. */
async function getUsageAllTime({ provider } = {}) {
  const where = provider ? { provider } : {};
  const agg = await prisma.aiUsageLog.aggregate({
    where,
    _count: true,
    _sum: { promptTokens: true, completionTokens: true, totalTokens: true },
    _min: { createdAt: true },
  });
  return {
    provider: provider || null,
    callCount: agg._count,
    totalPromptTokens: agg._sum.promptTokens || 0,
    totalCompletionTokens: agg._sum.completionTokens || 0,
    totalTokens: agg._sum.totalTokens || 0,
    trackingSince: agg._min.createdAt,
  };
}

module.exports = { getUsageSummary, getUsageAllTime };
