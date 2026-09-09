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
const systemConfig = require('./systemConfigService');
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
// buildArticleSummary accepte deux formes d'entrée selon l'appelant :
// - une ProposalLine Prisma déjà persistée (dailyHistory en JSON string, stock dans
//   stockAtGeneration, quantité dans quantitySuggested) — cas de runAiForecast/analyzeArticleRealtime ;
// - un objet "proposal" interne pas encore persisté, tel que produit par generateProposal
//   (dailyHistory déjà un tableau, stock dans `stock`, quantité dans quantityProposed) — cas de
//   l'intégration IA à la génération elle-même (generateAndSaveProposal). Éviter de forcer l'appelant
//   à reformater ses données juste pour cet appel, qui n'a pas besoin de cette distinction.
function buildArticleSummary(line) {
  let dailyHistory = [];
  if (Array.isArray(line.dailyHistory)) {
    dailyHistory = line.dailyHistory;
  } else if (typeof line.dailyHistory === 'string' && line.dailyHistory) {
    try {
      dailyHistory = JSON.parse(line.dailyHistory);
    } catch {
      dailyHistory = [];
    }
  }

  const classicQuantity = line.quantitySuggested ?? line.quantityProposed ?? 0;
  const currentStock = line.stockAtGeneration ?? line.stock ?? 0;

  return {
    ean: line.ean,
    label: line.label,
    // Résultat du calcul classique (computeQuantityToOrder), fourni comme point de départ à l'IA
    // plutôt que de lui laisser calculer une quantité indépendante à partir de zéro — évite des
    // écarts arbitraires entre deux méthodes qui n'ont jamais eu connaissance l'une de l'autre
    // (ex: 53 vs 73 sur le même article), et rend la réponse de l'IA directement actionnable comme
    // un ajustement justifié plutôt qu'un deuxième avis concurrent à départager soi-même.
    //
    // Cas particulier : un article bloqué par une commande RPOS récente hors plateforme
    // (excludedAsAlreadyOrderedRpos=true) a une quantité classique à 0 par construction (le besoin
    // est considéré déjà couvert). Lui donner 0 comme point de départ ne sert à rien — l'IA ne
    // ferait que confirmer 0 sans avoir vu le vrai besoin. On lui fournit alors
    // quantityIfUnblocked (déjà calculé : le besoin sans tenir compte de cette commande RPOS).
    systemSuggestedQuantity: (line.excludedAsAlreadyOrderedRpos && line.quantityIfUnblocked)
      ? line.quantityIfUnblocked
      : classicQuantity,
    avgWeeklySales: Number(line.avgWeeklySales?.toFixed(2) ?? 0),
    currentStock,
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

/**
 * Construit le prompt à partir du template configurable (Paramètres > IA, SystemConfig), pour
 * permettre à un admin d'ajuster les consignes données au LLM sans redéploiement. Remplace les
 * placeholders {{shopReference}}, {{shopName}}, {{articles}} par les valeurs réelles.
 */
async function buildPrompt(shopReference, shopName, articles) {
  const template = await systemConfig.getValue(systemConfig.KEYS.AI_ANALYSIS_PROMPT_TEMPLATE);
  return template
    .replace(/\{\{shopReference\}\}/g, shopReference || '')
    .replace(/\{\{shopName\}\}/g, shopName || '')
    .replace(/\{\{articles\}\}/g, JSON.stringify(articles, null, 2));
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
 * Analyse un ensemble d'articles par lots (ARTICLES_PER_BATCH, en parallèle contrôlé par
 * BATCH_CONCURRENCY) : construit le résumé de chaque article (buildArticleSummary), appelle le LLM
 * configuré avec fallback multi-clés, et retourne les suggestions obtenues par EAN. Un lot en échec
 * n'empêche jamais les autres de réussir — c'est à l'appelant de décider quoi faire des articles
 * sans suggestion (fallback sur le calcul classique, cf. generateAndSaveProposal et runAiForecast).
 * Factorisé ici car utilisé à deux endroits : l'analyse à la demande sur une proposition déjà
 * générée (runAiForecast) et, désormais, l'analyse intégrée à chaque génération elle-même.
 */
async function analyzeArticlesBatch(lines, shopReference, shopName) {
  const summaries = lines.map(buildArticleSummary);
  const batches = [];
  for (let i = 0; i < summaries.length; i += ARTICLES_PER_BATCH) {
    batches.push(summaries.slice(i, i + ARTICLES_PER_BATCH));
  }

  const byEan = new Map();
  let providerUsed = null;
  const batchErrors = [];

  await mapWithConcurrency(batches, BATCH_CONCURRENCY, async (batch) => {
    try {
      const prompt = await buildPrompt(shopReference, shopName, batch);
      const { result, providerUsed: usedForBatch } = await callWithFallback(prompt);
      providerUsed = providerUsed || usedForBatch;
      for (const r of result) byEan.set(String(r.ean), r);
    } catch (err) {
      batchErrors.push(err.message);
    }
  });

  return { byEan, providerUsed, batchErrors, totalBatches: batches.length };
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
    const { byEan, providerUsed, batchErrors, totalBatches } = await analyzeArticlesBatch(
      proposal.lines, proposal.rposShopReference, proposal.rposShopName
    );

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

    if (byEan.size === 0 && totalBatches > 0) {
      throw new Error(`Tous les lots ont échoué :\n${batchErrors.join('\n')}`);
    }

    await prisma.aiForecastLine.createMany({ data: lineData });
    await prisma.aiForecastRun.update({
      where: { id: run.id },
      data: {
        status: 'DONE',
        providerUsed,
        completedAt: new Date(),
        errorMessage: batchErrors.length > 0 ? `${batchErrors.length}/${totalBatches} lot(s) en échec (fallback sur le calcul classique pour ces articles) :\n${batchErrors.join('\n')}` : null,
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

/**
 * Analyse IA en direct d'un seul article (page "IA & Prédictions") : appelle le LLM immédiatement
 * sur cet article uniquement, sans persister d'AiForecastRun (analyse ponctuelle à la demande, pas
 * une génération complète de proposition) — retourne directement la suggestion ou lève une erreur.
 * Le résultat n'est pas mis en cache : chaque clic relance un vrai appel, cohérent avec l'attente
 * d'une analyse "en temps réel" plutôt qu'un résultat pré-calculé.
 */
async function analyzeArticleRealtime({ shopReference, shopName, line }) {
  const summary = buildArticleSummary(line);
  const prompt = await buildPrompt(shopReference, shopName, [summary]);
  const { result, providerUsed } = await callWithFallback(prompt);
  const suggestion = result.find((r) => String(r.ean) === String(line.ean)) || result[0];
  if (!suggestion) throw new Error('Réponse IA sans suggestion exploitable pour cet article');
  return {
    quantity: Math.max(0, Number(suggestion.quantity) || 0),
    reasoning: suggestion.reasoning || null,
    providerUsed,
  };
}

module.exports = { runAiForecast, getLatestAiForecast, testProviderKey, buildArticleSummary, analyzeArticleRealtime, analyzeArticlesBatch };
