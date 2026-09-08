const { PrismaClient } = require('@prisma/client');
const rpos = require('./rposClient');
const { getConfig } = require('./configService');
const { resolvePeriod } = require('./periodService');
const { readSalesLinesForPeriod } = require('./salesFileService');
const systemConfig = require('./systemConfigService');
const { forecastAvgWeeklySales } = require('./forecastService');
const { mapWithConcurrency } = require('../utils/concurrency');

const prisma = new PrismaClient();

/**
 * Récupère les lignes de vente d'un magasin sur une période, dans l'ordre de préférence :
 * 1. Fichier d'export local (le plus rapide, zéro appel réseau) si disponible pour la période.
 * 2. Base locale SalesLine, alimentée en tâche de fond par salesSyncJob.js (rapide, pas d'appel
 *    RPOS bloquant) — c'est la source normale une fois la synchro en place.
 * 3. RPOS en direct (lent, pagination potentiellement de plusieurs minutes) : seulement en
 *    dernier recours, si aucune des deux sources locales n'a de données pour cette période — par
 *    exemple un magasin dont la synchro n'a pas encore tourné, ou une période trop ancienne pour
 *    avoir été synchronisée.
 */
async function getSalesLinesForPeriod(posId, shopId, shopReference, dateStart, dateEnd) {
  if (shopReference) {
    const salesDir = await systemConfig.getValue(systemConfig.KEYS.SALES_FILES_DIR);
    const fileLines = readSalesLinesForPeriod(salesDir, shopReference, dateStart, dateEnd);
    if (fileLines) return { lines: fileLines, source: 'file' };
  }

  const dbLines = await prisma.salesLine.findMany({
    where: { rposShopId: shopId, date: { gte: new Date(dateStart), lt: new Date(dateEnd) } },
  });
  if (dbLines.length > 0) {
    return {
      lines: dbLines.map((l) => ({ ean: l.ean, label_1: l.label, quantity: l.quantity, total_excl_tax: l.revenueExclTax, date: l.date.toISOString() })),
      source: 'db',
    };
  }

  const rposLines = await rpos.getProductLinesForPeriod(posId, shopId, dateStart, dateEnd);
  return { lines: rposLines, source: 'rpos' };
}

// Un appel RPOS getProductByEan par article (jusqu'à 700+ sur un gros magasin) domine largement le
// temps de génération malgré les ventes déjà locales. Cache-aside avec TTL court : le stock change
// en continu (chaque vente le modifie), donc pas de synchro périodique pré-calculée — l'article est
// mis en cache la première fois qu'il est vu, puis relu depuis la table tant qu'il n'a pas expiré.
const PRODUCT_CACHE_TTL_MS = 15 * 60 * 1000;

async function cacheProduct(shopId, posId, ean, product) {
  const data = {
    rposPosId: posId,
    rposShopId: shopId,
    ean,
    productId: product.id,
    orderable: !!product.orderable,
    sellingPrice: Number(product.selling_price || 0),
    buyingPrice: Number(product.buying_price || 0),
    orderingUnit: Number(product.ordering_unit || 1),
    stock: Number(product.stock || 0),
    departmentId: product.department?.id || null,
  };
  await prisma.productCache.upsert({
    where: { rposShopId_ean: { rposShopId: shopId, ean } },
    update: data,
    create: data,
  });
}

async function getProductByEanCached(posId, shopId, ean) {
  const cached = await prisma.productCache.findUnique({ where: { rposShopId_ean: { rposShopId: shopId, ean } } });
  if (cached && Date.now() - cached.syncedAt.getTime() < PRODUCT_CACHE_TTL_MS) {
    return {
      id: cached.productId,
      orderable: cached.orderable,
      selling_price: cached.sellingPrice,
      buying_price: cached.buyingPrice,
      ordering_unit: cached.orderingUnit,
      stock: cached.stock,
      department: cached.departmentId ? { id: cached.departmentId } : null,
    };
  }

  const product = await rpos.getProductByEan(posId, shopId, ean);
  if (!product) return null;

  await cacheProduct(shopId, posId, ean, product);
  return product;
}

// Même principe de cache-aside que getProductByEanCached, pour le second appel RPOS par article
// (commandes récentes non livrées) qui restait le goulot dominant une fois ProductCache en place
// (mesuré : ~30% de gain avec ProductCache seul, cet appel domine le temps restant).
async function getRecentUndeliveredOrderedQuantityCached(posId, shopId, productId, maxAgeDays) {
  const cached = await prisma.recentOrderCache.findUnique({ where: { rposShopId_productId: { rposShopId: shopId, productId } } });
  if (cached && Date.now() - cached.syncedAt.getTime() < PRODUCT_CACHE_TTL_MS) {
    return {
      quantity: cached.quantity,
      orderCount: cached.orderCount,
      mostRecentDate: cached.mostRecentDate,
      mostRecentReference: cached.mostRecentReference,
      orders: cached.ordersJson ? JSON.parse(cached.ordersJson) : [],
    };
  }

  const result = await rpos.getRecentUndeliveredOrderedQuantity(posId, shopId, productId, maxAgeDays);

  const data = {
    rposPosId: posId,
    rposShopId: shopId,
    productId,
    quantity: result.quantity,
    orderCount: result.orderCount,
    mostRecentDate: result.mostRecentDate ? new Date(result.mostRecentDate) : null,
    mostRecentReference: result.mostRecentReference,
    ordersJson: JSON.stringify(result.orders || []),
  };
  await prisma.recentOrderCache.upsert({
    where: { rposShopId_productId: { rposShopId: shopId, productId } },
    update: data,
    create: data,
  });

  return result;
}

function toFloat(value) {
  if (!value) return 0;
  return parseFloat(String(value).replace(/\s/g, '').replace(',', '.')) || 0;
}

/**
 * Calcule le classement Pareto (20/80) à partir des lignes de vente RPOS d'une période donnée :
 * cumule le CA par article, trie par CA décroissant, et retient les articles nécessaires pour
 * atteindre le seuil configuré (ex: 80% du CA total), en excluant les lignes à CA négatif
 * (retours/annulations) du calcul du CA par article.
 */
