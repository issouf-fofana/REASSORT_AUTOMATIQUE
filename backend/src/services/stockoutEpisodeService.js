/**
 * Détection et diagnostic des épisodes de rupture de stock, SANS les données Cyrus (entrepôt) —
 * cf. rupture.md. Le diagnostic est donc une version simplifiée de la grille §5 du document : on ne
 * peut pas distinguer "stock central indisponible" / "non préparé" / "retard transport", ces 3 cas
 * retombent tous sur AMONT_A_PRECISER.
 */
const prisma = require('../utils/prisma');
const { getMovesFromLocal } = require('./stockMoveAnalysisService');
const rpos = require('./rposClient');
const systemConfig = require('./systemConfigService');

/**
 * Seuils de délai (commande attendue / livraison max) utilisés par reactionStatus — configurables
 * depuis Paramètres (demande explicite du 17/10/2026 : "le delai max de livrason doit etre 48h mais
 * il faut rendre ca modifiable sur les parametre"), 24h/48h par défaut si jamais réglés.
 */
async function getReactionDeadlines() {
  const [reaction, delivery] = await Promise.all([
    systemConfig.getValue(systemConfig.KEYS.STOCKOUT_REACTION_DEADLINE_HOURS),
    systemConfig.getValue(systemConfig.KEYS.STOCKOUT_DELIVERY_DEADLINE_HOURS),
  ]);
  return {
    reactionDeadlineHours: parseFloat(reaction) || 24,
    deliveryDeadlineHours: parseFloat(delivery) || 48,
  };
}

const LOOKBACK_WEEKS = 8;
const MIN_COMPARABLE_WEEKS = 4; // sous ce seuil, estimation trop fragile pour être affichée

/**
 * Ouvre un nouvel épisode pour chaque article passé de stock>0 à stock<=0 depuis le dernier
 * snapshot, et referme (status=RESOLUE) les épisodes EN_COURS dont le stock est redevenu positif.
 * Appelée après chaque capture de snapshot (cf. stockSnapshotJob.js).
 */
async function detectStockoutEpisodes(rposShopId) {
  const openEpisodes = await prisma.stockoutEpisode.findMany({
    where: { rposShopId, status: 'EN_COURS' },
  });
  const openByEan = new Map(openEpisodes.map((e) => [e.ean, e]));

  const latestSnapshots = await prisma.stockSnapshot.findMany({
    where: { rposShopId },
    orderBy: { capturedAt: 'desc' },
    distinct: ['ean'],
  });

  for (const snap of latestSnapshots) {
    const open = openByEan.get(snap.ean);

    if (snap.stock <= 0 && !open) {
      const diagnosis = await diagnoseCause(rposShopId, snap.ean);
      await prisma.stockoutEpisode.create({
        data: {
          rposPosId: snap.rposPosId,
          rposShopId,
          ean: snap.ean,
          label: diagnosis.label || null,
          department: diagnosis.department || null,
          sector: diagnosis.sector || null,
          startedAt: snap.capturedAt,
          status: 'EN_COURS',
          causeProposee: diagnosis.cause,
          niveauConfiance: diagnosis.confiance,
          commandeRefUtile: diagnosis.commandeRef || null,
        },
      });
    } else if (snap.stock > 0 && open) {
      const estimation = await estimateLoss(rposShopId, open.ean, open.startedAt, snap.capturedAt);
      await prisma.stockoutEpisode.update({
        where: { id: open.id },
        data: {
          status: 'RESOLUE',
          endedAt: snap.capturedAt,
          qtyPerdueEstimee: estimation.qtyPerdue,
          caPerdueEstime: estimation.caPerdue,
        },
      });
    }
  }
}

/**
 * Diagnostic simplifié (sans Cyrus) : on regarde uniquement si une commande récente couvrant cet
 * article existe, et à quel stade de receptionStatus elle est. Prend la ProposalLine la plus récente
 * pour (shop, ean) comme point d'entrée, puis cherche le ProposalOrder correspondant (même
 * proposalId + department).
 */
async function diagnoseCause(rposShopId, ean) {
  const recentLine = await prisma.proposalLine.findFirst({
    where: { ean, proposal: { rposShopId } },
    orderBy: { proposal: { generatedAt: 'desc' } },
    include: { proposal: true },
  });

  const label = recentLine?.label || null;
  const department = recentLine?.department || null;
  const sector = recentLine?.sector || null;

  if (!recentLine) {
    return { cause: 'MAGASIN_REASSORT', confiance: 'PROBABLE', label, department, sector };
  }

  const order = await prisma.proposalOrder.findFirst({
    where: { proposalId: recentLine.proposalId, department: recentLine.department || undefined },
    orderBy: { createdAt: 'desc' },
  });

  if (!order) {
    return { cause: 'MAGASIN_REASSORT', confiance: 'PROBABLE', label, department, sector };
  }

  if (order.rposOrderValidated === false || order.status === 'PENDING') {
    return { cause: 'MAGASIN_COMMANDE_NON_VALIDEE', confiance: 'CONFIRMEE', commandeRef: order.id, label, department, sector };
  }

  if (order.receptionStatus === 'EN_ATTENTE_RECEPTION') {
    return { cause: 'AMONT_A_PRECISER', confiance: 'PROBABLE', commandeRef: order.id, label, department, sector };
  }

  if (order.receptionStatus === 'RECUE_ESTIMEE') {
    return { cause: 'ECART_STOCK_RAYON', confiance: 'PROBABLE', commandeRef: order.id, label, department, sector };
  }

  return { cause: 'INDETERMINEE', confiance: 'INDETERMINEE', commandeRef: order.id, label, department, sector };
}

