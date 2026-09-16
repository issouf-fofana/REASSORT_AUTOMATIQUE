// Sous-routeur 'proposals' — Generation, consultation, validation et envoi des propositions de reassort.
// Monte dans routes/reassort/index.js sous le prefixe /api/reassort (requireAuth +
// requireSupervisedShop appliques la-bas, pas ici). Ne jamais monter ailleurs.
const express = require('express');
const router = express.Router();
const { resolveShopId, resolvePosId } = require('../../middleware/auth');
const prisma = require('../../utils/prisma');
const rpos = require('../../services/rposClient');
const {
  generateProposal,
  generateAndSaveProposal,
  getPendingProposal,
  startProposalValidation,
  getProposalStatus,
} = require('../../services/proposalService');
const { getWeeklyPlanHistory, findWeeklyPlanForDate } = require('../../services/weeklyPlanService');
const { getConfig } = require('../../services/configService');
const { resolvePeriod } = require('../../services/periodService');
const { filterProposalLinesForUser, DEPARTMENT_SCOPED_ROLES } = require('../../services/aiPermissionsService');
const { mapWithConcurrency } = require('../../utils/concurrency');

router.get('/proposal', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    const posId = resolvePosId(req);
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : undefined;

    if (!shopId || !posId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }

    const shopReference = req.user.rposShopReference || req.query.shopReference;
    const result = await generateProposal(posId, shopId, limit, shopReference);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Proposal generation error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/create-order - transmet une commande ad hoc vers RPOS (mode manuel, hors historisation)
// body: { supplierId, externalReference, comment, lines: [{ productId, quantity }] }
router.post('/create-order', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    const posId = resolvePosId(req);
    const { supplierId, orderDate, deliveryDate, externalReference, comment, lines } = req.body;

    if (!shopId || !posId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }
    // Commande manuelle non liée à une proposition (donc jamais filtrable par département) : un
    // rôle borné à un rayon ne doit pas pouvoir passer commande sur des produits arbitraires du
    // magasin entier via cette route (faille trouvée le 16/09/2026, audit "test tout ce qu'un
    // Rayonniste ne devrait pas pouvoir faire" — endroit sans appelant frontend actuellement, mais
    // atteignable par tout compte authentifié en appel HTTP direct).
    if (DEPARTMENT_SCOPED_ROLES.has(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Cette action n\'est pas autorisée pour votre rôle.' });
    }
    if (!supplierId || !Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({ success: false, message: 'supplierId et lines sont requis' });
    }

    const now = new Date();
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const order = await rpos.createSupplierOrder(posId, {
      shopId,
      supplierId,
      date: orderDate || now.toISOString().slice(0, 19),
      deliveryDate: deliveryDate || tomorrow.toISOString().slice(0, 10),
      externalReference: externalReference || 'Proposition réassort IA',
      comment: comment || `Commande générée automatiquement par le système de réassort (${req.user.name})`,
    });

    // Envoi des lignes par lots parallèles plutôt qu'une par une (audit performance : bloquait la
    // réponse HTTP plusieurs minutes sur une grosse commande) — concurrence modérée pour rester
    // raisonnable sur les écritures concurrentes d'une même commande fournisseur côté RPOS.
    const createdLines = [];
    const failedLines = [];
    const LINE_CONCURRENCY = 5;
    await mapWithConcurrency(lines, LINE_CONCURRENCY, async (line) => {
      try {
        const created = await rpos.addSupplierOrderLine(posId, {
          orderId: order.id,
          productId: line.productId,
          quantity: line.quantity,
          orderingUnit: line.orderingUnit,
        });
        createdLines.push(created);
      } catch (err) {
        failedLines.push({ productId: line.productId, error: err.body || err.message });
      }
    });

    res.status(201).json({
      success: true,
      data: {
        order,
        linesCreated: createdLines.length,
        linesFailed: failedLines.length,
        failedLines,
      },
    });
  } catch (error) {
    console.error('Create order error:', error);
    res.status(502).json({ success: false, message: error.message, details: error.body });
  }
});

// --- Flux historisé (phase pilote) ---