function computeParetoFromLines(lines, paretoThreshold, periodDays, forecastConfig) {
  const byEan = new Map();

  for (const line of lines) {
    const ean = (line.ean || '').trim();
    if (!ean || !/^\d+$/.test(ean)) continue; // ignore les codes génériques (poids, département)

    const caHt = toFloat(line.total_excl_tax);
    const quantity = toFloat(line.quantity);

    if (!byEan.has(ean)) {
      byEan.set(ean, { ean, label: line.label_1 || '', caHt: 0, quantity: 0, lines: [] });
    }
    const entry = byEan.get(ean);
    entry.caHt += caHt;
    entry.quantity += quantity;
    entry.lines.push({ date: line.date, quantity });
    if (line.label_1) entry.label = line.label_1;
  }

  const articles = Array.from(byEan.values()).filter((a) => a.caHt > 0);
  articles.sort((a, b) => b.caHt - a.caHt);

  const totalCa = articles.reduce((sum, a) => sum + a.caHt, 0);
  let cumulative = 0;
  const priorityArticles = [];

  for (const art of articles) {
    cumulative += art.caHt;
    const cumulativePct = totalCa ? cumulative / totalCa : 0;
    // Prévision par lissage exponentiel (readme évolution "intégration IA") : optionnelle par
    // magasin, retombe sur la moyenne plate historique si désactivée ou si l'historique est trop
    // court pour être fiable (cf. forecastService.MIN_DAYS_FOR_SMOOTHING).
    const forecast = forecastConfig?.enabled
      ? forecastAvgWeeklySales(art.lines, periodDays, forecastConfig.alpha)
      : { avgWeeklySales: (art.quantity / periodDays) * 7, method: 'flat', alpha: null };

    // Agrège les ventes par jour (pas juste la moyenne) : sert à donner à l'analyse IA la vraie
    // évolution de l'article sur la période plutôt qu'un seul chiffre plat, pour qu'elle puisse
    // elle-même repérer une tendance (accélération/ralentissement) ou un pic ponctuel à ignorer.
    const dailyMap = new Map();
    for (const line of art.lines) {
      const day = new Date(line.date).toISOString().slice(0, 10);
      dailyMap.set(day, (dailyMap.get(day) || 0) + line.quantity);
    }
    const dailyHistory = Array.from(dailyMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, quantity]) => ({ date, quantity: Math.round(quantity * 100) / 100 }));

    priorityArticles.push({
      code: art.ean,
      label: art.label,
      avg_weekly_quantity: forecast.avgWeeklySales,
      forecast_method: forecast.method,
      cumulative_pct: cumulativePct * 100,
      daily_history: dailyHistory,
    });
    if (cumulativePct >= paretoThreshold) break;
  }

  return { priorityArticles, totalArticlesWithSales: articles.length, totalCa };
}

/**
 * @param {number} [receptionLeadTimeDays] - si fourni (et useReceptionLeadTime=true), le besoin
 *   couvre ce nombre de jours de vente au lieu d'une semaine fixe implicite : plus le délai avant
 *   réception est long, plus il faut avoir anticipé la commande (readme évolution, délais de
 *   réception par magasin).
 * @param {boolean} [useReceptionLeadTime] - désactivé par défaut pour ne pas changer le
 *   comportement des magasins déjà actifs sans validation explicite au cas par cas.
 */
function computeQuantityToOrder(avgWeeklySales, stock, orderedQty, orderingUnit, safetyStockRatio, receptionLeadTimeDays, useReceptionLeadTime) {
  const coverageDays = useReceptionLeadTime && receptionLeadTimeDays ? receptionLeadTimeDays : 7;
  const expectedDemand = (avgWeeklySales / 7) * coverageDays;
  const safetyStock = avgWeeklySales * safetyStockRatio;
  const rawNeed = expectedDemand + safetyStock - stock - orderedQty;
  if (rawNeed <= 0) return 0;

  const unit = orderingUnit || 1;
  const nbUnits = Math.ceil(rawNeed / unit);
  return nbUnits * unit;
}

/**
 * Génère la proposition de commande pour un magasin : calcule le Pareto sur les ventes de la
 * période configurée, puis croise avec l'état courant du stock RPOS (API, en temps réel).
 *
 * Source des ventes : d'abord un fichier d'export local (rapide, zéro appel réseau vers RPOS)
 * si un fichier couvrant la période est disponible pour ce magasin ; sinon repli automatique sur
 * l'API RPOS en direct (plus lent, mais toujours à jour).
 *
 * @param {string} posId - identifiant du serveur RPOS hébergeant ce magasin (ex: "pos1")
 * @param {string} shopId - uuid du magasin RPOS
 * @param {string} [shopReference] - code magasin (ex: "050"), nécessaire pour chercher les fichiers locaux
 * @param {number} [limit] - limite le nombre d'articles traités (pour tests rapides)
 */