/**
 * Vente moyenne attendue par jour pour un article, sur les mêmes jours de semaine que `referenceDate`
 * parmi les LOOKBACK_WEEKS semaines précédentes — factorisé entre estimateLoss (perte pendant la
 * rupture) et estimateDemand (besoin couvert par une commande) pour ne pas dupliquer cette logique.
 * null si l'historique comparable est trop court (MIN_COMPARABLE_WEEKS) pour être fiable.
 */
async function getAvgDailyDemand(rposShopId, ean, referenceDate) {
  const lookbackStart = new Date(referenceDate.getTime() - LOOKBACK_WEEKS * 7 * 24 * 60 * 60 * 1000);
  const comparableSales = await prisma.salesLine.findMany({
    where: { rposShopId, ean, date: { gte: lookbackStart, lt: referenceDate } },
    select: { date: true, quantity: true, revenueExclTax: true },
  });

  const targetDow = referenceDate.getDay();
  const sameDowSales = comparableSales.filter((s) => s.date.getDay() === targetDow);
  const comparableWeeksCount = new Set(sameDowSales.map((s) => s.date.toISOString().slice(0, 10))).size;

  if (comparableWeeksCount < MIN_COMPARABLE_WEEKS) return null;

  return {
    avgDailyQty: sameDowSales.reduce((sum, s) => sum + s.quantity, 0) / comparableWeeksCount,
    avgDailyRevenue: sameDowSales.reduce((sum, s) => sum + s.revenueExclTax, 0) / comparableWeeksCount,
  };
}

/**
 * Quantité/CA perdus estimés = ventes attendues (moyenne du même jour de semaine sur les
 * LOOKBACK_WEEKS précédentes, hors période de rupture) moins ventes réellement réalisées pendant la
 * rupture. Cf. rupture.md §2.4.
 */
async function estimateLoss(rposShopId, ean, startedAt, endedAt) {
  const durationMs = endedAt.getTime() - startedAt.getTime();
  const durationDays = Math.max(1, Math.ceil(durationMs / (24 * 60 * 60 * 1000)));

  const demand = await getAvgDailyDemand(rposShopId, ean, startedAt);
  if (!demand) return { qtyPerdue: null, caPerdue: null };

  const expectedQty = demand.avgDailyQty * durationDays;
  const expectedRevenue = demand.avgDailyRevenue * durationDays;

  const actualSales = await prisma.salesLine.aggregate({
    where: { rposShopId, ean, date: { gte: startedAt, lte: endedAt } },
    _sum: { quantity: true, revenueExclTax: true },
  });
  const actualQty = actualSales._sum.quantity || 0;
  const actualRevenue = actualSales._sum.revenueExclTax || 0;

  const qtyPerdue = Math.max(0, expectedQty - actualQty);
  const caPerdue = Math.max(0, expectedRevenue - actualRevenue);

  return { qtyPerdue, caPerdue };
}

/**
 * Demande attendue (en quantité) sur `coverageDays` jours à partir de `fromDate` — utilisé pour
 * juger si une quantité commandée était suffisante pour couvrir le magasin jusqu'à la livraison
 * (demande explicite : "déterminer si la quantité commandée était suffisante pour couvrir les
 * besoins du magasin jusqu'à la livraison"). null si l'historique comparable est insuffisant.
 */
async function estimateDemand(rposShopId, ean, fromDate, coverageDays) {
  const demand = await getAvgDailyDemand(rposShopId, ean, fromDate);
  if (!demand) return null;
  return demand.avgDailyQty * coverageDays;
}

/**
 * Liste les épisodes en cours d'un magasin, pour le dashboard. durationHours calculé à la volée
 * (pas stocké, puisque l'épisode est toujours ouvert).
 *
 * Enrichi le 17/10/2026 (demande explicite : "on doit voir... qui son en rupture et qui on une
 * commande qui a ete passe dessu et ceux qui son en rupture et il ya pas de commande dessu") avec
 * hasOrder + reactionStatus (version LÉGÈRE, sans appel RPOS ni recalcul de perte — juste "une
 * commande a-t-elle été créée depuis le début de CET épisode ?", en masse pour tout le magasin en 2
 * requêtes plutôt qu'une par article comme getEpisodeDetail, potentiellement des centaines
 * d'articles en rupture sur un même rayon).
 */
