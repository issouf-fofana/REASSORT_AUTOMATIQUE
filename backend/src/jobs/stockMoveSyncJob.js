/**
 * Job planifié : synchronise localement les mouvements de stock RPOS (/api/stock_move/) de chaque
 * magasin actif, pour que le chatbot ("pourquoi le stock a bougé", mouvement de stock d'un article)
 * lise la base locale au lieu d'attendre un appel RPOS en direct à chaque question (4-5s mesurés le
 * 15/10/2026 même sur un réseau Prosuma normal, contre <100ms pour les outils déjà basés sur une
 * table locale comme SalesLine).
 *
 * Même structure que salesSyncJob.js (synchro incrémentale via *SyncState, overlap, réconciliation),
 * avec une différence clé : /api/stock_move/ renvoie un vrai id UUID par mouvement (confirmé par
 * test direct le 15/10/2026), donc pas de schéma de dédup composite à gérer comme pour SalesLine
 * (qui doit composer une dedupKey approximative faute d'identifiant RPOS natif).
 *
 * Confirmé par test direct le 15/10/2026 : GET /api/stock_move/ accepte shop+date_0+date_1 SANS
 * product__ean et renvoie bien TOUS les mouvements du magasin sur la période, avec product_ean/
 * product_label_1 déjà inclus dans chaque ligne (pagination standard page/page_size/next_page/
 * final_page, comme /api/end_of_life_product/) — contrairement à la fonction existante
 * getStockMovesForProduct (rposClient.js), qui exige toujours un EAN précis, ce job appelle l'API
 * directement sans ce filtre pour couvrir tout le magasin en un minimum d'appels.
 */
const prisma = require('../utils/prisma');
const rpos = require('../services/rposClient');
const rposServers = require('../services/rposServersService');
const systemConfig = require('../services/systemConfigService');
const { mapWithConcurrency } = require('../utils/concurrency');
const { resolveEpisodesFromArrivalMoves } = require('../services/stockoutEpisodeService');

// Marge de recouvrement : comme salesSyncJob, pour couvrir les mouvements arrivés en retard côté
// RPOS (synchro différée d'une caisse hors-ligne) qu'une synchro strictement incrémentale manquerait.
const OVERLAP_MINUTES = 30;

// Taille de page RPOS : même valeur que salesSyncJob (SYNC_PAGE_SIZE), cohérente avec le reste du
// projet. Le volume mesuré le 15/10/2026 (4651 mouvements/jour sur un seul magasin) implique souvent
// plusieurs pages par synchro incrémentale sur un magasin à fort trafic.
const SYNC_PAGE_SIZE = 250;

/**
 * Récupère UNE page de mouvements de stock pour tout un magasin (pas un article précis), sans
 * passer par getStockMovesForProduct (rposClient.js) qui exige toujours product__ean — fonction
 * dédiée à cette synchro magasin-entier, pagination complète via next_page/final_page (confirmé
 * identique au pattern de getAllEndOfLifeProducts).
 */
async function fetchStockMovePage(posId, shopId, dateStart, dateEnd, page, pageSize) {
  const data = await rpos.getStockMovesPageForShop(posId, shopId, dateStart, dateEnd, page, pageSize);
  return data;
}

/**
 * Récupère et sauvegarde les mouvements de stock d'un magasin sur [start, now], en paginant
 * directement (même raisonnement que fetchAndSaveWindow dans salesSyncJob.js : éviter une limite de
 * lignes par appel sur un magasin à fort volume).
 */
async function fetchAndSaveWindow(posId, shopId, start, now) {
  const dateStart = start.toISOString().slice(0, 19);
  const dateEnd = now.toISOString().slice(0, 19);
  let page = 1;
  let allRawMoves = [];

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const pageResult = await fetchStockMovePage(posId, shopId, dateStart, dateEnd, page, SYNC_PAGE_SIZE);
    allRawMoves = allRawMoves.concat(pageResult.results);
    if (!pageResult.nextPage) break;
    page = pageResult.nextPage;
  }

  const rows = toStockMoveRows(allRawMoves, posId, shopId);
  if (rows.length > 0) {
    // rpos_move_id est un vrai identifiant unique RPOS (contrairement à la dedupKey composite de
    // SalesLine) : skipDuplicates suffit seul à éviter tout doublon, même sur un mouvement déjà vu
    // lors d'un cycle de synchro précédent (fenêtre d'overlap).
    await prisma.stockMove.createMany({ data: rows, skipDuplicates: true });
  }

  // `rows` retourné en plus du count (demande explicite du 19/10/2026 : "il me dis arrivage ok mais
  // il continue de compté pourquoi ?") — permet à syncShop() de résoudre immédiatement les
  // épisodes de rupture concernés par un nouvel Arrivage, sans attendre le prochain StockSnapshot.
  return rows;
}