async function generateProposal(posId, shopId, limit, shopReference, periodOverride) {
  console.log(`[proposalService] Génération démarrée : posId=${posId} shopId=${shopId} shopReference=${shopReference || '-'} limit=${limit || 'aucune'}`);

  const baseConfig = await getConfig(shopId);
  // Un override ponctuel de période (choisi au moment de la génération manuelle) ne modifie
  // jamais la configuration permanente du magasin : il ne s'applique qu'à cette génération.
  const config = periodOverride
    ? { ...baseConfig, periodMode: periodOverride.periodMode, customStart: periodOverride.customStart, customEnd: periodOverride.customEnd }
    : baseConfig;
  const period = await resolvePeriod(posId, shopId, config);
  console.log(`[proposalService] Période résolue : ${period.start} -> ${period.end} (mode ${config.periodMode})`);

  const periodDays = Math.max(1, (new Date(period.end) - new Date(period.start)) / (24 * 60 * 60 * 1000));

  const salesResult = await getSalesLinesForPeriod(posId, shopId, shopReference, period.start, period.end);
  const lines = salesResult.lines;
  const salesSource = salesResult.source;
  if (salesSource === 'rpos') {
    console.log(`[proposalService] Aucune donnée locale (fichier/base) disponible, appel RPOS getProductLinesForPeriod...`);
  }
  console.log(`[proposalService] ${lines.length} ligne(s) de vente chargée(s) (source: ${salesSource})`);

  const { priorityArticles, totalArticlesWithSales } = computeParetoFromLines(
    lines,
    config.paretoThreshold,
    periodDays,
    { enabled: config.forecastEnabled, alpha: config.forecastAlpha }
  );
  console.log(`[proposalService] Pareto : ${priorityArticles.length}/${totalArticlesWithSales} article(s) prioritaire(s) (seuil ${config.paretoThreshold * 100}%)`);

  let articles = priorityArticles;
  if (limit) articles = articles.slice(0, limit);

  // Saisonnalité (readme §8) : compare la période d'analyse actuelle à la même période N années
  // en arrière, et ajuste la vente moyenne prévue si l'écart dépasse le seuil configuré, pour ne
  // pas sous-estimer un pic saisonnier (ex: chocolat à Pâques) basé uniquement sur la moyenne
  // récente. Toujours calculé sur la période de référence du magasin (jamais la date système),
  // donc valable aussi bien sur des données anciennes (test) qu'en production.
  if (config.seasonalityComparisonEnabled) {
    const lookbackYears = config.seasonalityLookbackYears || 1;
    const adjustmentThreshold = config.seasonalityAdjustmentThresholdPct || 15;

    const priorStart = new Date(period.start);
    priorStart.setFullYear(priorStart.getFullYear() - lookbackYears);
    const priorEnd = new Date(period.end);
    priorEnd.setFullYear(priorEnd.getFullYear() - lookbackYears);

    console.log(`[proposalService] Saisonnalité activée : comparaison avec ${priorStart.toISOString()} -> ${priorEnd.toISOString()} (N-${lookbackYears})`);

    let priorLines = [];
    try {
      priorLines = (await getSalesLinesForPeriod(posId, shopId, shopReference, priorStart.toISOString(), priorEnd.toISOString())).lines;
    } catch (err) {
      console.error('[proposalService] Échec de récupération des ventes N-1 pour la saisonnalité:', err.message);
      priorLines = [];
    }

    const priorQuantityByEan = new Map();
    for (const line of priorLines) {
      const ean = (line.ean || '').trim();
      if (!ean || !/^\d+$/.test(ean)) continue;
      priorQuantityByEan.set(ean, (priorQuantityByEan.get(ean) || 0) + toFloat(line.quantity));
    }

    if (priorQuantityByEan.size === 0) {
      console.log('[proposalService] Aucune donnée N-1 disponible pour cette période : saisonnalité ignorée pour cette génération.');
    } else {
      for (const art of articles) {
        const priorQuantity = priorQuantityByEan.get(art.code);
        if (!priorQuantity) continue; // pas de vente N-1 pour cet article : pas d'ajustement possible

        const currentQuantity = art.avg_weekly_quantity * (periodDays / 7);
        if (currentQuantity <= 0) continue;

        const deviationPct = ((priorQuantity - currentQuantity) / currentQuantity) * 100;
        if (Math.abs(deviationPct) > adjustmentThreshold) {
          // La période N-1 a généré nettement plus (ou moins) de ventes que la période actuelle :
          // on ajuste la prévision vers la valeur N-1, en supposant une tendance saisonnière plutôt
          // qu'un simple aléa (readme §8, exemple du chocolat à Pâques).
          const adjustedWeeklyQuantity = (priorQuantity / (periodDays / 7));
          console.log(`[proposalService] Saisonnalité : article ${art.code} ajusté de ${art.avg_weekly_quantity.toFixed(1)} à ${adjustedWeeklyQuantity.toFixed(1)}/semaine (écart N-1: ${deviationPct.toFixed(0)}%)`);
          art.avg_weekly_quantity = adjustedWeeklyQuantity;
          art.seasonality_adjusted = true;
          art.seasonality_deviation_pct = deviationPct;
        }
      }
    }
  }

  // Part de CA de chaque article dans le CA total du magasin, sur une période de référence
  // configurable indépendante de la période d'analyse Pareto (ex: hier, même si le Pareto est
  // calculé sur 30 jours). Réutilise les lignes déjà chargées si les deux périodes coïncident.
  const revenueShareDays = config.revenueSharePeriodDays || 1;
  const revenueShareEnd = period.end;
  const revenueShareStart = new Date(new Date(period.end).getTime() - revenueShareDays * 24 * 60 * 60 * 1000).toISOString();

  let revenueShareLines = lines;
  if (revenueShareDays !== periodDays) {
    const revenueShareResult = await getSalesLinesForPeriod(posId, shopId, shopReference, revenueShareStart, revenueShareEnd);
    revenueShareLines = revenueShareResult.lines;
    if (revenueShareResult.source === 'rpos') {
      console.log(`[proposalService] Aucune donnée locale pour le CA de référence (${revenueShareDays}j), appel RPOS...`);
    }
  }

  const revenueByEan = new Map();
  let shopTotalRevenue = 0;
  for (const line of revenueShareLines) {
    const ean = (line.ean || '').trim();
    if (!ean || !/^\d+$/.test(ean)) continue;
    const caHt = toFloat(line.total_excl_tax);
    if (caHt <= 0) continue;
    revenueByEan.set(ean, (revenueByEan.get(ean) || 0) + caHt);
    shopTotalRevenue += caHt;
  }

  // RPOS ne reflète pas toujours les commandes "en préparation" dans current_ordered_quantity
  // côté produit : on interroge nous-mêmes la quantité déjà en transit (commandée par cette
  // plateforme, pas encore reçue) pour chaque article, et on la déduit du besoin plutôt que
  // d'exclure silencieusement l'article — l'article reste visible avec un badge explicite si son
  // besoin résiduel tombe à 0 à cause de cette quantité en transit.
  const { quantityByEan: inTransitByEan, orderInfoByEan: platformOrderInfoByEan } = await rpos.getPendingPlatformOrderedEans(posId, shopId);

  const proposals = [];
  const skipped = { notFound: [], notOrderable: [], negativeStock: [], alreadyOrdered: [], genericArticle: [] };
  const revenueSharePctFor = (ean) => shopTotalRevenue > 0 ? ((revenueByEan.get(ean) || 0) / shopTotalRevenue) * 100 : null;

  // Pré-chauffe le cache produit par lots de ~200 EAN via le filtre RPOS ean__in (confirmé
  // supporté par test direct), au lieu d'un appel getProductByEan par article : sur un magasin à
  // cache froid (1000+ articles Pareto), ça remplace ~1000 appels réseau individuels par ~5-10
  // appels en lot — c'était le principal goulot de la génération de proposition (audit
  // performance). getProductByEanCached en dessous lira ensuite tout depuis ProductCache, déjà
  // rempli ici, sans appel RPOS supplémentaire pour les articles trouvés.
  const eansToPrefetch = articles.map((a) => a.code);
  const productsByEan = await rpos.getProductsByEans(posId, shopId, eansToPrefetch);
  await Promise.all(Array.from(productsByEan.entries()).map(([ean, product]) => cacheProduct(shopId, posId, ean, product)));
  console.log(`[proposalService] Pré-chauffe produit : ${productsByEan.size}/${eansToPrefetch.length} article(s) trouvé(s) en un lot RPOS`);

  // Un appel RPOS par article (getProductByEan) en série peut prendre 10-20+ minutes sur un
  // magasin à fort catalogue Pareto (1000+ articles prioritaires) : RPOS répond en 200-500ms+ par
  // requête, donc 1000 appels séquentiels = 3-8 minutes rien que pour ça, avant même le reste du
  // calcul. Avec la pré-chauffe ci-dessus, cette boucle ne fait plus d'appel RPOS pour les
  // articles déjà en cache — seuls les articles absents du lot (rare) retombent sur un appel
  // individuel. On garde le traitement par lots parallèles pour ce cas résiduel et pour le reste
  // du calcul par article (commandes récentes, hiérarchie département).
  const CONCURRENCY = 10;

  async function processArticle(art) {
    const ean = art.code;
    const quantityInTransit = inTransitByEan.get(ean) || 0;

    const product = await getProductByEanCached(posId, shopId, ean);

    if (!product) {
      return { skip: 'notFound', ean, label: art.label, revenueSharePct: revenueSharePctFor(ean) };
    }
    if (!product.orderable) {
      return { skip: 'notOrderable', ean, label: art.label, revenueSharePct: revenueSharePctFor(ean) };
    }

    // Écarte les articles génériques/poids libre (agrégés au niveau d'un rayon entier, ex:
    // "FRUITS & LEGUMES" à 1 CFA), qui ne sont pas de vrais produits vendables individuellement
    // et faussent totalement le calcul avec des quantités proposées énormes.
    const sellingPriceForFilter = Number(product.selling_price || 0);
    if (config.excludeGenericArticlesBelowPrice > 0 && sellingPriceForFilter < config.excludeGenericArticlesBelowPrice) {
      return { skip: 'genericArticle', ean, label: art.label, revenueSharePct: revenueSharePctFor(ean) };
    }

    // Secteur + rayon (readme §11 et évolution "vue par secteur puis rayon") : le rayon (2e niveau
    // de la hiérarchie RPOS) sert à regrouper les articles à la validation et créer une commande
    // fournisseur distincte par rayon ; le secteur (1er niveau) sert uniquement à la navigation
    // dans l'UI (un responsable de secteur clique sur son secteur puis choisit le rayon précis).
    const { sector, rayon: department } = await rpos.getDepartmentHierarchy(posId, product.department?.id);

    let stock = Number(product.stock || 0);
    const hadNegativeStock = stock < 0;
    const actualStock = stock; // valeur brute RPOS avant écrasement à 0, conservée pour l'affichage
    let hadNegativeStockSkip = false;
    if (hadNegativeStock) {
      hadNegativeStockSkip = true;
      if (config.treatNegativeStockAsZero) {
        // Stock non fiable (l'article continue de se vendre alors que RPOS indique un stock
        // négatif) : ne se corrige que via une intégration de facture (réception de commande) ou
        // un inventaire physique côté RPOS. En attendant, l'article reste prioritaire (80% du CA),
        // on couvre le besoin uniquement sur la base des ventes réelles, sans stock à déduire.
        stock = 0;
      }
      // Sinon (treatNegativeStockAsZero=false) : on garde la valeur négative réelle, à la fois
      // dans le calcul du besoin (le déficit de stock s'ajoute alors à la quantité à commander)
      // et dans l'affichage, pour ne pas masquer une anomalie de stock au responsable magasin.
    }

    // La quantité déjà commandée déduite du besoin cumule notre propre suivi des commandes en
    // transit de cette plateforme et les commandes RPOS récentes non livrées (hors plateforme),
    // sans compter deux fois la même chose : RPOS finit généralement par refléter la commande de
    // cette plateforme une fois "en attente de livraison" (statut 2), donc on garde le plus grand
    // des deux plutôt que de les additionner.
    // On n'utilise PAS product.current_ordered_quantity (le compteur RPOS brut) : sur les
    // commandes centrales, RPOS ne marque jamais réellement une commande "livrée" (pas de suivi
    // de réception, cf. receptionSyncJob.js), donc ce compteur accumule indéfiniment des commandes
    // de plusieurs mois qui masqueraient un vrai besoin de recommander. On ne compte que les
    // commandes RPOS récentes (≤ config.recentOrderMaxAgeDays, réglable par magasin dans
    // Paramètres) : au-delà, on considère qu'il est légitime de repasser commande même si RPOS
    // affiche encore un reliquat.
    const recentRposOrder = await getRecentUndeliveredOrderedQuantityCached(posId, shopId, product.id, config.recentOrderMaxAgeDays);
    const rposOrderedQty = recentRposOrder.quantity;
    const orderedQty = Math.max(rposOrderedQty, quantityInTransit);
    const orderingUnit = Number(product.ordering_unit || 1);
    const avgWeeklySales = Number(art.avg_weekly_quantity);

    const quantityProposed = computeQuantityToOrder(
      avgWeeklySales, stock, orderedQty, orderingUnit, config.safetyStockRatio,
      config.receptionLeadTimeDays, config.useReceptionLeadTimeInCalculation
    );
    // Un article avec beaucoup de CA peut avoir un besoin nul simplement parce que RPOS indique
    // déjà une grosse quantité en commande (current_ordered_quantity, une commande manuelle ou
    // fournisseur classique, indépendante de cette plateforme) : sans ce badge, il disparaîtrait
    // silencieusement de la proposition sans aucune explication visible à l'écran, ce qui a déjà
    // fait croire à une erreur de calcul de part de CA alors que l'article était juste masqué.
    const excludedAsAlreadyOrdered = quantityProposed <= 0 && quantityInTransit > 0;
    const excludedAsAlreadyOrderedRpos = quantityProposed <= 0 && quantityInTransit === 0 && rposOrderedQty > 0;
    if (quantityProposed <= 0 && !excludedAsAlreadyOrdered && !excludedAsAlreadyOrderedRpos) {
      return { hadNegativeStockSkip, ean, label: art.label, revenueSharePct: revenueSharePctFor(ean), proposal: null };
    }

    // Quantité qui aurait été proposée si on ignorait la commande RPOS récente hors plateforme —
    // sert à préremplir la saisie côté magasin quand il choisit de "débloquer" l'article malgré la
    // commande en cours, au lieu de le laisser retaper le calcul à la main.
    const quantityIfUnblocked = excludedAsAlreadyOrderedRpos
      ? computeQuantityToOrder(avgWeeklySales, stock, quantityInTransit, orderingUnit, config.safetyStockRatio, config.receptionLeadTimeDays, config.useReceptionLeadTimeInCalculation)
      : null;

    const avgDailySales = avgWeeklySales / 7;
    // Nombre de jours avant rupture au rythme de vente actuel si aucune commande n'est passée.
    // null si l'article ne se vend pas (pas de risque de rupture calculable).
    const daysUntilStockout = avgDailySales > 0 ? stock / avgDailySales : null;

    const revenueSharePct = shopTotalRevenue > 0 ? ((revenueByEan.get(ean) || 0) / shopTotalRevenue) * 100 : null;

    return {
      hadNegativeStockSkip,
      ean,
      label: art.label,
      revenueSharePct,
      proposal: {
        ean,
        label: art.label,
        avgWeeklySales,
        stock,
        daysUntilStockout,
        currentOrderedQuantity: orderedQty,
        orderingUnit,
        quantityProposed,
        productId: product.id,
        cumulativePct: Number(art.cumulative_pct),
        sellingPrice: Number(product.selling_price || 0),
        buyingPrice: Number(product.buying_price || 0),
        revenueSharePct,
        hadNegativeStock,
        actualStock,
        department,
        sector,
        seasonalityAdjusted: !!art.seasonality_adjusted,
        seasonalityDeviationPct: art.seasonality_deviation_pct ?? null,
        forecastMethod: art.forecast_method || 'flat',
        dailyHistory: art.daily_history || [],
        excludedAsAlreadyOrdered,
        excludedAsAlreadyOrderedRpos,
        quantityInTransit,
        // Référence + date de la commande créée par cette plateforme responsable de quantityInTransit
        // (badge "Déjà commandé"), pour indiquer au magasin où retrouver cette commande dans RPOS.
        platformOrderReference: excludedAsAlreadyOrdered ? (platformOrderInfoByEan.get(ean)?.reference || null) : null,
        platformOrderDate: excludedAsAlreadyOrdered ? (platformOrderInfoByEan.get(ean)?.date || null) : null,
        rposOrderReference: excludedAsAlreadyOrderedRpos ? recentRposOrder.mostRecentReference : null,
        rposOrderDate: excludedAsAlreadyOrderedRpos ? recentRposOrder.mostRecentDate : null,
        rposOrderCount: excludedAsAlreadyOrderedRpos ? recentRposOrder.orderCount : null,
        rposOrders: excludedAsAlreadyOrderedRpos ? recentRposOrder.orders : null,
        quantityIfUnblocked,
      },
    };
  }

  for (let i = 0; i < articles.length; i += CONCURRENCY) {
    const batch = articles.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(processArticle));
    for (const result of results) {
      if (!result) continue;
      if (result.skip) {
        skipped[result.skip].push({ ean: result.ean, label: result.label, revenueSharePct: result.revenueSharePct });
        continue;
      }
      if (result.hadNegativeStockSkip) skipped.negativeStock.push({ ean: result.ean, label: result.label, revenueSharePct: result.revenueSharePct });
      if (!result.proposal) continue;
      if (result.proposal.excludedAsAlreadyOrdered) skipped.alreadyOrdered.push({ ean: result.ean, label: result.label, revenueSharePct: result.revenueSharePct });
      proposals.push(result.proposal);
    }
  }

  proposals.sort((a, b) => b.avgWeeklySales - a.avgWeeklySales);

  console.log(`[proposalService] Génération terminée : ${proposals.length} proposition(s) (ignorés : ${skipped.notFound.length} introuvables, ${skipped.notOrderable.length} non commandables, ${skipped.negativeStock.length} stock négatif, ${skipped.alreadyOrdered.length} déjà commandés, ${skipped.genericArticle.length} génériques exclus)`);

  return {
    proposals,
    skipped,
    stats: {
      totalArticlesWithSales,
      totalArticlesAnalyzed: articles.length,
      proposalsGenerated: proposals.length,
      skippedNotFound: skipped.notFound.length,
      skippedNotOrderable: skipped.notOrderable.length,
      skippedNegativeStock: skipped.negativeStock.length,
      skippedAlreadyOrdered: skipped.alreadyOrdered.length,
      skippedGenericArticle: skipped.genericArticle.length,
      periodStart: period.start,
      periodEnd: period.end,
      periodMode: config.periodMode,
      paretoThreshold: config.paretoThreshold,
      safetyStockRatio: config.safetyStockRatio,
      receptionLeadTimeDays: config.receptionLeadTimeDays,
      salesSource,
      revenueSharePeriodDays: revenueShareDays,
      revenueShareStart,
      revenueShareEnd,
      shopTotalRevenue,
    },
  };
}