async function getOpenEpisodes(rposShopId) {
  const episodes = await prisma.stockoutEpisode.findMany({
    where: { rposShopId, status: 'EN_COURS' },
    orderBy: { startedAt: 'asc' },
  });
  if (!episodes.length) return [];

  const { reactionDeadlineHours, deliveryDeadlineHours } = await getReactionDeadlines();
  const now = new Date();
  const eans = [...new Set(episodes.map((e) => e.ean))];
  const earliestStart = episodes.reduce((min, e) => (e.startedAt < min ? e.startedAt : min), episodes[0].startedAt);

  // Toutes les lignes de proposition + commandes potentiellement pertinentes pour CES articles
  // depuis le début de rupture le plus ancien du lot — un seul aller-retour DB, le matching précis
  // par épisode (seuil de date propre à chaque startedAt) se fait ensuite en mémoire.
  const lines = await prisma.proposalLine.findMany({
    where: { ean: { in: eans }, proposal: { rposShopId, generatedAt: { gte: earliestStart } } },
    select: { ean: true, department: true, proposalId: true, proposal: { select: { generatedAt: true } } },
  });
  const proposalIds = [...new Set(lines.map((l) => l.proposalId))];
  const orders = proposalIds.length
    ? await prisma.proposalOrder.findMany({
        where: { proposalId: { in: proposalIds }, createdAt: { gte: earliestStart } },
        select: { proposalId: true, department: true, createdAt: true, receptionStatus: true, actualReceptionDate: true },
      })
    : [];

  // Index proposalId+department -> commandes (triées, la plus ancienne en premier) pour un lookup
  // O(1) par ligne plutôt qu'un .find() recalculé à chaque épisode.
  const ordersByKey = new Map();
  for (const o of orders) {
    const key = `${o.proposalId}::${o.department || ''}`;
    if (!ordersByKey.has(key)) ordersByKey.set(key, []);
    ordersByKey.get(key).push(o);
  }
  for (const list of ordersByKey.values()) list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const linesByEan = new Map();
  for (const l of lines) {
    if (!linesByEan.has(l.ean)) linesByEan.set(l.ean, []);
    linesByEan.get(l.ean).push(l);
  }
  for (const list of linesByEan.values()) list.sort((a, b) => a.proposal.generatedAt.getTime() - b.proposal.generatedAt.getTime());

  return episodes.map((e) => {
    const durationHours = Math.round(((now.getTime() - e.startedAt.getTime()) / (60 * 60 * 1000)) * 10) / 10;

    let orderCreatedAt = null;
    let matchedOrder = null;
    for (const line of linesByEan.get(e.ean) || []) {
      if (line.proposal.generatedAt < e.startedAt) continue;
      const key = `${line.proposalId}::${line.department || ''}`;
      const candidate = (ordersByKey.get(key) || []).find((o) => o.createdAt >= e.startedAt);
      if (candidate) { orderCreatedAt = candidate.createdAt; matchedOrder = candidate; break; }
    }

    const hasOrder = orderCreatedAt !== null;
    let reactionStatus;
    if (hasOrder) reactionStatus = 'REAGI';
    else if (durationHours > deliveryDeadlineHours) reactionStatus = 'MAGASIN_NA_PAS_REAGI';
    else if (durationHours > reactionDeadlineHours) reactionStatus = 'RETARD';
    else reactionStatus = 'EN_ATTENTE';

    // Statut de livraison, distinct de reactionStatus (demande explicite du 17/10/2026 : "l'autre ou
    // ya commande mais pas encore livré ou il ya pas encore arrivage sur rpos pour metre a jour le
    // stock") — SANS_COMMANDE / EN_ATTENTE_LIVRAISON (commande passée, receptionStatus pas encore
    // RECUE_ESTIMEE) / LIVREE (receptionStatus RECUE_ESTIMEE, cf. le commentaire sur ce champ dans
    // schema.prisma : c'est une ESTIMATION basée sur le délai configuré, jamais une confirmation
    // RPOS certaine — présenté comme tel, pas comme une preuve de réception).
    let deliveryStatus = 'SANS_COMMANDE';
    if (hasOrder) {
      deliveryStatus = matchedOrder.receptionStatus === 'RECUE_ESTIMEE' ? 'LIVREE' : 'EN_ATTENTE_LIVRAISON';
    }

    // startedAt/orderCreatedAt renvoyés en plus de durationHours (déjà calculé côté serveur) pour
    // que le frontend puisse faire tourner un vrai chronomètre live (demande explicite du
    // 17/10/2026 : "le user doit voir compté... le compteur de rupture avant commande continue
    // toujour de compté") plutôt qu'une valeur figée au chargement de la page.
    return {
      ...e,
      durationHours,
      hasOrder,
      reactionStatus,
      orderCreatedAt,
      deliveryStatus,
      actualReceptionDate: matchedOrder?.actualReceptionDate ?? null,
    };
  });
}

/**
 * Vue d'ensemble pour les KPI du dashboard : nombre de ruptures en cours, durée moyenne, CA perdu
 * cumulé sur les épisodes résolus récemment, répartition des causes.
 */
