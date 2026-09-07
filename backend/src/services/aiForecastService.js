/**
 * Prévision de quantité à commander par IA (LLM), en remplacement ponctuel ("à la demande") du
 * calcul classique (computeQuantityToOrder) pour une proposition donnée : envoie un résumé
 * statistique de chaque article (pas l'historique brut, pour rester léger en tokens/coût) au LLM
 * configuré, et récupère une quantité suggérée + une courte justification.
 *
 * Multi-fournisseur avec bascule automatique (AiProviderKey, triées par priorité) : si la clé de
 * plus haute priorité échoue (quota épuisé, erreur d'authentification, timeout), on retente avec
 * la suivante, sans intervention de l'utilisateur.
 */
const { PrismaClient } = require('@prisma/client');
const crypto = require('./cryptoService');
const { mapWithConcurrency } = require('../utils/concurrency');

const prisma = new PrismaClient();

// Un seul prompt géant avec tous les articles Pareto d'un magasin (jusqu'à 1000+) risquait de
// dépasser les limites de tokens du modèle ou de prendre plusieurs dizaines de secondes en un seul
// appel bloquant (audit performance). Découpage en lots envoyés en parallèle contrôlé : plus rapide
// au total, et un lot en échec n'invalide pas les autres (chacun retente le fallback multi-clés
// indépendamment).
const ARTICLES_PER_BATCH = 40;
const BATCH_CONCURRENCY = 3;

const DEFAULT_MODEL_BY_PROVIDER = {
  gemini: 'gemini-3.6-flash',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-haiku-latest',
};

/**
 * Construit le résumé statistique envoyé au LLM pour un article : les mêmes indicateurs déjà
 * calculés par le réassort classique (vente moy./sem., tendance, saisonnalité, stock, commandes en
 * cours), pour que le LLM raisonne sur des données déjà normalisées plutôt que du texte brut.
 */
function buildArticleSummary(line) {
  // dailyHistory est stocké en JSON string sur ProposalLine (cf. generateAndSaveProposal) : donne
  // à l'IA la vraie évolution jour par jour sur la période d'analyse, plutôt qu'un seul chiffre
  // moyen (avgWeeklySales) qui masque une tendance ou un pic ponctuel — elle peut ainsi juger
  // elle-même si la vente moyenne reflète bien un rythme stable ou doit être pondérée.
  let dailyHistory = [];
  if (line.dailyHistory) {
    try {
      dailyHistory = JSON.parse(line.dailyHistory);
    } catch {
      dailyHistory = [];
    }
  }

  return {
    ean: line.ean,
    label: line.label,
    avgWeeklySales: Number(line.avgWeeklySales?.toFixed(2) ?? 0),
    currentStock: line.stock,
    orderingUnit: line.orderingUnit,
    daysUntilStockout: line.daysUntilStockout !== null && line.daysUntilStockout !== undefined
      ? Number(line.daysUntilStockout.toFixed(1))
      : null,
    currentOrderedQuantity: line.currentOrderedQuantity || 0,
    revenueSharePct: line.revenueSharePct !== null && line.revenueSharePct !== undefined
      ? Number(line.revenueSharePct.toFixed(2))
      : null,
    seasonalityAdjusted: !!line.seasonalityAdjusted,
    hadNegativeStock: !!line.hadNegativeStock,
    dailyHistory,
  };
}

function buildPrompt(shopReference, shopName, articles) {
  return `Tu es un assistant d'approvisionnement pour un magasin de grande distribution (${shopReference} ${shopName || ''}).
Pour chaque article ci-dessous, propose la quantité à commander pour la période à venir, en te basant sur :
- la vente moyenne hebdomadaire (avgWeeklySales) : une moyenne plate sur toute la période analysée, qui peut masquer une tendance ou un pic ponctuel
- l'historique jour par jour (dailyHistory, [{date, quantity}]) : utilise-le pour juger si avgWeeklySales reflète bien un rythme stable, ou s'il faut l'ajuster — par exemple une seule grosse journée exceptionnelle (promotion, revente ponctuelle) ne doit pas être extrapolée comme un rythme hebdomadaire normal, alors qu'une tendance régulière à la hausse ou à la baisse sur plusieurs jours mérite d'être prise en compte
- le stock actuel (currentStock) et le nombre de jours avant rupture (daysUntilStockout)
- la quantité déjà en commande non reçue (currentOrderedQuantity), à ne pas recommander en double
- l'unité de commande (orderingUnit) : la quantité proposée doit être un multiple de cette unité
- la part de chiffre d'affaires de l'article (revenueSharePct) : les articles à forte part méritent une couverture de stock plus prudente

Articles (JSON) :
${JSON.stringify(articles, null, 2)}

Réponds UNIQUEMENT avec un tableau JSON valide, sans texte autour, au format exact :
[{"ean": "...", "quantity": 0, "reasoning": "courte justification en français, une phrase"}]
Une entrée par article fourni, dans le même ordre. quantity doit être un entier positif ou nul, multiple de orderingUnit.`;
}