/**
 * Génère la proposition d'un magasin et la persiste en base (historisation, cf. readme section 16).
 * Appelée par le job planifié (nuit) ou manuellement pendant la phase pilote.
 */
async function generateAndSaveProposal({ posId, shopId, shopReference, shopName, limit, periodOverride }) {
  // On calcule d'abord la nouvelle proposition (appels RPOS potentiellement instables) avant de
  // toucher à l'ancienne : si RPOS échoue (502/503), le magasin garde sa proposition GENERATED
  // précédente au lieu de se retrouver sans aucune proposition en attente.
  const result = await generateProposal(posId, shopId, limit, shopReference, periodOverride);

  // Une seule proposition GENERATED active à la fois par magasin : on rejette l'ancienne
  // seulement maintenant que la nouvelle génération a réussi, pour ne jamais en accumuler plusieurs.
  await prisma.proposal.updateMany({
    where: { rposShopId: shopId, status: 'GENERATED' },
    data: { status: 'REJECTED' },
  });

  const proposal = await prisma.proposal.create({
    data: {
      rposShopId: shopId,
      rposShopReference: shopReference,
      rposShopName: shopName,
      rposPosId: posId,
      status: 'GENERATED',
      revenueShareStart: new Date(result.stats.revenueShareStart),
      revenueShareEnd: new Date(result.stats.revenueShareEnd),
      shopTotalRevenue: result.stats.shopTotalRevenue,
      analysisPeriodStart: new Date(result.stats.periodStart),
      analysisPeriodEnd: new Date(result.stats.periodEnd),
      analysisPeriodMode: result.stats.periodMode,
      paretoThresholdUsed: result.stats.paretoThreshold,
      safetyStockRatioUsed: result.stats.safetyStockRatio,
      receptionLeadTimeDaysUsed: result.stats.receptionLeadTimeDays,
      totalArticlesWithSales: result.stats.totalArticlesWithSales,
      skippedNotFound: result.stats.skippedNotFound,
      skippedNotOrderable: result.stats.skippedNotOrderable,
      skippedNegativeStock: result.stats.skippedNegativeStock,
      skippedAlreadyOrdered: result.stats.skippedAlreadyOrdered,
      skippedGenericArticle: result.stats.skippedGenericArticle,
      lines: {
        create: result.proposals.map((p) => ({
          ean: p.ean,
          label: p.label,
          productId: p.productId,
          quantitySuggested: p.quantityProposed,
          stockAtGeneration: p.stock,
          avgWeeklySales: p.avgWeeklySales,
          daysUntilStockout: p.daysUntilStockout,
          sellingPrice: p.sellingPrice,
          buyingPrice: p.buyingPrice,
          revenueSharePct: p.revenueSharePct,
          hadNegativeStock: p.hadNegativeStock,
          actualStock: p.actualStock,
          department: p.department,
          sector: p.sector,
          forecastMethod: p.forecastMethod,
          dailyHistory: p.dailyHistory && p.dailyHistory.length ? JSON.stringify(p.dailyHistory) : null,
          seasonalityAdjusted: p.seasonalityAdjusted,
          seasonalityDeviationPct: p.seasonalityDeviationPct,
          currentOrderedQuantity: p.currentOrderedQuantity,
          orderingUnit: p.orderingUnit,
          cumulativePct: p.cumulativePct,
          excludedAsAlreadyOrdered: p.excludedAsAlreadyOrdered,
          platformOrderReference: p.platformOrderReference,
          platformOrderDate: p.platformOrderDate ? new Date(p.platformOrderDate) : null,
          excludedAsAlreadyOrderedRpos: p.excludedAsAlreadyOrderedRpos,
          rposOrderReference: p.rposOrderReference,
          rposOrderDate: p.rposOrderDate ? new Date(p.rposOrderDate) : null,
          rposOrderCount: p.rposOrderCount,
          quantityIfUnblocked: p.quantityIfUnblocked,
          quantityInTransit: p.quantityInTransit,
        })),
      },
    },
    include: { lines: true },
  });

  const excludedArticleRows = [];
  for (const [reason, items] of Object.entries(result.skipped)) {
    for (const item of items) {
      excludedArticleRows.push({
        proposalId: proposal.id,
        ean: item.ean,
        label: item.label || null,
        revenueSharePct: item.revenueSharePct,
        reason,
      });
    }
  }
  if (excludedArticleRows.length) {
    await prisma.excludedArticle.createMany({ data: excludedArticleRows });
  }

  return { proposal, stats: result.stats };
}