async function getDashboardSummary(rposShopId, { resolvedLookbackDays = 30 } = {}) {
  const [openEpisodes, resolvedEpisodes] = await Promise.all([
    getOpenEpisodes(rposShopId),
    prisma.stockoutEpisode.findMany({
      where: {
        rposShopId,
        status: 'RESOLUE',
        endedAt: { gte: new Date(Date.now() - resolvedLookbackDays * 24 * 60 * 60 * 1000) },
      },
    }),
  ]);

  const avgDurationHours = openEpisodes.length
    ? openEpisodes.reduce((sum, e) => sum + e.durationHours, 0) / openEpisodes.length
    : 0;

  // caPerdueEstime est désormais TOUJOURS lu depuis la valeur stockée, jamais recalculé ici (bug de
  // performance trouvé le 17/10/2026 : recalculer estimateLoss() pour chaque épisode EN_COURS à
  // chaque chargement de page prenait ~3s avec plusieurs centaines de ruptures ouvertes — demande
  // explicite : "les calcule de perte... doit etre fait au prealable... comme la vue de proposition
  // de commande"). Un job dédié (stockoutLossRecalcJob.js, toutes les heures) maintient ce champ à
  // jour pour les épisodes EN_COURS — avant son premier passage sur un épisode tout juste détecté,
  // la valeur reste simplement null (page "estimation indisponible", pas une erreur).
  const totalCaPerdu = [...openEpisodes, ...resolvedEpisodes].reduce((sum, e) => sum + (e.caPerdueEstime || 0), 0);

  const causeCounts = {};
  for (const e of [...openEpisodes, ...resolvedEpisodes]) {
    causeCounts[e.causeProposee] = (causeCounts[e.causeProposee] || 0) + 1;
  }

  return {
    openCount: openEpisodes.length,
    avgDurationHours: Math.round(avgDurationHours * 10) / 10,
    totalCaPerduEstime: Math.round(totalCaPerdu),
    causeCounts,
    openEpisodes,
  };
}

// Seuil "rupture longue" par défaut, cf. spec §2 "Nombre de ruptures qui dépassent un seuil de
// durée défini" — pas de configuration dédiée pour l'instant (vague 1 : vue réseau), valeur fixe
// raisonnable reprise s'il faut la rendre réglable plus tard.
const LONG_EPISODE_HOURS = 48;

// Causes qui indiquent qu'AUCUNE commande n'a été identifiée pour expliquer la rupture (spec §2 :
// "Nombre de ruptures sans commande de réapprovisionnement identifiée") — distinct de
// MAGASIN_COMMANDE_NON_VALIDEE, où une commande EXISTE mais n'a pas été validée.
const NO_ORDER_CAUSES = new Set(['MAGASIN_REASSORT', 'INDETERMINEE']);

/**
 * Vue réseau (spec rupture.md §2, 16/10/2026) : pour chaque magasin accessible, une ligne-résumé
 * de sa situation de ruptures. Même principe que getStockoutRisksAllShops (chatbotToolsService.js) :
 * itère les magasins du périmètre, agrège, trie par magasin le plus touché en premier.
 */
async function getDashboardSummaryAllShops(allowedShopIds, { resolvedLookbackDays = 30 } = {}) {
  // allowedShopIds === null signifie "pas de restriction" (ADMIN, cf. getAccessibleShopIds dans
  // middleware/auth.js) — distinct d'un tableau vide, qui signifierait "aucun magasin accessible"
  // pour un SUPERVISOR sans périmètre configuré. Même convention que getWeeklyConformityRate.
  if (Array.isArray(allowedShopIds) && !allowedShopIds.length) return { found: false, message: 'Aucun magasin accessible pour ce compte.' };

  const shops = await prisma.shop.findMany({
    where: allowedShopIds !== null ? { rposShopId: { in: allowedShopIds } } : {},
    select: { rposShopId: true, reference: true, name: true },
  });

  const results = [];
  for (const shop of shops) {
    const [openEpisodes, resolvedCount] = await Promise.all([
      prisma.stockoutEpisode.findMany({ where: { rposShopId: shop.rposShopId, status: 'EN_COURS' } }),
      prisma.stockoutEpisode.count({
        where: {
          rposShopId: shop.rposShopId,
          status: 'RESOLUE',
          endedAt: { gte: new Date(Date.now() - resolvedLookbackDays * 24 * 60 * 60 * 1000) },
        },
      }),
    ]);
    if (!openEpisodes.length && !resolvedCount) continue;

    const now = Date.now();
    const durations = openEpisodes.map((e) => (now - e.startedAt.getTime()) / (60 * 60 * 1000));
    const avgDurationHours = durations.length ? durations.reduce((s, d) => s + d, 0) / durations.length : 0;
    const longEpisodesCount = durations.filter((d) => d >= LONG_EPISODE_HOURS).length;
    const noOrderCount = openEpisodes.filter((e) => NO_ORDER_CAUSES.has(e.causeProposee)).length;

    const resolvedWithLoss = await prisma.stockoutEpisode.findMany({
      where: { rposShopId: shop.rposShopId, status: 'RESOLUE', endedAt: { gte: new Date(now - resolvedLookbackDays * 24 * 60 * 60 * 1000) } },
      select: { caPerdueEstime: true },
    });
    // caPerdueEstime lu depuis la valeur stockée pour tous les épisodes (EN_COURS inclus, maintenue
    // à jour par stockoutLossRecalcJob.js) — plus de recalcul temps réel ici, cf. getDashboardSummary.
    const totalCaPerdu = resolvedWithLoss.reduce((s, e) => s + (e.caPerdueEstime || 0), 0) + openEpisodes.reduce((s, e) => s + (e.caPerdueEstime || 0), 0);

    results.push({
      rposShopId: shop.rposShopId,
      shopReference: shop.reference,
      shopName: shop.name,
      openCount: openEpisodes.length,
      totalEpisodesCount: openEpisodes.length + resolvedCount,
      avgDurationHours: Math.round(avgDurationHours * 10) / 10,
      longEpisodesCount,
      noOrderCount,
      totalCaPerduEstime: Math.round(totalCaPerdu),
    });
  }

  results.sort((a, b) => b.openCount - a.openCount);

  if (!results.length) return { found: true, shopCount: 0, shops: [], message: 'Aucun magasin avec une rupture détectée sur la période.' };
  return {
    found: true,
    shopCount: results.length,
    totalOpenAcrossShops: results.reduce((s, r) => s + r.openCount, 0),
    shops: results,
  };
}

