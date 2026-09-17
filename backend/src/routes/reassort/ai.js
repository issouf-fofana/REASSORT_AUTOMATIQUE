// Sous-routeur 'ai' — Cles IA, analyse par article, chatbot, journal audit et Conseiller amelioration.
// Monte dans routes/reassort/index.js sous le prefixe /api/reassort (requireAuth +
// requireSupervisedShop appliques la-bas, pas ici). Ne jamais monter ailleurs.
const express = require('express');
const router = express.Router();
const { requireAdmin, resolveShopId, resolvePosId } = require('../../middleware/auth');
const prisma = require('../../utils/prisma');
const shopActivityService = require('../../services/shopActivityService');
const chatbotService = require('../../services/chatbotService');
const aiForecastService = require('../../services/aiForecastService');
const cryptoService = require('../../services/cryptoService');
const improvementService = require('../../services/improvementService');
const errorReportService = require('../../services/errorReportService');
const correctionRecordService = require('../../services/correctionRecordService');
const aiMasteryService = require('../../services/aiMasteryService');
const autonomyReadinessService = require('../../services/autonomyReadinessService');
const { filterProposalLinesForUser, getCapabilityGuide, getPlatformGuide } = require('../../services/aiPermissionsService');

// Un Rayonniste/Chef de département ne doit pas pouvoir faire analyser par l'IA (ou poser une
// question de suivi sur) un article hors de son rayon simplement en connaissant son EAN dans cette
// proposition — même famille de faille que le chatbot général (trouvée le 16/09/2026 : le contrôle
// de shop existait déjà sur ces routes mais jamais celui de département).
async function assertLineInUserScope(req, res, line) {
  const currentUser = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (filterProposalLinesForUser([line], currentUser).length > 0) return true;
  res.status(403).json({ success: false, message: 'Cet article n\'est pas dans votre périmètre.' });
  return false;
}