/** Dernière proposition en attente de validation pour un magasin (status GENERATED). */
async function getPendingProposal(shopId) {
  return prisma.proposal.findFirst({
    where: { rposShopId: shopId, status: 'GENERATED' },
    orderBy: { generatedAt: 'desc' },
    include: { lines: true },
  });
}

/**
 * Démarre la validation d'une proposition : enregistre les décisions humaines et lance l'envoi
 * vers RPOS en tâche de fond (non attendue), pour ne pas bloquer la requête HTTP sur des centaines
 * de lignes envoyées une par une. Retourne immédiatement l'état "en cours".
 * @param {object} params
 * @param {string} params.proposalId
 * @param {string} params.shopId
 * @param {string} params.userEmail
 * @param {Array<{lineId: string, quantity: number, excluded: boolean}>} params.decisions
 * @param {object} params.orderHeader - { supplierId, orderDate, deliveryDate, externalReference, comment }
 */
async function startProposalValidation({ proposalId, posId, shopId, userEmail, decisions, orderHeader, validateAfterCreate }) {
  const proposal = await prisma.proposal.findUnique({ where: { id: proposalId }, include: { lines: true } });
  if (!proposal) throw new Error('Proposition introuvable');
  if (proposal.status !== 'GENERATED') throw new Error('Cette proposition a déjà été traitée ou est en cours de traitement');

  const config = await getConfig(shopId);
  const decisionByLineId = new Map(decisions.map((d) => [d.lineId, d]));

  const linesToOrder = [];
  for (const line of proposal.lines) {
    const decision = decisionByLineId.get(line.id);
    const excluded = decision ? !!decision.excluded : false;
    const quantity = decision && decision.quantity != null ? decision.quantity : line.quantitySuggested;

    await prisma.proposalLine.update({
      where: { id: line.id },
      data: { quantityValidated: excluded ? null : quantity, wasExcluded: excluded },
    });

    if (!excluded && quantity > 0) {
      linesToOrder.push({ lineId: line.id, productId: line.productId, quantity, orderingUnit: line.orderingUnit, department: line.department || 'Sans rayon' });
    }
  }

  if (linesToOrder.length === 0) {
    throw new Error('Aucun article sélectionné pour la commande');
  }

  await prisma.proposal.update({
    where: { id: proposalId },
    data: {
      status: 'VALIDATING',
      linesTotal: linesToOrder.length,
      linesProcessed: 0,
      linesFailed: 0,
    },
  });

  // Fire-and-forget : le traitement continue même après que la réponse HTTP est partie.
  runValidationInBackground({
    proposalId, posId, shopId, userEmail, linesToOrder, orderHeader, validateAfterCreate,
    splitByDepartment: config.splitOrdersByDepartment,
    receptionLeadTimeDays: config.receptionLeadTimeDays,
  }).catch((err) => {
    console.error(`[validateProposal] Échec fatal pour la proposition ${proposalId}:`, err);
    prisma.proposal.update({
      where: { id: proposalId },
      data: { status: 'VALIDATION_FAILED', validationError: err.message },
    }).catch(() => {});
  });

  return { proposalId, linesTotal: linesToOrder.length };
}