/**
 * Agrégation générique par champ de classement (rayon ou secteur) — factorise ce qui était dupliqué
 * entre getDashboardSummaryByDepartment et getDashboardSummaryBySector (navigation Secteur → Rayon
 * → Articles du module Ruptures, identique à Proposition de commande, demande du 16/10/2026). Même
 * indicateurs que la vue réseau (§2), appliqués au niveau du champ choisi. `extraWhere` permet de
 * restreindre à un secteur précis pour lister seulement SES rayons (étape intermédiaire Rayon).
 */
async function getDashboardSummaryByField(rposShopId, field, { resolvedLookbackDays = 30, extraWhere = {}, noDataLabel } = {}) {
  const now = new Date();
  const resolvedSince = new Date(now.getTime() - resolvedLookbackDays * 24 * 60 * 60 * 1000);

  const [openEpisodes, resolvedEpisodes] = await Promise.all([
    prisma.stockoutEpisode.findMany({ where: { rposShopId, status: 'EN_COURS', ...extraWhere } }),
    prisma.stockoutEpisode.findMany({
      where: { rposShopId, status: 'RESOLUE', endedAt: { gte: resolvedSince }, ...extraWhere },
      select: { [field]: true, caPerdueEstime: true },
    }),
  ]);

  if (!openEpisodes.length && !resolvedEpisodes.length) {
    return { found: true, groupCount: 0, groups: [], message: noDataLabel || 'Aucune rupture détectée pour ce magasin sur la période.' };
  }

  // Valeur null possible (épisode dont l'article n'a jamais été proposé, cf. diagnoseCause) —
  // regroupée sous un libellé "Sans ..." plutôt que silencieusement exclue, pour ne jamais faire
  // disparaître un épisode réel de la vue agrégée.
  const fallbackLabel = field === 'sector' ? 'Sans secteur' : 'Sans rayon';
  const byGroup = new Map();
  function getBucket(value) {
    const key = value || fallbackLabel;
    if (!byGroup.has(key)) byGroup.set(key, { group: key, openEpisodes: [], resolvedCount: 0, totalCaPerdu: 0 });
    return byGroup.get(key);
  }

  // caPerdueEstime lu depuis la valeur stockée (maintenue à jour par stockoutLossRecalcJob.js pour
  // les épisodes EN_COURS) — plus de recalcul temps réel ici, cf. getDashboardSummary.
  for (const e of openEpisodes) {
    const bucket = getBucket(e[field]);
    bucket.openEpisodes.push(e);
    bucket.totalCaPerdu += e.caPerdueEstime || 0;
  }
  for (const e of resolvedEpisodes) {
    const bucket = getBucket(e[field]);
    bucket.resolvedCount += 1;
    bucket.totalCaPerdu += e.caPerdueEstime || 0;
  }

  const results = Array.from(byGroup.values()).map((bucket) => {
    const durations = bucket.openEpisodes.map((e) => (now.getTime() - e.startedAt.getTime()) / (60 * 60 * 1000));
    const avgDurationHours = durations.length ? durations.reduce((s, d) => s + d, 0) / durations.length : 0;
    const longEpisodesCount = durations.filter((d) => d >= LONG_EPISODE_HOURS).length;
    const noOrderCount = bucket.openEpisodes.filter((e) => NO_ORDER_CAUSES.has(e.causeProposee)).length;

    const causeCounts = {};
    for (const e of bucket.openEpisodes) causeCounts[e.causeProposee] = (causeCounts[e.causeProposee] || 0) + 1;

    return {
      group: bucket.group,
      openCount: bucket.openEpisodes.length,
      totalEpisodesCount: bucket.openEpisodes.length + bucket.resolvedCount,
      avgDurationHours: Math.round(avgDurationHours * 10) / 10,
      longEpisodesCount,
      noOrderCount,
      causeCounts,
      totalCaPerduEstime: Math.round(bucket.totalCaPerdu),
    };
  });

  results.sort((a, b) => b.openCount - a.openCount);

  return {
    found: true,
    groupCount: results.length,
    totalOpenAcrossGroups: results.reduce((s, r) => s + r.openCount, 0),
    groups: results,
  };
}

/** Dashboard par secteur (1er niveau, spec rupture.md §7 étendu, 16/10/2026) : point d'entrée de la
 * navigation Secteur → Rayon → Articles. */