// Fenêtre de réconciliation : même raisonnement que salesSyncJob (RPOS peut répondre incomplet sans
// lever d'erreur sur une dégradation ponctuelle).
const RECONCILE_HOURS = 48;

async function windowNeedsReconciliation(posId, shopId, start, now) {
  const dateStart = start.toISOString().slice(0, 19);
  const dateEnd = now.toISOString().slice(0, 19);
  const rposPage = await fetchStockMovePage(posId, shopId, dateStart, dateEnd, 1, 1);
  const localCount = await prisma.stockMove.count({ where: { rposShopId: shopId, date: { gte: start, lte: now } } });
  return rposPage.count !== localCount;
}

async function syncShop(posId, shop, logger) {
  const shopId = shop.id;
  const shopLabel = `${shop.reference || shopId}${shop.name ? ' — ' + shop.name : ''}`;
  const shopStartedAt = new Date();
  const state = await prisma.stockMoveSyncState.findUnique({ where: { rposShopId: shopId } });
  const now = new Date();

  const start = state?.lastSyncedUntil
    ? new Date(state.lastSyncedUntil.getTime() - OVERLAP_MINUTES * 60 * 1000)
    : new Date(now.getTime() - 24 * 60 * 60 * 1000); // pas d'historique connu : 24h par défaut

  try {
    // Purge d'abord la fenêtre de recouvrement (même principe que salesSyncJob : un mouvement
    // corrigé/annulé côté RPOS entre deux synchros ne doit pas laisser de doublon obsolète).
    await prisma.stockMove.deleteMany({ where: { rposShopId: shopId, date: { gte: start, lte: now } } });

    const rows = await fetchAndSaveWindow(posId, shopId, start, now);

    const reconcileStart = new Date(now.getTime() - RECONCILE_HOURS * 60 * 60 * 1000);
    if (reconcileStart < start) {
      const needsReconcile = await windowNeedsReconciliation(posId, shopId, reconcileStart, start);
      if (needsReconcile) {
        console.warn(`[stockMoveSyncJob] ${shop.reference || shopId} (${posId}) : écart détecté sur ${reconcileStart.toISOString()} -> ${start.toISOString()}, réimport...`);
        await prisma.stockMove.deleteMany({ where: { rposShopId: shopId, date: { gte: reconcileStart, lte: start } } });
        const reconciledRows = await fetchAndSaveWindow(posId, shopId, reconcileStart, start);
        rows.push(...reconciledRows);
        console.log(`[stockMoveSyncJob] ${shop.reference || shopId} (${posId}) : réconciliation terminée, ${reconciledRows.length} mouvement(s) réimporté(s).`);
      }
    }

    // Résout immédiatement les ruptures EN_COURS dont un nouvel Arrivage vient d'être synchronisé
    // (demande explicite du 19/10/2026 : "il me dis arrivage ok mais il continue de compté
    // pourquoi ?") — sans attendre le prochain StockSnapshot (toutes les 6h par défaut).
    const arrivalMoves = rows.filter((r) => ['Arrivage', 'Arrivage manuel'].includes(r.typeLabel));
    if (arrivalMoves.length) {
      const resolved = await resolveEpisodesFromArrivalMoves(shopId, arrivalMoves);
      if (resolved > 0) {
        console.log(`[stockMoveSyncJob] ${shop.reference || shopId} (${posId}) : ${resolved} rupture(s) résolue(s) immédiatement grâce à un arrivage détecté.`);
      }
    }

    await prisma.stockMoveSyncState.upsert({
      where: { rposShopId: shopId },
      update: { lastSyncedUntil: now, lastSyncStatus: 'ok', lastSyncError: null },
      create: { rposPosId: posId, rposShopId: shopId, lastSyncedUntil: now, lastSyncStatus: 'ok' },
    });

    console.log(`[stockMoveSyncJob] ${shop.reference || shopId} (${posId}) : ${rows.length} mouvement(s) synchronisé(s) (${start.toISOString()} -> ${now.toISOString()})`);
    logger?.shopResult({
      rposShopId: shopId, shopLabel, status: 'success',
      detail: `${rows.length} mouvement(s) synchronisé(s)`,
      startedAt: shopStartedAt, finishedAt: new Date(),
    });
  } catch (err) {
    console.error(`[stockMoveSyncJob] Échec pour ${shop.reference || shopId} (${posId}):`, err.message);
    await prisma.stockMoveSyncState.upsert({
      where: { rposShopId: shopId },
      update: { lastSyncStatus: 'error', lastSyncError: err.message },
      create: { rposPosId: posId, rposShopId: shopId, lastSyncStatus: 'error', lastSyncError: err.message },
    });
    logger?.shopResult({
      rposShopId: shopId, shopLabel, status: 'error',
      errorMessage: err.message,
      startedAt: shopStartedAt, finishedAt: new Date(),
    });
  }
}