router.get('/ai/keys', requireAdmin, async (req, res) => {
  try {
    const keys = await prisma.aiProviderKey.findMany({ orderBy: { priority: 'asc' } });
    const data = keys.map((k) => ({
      id: k.id,
      provider: k.provider,
      label: k.label,
      model: k.model,
      priority: k.priority,
      isActive: k.isActive,
      lastUsedAt: k.lastUsedAt,
      lastError: k.lastError,
      lastErrorAt: k.lastErrorAt,
      maskedKey: cryptoService.maskApiKey(cryptoService.decrypt(k.encryptedApiKey)),
    }));
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/ai/keys - ajoute une clé API (ADMIN uniquement)
// body: { provider, label, apiKey, model, priority }
router.post('/ai/keys', requireAdmin, async (req, res) => {
  try {
    const { provider, label, apiKey, model, priority } = req.body;
    if (!provider || !label || !apiKey) {
      return res.status(400).json({ success: false, message: 'provider, label et apiKey sont requis' });
    }
    const key = await prisma.aiProviderKey.create({
      data: {
        provider,
        label,
        model: model || null,
        priority: priority ?? 0,
        encryptedApiKey: cryptoService.encrypt(apiKey),
        createdBy: req.user.email,
      },
    });
    res.json({ success: true, data: { id: key.id } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT /api/reassort/ai/keys/:id - met à jour une clé (label, priorité, actif, éventuellement la clé elle-même)
router.put('/ai/keys/:id', requireAdmin, async (req, res) => {
  try {
    const { label, apiKey, model, priority, isActive } = req.body;
    const data = {};
    if (label !== undefined) data.label = label;
    if (model !== undefined) data.model = model || null;
    if (priority !== undefined) data.priority = priority;
    if (isActive !== undefined) data.isActive = isActive;
    if (apiKey) data.encryptedApiKey = cryptoService.encrypt(apiKey);

    await prisma.aiProviderKey.update({ where: { id: req.params.id }, data });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE /api/reassort/ai/keys/:id
router.delete('/ai/keys/:id', requireAdmin, async (req, res) => {
  try {
    await prisma.aiProviderKey.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/ai/keys/:id/test - teste une clé isolément (prompt minimal), sans proposition
router.post('/ai/keys/:id/test', requireAdmin, async (req, res) => {
  try {
    const result = await aiForecastService.testProviderKey(req.params.id);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/proposal/:proposalId/ai-forecast - lance une analyse IA à la demande sur une
// proposition existante (ne modifie jamais la proposition classique).
router.post('/proposal/:proposalId/ai-forecast', requireAdmin, async (req, res) => {
  try {
    const run = await aiForecastService.runAiForecast(req.params.proposalId, req.user.email);
    res.json({ success: true, data: run });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/proposal/:proposalId/ai-forecast - dernier résultat d'analyse IA pour cette proposition
router.get('/proposal/:proposalId/ai-forecast', requireAdmin, async (req, res) => {
  try {
    const run = await aiForecastService.getLatestAiForecast(req.params.proposalId);
    res.json({ success: true, data: run });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/shop-activity/warm - déclenche le calcul du profil d'activité du magasin
// (shopActivityService) en arrière-plan, SANS attendre le résultat (répond immédiatement) : à
// appeler dès qu'un magasin est sélectionné sur une page qui propose l'analyse IA par article, pour
// que ce profil soit déjà en cache (24h) au moment du premier clic "Analyser" — évite de faire
// attendre l'utilisateur ~15-30s sur ce calcul au moment précis où il veut un résultat rapide.
// Idempotent et sans risque : un appel répété pendant que le cache est déjà chaud ne fait rien
// (getShopActivityProfile relit le cache directement).
router.post('/shop-activity/warm', async (req, res) => {
  const shopId = resolveShopId(req);
  const posId = resolvePosId(req);
  res.json({ success: true }); // répond tout de suite, le calcul continue derrière
  if (!shopId || !posId) return;
  shopActivityService.getShopActivityProfile(posId, shopId).catch(() => {}); // best-effort, jamais bloquant
});

// POST /api/reassort/proposal/:proposalId/ai-analyze-article - analyse IA en direct d'un seul
// article (page "IA & Prédictions") : appel LLM immédiat, sans persistance (AiForecastRun est pour
// une génération complète, pas une analyse ponctuelle). Body: { ean }.
router.post('/proposal/:proposalId/ai-analyze-article', async (req, res) => {
  try {
    const { ean } = req.body;
    if (!ean) return res.status(400).json({ success: false, message: 'ean requis' });

    const proposal = await prisma.proposal.findUnique({ where: { id: req.params.proposalId } });
    if (!proposal) return res.status(404).json({ success: false, message: 'Proposition introuvable' });

    const shopId = resolveShopId(req);
    if (shopId && proposal.rposShopId !== shopId) {
      return res.status(403).json({ success: false, message: 'Cette proposition n\'appartient pas à votre magasin' });
    }

    const line = await prisma.proposalLine.findFirst({ where: { proposalId: proposal.id, ean } });
    if (!line) return res.status(404).json({ success: false, message: 'Article introuvable dans cette proposition' });
    if (!(await assertLineInUserScope(req, res, line))) return;

    const result = await aiForecastService.analyzeArticleRealtime({
      shopReference: proposal.rposShopReference,
      shopName: proposal.rposShopName,
      line,
      shopConfig: { safetyStockRatio: proposal.safetyStockRatioUsed, receptionLeadTimeDays: proposal.receptionLeadTimeDaysUsed },
      posId: proposal.rposPosId,
      shopId: proposal.rposShopId,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/proposal/:proposalId/ai-analyze-article-stream - variante streamée (SSE) de la
// route ci-dessus : le texte de l'IA s'affiche au fur et à mesure côté frontend (façon
// conversation), plutôt que d'attendre la réponse complète avant de tout afficher d'un coup. POST
// (pas l'EventSource natif du navigateur, qui ne supporte ni POST ni header Authorization custom) :
// le frontend consomme ce flux via fetch() + response.body.getReader(), même mécanisme que celui
// utilisé côté serveur pour lire les flux des fournisseurs LLM. Body: { ean }.
router.post('/proposal/:proposalId/ai-analyze-article-stream', async (req, res) => {
  const { ean } = req.body;
  if (!ean) return res.status(400).json({ success: false, message: 'ean requis' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const proposal = await prisma.proposal.findUnique({ where: { id: req.params.proposalId } });
    if (!proposal) { send('error', { message: 'Proposition introuvable' }); return res.end(); }

    const shopId = resolveShopId(req);
    if (shopId && proposal.rposShopId !== shopId) {
      send('error', { message: 'Cette proposition n\'appartient pas à votre magasin' });
      return res.end();
    }

    const line = await prisma.proposalLine.findFirst({ where: { proposalId: proposal.id, ean } });
    if (!line) { send('error', { message: 'Article introuvable dans cette proposition' }); return res.end(); }
    const currentUser = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!filterProposalLinesForUser([line], currentUser).length) {
      send('error', { message: 'Cet article n\'est pas dans votre périmètre.' });
      return res.end();
    }

    const result = await aiForecastService.analyzeArticleRealtimeStream({
      shopReference: proposal.rposShopReference,
      shopName: proposal.rposShopName,
      line,
      shopConfig: { safetyStockRatio: proposal.safetyStockRatioUsed, receptionLeadTimeDays: proposal.receptionLeadTimeDaysUsed },
      posId: proposal.rposPosId,
      shopId: proposal.rposShopId,
      onQuantity: (quantity) => send('quantity', { quantity }),
      onTextChunk: (text) => send('chunk', { text }),
    });

    send('done', result);
    res.end();
  } catch (error) {
    send('error', { message: error.message });
    res.end();
  }
});

// POST /api/reassort/proposal/:proposalId/ai-ask-followup-stream - question libre du magasin sur
// une recommandation déjà donnée (cf. demande explicite : "le magasin doit pouvoir demander à l'IA
// pourquoi elle recommande une quantité donnée", "combien de jours cette commande va-t-elle
// couvrir ?", etc.). Streamé en SSE comme l'analyse initiale. Body: { ean, previousQuantity,
// previousReasoning, conversationHistory, question }.
router.post('/proposal/:proposalId/ai-ask-followup-stream', async (req, res) => {
  const { ean, previousQuantity, previousReasoning, conversationHistory, question } = req.body;
  if (!ean || !question) return res.status(400).json({ success: false, message: 'ean et question sont requis' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const proposal = await prisma.proposal.findUnique({ where: { id: req.params.proposalId } });
    if (!proposal) { send('error', { message: 'Proposition introuvable' }); return res.end(); }

    const shopId = resolveShopId(req);
    if (shopId && proposal.rposShopId !== shopId) {
      send('error', { message: 'Cette proposition n\'appartient pas à votre magasin' });
      return res.end();
    }

    const line = await prisma.proposalLine.findFirst({ where: { proposalId: proposal.id, ean } });
    if (!line) { send('error', { message: 'Article introuvable dans cette proposition' }); return res.end(); }
    const currentUser = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!filterProposalLinesForUser([line], currentUser).length) {
      send('error', { message: 'Cet article n\'est pas dans votre périmètre.' });
      return res.end();
    }

    const result = await aiForecastService.askFollowUpQuestion({
      shopReference: proposal.rposShopReference,
      shopName: proposal.rposShopName,
      line,
      shopConfig: { safetyStockRatio: proposal.safetyStockRatioUsed, receptionLeadTimeDays: proposal.receptionLeadTimeDaysUsed },
      posId: proposal.rposPosId,
      shopId: proposal.rposShopId,
      previousQuantity,
      previousReasoning,
      conversationHistory,
      question,
      onTextChunk: (text) => send('chunk', { text }),
    });

    send('done', result);
    res.end();
  } catch (error) {
    send('error', { message: error.message });
    res.end();
  }
});

// GET /api/reassort/chatbot/suggested-questions - questions suggérées (§34), éditables depuis
// Paramètres > IA (CHATBOT_SUGGESTED_QUESTIONS, une par ligne) sans redéploiement.
router.get('/chatbot/suggested-questions', async (req, res) => {
  res.json({ success: true, data: await chatbotService.getSuggestedQuestions() });
});

// GET /api/reassort/chatbot/capability-guide - "Ce que je peux vous demander" (demande du 16/09/2026
// : "créer une vue qui guide les questions que chaque profil peut poser") — reflète les permissions
// RÉELLEMENT appliquées à l'utilisateur connecté (rôle + personnalisation aiPermissionsJson
// éventuelle), pas une liste générique identique pour tout le monde : un Rayonniste ne voit pas les
// mêmes exemples qu'un Directeur, et voit explicitement ce qui lui est refusé et pourquoi.
router.get('/chatbot/capability-guide', async (req, res) => {
  try {
    const currentUser = await prisma.user.findUnique({ where: { id: req.user.id } });
    res.json({ success: true, data: getCapabilityGuide(currentUser) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/platform-guide - "Ce que je peux faire sur la plateforme" (demande du 16/09/2026
// : "chaque user dois voir ce quil peux faire sur la plaforme", au-delà des seules questions du
// chatbot) — pages accessibles et actions clés pour le rôle de l'utilisateur connecté.
router.get('/platform-guide', async (req, res) => {
  try {
    const currentUser = await prisma.user.findUnique({ where: { id: req.user.id } });
    res.json({ success: true, data: getPlatformGuide(currentUser) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/chatbot/conversations - liste des conversations de l'utilisateur connecté
// (toutes magasins confondus, plus récentes d'abord), pour la liste latérale façon ChatGPT.
router.get('/chatbot/conversations', async (req, res) => {
  try {
    const conversations = await prisma.chatbotConversation.findMany({
      where: { userId: req.user.id },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, title: true, rposShopId: true, department: true, subDepartment: true, updatedAt: true },
      take: 100,
    });
    res.json({ success: true, data: conversations });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/chatbot/conversations/:id - messages complets d'une conversation (vérifie
// qu'elle appartient bien à l'utilisateur connecté, jamais l'historique d'un autre compte).
router.get('/chatbot/conversations/:id', async (req, res) => {
  try {
    const conversation = await prisma.chatbotConversation.findUnique({
      where: { id: req.params.id },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!conversation || conversation.userId !== req.user.id) {
      return res.status(404).json({ success: false, message: 'Conversation introuvable' });
    }
    res.json({ success: true, data: conversation });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE /api/reassort/chatbot/conversations/:id - supprime une conversation (et ses messages, cascade).
router.delete('/chatbot/conversations/:id', async (req, res) => {
  try {
    const conversation = await prisma.chatbotConversation.findUnique({ where: { id: req.params.id } });
    if (!conversation || conversation.userId !== req.user.id) {
      return res.status(404).json({ success: false, message: 'Conversation introuvable' });
    }
    await prisma.chatbotConversation.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/chatbot/ask-stream - AI Store Assistant (CAHIER_DES_CHARGES.md §34-38, étape
// 11) : question libre du responsable magasin, avec contexte magasin/rayon/sous-rayon. Streamé en
// SSE comme les autres analyses IA. Body: { conversationId (optionnel, crée une nouvelle
// conversation si absent), department, subDepartment, question }. Le magasin est déterminé par
// resolveShopId (permission de l'utilisateur), jamais par un paramètre libre côté client — cohérent
// avec §43 (le chatbot ne doit jamais pouvoir contourner les permissions pour consulter un autre
// magasin). Chaque question/réponse est persistée (ChatbotMessage) pour l'historique.
router.post('/chatbot/ask-stream', async (req, res) => {
  const { conversationId, department, subDepartment, question } = req.body;
  if (!question) return res.status(400).json({ success: false, message: 'question requise' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const shopId = resolveShopId(req);
    if (!shopId) { send('error', { message: 'Aucun magasin assigné à ce compte' }); return res.end(); }

    const shop = await prisma.shop.findUnique({ where: { rposShopId: shopId } });
    if (!shop) { send('error', { message: 'Magasin introuvable' }); return res.end(); }

    // Permissions IA (rôle + personnalisation éventuelle) lues depuis la base, jamais depuis le JWT
    // (payload figé à la connexion — un ajustement de permission par un admin doit s'appliquer
    // immédiatement, sans attendre l'expiration du token, même logique que requireSupervisedShop).
    const currentUser = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!currentUser) { send('error', { message: 'Utilisateur introuvable' }); return res.end(); }

    // DEPARTMENT_HEAD/SHELF_STOCKER : le département/rayon assigné s'impose TOUJOURS, ignorant
    // toute valeur envoyée par le client (sinon un rayonniste pourrait interroger n'importe quel
    // autre rayon simplement en changeant le paramètre "department" de sa requête — la restriction
    // de périmètre doit être appliquée côté serveur, jamais faire confiance à l'input client ici).
    const RESTRICTED_ROLES = new Set(['DEPARTMENT_HEAD', 'SHELF_STOCKER']);
    const effectiveDepartment = RESTRICTED_ROLES.has(currentUser.role)
      ? currentUser.assignedDepartment
      : department;

    let conversation = conversationId
      ? await prisma.chatbotConversation.findUnique({ where: { id: conversationId }, include: { messages: { orderBy: { createdAt: 'asc' } } } })
      : null;
    if (conversation && conversation.userId !== req.user.id) {
      send('error', { message: 'Cette conversation ne vous appartient pas' });
      return res.end();
    }
    if (!conversation) {
      conversation = await prisma.chatbotConversation.create({
        data: {
          userId: req.user.id,
          rposShopId: shopId,
          title: question.slice(0, 80),
          department: effectiveDepartment || null,
          subDepartment: subDepartment || null,
        },
        include: { messages: true },
      });
    }

    // Reconstruit les tours question/réponse en parcourant les messages dans l'ordre (déjà triés
    // par createdAt asc) : chaque message "user" est suivi de sa réponse "assistant" correspondante.
    const conversationHistory = [];
    for (let i = 0; i < conversation.messages.length - 1; i++) {
      if (conversation.messages[i].role === 'user' && conversation.messages[i + 1].role === 'assistant') {
        conversationHistory.push({
          question: conversation.messages[i].content,
          answer: conversation.messages[i + 1].content,
          toolUsed: conversation.messages[i + 1].toolUsed || null,
          toolResult: conversation.messages[i + 1].toolResult ? JSON.parse(conversation.messages[i + 1].toolResult) : null,
        });
      }
    }

    await prisma.chatbotMessage.create({ data: { conversationId: conversation.id, role: 'user', content: question } });

    const result = await chatbotService.askAssistant({
      rposShopId: shopId,
      posId: shop.rposPosId,
      shopReference: shop.reference,
      shopName: shop.name,
      department: effectiveDepartment || conversation.department,
      subDepartment: subDepartment || conversation.subDepartment,
      conversationHistory,
      question,
      onTextChunk: (text) => send('chunk', { text }),
      user: currentUser,
    });

    await Promise.all([
      prisma.chatbotMessage.create({ data: { conversationId: conversation.id, role: 'assistant', content: result.answer, toolUsed: result.toolUsed, toolResult: result.toolResult ? JSON.stringify(result.toolResult) : null } }),
      prisma.chatbotConversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } }),
    ]);

    send('done', { ...result, conversationId: conversation.id });
    res.end();
  } catch (error) {
    send('error', { message: error.message });
    res.end();
  }
});

// PUT /api/reassort/proposal/:proposalId/line-quantity - applique une quantité choisie par
// l'utilisateur (page "IA & Prédictions") sur une ligne de proposition : la recommandation IA
// n'est jamais imposée automatiquement, l'utilisateur reste décisionnaire (peut commander moins,
// plus, ou suivre l'IA telle quelle). Ne touche qu'à ProposalLine.quantitySuggested — la
// validation/envoi vers RPOS reste sur purchase-order.html comme aujourd'hui.
router.put('/proposal/:proposalId/line-quantity', async (req, res) => {
  try {
    const { ean, quantity } = req.body;
    if (!ean) return res.status(400).json({ success: false, message: 'ean requis' });
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty < 0) {
      return res.status(400).json({ success: false, message: 'quantity doit être un nombre positif ou nul' });
    }

    const proposal = await prisma.proposal.findUnique({ where: { id: req.params.proposalId } });
    if (!proposal) return res.status(404).json({ success: false, message: 'Proposition introuvable' });

    const shopId = resolveShopId(req);
    if (shopId && proposal.rposShopId !== shopId) {
      return res.status(403).json({ success: false, message: 'Cette proposition n\'appartient pas à votre magasin' });
    }
    if (proposal.status !== 'GENERATED') {
      return res.status(409).json({ success: false, message: 'Cette proposition n\'est plus modifiable (déjà validée ou remplacée)' });
    }

    const line = await prisma.proposalLine.findFirst({ where: { proposalId: proposal.id, ean } });
    if (!line) return res.status(404).json({ success: false, message: 'Article introuvable dans cette proposition' });
    if (!(await assertLineInUserScope(req, res, line))) return;

    const updated = await prisma.proposalLine.update({
      where: { id: line.id },
      data: { quantitySuggested: Math.round(qty) },
    });
    res.json({ success: true, data: { ean: updated.ean, quantitySuggested: updated.quantitySuggested } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/error-reports - capteur frontend du debug global : chaque page interne
// remonte ses erreurs JS non capturées (layout.js, TOUTES les pages/vues couvertes).
// Authentifié mais pas forcément ADMIN (les erreurs des comptes STORE sont précieuses aussi) —
// le regroupement et la déduplication se font côté chien de garde, ici on journalise juste
// (plafond anti-spam côté client : 20 envois + dédup 60s par page chargée).
router.post('/error-reports', async (req, res) => {
  try {
    const { page, message, stack } = req.body;
    if (!message) return res.status(400).json({ success: false, message: 'message requis' });
    await errorReportService.reportError({
      source: 'frontend',
      page: page || null,
      message,
      stack: stack || null,
      userEmail: (req.user && req.user.email) || null,
      shopRef: (req.user && req.user.rposShopReference) || null,
      ip: req.ip || null,
      userAgent: req.get('User-Agent') || null,
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/error-reports/recent - journal d'audit des erreurs (base du debug global) :
// les 100 dernières erreurs capturées (toutes pages frontend + toutes API 5xx), les plus
// récentes d'abord. Réservé ADMIN. Prouve que les bugs sont bien sauvés avant analyse.
router.get('/error-reports/recent', requireAdmin, async (req, res) => {
  try {
    const rows = await prisma.errorReport.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
    const total = await prisma.errorReport.count();
    res.json({ success: true, data: { total, rows } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/improvements - Conseiller d'amélioration IA (première brique AI Center,
// §44) : constats persistés avec priorité, statut et timeline.
// ?status= & ?priority= pour filtrer, ?sort=priority (défaut, critiques d'abord) ou recent.
// Réservé ADMIN : pilotage global du système, pas par magasin.
router.get('/improvements', requireAdmin, async (req, res) => {
  try {
    const where = {};
    if (req.query.status) where.status = req.query.status;
    if (req.query.priority) where.priority = req.query.priority;
    const rows = await prisma.aIImprovement.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 });
    const rank = improvementService.PRIORITY_RANK;
    if ((req.query.sort || 'priority') === 'priority') {
      rows.sort((a, b) => (rank[a.priority] ?? 9) - (rank[b.priority] ?? 9) || b.createdAt - a.createdAt);
    }
    res.json({ success: true, data: rows.map((r) => ({ ...r, evidence: r.evidence ? JSON.parse(r.evidence) : null })) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/improvements/health - constats ACTUELS du chien de garde, sans rien
// persister : aperçu instantané avant de lancer une génération.
router.get('/improvements/health', requireAdmin, async (req, res) => {
  try {
    res.json({ success: true, data: await improvementService.collectFindings() });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/improvements/:id - détail complet + timeline des événements
// (Détection → Analyse IA → Recommandation → Validation → Correction → Vérification → Résultat).
router.get('/improvements/:id', requireAdmin, async (req, res) => {
  try {
    const row = await prisma.aIImprovement.findUnique({
      where: { id: req.params.id },
      include: { events: { orderBy: { at: 'asc' } } },
    });
    if (!row) return res.status(404).json({ success: false, message: 'Recommandation introuvable' });
    res.json({ success: true, data: { ...row, evidence: row.evidence ? JSON.parse(row.evidence) : null } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});
// GET /api/reassort/corrections - journal unifié des corrections (AI_AUTO + DEV_FIX), demande du
// 17/09/2026 : chaque entrée trace erreur constatée, contexte, cause, correction, fichiers/fonctions
// touchés, tests avant/après, et liens vers l'historique des corrections similaires. Filtrable par
// domaine (capacité IA) et/ou source.
router.get('/corrections', requireAdmin, async (req, res) => {
  try {
    const data = await correctionRecordService.listCorrections({
      domain: req.query.domain || undefined,
      source: req.query.source || undefined,
      limit: req.query.limit ? parseInt(req.query.limit, 10) : undefined,
      cursor: req.query.cursor || undefined,
    });
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/corrections/:id - détail complet d'une correction, y compris les corrections
// similaires passées résolues en objets complets (pas seulement leurs ids) pour affichage direct.
router.get('/corrections/:id', requireAdmin, async (req, res) => {
  try {
    const record = await correctionRecordService.getCorrection(req.params.id);
    if (!record) return res.status(404).json({ success: false, message: 'Correction introuvable' });
    const similar = await Promise.all(
      (record.similarPastCorrectionIds || []).map((id) => correctionRecordService.getCorrection(id)),
    );
    res.json({ success: true, data: { ...record, similarPastCorrections: similar.filter(Boolean) } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/corrections - ajoute une entrée DEV_FIX au journal (correction de code faite en
// développement, ex: par Claude) — saisie manuelle au moment du fix, jamais générée automatiquement
// contrairement aux entrées AI_AUTO (cf. improvementService.js, transition vers IMPROVED).
router.post('/corrections', requireAdmin, async (req, res) => {
  try {
    const { domain, errorObserved, context, rootCause, fixApplied, filesChanged, functionsChanged, testsBefore, testsAfter } = req.body;
    if (!domain || !errorObserved || !context || !rootCause || !fixApplied) {
      return res.status(400).json({ success: false, message: 'domain, errorObserved, context, rootCause et fixApplied sont requis' });
    }
    const record = await correctionRecordService.recordCorrection({
      source: 'DEV_FIX',
      domain, errorObserved, context, rootCause, fixApplied,
      filesChanged, functionsChanged, testsBefore, testsAfter,
      createdBy: (req.user && req.user.email) || 'dev',
    });
    res.json({ success: true, data: record });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/mastery - mémoire de maîtrise par domaine métier (demande du 17/09/2026) :
// niveau de maîtrise/confiance calculé pour chaque capacité IA (stock, sales, orders, accuracy...),
// avec la méthode de calcul explicite (vraie vérité-terrain pour "accuracy", volume/ancienneté des
// corrections pour les autres — cf. aiMasteryService.js).
router.get('/mastery', requireAdmin, async (req, res) => {
  try {
    res.json({ success: true, data: await aiMasteryService.listMastery() });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/mastery/recompute - relance le calcul de tous les domaines à la demande (le
// cron planifié le fait déjà périodiquement, cette route sert au bouton "Recalculer maintenant").
router.post('/mastery/recompute', requireAdmin, async (req, res) => {
  try {
    await aiMasteryService.recomputeAllDomains();
    res.json({ success: true, data: await aiMasteryService.listMastery() });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/autonomy-readiness - palier de préparation à l'autonomie EFFECTIVEMENT tenu
// (avec hystérésis : n'affiche une montée de palier que si elle est confirmée sur plusieurs
// snapshots consécutifs, cf. autonomyReadinessService.js). Indicateur purement consultatif — ne
// déclenche jamais de changement de comportement du système.
router.get('/autonomy-readiness', requireAdmin, async (req, res) => {
  try {
    const data = await autonomyReadinessService.getEffectiveReadiness();
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/autonomy-readiness/history - historique des snapshots calculés (évolution du
// score et du palier dans le temps).
router.get('/autonomy-readiness/history', requireAdmin, async (req, res) => {
  try {
    const data = await autonomyReadinessService.listHistory({ limit: req.query.limit ? parseInt(req.query.limit, 10) : undefined });
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/autonomy-readiness/recompute - calcule un nouveau snapshot à la demande (un
// cron planifié le fera aussi périodiquement une fois en production).
router.post('/autonomy-readiness/recompute', requireAdmin, async (req, res) => {
  try {
    await autonomyReadinessService.computeSnapshot();
    res.json({ success: true, data: await autonomyReadinessService.getEffectiveReadiness() });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/improvements/generate - lance le cycle complet : détection des anomalies
// silencieuses, persistance (dédupliquée), enrichissement IA des priorités, puis évaluation
// d'effet des recommandations précédemment appliquées (boucle d'apprentissage). Le contexte
// Qui/Où (email, IP, version, environnement) est figé sur chaque constat pour traçabilité.
router.post('/improvements/generate', requireAdmin, async (req, res) => {
  try {
    let appVersion = null;
    try { appVersion = require('../../../package.json').version || null; } catch { appVersion = null; }
    const data = await improvementService.generateImprovements({
      actor: (req.user && req.user.email) || 'admin',
      ip: req.ip || null,
      appVersion,
      environment: process.env.NODE_ENV || 'production',
    });
    res.json({ success: true, data });
  } catch (error) {
    console.error('[improvements/generate]', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT /api/reassort/improvements/:id - ajuste la proposition IA (recommandation, reco dev,
// priorité). La proposition de l'IA est modifiable par l'humain avant application ; chaque
// modification est tracée dans la timeline (action EDITED). Interdit sur APPLIED/IMPROVED
// (clôturées : rouvrir d'abord).
router.put('/improvements/:id', requireAdmin, async (req, res) => {
  try {
    const { detail, devRecommendation, priority } = req.body;
    const data = await improvementService.updateImprovement(req.params.id, { detail, devRecommendation, priority }, {
      actor: (req.user && req.user.email) || 'admin',
    });
    res.json({ success: true, data });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
});
// POST /api/reassort/improvements/:id/status - { status, note? } : l'humain reste décisionnaire.
// Statuts : IN_PROGRESS (en cours), TO_VERIFY (à vérifier), APPLIED (appliqué + note de ce qui
// a réellement été fait), DISMISSED (ignoré + motif obligatoire), PROPOSED (rouvrir).
// IMPROVED/NO_EFFECT sont posés par le système seul (évaluation), jamais à la main.
// Chaque transition est tracée (acteur, note) dans la timeline — rien ne disparaît.
router.post('/improvements/:id/status', requireAdmin, async (req, res) => {
  try {
    const { status, note } = req.body;
    const data = await improvementService.setImprovementStatus(req.params.id, status, {
      actor: (req.user && req.user.email) || 'admin',
      note: (note || '').slice(0, 2000) || null,
    });
    res.json({ success: true, data });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
});

module.exports = router;
module.exports = router;