async function getDashboardSummaryBySector(rposShopId, options = {}) {
  return getDashboardSummaryByField(rposShopId, 'sector', options);
}

/** Dashboard par rayon — optionnellement restreint à un secteur (2e niveau de la navigation). */
async function getDashboardSummaryByDepartment(rposShopId, { sector, ...options } = {}) {
  const extraWhere = sector !== undefined ? { sector: sector === '__none__' ? null : sector } : {};
  return getDashboardSummaryByField(rposShopId, 'department', { ...options, extraWhere });
}

// Historique des mouvements de stock/ventes affiché dans la fiche détail : fenêtre large pour
// couvrir tout l'épisode (même ancien) plus quelques jours avant son début (spec §3 : "quantités
// vendues avant la rupture").
const PRE_EPISODE_CONTEXT_DAYS = 14;

/**
 * Fiche détaillée d'un épisode de rupture (spec rupture.md §3-§5, 16/10/2026) : identité article,
 * mouvements de stock, ventes avant/pendant la rupture, commande associée avec sa chronologie
 * complète (création -> transmission -> réception, via ReceptionEvent), et les 3 délais distincts
 * demandés (§4 : réaction, réapprovisionnement, durée totale) — jamais additionnés entre eux,
 * affichés séparément comme le document l'exige explicitement.
 */