// Même concurrence que salesSyncJob (4 magasins en parallèle par serveur RPOS partagé).
const SHOP_CONCURRENCY_PER_SERVER = 4;
// BUG DE PERFORMANCE CORRIGÉ le 23/10/2026 (signalé : "Articles les plus vendus" et d'autres
// widgets bloqués ~15s en "Chargement..." — pas un calcul lent côté route, mesuré à 375ms en
// isolation, mais la base/l'instance saturées PENDANT que ce job tournait) — Promise.all sur TOUS
// les serveurs RPOS actifs (~18 en prod) × 4 magasins chacun = jusqu'à ~72 synchronisations en
// écriture simultanées, chacune insérant des milliers de lignes (11573/15051/16655 mesurés en un
// seul passage), saturant le pool de connexions Prisma/PostgreSQL et ralentissant TOUTE requête
// HTTP concurrente, pas seulement celle-ci. mapWithConcurrency limite désormais le nombre de
// SERVEURS traités en même temps (le nombre de magasins en parallèle PAR serveur reste inchangé),
// au prix d'un temps total de passage plus long — acceptable pour un job de fond, contrairement à
// une page que l'utilisateur attend activement.
const SERVER_CONCURRENCY = 3;

async function runStockMoveSync(logger) {
  const servers = await rposServers.listServers();
  const activeServers = servers.filter((s) => s.isActive && s.rposUser && s.rposPassword);

  console.log(`[stockMoveSyncJob] Synchronisation démarrée sur ${activeServers.length} serveur(s)...`);
  logger?.log(`Synchronisation démarrée sur ${activeServers.length} serveur(s).`);

  await mapWithConcurrency(activeServers, SERVER_CONCURRENCY, async (server) => {
    let shops;
    try {
      shops = await rpos.getShops(server.posId);
    } catch (err) {
      console.error(`[stockMoveSyncJob] Impossible de lister les magasins de ${server.posId}:`, err.message);
      logger?.shopResult({ rposShopId: server.posId, shopLabel: `Serveur ${server.posId}`, status: 'error', errorMessage: `Liste des magasins indisponible : ${err.message}` });
      return;
    }
    await mapWithConcurrency(shops, SHOP_CONCURRENCY_PER_SERVER, (shop) => syncShop(server.posId, shop, logger));
  });

  console.log('[stockMoveSyncJob] Synchronisation terminée.');
  logger?.log('Synchronisation terminée.');
}

function toStockMoveRows(moves, posId, shopId) {
  return moves
    .filter((m) => m.id && m.product_ean)
    .map((m) => ({
      rposMoveId: String(m.id),
      rposPosId: posId,
      rposShopId: shopId,
      ean: String(m.product_ean).trim(),
      label: m.product_label_1 || null,
      date: new Date(m.date),
      typeLabel: m.stock_move_type_label,
      recording: m._recording || null,
      isScrap: !!m._isScrap,
      quantity: parseFloat(String(m.quantity || 0).replace(',', '.')) || 0,
      previousQuantity: m.previous_quantity != null ? parseFloat(String(m.previous_quantity).replace(',', '.')) || 0 : null,
    }));
}

module.exports = { runStockMoveSync };