/**
 * Crée une commande fournisseur RPOS pour un groupe de lignes (un rayon, ou toutes les lignes si
 * la séparation par rayon est désactivée), et y ajoute chaque ligne. Retourne un résumé pour le
 * suivi de progression et l'historisation (ProposalOrder).
 */
async function createOrderForLines(posId, shopId, userEmail, department, lines, orderHeader, validateAfterCreate) {
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const referenceSuffix = department ? ` — ${department}` : '';

  const order = await rpos.createSupplierOrder(posId, {
    shopId,
    supplierId: orderHeader.supplierId,
    date: orderHeader.orderDate || now.toISOString().slice(0, 19),
    deliveryDate: orderHeader.deliveryDate || tomorrow.toISOString().slice(0, 10),
    externalReference: (orderHeader.externalReference || 'Proposition réassort') + referenceSuffix,
    comment: orderHeader.comment || `Validée par ${userEmail}`,
  });

  // Envoi par lots parallèles plutôt qu'une ligne à la fois (audit performance : une proposition de
  // plusieurs centaines de lignes pouvait prendre plusieurs minutes rien que pour cette étape,
  // prolongeant d'autant la fenêtre où la commande RPOS reste incomplète côté fournisseur).
  let processed = 0;
  let failed = 0;
  const LINE_CONCURRENCY = 5;
  await mapWithConcurrency(lines, LINE_CONCURRENCY, async (line) => {
    try {
      await rpos.addSupplierOrderLine(posId, {
        orderId: order.id,
        productId: line.productId,
        quantity: line.quantity,
        orderingUnit: line.orderingUnit,
      });
    } catch (err) {
      failed += 1;
      console.error(`[validateProposal] Ligne échouée (produit ${line.productId}, rayon ${department}):`, err.message);
    }
    processed += 1;
  });

  let rposOrderValidated = null;
  if (validateAfterCreate) {
    try {
      await rpos.validateSupplierOrder(posId, { orderId: order.id, deliveryDate: orderHeader.deliveryDate });
      rposOrderValidated = true;
    } catch (err) {
      // La commande reste "en préparation" côté RPOS : ce n'est pas un échec de l'envoi des
      // articles (déjà réussi à ce stade), on le signale distinctement sans marquer la
      // proposition entière en échec.
      console.error(`[validateProposal] Validation RPOS échouée pour la commande ${order.id} (rayon ${department}):`, err.message);
      rposOrderValidated = false;
    }
  }

  return { order, processed, failed, rposOrderValidated };
}