async function getEpisodeDetail(episodeId) {
  const episode = await prisma.stockoutEpisode.findUnique({ where: { id: episodeId } });
  if (!episode) return { found: false, message: 'Épisode de rupture introuvable.' };

  const now = new Date();
  const endedAt = episode.endedAt || now;
  const durationHours = Math.round(((endedAt.getTime() - episode.startedAt.getTime()) / (60 * 60 * 1000)) * 10) / 10;

  // Commande associée à CET épisode précis : contrairement à diagnoseCause (qui prend la dernière
  // proposition connue, utile pour un diagnostic rapide à la détection), on ne retient ici qu'une
  // commande créée À PARTIR du début de la rupture — une commande plus ancienne n'est pas une
  // réaction à cette rupture mais à une situation antérieure (bug trouvé en testant réellement :
  // un épisode du 16/10 se voyait associer une commande du 16/09, donnant un "délai de réaction"
  // négatif de -719h). Sans commande postérieure au début, order reste null (spec §4, scénario 1 :
  // "aucune commande n'a été identifiée").
  const candidateLines = await prisma.proposalLine.findMany({
    where: { ean: episode.ean, proposal: { rposShopId: episode.rposShopId, generatedAt: { gte: episode.startedAt } } },
    orderBy: { proposal: { generatedAt: 'asc' } },
    include: { proposal: true },
  });

  let order = null;
  let matchedLine = null;
  let receptionEvents = [];
  for (const line of candidateLines) {
    const candidateOrder = await prisma.proposalOrder.findFirst({
      where: { proposalId: line.proposalId, department: line.department || undefined, createdAt: { gte: episode.startedAt } },
      orderBy: { createdAt: 'asc' },
    });
    if (candidateOrder) {
      order = candidateOrder;
      matchedLine = line;
      break;
    }
  }
  // Qui a créé/validé la commande, et sa date de validation réelle (demande explicite du
  // 17/10/2026 : "date e validation et heure puis il qui a cree et validé") — ProposalOrder/Proposal
  // ne stocke QUE qui a validé la proposition côté plateforme (Proposal.validatedBy), pas forcément
  // qui a créé/validé la commande fournisseur réelle côté RPOS (peut être différent : validation
  // automatique par la génération nocturne, ou commande ensuite revalidée manuellement sur RPOS).
  // Même principe que getValidatedOrders (chatbotToolsService.js) : created_by/validated_by/
  // validation_date ne sont disponibles QUE via l'API RPOS /api/supplier_order/, jamais en base
  // locale — recherche par référence (rposOrderReference) dans un lot paginé, jamais un échec
  // bloquant (RPOS injoignable = champs simplement absents, pas une erreur de la page).
  let rposOrderDetail = null;
  if (order && order.rposOrderReference) {
    try {
      const { results } = await rpos.getSupplierOrders(episode.rposPosId, { shopId: episode.rposShopId, pageSize: 200, platformOnly: false });
      const match = results.find((o) => o.reference === order.rposOrderReference);
      if (match) {
        rposOrderDetail = {
          createdBy: match.created_by || null,
          validatedBy: match.validated_by || null,
          validationDate: match.validation_date || null,
        };
      }
    } catch (err) {
      console.error(`[stockoutEpisodeService] RPOS injoignable pour le détail de commande ${order.rposOrderReference} :`, err.message);
    }
  }

  if (order) {
    receptionEvents = await prisma.receptionEvent.findMany({
      where: { proposalOrderId: order.id },
      orderBy: { observedAt: 'asc' },
    });
  }

  // Les 3 délais distincts de la spec §4 — null si l'étape correspondante n'a pas (encore) de date.
  let reactionDelayHours = null;
  let replenishmentDelayHours = null;
  if (order) {
    reactionDelayHours = Math.round(((order.createdAt.getTime() - episode.startedAt.getTime()) / (60 * 60 * 1000)) * 10) / 10;
    if (order.actualReceptionDate) {
      replenishmentDelayHours = Math.round(((order.actualReceptionDate.getTime() - order.createdAt.getTime()) / (60 * 60 * 1000)) * 10) / 10;
    }
  }

  const contextStart = new Date(episode.startedAt.getTime() - PRE_EPISODE_CONTEXT_DAYS * 24 * 60 * 60 * 1000);
  const [stockMoves, salesBefore, salesDuring] = await Promise.all([
    getMovesFromLocal(episode.rposShopId, episode.ean, contextStart, endedAt),
    prisma.salesLine.aggregate({
      where: { rposShopId: episode.rposShopId, ean: episode.ean, date: { gte: contextStart, lt: episode.startedAt } },
      _sum: { quantity: true, revenueExclTax: true },
      _count: true,
    }),
    prisma.salesLine.aggregate({
      where: { rposShopId: episode.rposShopId, ean: episode.ean, date: { gte: episode.startedAt, lte: endedAt } },
      _sum: { quantity: true, revenueExclTax: true },
    }),
  ]);

  // Statut de réaction du magasin (demande explicite du 16/10/2026 : "une commande doit etre fait
  // dans 24h et la livraison est prevu pour 48h... si Apres 48h que ya pas de commande c'est la on
  // doit voir" + "si aucune commande n'a encore été passée... le système ne doit pas attribuer
  // automatiquement la perte au magasin... il doit signaler que le stock n'est potentiellement pas
  // à jour") — règle à 2 seuils + 1 garde-fou, distincte de causeProposee (figée à l'ouverture de
  // l'épisode, jamais réévaluée) : ici calculée à chaque lecture, donc toujours à jour même sur un
  // épisode encore ouvert depuis des jours.
  //   - Aucune vente enregistrée depuis le début de la rupture ET aucune commande : personne n'a
  //     concrètement constaté l'absence du produit (ni vente ratée, ni réassort) — le stock à 0
  //     peut être une désynchronisation RPOS plutôt qu'une vraie rupture (STOCK_PEUT_ETRE_PAS_A_JOUR),
  //     distinct d'un manque de réaction confirmé. Prioritaire sur les seuils 24h/48h : sans aucun
  //     signal de vente, même après 48h on ne peut pas conclure avec certitude que c'est le magasin.
  //   - < 24h sans commande (avec ventes constatées) : délai normal, pas encore de jugement (EN_ATTENTE)
  //   - 24-48h sans commande : en retard mais pas encore confirmé fautif (RETARD)
  //   - > 48h sans AUCUNE commande passée depuis le début : confirmé, le magasin n'a pas réagi
  //     (MAGASIN_NA_PAS_REAGI)
  //   - une commande existe : le magasin a réagi, le statut porte sur le délai de réaction observé
  //     (REAGI)
  const { reactionDeadlineHours, deliveryDeadlineHours } = await getReactionDeadlines();
  const noSalesSinceStart = (salesDuring._sum.quantity || 0) === 0;
  let reactionStatus;
  if (order) {
    reactionStatus = 'REAGI';
  } else if (noSalesSinceStart) {
    reactionStatus = 'STOCK_PEUT_ETRE_PAS_A_JOUR';
  } else if (durationHours > deliveryDeadlineHours) {
    reactionStatus = 'MAGASIN_NA_PAS_REAGI';
  } else if (durationHours > reactionDeadlineHours) {
    reactionStatus = 'RETARD';
  } else {
    reactionStatus = 'EN_ATTENTE';
  }

  // Perte avant/après commande, séparément (demande explicite du 17/10/2026 : "on doit voir le ca
  // perte avant la commande et ca perte apres la commande") — distinct de caPerdueEstime (perte
  // totale sur toute la durée, déjà stockée/précalculée par stockoutLossRecalcJob.js). Recalculé ici
  // à la demande (consultation d'un seul épisode, pas une agrégation de centaines) : avant = du
  // début de la rupture à la commande, après = de la commande à la fin (ou maintenant si toujours
  // en cours). Null si aucune commande (rien à séparer) ou historique de ventes insuffisant.
  let lossBeforeOrder = null;
  let lossAfterOrder = null;
  if (order) {
    const [before, after] = await Promise.all([
      order.createdAt.getTime() > episode.startedAt.getTime()
        ? estimateLoss(episode.rposShopId, episode.ean, episode.startedAt, order.createdAt)
        : { qtyPerdue: 0, caPerdue: 0 },
      endedAt.getTime() > order.createdAt.getTime()
        ? estimateLoss(episode.rposShopId, episode.ean, order.createdAt, endedAt)
        : { qtyPerdue: 0, caPerdue: 0 },
    ]);
    lossBeforeOrder = before;
    lossAfterOrder = after;
  }

  // Suffisance de la quantité commandée (demande explicite : "déterminer si la quantité commandée
  // était suffisante pour couvrir les besoins du magasin jusqu'à la livraison") — même méthode que
  // estimateLoss : demande attendue = vente moyenne du même jour de semaine sur 8 semaines
  // comparables, multipliée par la durée réelle entre la commande et la réception (ou, si pas
  // encore reçue, jusqu'à maintenant). Null si pas de commande, pas encore assez de recul pour
  // juger (pas encore reçue ET commande très récente), ou historique de vente insuffisant.
  let orderQuantitySufficiency = null;
  if (order && matchedLine) {
    const coverageEnd = order.actualReceptionDate || now;
    const coverageDays = Math.max(1, Math.ceil((coverageEnd.getTime() - order.createdAt.getTime()) / (24 * 60 * 60 * 1000)));
    const demandEstimate = await estimateDemand(episode.rposShopId, episode.ean, order.createdAt, coverageDays);
    const quantityOrdered = matchedLine.quantityValidated ?? matchedLine.quantitySuggested ?? null;
    if (demandEstimate !== null && quantityOrdered !== null) {
      orderQuantitySufficiency = {
        quantityOrdered,
        expectedDemand: Math.round(demandEstimate * 10) / 10,
        sufficient: quantityOrdered >= demandEstimate,
      };
    }
  }

  return {
    found: true,
    id: episode.id,
    ean: episode.ean,
    label: episode.label,
    department: episode.department,
    sector: episode.sector,
    rposShopId: episode.rposShopId,
    startedAt: episode.startedAt,
    endedAt: episode.endedAt,
    status: episode.status,
    durationHours,
    causeProposee: episode.causeProposee,
    niveauConfiance: episode.niveauConfiance,
    reactionStatus,
    qtyPerdueEstimee: episode.qtyPerdueEstimee,
    caPerdueEstime: episode.caPerdueEstime,
    salesBeforeEpisode: {
      windowDays: PRE_EPISODE_CONTEXT_DAYS,
      quantity: salesBefore._sum.quantity || 0,
      revenue: salesBefore._sum.revenueExclTax || 0,
    },
    salesDuringEpisode: {
      quantity: salesDuring._sum.quantity || 0,
      revenue: salesDuring._sum.revenueExclTax || 0,
    },
    stockMoves,
    order: order
      ? {
          id: order.id,
          rposOrderReference: order.rposOrderReference,
          status: order.status,
          receptionStatus: order.receptionStatus,
          rposOrderValidated: order.rposOrderValidated,
          supplierName: order.supplierName,
          deliveryType: order.deliveryType,
          createdAt: order.createdAt,
          createdBy: rposOrderDetail?.createdBy ?? null,
          // RPOS (rposOrderDetail) prioritaire : reflète la commande fournisseur réelle, pas
          // seulement notre proposition interne. Repli sur Proposal.validatedAt/validatedBy si RPOS
          // injoignable ou sans correspondance — mieux qu'un champ vide.
          validatedAt: rposOrderDetail?.validationDate ?? matchedLine?.proposal?.validatedAt ?? null,
          validatedBy: rposOrderDetail?.validatedBy ?? matchedLine?.proposal?.validatedBy ?? null,
          expectedReceptionDate: order.expectedReceptionDate,
          actualReceptionDate: order.actualReceptionDate,
          quantityOrdered: matchedLine?.quantityValidated ?? matchedLine?.quantitySuggested ?? null,
        }
      : null,
    receptionEvents: receptionEvents.map((e) => ({ observedAt: e.observedAt, receptionStatus: e.receptionStatus, rposStatus: e.rposStatus })),
    reactionDelayHours,
    replenishmentDelayHours,
    totalDurationHours: durationHours,
    orderQuantitySufficiency,
    lossBeforeOrder,
    lossAfterOrder,
    reactionDeadlineHours,
    deliveryDeadlineHours,
  };
}