function parseJsonArrayFromText(text) {
  // Les LLM enveloppent parfois la réponse dans un bloc ```json ... ``` malgré la consigne : on
  // extrait le premier tableau JSON trouvé plutôt que d'exiger un JSON.parse strict sur tout le texte.
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('Réponse IA sans tableau JSON reconnaissable');
  return JSON.parse(match[0]);
}

async function callGemini(apiKey, model, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model || DEFAULT_MODEL_BY_PROVIDER.gemini}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2 },
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`Gemini ${res.status}: ${errText}`);
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Réponse Gemini vide ou inattendue');
  return parseJsonArrayFromText(text);
}

async function callOpenAi(apiKey, model, prompt) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL_BY_PROVIDER.openai,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`OpenAI ${res.status}: ${errText}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('Réponse OpenAI vide ou inattendue');
  return parseJsonArrayFromText(text);
}

async function callAnthropic(apiKey, model, prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL_BY_PROVIDER.anthropic,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`Anthropic ${res.status}: ${errText}`);
  }
  const data = await res.json();
  const text = data.content?.[0]?.text;
  if (!text) throw new Error('Réponse Anthropic vide ou inattendue');
  return parseJsonArrayFromText(text);
}

const CALLERS = { gemini: callGemini, openai: callOpenAi, anthropic: callAnthropic };

/**
 * Essaie chaque clé API active par ordre de priorité jusqu'à ce qu'une réponde avec succès.
 * Journalise l'échec (lastError/lastErrorAt) sur la clé fautive pour visibilité côté UI, sans
 * bloquer l'essai des clés suivantes.
 */
async function callWithFallback(prompt) {
  const keys = await prisma.aiProviderKey.findMany({
    where: { isActive: true },
    orderBy: { priority: 'asc' },
  });
  if (keys.length === 0) {
    throw new Error('Aucune clé API IA configurée. Ajoutez-en une dans Paramètres > IA.');
  }

  const errors = [];
  for (const key of keys) {
    const caller = CALLERS[key.provider];
    if (!caller) {
      errors.push(`${key.label}: fournisseur "${key.provider}" non supporté`);
      continue;
    }
    try {
      const apiKey = crypto.decrypt(key.encryptedApiKey);
      const result = await caller(apiKey, key.model, prompt);
      await prisma.aiProviderKey.update({
        where: { id: key.id },
        data: { lastUsedAt: new Date(), lastError: null, lastErrorAt: null },
      });
      return { result, providerUsed: key.provider, keyLabel: key.label };
    } catch (err) {
      errors.push(`${key.label} (${key.provider}): ${err.message}`);
      await prisma.aiProviderKey.update({
        where: { id: key.id },
        data: { lastError: err.message, lastErrorAt: new Date() },
      }).catch(() => {});
    }
  }
  throw new Error(`Toutes les clés IA ont échoué :\n${errors.join('\n')}`);
}

/**
 * Teste une clé API isolément (bouton "Tester" dans Paramètres > IA) : envoie un prompt minimal,
 * sans toucher à une proposition ni à AiForecastRun — juste pour vérifier que la clé est valide et
 * que le fournisseur répond, avant de s'en servir sur une vraie analyse.
 */
async function testProviderKey(keyId) {
  const key = await prisma.aiProviderKey.findUnique({ where: { id: keyId } });
  if (!key) throw new Error('Clé introuvable');

  const caller = CALLERS[key.provider];
  if (!caller) throw new Error(`Fournisseur "${key.provider}" non supporté`);

  const testPrompt = 'Réponds UNIQUEMENT avec ce tableau JSON, sans texte autour : [{"ean": "TEST", "quantity": 1, "reasoning": "ok"}]';

  try {
    const apiKey = crypto.decrypt(key.encryptedApiKey);
    const start = Date.now();
    const result = await caller(apiKey, key.model, testPrompt);
    const durationMs = Date.now() - start;
    await prisma.aiProviderKey.update({
      where: { id: keyId },
      data: { lastUsedAt: new Date(), lastError: null, lastErrorAt: null },
    });
    return { success: true, durationMs, sample: result };
  } catch (err) {
    await prisma.aiProviderKey.update({
      where: { id: keyId },
      data: { lastError: err.message, lastErrorAt: new Date() },
    }).catch(() => {});
    throw err;
  }
}

/**
 * Lance une analyse IA sur les lignes d'une proposition existante : construit le résumé par
 * article, appelle le LLM (avec fallback multi-clés), et persiste le résultat dans AiForecastRun
 * sans jamais modifier la proposition classique — l'utilisateur choisit explicitement d'appliquer
 * ou non les quantités suggérées à la validation.
 */
async function runAiForecast(proposalId, requestedBy) {
  const proposal = await prisma.proposal.findUnique({ where: { id: proposalId }, include: { lines: true } });
  if (!proposal) throw new Error('Proposition introuvable');

  const run = await prisma.aiForecastRun.create({
    data: { proposalId, rposShopId: proposal.rposShopId, status: 'RUNNING', requestedBy },
  });

  try {
    const summaries = proposal.lines.map(buildArticleSummary);
    const batches = [];
    for (let i = 0; i < summaries.length; i += ARTICLES_PER_BATCH) {
      batches.push(summaries.slice(i, i + ARTICLES_PER_BATCH));
    }

    const byEan = new Map();
    let providerUsed = null;
    const batchErrors = [];

    await mapWithConcurrency(batches, BATCH_CONCURRENCY, async (batch) => {
      try {
        const prompt = buildPrompt(proposal.rposShopReference, proposal.rposShopName, batch);
        const { result, providerUsed: usedForBatch } = await callWithFallback(prompt);
        providerUsed = providerUsed || usedForBatch;
        for (const r of result) byEan.set(String(r.ean), r);
      } catch (err) {
        batchErrors.push(err.message);
      }
    });

    // Un lot en échec ne bloque pas les autres : les articles concernés gardent simplement la
    // quantité calculée classiquement (fallback silencieux), plutôt que de faire échouer toute
    // l'analyse pour une panne partielle sur une fraction des articles.
    const lineData = proposal.lines.map((line) => {
      const suggestion = byEan.get(line.ean);
      return {
        runId: run.id,
        ean: line.ean,
        label: line.label,
        quantitySuggested: suggestion ? Math.max(0, Number(suggestion.quantity) || 0) : line.quantitySuggested,
        reasoning: suggestion?.reasoning || null,
      };
    });

    if (byEan.size === 0 && batches.length > 0) {
      throw new Error(`Tous les lots ont échoué :\n${batchErrors.join('\n')}`);
    }

    await prisma.aiForecastLine.createMany({ data: lineData });
    await prisma.aiForecastRun.update({
      where: { id: run.id },
      data: {
        status: 'DONE',
        providerUsed,
        completedAt: new Date(),
        errorMessage: batchErrors.length > 0 ? `${batchErrors.length}/${batches.length} lot(s) en échec (fallback sur le calcul classique pour ces articles) :\n${batchErrors.join('\n')}` : null,
      },
    });

    return prisma.aiForecastRun.findUnique({ where: { id: run.id }, include: { lines: true } });
  } catch (err) {
    await prisma.aiForecastRun.update({
      where: { id: run.id },
      data: { status: 'ERROR', errorMessage: err.message, completedAt: new Date() },
    });
    throw err;
  }
}

async function getLatestAiForecast(proposalId) {
  return prisma.aiForecastRun.findFirst({
    where: { proposalId },
    orderBy: { requestedAt: 'desc' },
    include: { lines: true },
  });
}

module.exports = { runAiForecast, getLatestAiForecast, testProviderKey, buildArticleSummary };