async function runValidationInBackground({ proposalId, posId, shopId, userEmail, linesToOrder, orderHeader, validateAfterCreate, splitByDepartment, receptionLeadTimeDays }) {
  // Regroupe les lignes par rayon (ou un seul groupe "toutes lignes" si la séparation est
  // désactivée), pour créer une commande fournisseur distincte par rayon (readme §11).
  const groups = new Map();
  if (splitByDepartment) {
    for (const line of linesToOrder) {
      const key = line.department || 'Sans rayon';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(line);
    }
  } else {
    groups.set(null, linesToOrder);
  }

  let totalProcessed = 0;
  let totalFailed = 0;
  let firstOrder = null;
  let overallValidated = null;

  // Date de réception prévue = maintenant + délai de réception configuré pour ce magasin, figée
  // au moment de la validation (readme évolution, gestion des délais de réception par magasin).
  const leadDays = receptionLeadTimeDays ?? 1;
  const expectedReceptionDate = new Date(Date.now() + leadDays * 24 * 60 * 60 * 1000);

  for (const [department, lines] of groups) {
    const proposalOrder = await prisma.proposalOrder.create({
      data: {
        proposalId, department: department || 'Toutes lignes', linesTotal: lines.length, status: 'PENDING',
        expectedReceptionDate,
      },
    });

    try {
      const { order, processed, failed, rposOrderValidated } = await createOrderForLines(
        posId, shopId, userEmail, department, lines, orderHeader, validateAfterCreate
      );

      // Statut métier de réception initial : EN_ATTENTE_RECEPTION si transmise à l'entrepôt
      // (validée sur RPOS), sinon COMMANDEE (créée mais encore "en préparation" côté RPOS).
      const receptionStatus = rposOrderValidated ? 'EN_ATTENTE_RECEPTION' : 'COMMANDEE';

      await prisma.proposalOrder.update({
        where: { id: proposalOrder.id },
        data: {
          rposOrderId: order.id,
          rposOrderReference: order.reference,
          rposOrderValidated,
          linesFailed: failed,
          status: failed === lines.length ? 'FAILED' : 'DONE',
          receptionStatus,
          lastRposStatus: rposOrderValidated ? 2 : 1,
          lastSyncedAt: new Date(),
        },
      });

      if (!firstOrder) firstOrder = order;
      totalProcessed += processed;
      totalFailed += failed;
      overallValidated = overallValidated === false ? false : rposOrderValidated;
    } catch (err) {
      console.error(`[validateProposal] Échec de création de la commande pour le rayon ${department}:`, err.message);
      await prisma.proposalOrder.update({
        where: { id: proposalOrder.id },
        data: { status: 'FAILED', linesFailed: lines.length, errorMessage: err.message },
      });
      totalFailed += lines.length;
      overallValidated = false;
    }

    // On rafraîchit la progression après chaque rayon traité, pas après chaque ligne, pour ne pas
    // multiplier les écritures DB sur des propositions de plusieurs centaines de lignes.
    await prisma.proposal.update({
      where: { id: proposalId },
      data: { linesProcessed: totalProcessed, linesFailed: totalFailed },
    });
  }

  const order = firstOrder;
  const rposOrderValidated = overallValidated;
  const processed = totalProcessed;
  const failed = totalFailed;

  await prisma.proposal.update({
    where: { id: proposalId },
    data: {
      rposOrderId: order?.id,
      rposOrderReference: order?.reference,
      status: 'VALIDATED',
      validatedAt: new Date(),
      validatedBy: userEmail,
      linesProcessed: processed,
      linesFailed: failed,
      rposOrderValidated,
    },
  });
}

/** État courant d'une proposition en cours ou terminée de validation (pour le suivi de progression). */
async function getProposalStatus(proposalId) {
  return prisma.proposal.findUnique({
    where: { id: proposalId },
    select: {
      id: true,
      status: true,
      linesTotal: true,
      linesProcessed: true,
      linesFailed: true,
      validationError: true,
      rposOrderReference: true,
      rposOrderValidated: true,
      orders: {
        select: {
          department: true, rposOrderId: true, rposOrderReference: true,
          rposOrderValidated: true, linesTotal: true, linesFailed: true, status: true, errorMessage: true,
        },
      },
    },
  });
}

/**
 * Taux de conformité : proportion des lignes validées sans aucune modification humaine
 * (quantité identique à la suggestion, non exclue), sur l'ensemble des propositions validées.
 * Sert à décider quand basculer un magasin/article en validation automatique (readme section 17).
 */
async function getConformityRate(shopId) {
  const lines = await prisma.proposalLine.findMany({
    where: {
      proposal: { rposShopId: shopId, status: 'VALIDATED' },
    },
  });

  if (lines.length === 0) return { rate: null, totalLines: 0, unchangedLines: 0 };

  const unchanged = lines.filter(
    (l) => !l.wasExcluded && l.quantityValidated === l.quantitySuggested
  ).length;

  return {
    rate: unchanged / lines.length,
    totalLines: lines.length,
    unchangedLines: unchanged,
  };
}

/**
 * Taux de rupture : proportion des articles proposés qui étaient déjà en rupture (stock épuisé
 * au rythme de vente actuel) au moment de la génération de la proposition, sur les propositions
 * validées. Sert à mesurer si le réassort automatique intervient suffisamment tôt (cf. readme §17).
 */
async function getStockoutRate(shopId) {
  const lines = await prisma.proposalLine.findMany({
    where: {
      proposal: { rposShopId: shopId, status: 'VALIDATED' },
      wasExcluded: false,
      daysUntilStockout: { not: null },
    },
    select: { daysUntilStockout: true },
  });

  if (lines.length === 0) return { rate: null, totalLines: 0, stockoutLines: 0 };

  const stockoutLines = lines.filter((l) => l.daysUntilStockout <= 0).length;

  return {
    rate: stockoutLines / lines.length,
    totalLines: lines.length,
    stockoutLines,
  };
}

/**
 * Taux de surstock : proportion des articles dont la quantité finalement commandée dépasse
 * largement le besoin théorique (vente moyenne + stock de sécurité), signe d'une correction
 * manuelle excessive à la hausse par le magasin (cf. readme §17). Le seuil de dépassement
 * (overstockThresholdMultiplier, 1.5 par défaut) est configurable par magasin dans les Paramètres.
 */
async function getOverstockRate(shopId) {
  const config = await getConfig(shopId);
  const lines = await prisma.proposalLine.findMany({
    where: {
      proposal: { rposShopId: shopId, status: 'VALIDATED' },
      wasExcluded: false,
      quantityValidated: { not: null },
      avgWeeklySales: { not: null },
    },
    select: { quantityValidated: true, avgWeeklySales: true },
  });

  if (lines.length === 0) return { rate: null, totalLines: 0, overstockLines: 0 };

  const threshold = config.overstockThresholdMultiplier || 1.5;
  const overstockLines = lines.filter((l) => {
    const theoreticalNeed = l.avgWeeklySales * (1 + config.safetyStockRatio);
    return theoreticalNeed > 0 && l.quantityValidated > theoreticalNeed * threshold;
  }).length;

  return {
    rate: overstockLines / lines.length,
    totalLines: lines.length,
    overstockLines,
  };
}

/**
 * Vue globale multi-magasins pour le tableau de bord administrateur (readme §32) : agrège les
 * propositions de tous les magasins ayant un compte STORE actif, sans exposer le détail des
 * lignes (juste des compteurs), pour ne pas alourdir la requête sur un grand nombre de magasins.
 */