/**
 * Évolution du nombre de ruptures en cours, jour par jour, sur les `days` derniers jours (demande
 * du 16/10/2026, drill-down magasin au même niveau de détail visuel que TableauDeBord.tsx : graphe
 * de tendance, pas juste un chiffre figé). Pour chaque jour, compte les épisodes qui étaient
 * EN_COURS à ce moment précis (startedAt <= jour ET (pas encore résolu OU résolu après ce jour)) —
 * calcul direct en JS plutôt qu'une requête SQL par jour (30 requêtes), un seul findMany suffit car
 * le nombre d'épisodes sur 30j + marge reste limité par magasin.
 */
async function getTrend(rposShopId, { days = 30 } = {}) {
  const now = new Date();
  const windowStart = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  // Tout épisode qui a pu être "en cours" à un moment de la fenêtre : commencé avant la fin de la
  // fenêtre, et (toujours ouvert OU résolu après le début de la fenêtre).
  const episodes = await prisma.stockoutEpisode.findMany({
    where: {
      rposShopId,
      startedAt: { lte: now },
      OR: [{ endedAt: null }, { endedAt: { gte: windowStart } }],
    },
    select: { startedAt: true, endedAt: true },
  });

  const points = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const count = episodes.filter((e) => e.startedAt <= day && (!e.endedAt || e.endedAt > day)).length;
    points.push({ date: day.toISOString().slice(0, 10), openCount: count });
  }

  return { found: true, points };
}

module.exports = { detectStockoutEpisodes, getOpenEpisodes, getDashboardSummary, getDashboardSummaryAllShops, getDashboardSummaryByDepartment, getDashboardSummaryBySector, getEpisodeDetail, getTrend, diagnoseCause, estimateLoss };