// GET /api/reassort/proposal/generate/preview-period?periodMode=&customStart=&customEnd= - calcule
// et renvoie les dates exactes (début/fin) qui seraient utilisées pour une génération, SANS lancer
// quoi que ce soit — pour que l'utilisateur voie concrètement quel intervalle sera analysé avant de
// confirmer (le mode par défaut ne dit pas la date réelle, calculée à partir de la dernière vente
// RÉELLE du magasin via RPOS, pas de la date système). periodMode vide = période configurée du
// magasin (comportement par défaut au lancement réel).
router.get('/proposal/generate/preview-period', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    const posId = resolvePosId(req);
    if (!shopId || !posId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }

    const baseConfig = await getConfig(shopId);
    const { periodMode, customStart, customEnd } = req.query;
    const config = periodMode
      ? { ...baseConfig, periodMode, customStart: customStart || null, customEnd: customEnd || null }
      : baseConfig;

    const period = await resolvePeriod(posId, shopId, config);

    // Couverture locale réelle sur cette période (avant même de lancer quoi que ce soit) : permet
    // d'avertir l'utilisateur dans CE modal de confirmation si la base n'a pas encore toutes les
    // données de la période choisie, plutôt que de le découvrir après coup dans le bandeau de
    // résultat une fois la génération faite — bug constaté où une génération tournait
    // silencieusement sur des données partielles sans que rien ne le signale avant de lancer.
    const [earliestLocal, latestLocal] = await Promise.all([
      prisma.salesLine.findFirst({ where: { rposShopId: shopId, date: { gte: new Date(period.start), lt: new Date(period.end) } }, orderBy: { date: 'asc' }, select: { date: true } }),
      prisma.salesLine.findFirst({ where: { rposShopId: shopId, date: { gte: new Date(period.start), lt: new Date(period.end) } }, orderBy: { date: 'desc' }, select: { date: true } }),
    ]);

    let coverageWarning = null;
    if (!earliestLocal) {
      coverageWarning = { type: 'NO_DATA', message: 'Aucune donnée locale pour cette période — la génération devra tout récupérer depuis RPOS en direct (peut prendre plusieurs minutes).' };
    } else {
      const gapStartHours = (earliestLocal.date.getTime() - new Date(period.start).getTime()) / (60 * 60 * 1000);
      const gapEndHours = (new Date(period.end).getTime() - latestLocal.date.getTime()) / (60 * 60 * 1000);
      if (gapStartHours > 24) {
        coverageWarning = {
          type: 'PARTIAL_START',
          message: `Les données locales de ce magasin ne remontent qu'au ${earliestLocal.date.toLocaleDateString('fr-FR')} — ${Math.round(gapStartHours / 24)} jour(s) de début de période manquant(s). La génération complétera automatiquement via RPOS, mais cela peut ralentir le calcul.`,
        };
      } else if (gapEndHours > 24) {
        coverageWarning = {
          type: 'PARTIAL_END',
          message: `Les données locales de ce magasin s'arrêtent au ${latestLocal.date.toLocaleDateString('fr-FR')} — ${Math.round(gapEndHours / 24)} jour(s) de fin de période manquant(s) (synchro pas encore à jour).`,
        };
      }
    }

    res.json({ success: true, data: { ...period, coverageWarning } });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/proposal/generate?limit=<n> - génère et sauvegarde une proposition, à la
// demande. Ouvert aux comptes STORE (pour leur propre magasin) et ADMIN (avec ?shop=&pos=).
// Rejette l'ancienne proposition GENERATED du magasin si elle n'a pas encore été validée.
// Répond immédiatement avec un runId à suivre via GET /proposal/generate/:runId/status, au lieu de
// bloquer la requête HTTP jusqu'à la fin (jusqu'à plusieurs minutes sur un gros magasin avec appel
// RPOS) — même principe que /proposal/:id/validate, pour permettre une vraie barre de progression
// (étape en cours, X/Y articles traités, dernier article traité) plutôt qu'un déroulé simulé.
router.post('/proposal/generate', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    const posId = resolvePosId(req);
    const limit = req.body.limit ? parseInt(req.body.limit, 10) : undefined;

    if (!shopId || !posId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }

    const shopReference = req.user.rposShopReference || req.body.shopReference;
    const shopName = req.user.rposShopName || req.body.shopName;

    if (!shopReference || !shopName) {
      return res.status(400).json({ success: false, message: 'Référence et nom du magasin requis (shopReference, shopName)' });
    }

    // Override ponctuel de la période d'analyse pour cette seule génération (n'affecte jamais la
    // configuration permanente du magasin) : { periodMode, customStart, customEnd }.
    const periodOverride = req.body.periodOverride || undefined;

    const run = await prisma.proposalGenerationRun.create({
      data: { rposShopId: shopId, status: 'RUNNING', step: 'SALES' },
    });

    res.status(202).json({ success: true, data: { runId: run.id } });

    // Tâche de fond : la réponse HTTP est déjà partie, toute erreur ici est capturée et écrite sur
    // le run (jamais renvoyée au client via cette requête, qui a déjà répondu).
    (async () => {
      try {
        const onProgress = async (p) => {
          await prisma.proposalGenerationRun.update({
            where: { id: run.id },
            data: {
              step: p.step,
              ...(p.articlesTotal !== undefined ? { articlesTotal: p.articlesTotal } : {}),
              ...(p.articlesProcessed !== undefined ? { articlesProcessed: p.articlesProcessed } : {}),
              ...(p.lastArticleEan !== undefined ? { lastArticleEan: p.lastArticleEan } : {}),
              ...(p.lastArticleLabel !== undefined ? { lastArticleLabel: p.lastArticleLabel } : {}),
              ...(p.aiUnavailable !== undefined ? { aiUnavailable: p.aiUnavailable } : {}),
              ...(p.aiArticlesAdjusted !== undefined ? { aiArticlesAdjusted: p.aiArticlesAdjusted } : {}),
              ...(p.aiErrorMessage !== undefined ? { aiErrorMessage: p.aiErrorMessage } : {}),
            },
          }).catch(() => {}); // une mise à jour de progression manquée ne doit jamais interrompre la génération elle-même
        };

        const { proposal, weeklyPlanAttached } = await generateAndSaveProposal({ posId, shopId, shopReference, shopName, limit, periodOverride, onProgress });
        if (!weeklyPlanAttached) {
          console.warn(`[proposal/generate] ALERTE ${shopReference} : proposition ${proposal.id} sans plan hebdomadaire (prédictions non évaluables).`);
        }

        await prisma.proposalGenerationRun.update({
          where: { id: run.id },
          data: { status: 'DONE', step: 'DONE', proposalId: proposal.id, completedAt: new Date() },
        });
      } catch (error) {
        console.error('Proposal generate+save error:', error);
        await prisma.proposalGenerationRun.update({
          where: { id: run.id },
          data: { status: 'ERROR', errorMessage: error.message, completedAt: new Date() },
        }).catch(() => {});
      }
    })();
  } catch (error) {
    console.error('Proposal generate start error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/proposal/generate/active?shop=... - le run de génération EN COURS pour ce
// magasin, s'il y en a un (RUNNING). Permet de retrouver une génération lancée puis dont le modal a
// été fermé (ou la page quittée/rechargée) sans l'annuler : la tâche de fond continue indépendamment
// du frontend, ce endpoint sert juste à savoir "est-ce qu'il y a quelque chose en cours ?" pour
// pouvoir rouvrir le suivi de progression.
router.get('/proposal/generate/active', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    if (!shopId) return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });

    const run = await prisma.proposalGenerationRun.findFirst({
      where: { rposShopId: shopId, status: 'RUNNING' },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, data: run ? { runId: run.id } : null });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/proposal/generate/:runId/status - progression d'une génération en cours
// (polling, cf. commentaire ci-dessus). Répond aussi le contenu complet de la proposition une fois
// DONE (proposal + stats), pour éviter un second aller-retour au frontend une fois terminé.
router.get('/proposal/generate/:runId/status', async (req, res) => {
  try {
    const run = await prisma.proposalGenerationRun.findUnique({ where: { id: req.params.runId } });
    if (!run) return res.status(404).json({ success: false, message: 'Génération introuvable' });

    const shopId = resolveShopId(req);
    if (shopId && run.rposShopId !== shopId) {
      return res.status(403).json({ success: false, message: 'Cette génération n\'appartient pas à votre magasin' });
    }

    let proposal = null;
    if (run.status === 'DONE' && run.proposalId) {
      proposal = await prisma.proposal.findUnique({ where: { id: run.proposalId }, include: { lines: true } });
    }

    res.json({
      success: true,
      data: {
        status: run.status,
        step: run.step,
        articlesTotal: run.articlesTotal,
        articlesProcessed: run.articlesProcessed,
        lastArticleEan: run.lastArticleEan,
        lastArticleLabel: run.lastArticleLabel,
        errorMessage: run.errorMessage,
        aiUnavailable: run.aiUnavailable,
        aiArticlesAdjusted: run.aiArticlesAdjusted,
        aiErrorMessage: run.aiErrorMessage,
        proposal,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/proposal/pending - la proposition du jour en attente de validation pour le magasin de l'utilisateur
router.get('/proposal/pending', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    if (!shopId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }

    const proposal = await getPendingProposal(shopId);
    // Rayonniste/Chef de département (plan de rôles validé le 15/09/2026, étape 3) : ne voient que
    // les lignes de leur département/rayon assigné, jamais les autres rayons du même magasin —
    // no-op pour tout autre rôle (cf. filterProposalLinesForUser). assignedDepartment n'est jamais
    // dans le JWT (comme supervisedShops, cf. auth.js) : relu en base pour rester à jour même si
    // modifié après la connexion, sans attendre l'expiration du token.
    if (proposal) {
      const currentUser = await prisma.user.findUnique({ where: { id: req.user.id } });
      proposal.lines = filterProposalLinesForUser(proposal.lines, currentUser);
    }
    res.json({ success: true, data: proposal });
  } catch (error) {
    console.error('Pending proposal error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/proposal/history?shop=... - liste des générations passées d'un magasin (les
// plus récentes en premier), pour permettre de revenir consulter une proposition qui n'est plus
// "GENERATED" (déjà validée ou remplacée par une génération plus récente — REJECTED) : jusqu'ici
// purchase-order.html n'affichait plus rien dès qu'une proposition sortait du statut GENERATED,
// sans aucun moyen de la revoir.
router.get('/proposal/history', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    if (!shopId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }
    const proposals = await prisma.proposal.findMany({
      where: { rposShopId: shopId },
      orderBy: { generatedAt: 'desc' },
      take: 30,
      select: { id: true, generatedAt: true, status: true },
    });
    res.json({ success: true, data: proposals });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/proposal/:id - une proposition précise par id, quel que soit son statut
// (GENERATED, REJECTED, VALIDATED...), avec ses lignes complètes — même format que
// GET /proposal/pending, pour réutiliser exactement le même rendu côté frontend.
router.get('/proposal/:id', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    const proposal = await prisma.proposal.findUnique({ where: { id: req.params.id }, include: { lines: true } });
    if (!proposal) return res.status(404).json({ success: false, message: 'Proposition introuvable' });
    if (shopId && proposal.rposShopId !== shopId) {
      return res.status(403).json({ success: false, message: 'Cette proposition n\'appartient pas à votre magasin' });
    }
    // Même restriction par département/rayon que GET /proposal/pending (plan de rôles, étape 3).
    const currentUser = await prisma.user.findUnique({ where: { id: req.user.id } });
    proposal.lines = filterProposalLinesForUser(proposal.lines, currentUser);
    res.json({ success: true, data: proposal });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/proposal/:id/validate - démarre la validation (envoi vers RPOS en tâche de fond)
// body: { supplierId, externalReference, comment, orderDate, deliveryDate, decisions: [{ lineId, quantity, excluded }],
//         validateAfterCreate }
// validateAfterCreate=false (par défaut) : la commande reste "en préparation" sur RPOS, non prise en
// compte par l'entrepôt (utile en phase de test). true : la commande est en plus validée sur RPOS.
// Répond immédiatement avec status "VALIDATING" ; suivre la progression via GET .../status
router.post('/proposal/:id/validate', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    const posId = resolvePosId(req);
    const { supplierId, orderDate, deliveryDate, externalReference, comment, decisions, validateAfterCreate } = req.body;

    if (!shopId || !posId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }
    if (!supplierId || !Array.isArray(decisions)) {
      return res.status(400).json({ success: false, message: 'supplierId et decisions sont requis' });
    }

    // Rayonniste/Chef de département (plan de rôles, étape 3) : ne peuvent valider QUE les lignes de
    // leur périmètre. startProposalValidation traite TOUTES les lignes de la proposition (decisions
    // ne fait qu'ajuster/exclure des lignes déjà connues, jamais en restreindre la liste elle-même,
    // cf. proposalService.js) — sans ce filtre, un compte restreint pourrait valider une commande
    // portant sur des rayons entiers hors de son périmètre malgré une UI qui ne lui en montre qu'un.
    const currentUser = await prisma.user.findUnique({ where: { id: req.user.id } });
    let allowedLineIds = null;
    if (currentUser && DEPARTMENT_SCOPED_ROLES.has(currentUser.role)) {
      const scopedProposal = await prisma.proposal.findUnique({ where: { id: req.params.id }, select: { lines: { select: { id: true, department: true } } } });
      const allowedLines = filterProposalLinesForUser(scopedProposal?.lines || [], currentUser);
      allowedLineIds = new Set(allowedLines.map((l) => l.id));
    }
    if (allowedLineIds) {
      // Toute ligne hors périmètre est forcée à "exclue", quoi que le client ait envoyé dans
      // decisions pour cette ligne (jamais faire confiance à l'input client pour une restriction de
      // sécurité).
      for (const line of (await prisma.proposalLine.findMany({ where: { proposalId: req.params.id }, select: { id: true } }))) {
        if (!allowedLineIds.has(line.id)) {
          const idx = decisions.findIndex((d) => d.lineId === line.id);
          // outOfScope=true : cette exclusion vient du filtrage de sécurité, pas d'un rejet métier
          // volontaire — distinction nécessaire pour ne pas fausser le KPI de taux de rejet (§23).
          if (idx >= 0) decisions[idx] = { ...decisions[idx], excluded: true, outOfScope: true };
          else decisions.push({ lineId: line.id, excluded: true, outOfScope: true });
        }
      }
    }

    const result = await startProposalValidation({
      proposalId: req.params.id,
      posId,
      shopId,
      userEmail: req.user.email,
      decisions,
      orderHeader: { supplierId, orderDate, deliveryDate, externalReference, comment },
      validateAfterCreate: !!validateAfterCreate,
    });

    res.status(202).json({ success: true, data: result });
  } catch (error) {
    console.error('Start validation error:', error);
    res.status(400).json({ success: false, message: error.message, details: error.body });
  }
});

// GET /api/reassort/proposal/:id/status - progression de l'envoi vers RPOS
router.get('/proposal/:id/status', async (req, res) => {
  try {
    const status = await getProposalStatus(req.params.id);
    if (!status) return res.status(404).json({ success: false, message: 'Proposition introuvable' });
    res.json({ success: true, data: status });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/proposal/:id/excluded?reason=... - détail des articles exclus d'une catégorie
// (carte "Reste du CA magasin"), triés par part de CA magasin décroissante.
router.get('/proposal/:id/excluded', async (req, res) => {
  try {
    const { reason } = req.query;
    const where = { proposalId: req.params.id };
    if (reason) where.reason = reason;
    const items = await prisma.excludedArticle.findMany({
      where,
      orderBy: { revenueSharePct: 'desc' },
    });
    res.json({ success: true, data: items });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/weekly-plan/current?shop=... - plan hebdomadaire actif du magasin pour la
// semaine en cours (CAHIER_DES_CHARGES.md §11-13, étape 2).
router.get('/weekly-plan/current', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    if (!shopId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }
    const plan = await findWeeklyPlanForDate(shopId);
    if (!plan) return res.json({ success: true, data: null });
    const history = await getWeeklyPlanHistory(plan.id);
    res.json({ success: true, data: history });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/weekly-plan/:id/history - historique des révisions d'un plan donné, avec
// l'évolution de la quantité proposée par article entre révisions.
router.get('/weekly-plan/:id/history', async (req, res) => {
  try {
    const history = await getWeeklyPlanHistory(req.params.id);
    if (!history) return res.status(404).json({ success: false, message: 'Plan hebdomadaire introuvable' });
    res.json({ success: true, data: history });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/predictions/proposals - liste des propositions du magasin courant (les plus
// récentes en premier), pour alimenter le sélecteur de la page "IA & Prédictions" : permet de
// consulter les prédictions d'une génération passée, pas seulement la toute dernière.
module.exports = router;