async function getAdminDashboard() {
  const shops = await prisma.user.findMany({
    where: { role: 'STORE', isActive: true, rposShopId: { not: null } },
    distinct: ['rposShopId'],
    select: { rposShopId: true, rposShopReference: true, rposShopName: true, rposPosId: true },
  });

  const shopIds = shops.map((s) => s.rposShopId);

  // Fenêtre glissante de 90 jours (audit performance) : sans borne de date, ces requêtes chargeaient
  // TOUT l'historique validé de TOUS les magasins depuis le début du système à chaque affichage du
  // dashboard admin, avec une croissance non bornée dans le temps. 90 jours reste largement
  // suffisant pour les taux de conformité/rupture affichés (indicateurs de tendance récente, pas
  // un historique complet).
  const dashboardWindowStart = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const [pendingCounts, validatedProposals, allValidatedLines] = await Promise.all([
    prisma.proposal.groupBy({
      by: ['rposShopId'],
      where: { rposShopId: { in: shopIds }, status: 'GENERATED' },
      _count: true,
    }),
    prisma.proposal.findMany({
      where: { rposShopId: { in: shopIds }, status: 'VALIDATED', validatedAt: { gte: dashboardWindowStart } },
      select: { rposShopId: true, validatedAt: true, rposOrderReference: true },
      orderBy: { validatedAt: 'desc' },
    }),
    prisma.proposalLine.findMany({
      where: { proposal: { rposShopId: { in: shopIds }, status: 'VALIDATED', validatedAt: { gte: dashboardWindowStart } } },
      select: {
        proposal: { select: { rposShopId: true } },
        wasExcluded: true,
        quantitySuggested: true,
        quantityValidated: true,
        daysUntilStockout: true,
      },
    }),
  ]);

  const pendingByShop = new Map(pendingCounts.map((p) => [p.rposShopId, p._count]));
  const validatedByShop = new Map();
  for (const p of validatedProposals) {
    if (!validatedByShop.has(p.rposShopId)) validatedByShop.set(p.rposShopId, []);
    validatedByShop.get(p.rposShopId).push(p);
  }

  let totalLines = 0;
  let unchangedLines = 0;
  let stockoutLines = 0;
  let stockoutEligible = 0;
  const perShopLines = new Map();

  for (const line of allValidatedLines) {
    const shopId = line.proposal.rposShopId;
    if (!perShopLines.has(shopId)) perShopLines.set(shopId, { total: 0, unchanged: 0, stockout: 0, stockoutEligible: 0 });
    const bucket = perShopLines.get(shopId);

    if (!line.wasExcluded) {
      totalLines += 1;
      bucket.total += 1;
      if (line.quantityValidated === line.quantitySuggested) {
        unchangedLines += 1;
        bucket.unchanged += 1;
      }
      if (line.daysUntilStockout !== null && line.daysUntilStockout !== undefined) {
        stockoutEligible += 1;
        bucket.stockoutEligible += 1;
        if (line.daysUntilStockout <= 0) {
          stockoutLines += 1;
          bucket.stockout += 1;
        }
      }
    }
  }

  const perShop = shops.map((s) => {
    const bucket = perShopLines.get(s.rposShopId) || { total: 0, unchanged: 0, stockout: 0, stockoutEligible: 0 };
    const validated = validatedByShop.get(s.rposShopId) || [];
    return {
      rposShopId: s.rposShopId,
      rposShopReference: s.rposShopReference,
      rposShopName: s.rposShopName,
      rposPosId: s.rposPosId,
      pendingProposals: pendingByShop.get(s.rposShopId) || 0,
      validatedProposals: validated.length,
      lastValidatedAt: validated[0]?.validatedAt || null,
      conformityRate: bucket.total > 0 ? bucket.unchanged / bucket.total : null,
      stockoutRate: bucket.stockoutEligible > 0 ? bucket.stockout / bucket.stockoutEligible : null,
    };
  });

  const stockoutAlertThreshold = parseFloat(
    await systemConfig.getValue(systemConfig.KEYS.ADMIN_DASHBOARD_STOCKOUT_ALERT_THRESHOLD)
  ) || 0.30;

  return {
    totalShops: shops.length,
    shopsWithPendingProposal: pendingCounts.length,
    totalPendingProposals: pendingCounts.reduce((sum, p) => sum + p._count, 0),
    totalValidatedProposals: validatedProposals.length,
    globalConformityRate: totalLines > 0 ? unchangedLines / totalLines : null,
    globalStockoutRate: stockoutEligible > 0 ? stockoutLines / stockoutEligible : null,
    stockoutAlertThreshold,
    perShop,
  };
}

/**
 * Précision des prévisions (readme §17) : compare, pour chaque ligne validée dont la fenêtre de
 * mesure est écoulée, la vente moyenne prévue (avgWeeklySales, ramenée à la durée de la fenêtre)
 * à la quantité réellement vendue sur cette même fenêtre après validation. Calculé à la demande
 * (pas de job), avec mise en cache par ligne car une fenêtre passée ne change plus jamais.
 */
async function getForecastAccuracy(shopId) {
  const config = await getConfig(shopId);
  const windowDays = config.forecastAccuracyWindowDays ?? 7;
  const thresholdPct = config.forecastAccuracyThresholdPct ?? 20;
  const now = new Date();

  const lines = await prisma.proposalLine.findMany({
    where: {
      proposal: { rposShopId: shopId, status: 'VALIDATED' },
      wasExcluded: false,
      avgWeeklySales: { not: null, gt: 0 },
    },
    include: { proposal: { select: { validatedAt: true, rposPosId: true, rposShopId: true } } },
  });

  let evaluated = 0;
  let accurate = 0;

  for (const line of lines) {
    const validatedAt = line.proposal.validatedAt;
    if (!validatedAt) continue;

    const windowEnd = new Date(new Date(validatedAt).getTime() + windowDays * 24 * 60 * 60 * 1000);
    if (windowEnd > now) continue; // fenêtre pas encore écoulée : pas encore évaluable

    let actualQuantity = line.actualSalesQuantity;
    if (actualQuantity === null || actualQuantity === undefined) {
      // Jamais mesuré : interroge RPOS une seule fois puis met en cache (la période est figée).
      actualQuantity = await rpos.getSalesQuantityForProductInPeriod(
        line.proposal.rposPosId,
        line.proposal.rposShopId,
        line.ean,
        new Date(validatedAt).toISOString().slice(0, 19),
        windowEnd.toISOString().slice(0, 19)
      );
      await prisma.proposalLine.update({
        where: { id: line.id },
        data: { actualSalesQuantity: actualQuantity, actualSalesFetchedAt: new Date() },
      });
    }

    const expectedQuantity = (line.avgWeeklySales / 7) * windowDays;
    if (expectedQuantity <= 0) continue;

    const deviationPct = Math.abs(actualQuantity - expectedQuantity) / expectedQuantity * 100;
    evaluated += 1;
    if (deviationPct <= thresholdPct) accurate += 1;
  }

  return {
    rate: evaluated > 0 ? accurate / evaluated : null,
    evaluatedLines: evaluated,
    accurateLines: accurate,
    windowDays,
    thresholdPct,
  };
}

module.exports = {
  generateProposal,
  computeQuantityToOrder,
  generateAndSaveProposal,
  getPendingProposal,
  startProposalValidation,
  getProposalStatus,
  getConformityRate,
  getStockoutRate,
  getOverstockRate,
  getAdminDashboard,
  getForecastAccuracy,
};
