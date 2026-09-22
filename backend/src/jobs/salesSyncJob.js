/**
 * Job planifié : synchronise localement les ventes RPOS (/api/product_line/) de chaque magasin
 * actif, pour que la génération de proposition et le graphique d'évolution d'un article lisent
 * la base locale au lieu d'attendre plusieurs minutes de pagination RPOS à chaque consultation.
 *
 * Synchronisation incrémentale : pour chaque magasin, on ne récupère que les ventes depuis la
 * dernière date synchronisée (SalesSyncState.lastSyncedUntil), jamais tout l'historique à chaque
 * exécution. Le tout premier passage pour un magasin doit donc être amorcé avec un backfill plus
 * large (cf. runInitialBackfillForShop) sous peine de repartir de "maintenant" et de ne jamais
 * couvrir l'historique passé.
 */
const prisma = require('../utils/prisma');
const rpos = require('../services/rposClient');
const rposServers = require('../services/rposServersService');
const systemConfig = require('../services/systemConfigService');
const { mapWithConcurrency } = require('../utils/concurrency');


// Marge de recouvrement : on resynchronise toujours un peu avant la dernière date connue, pour
// couvrir les ventes qui seraient arrivées en retard côté RPOS (ex: caisse hors-ligne synchronisée
// après coup) et qu'une synchro strictement après lastSyncedUntil aurait manquées.
const OVERLAP_MINUTES = 30;

// Taille de tranche pour la synchro incrémentale : bien plus petite que celle du backfill initial
// (TARGET_LINES_PER_CHUNK=400k dans salesBackfillService.js), car ce job tourne toutes les 15 min
// sur 18 serveurs à la suite — une seule tranche par magasin doit rester rapide pour ne pas
// monopoliser un serveur RPOS partagé pendant que les 17 autres magasins attendent leur tour.
const SYNC_PAGE_SIZE = 250;

/**
 * Récupère et sauvegarde les ventes d'un magasin sur [start, now], en paginant directement (pas
 * via getProductLinesForPeriod, qui échoue au-delà de MAX_SALES_LINES_PER_GENERATION) : un magasin
 * à fort volume peut dépasser cette limite même sur une fenêtre de 24h+30min d'overlap, ce qui
 * faisait échouer sa synchro à chaque exécution (toutes les 15 min, indéfiniment).
 */
async function fetchAndSaveWindow(posId, shopId, start, now) {
  const dateStart = start.toISOString().slice(0, 19);
  const dateEnd = now.toISOString().slice(0, 19);
  let page = 1;
  let allRawLines = [];

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const pageResult = await rpos.fetchProductLinesPage(posId, shopId, dateStart, dateEnd, page, SYNC_PAGE_SIZE);
    allRawLines = allRawLines.concat(pageResult.results);
    if (!pageResult.nextPage) break;
    page = pageResult.nextPage;
  }

  // Toutes les lignes de la fenêtre collectées AVANT de calculer dedupKey (pas page par page) :
  // deux ventes en collision (même EAN/date/qté/montant à la même seconde, cf. toSalesLineRows)
  // pourraient sinon tomber sur deux pages différentes et échapper à l'indexation qui les distingue.
  const rows = toSalesLineRows(allRawLines, posId, shopId);
  if (rows.length > 0) {
    await prisma.salesLine.createMany({ data: rows, skipDuplicates: true });
  }

  return rows.length;
}

// Fenêtre de réconciliation : RPOS peut parfois répondre incomplet sur une page sans lever
// d'erreur (dégradation serveur, coupure réseau ponctuelle non fatale) — la synchro incrémentale
// avance alors silencieusement lastSyncedUntil sans avoir tout récupéré, et l'overlap de 30 min
// ne rattrape rien passé ce délai. Après chaque synchro, on recompare donc le total RPOS vs local
// sur les dernières 48h et on réimporte la fenêtre entière au moindre écart.
const RECONCILE_HOURS = 48;

/**
 * Compare rapidement le nombre de lignes RPOS et locales sur [start, now] (un seul appel RPOS,
 * page_size=1, pour ne lire que `count`) : si les totaux diffèrent, retourne true et le job
 * réimporte toute la fenêtre pour combler l'écart, quel qu'il soit.
 */
async function windowNeedsReconciliation(posId, shopId, start, now) {
  const dateStart = start.toISOString().slice(0, 19);
  const dateEnd = now.toISOString().slice(0, 19);
  const rposPage = await rpos.fetchProductLinesPage(posId, shopId, dateStart, dateEnd, 1, 1);
  const localCount = await prisma.salesLine.count({ where: { rposShopId: shopId, date: { gte: start, lte: now } } });
  return rposPage.count !== localCount;
}

async function syncShop(posId, shop) {
  const shopId = shop.id;
  const state = await prisma.salesSyncState.findUnique({ where: { rposShopId: shopId } });
  const now = new Date();

  const start = state?.lastSyncedUntil
    ? new Date(state.lastSyncedUntil.getTime() - OVERLAP_MINUTES * 60 * 1000)
    : new Date(now.getTime() - 24 * 60 * 60 * 1000); // pas d'historique connu : 24h par défaut

  try {
    // Purge d'abord la fenêtre de recouvrement pour éviter les doublons côté suppression (la
    // dédup à l'insertion via dedupKey+skipDuplicates suffirait seule, mais deleteMany reste utile
    // si une vente a été corrigée/annulée côté RPOS entre deux synchros).
    await prisma.salesLine.deleteMany({ where: { rposShopId: shopId, date: { gte: start, lte: now } } });

    const totalLines = await fetchAndSaveWindow(posId, shopId, start, now);

    // Réconciliation : si la fenêtre récente (48h) ne correspond plus entre RPOS et le local,
    // probable trou silencieux d'un cycle précédent — on réimporte toute la fenêtre pour le combler.
    const reconcileStart = new Date(now.getTime() - RECONCILE_HOURS * 60 * 60 * 1000);
    if (reconcileStart < start) {
      const needsReconcile = await windowNeedsReconciliation(posId, shopId, reconcileStart, start);
      if (needsReconcile) {
        console.warn(`[salesSyncJob] ${shop.reference || shopId} (${posId}) : écart détecté sur ${reconcileStart.toISOString()} -> ${start.toISOString()}, réimport...`);
        await prisma.salesLine.deleteMany({ where: { rposShopId: shopId, date: { gte: reconcileStart, lte: start } } });
        const reconciledLines = await fetchAndSaveWindow(posId, shopId, reconcileStart, start);
        console.log(`[salesSyncJob] ${shop.reference || shopId} (${posId}) : réconciliation terminée, ${reconciledLines} ligne(s) réimportée(s).`);
      }
    }

    await prisma.salesSyncState.upsert({
      where: { rposShopId: shopId },
      update: { lastSyncedUntil: now, lastSyncStatus: 'ok', lastSyncError: null },
      create: { rposPosId: posId, rposShopId: shopId, lastSyncedUntil: now, lastSyncStatus: 'ok' },
    });

    console.log(`[salesSyncJob] ${shop.reference || shopId} (${posId}) : ${totalLines} ligne(s) synchronisée(s) (${start.toISOString()} -> ${now.toISOString()})`);
  } catch (err) {
    console.error(`[salesSyncJob] Échec pour ${shop.reference || shopId} (${posId}):`, err.message);
    await prisma.salesSyncState.upsert({
      where: { rposShopId: shopId },
      update: { lastSyncStatus: 'error', lastSyncError: err.message },
      create: { rposPosId: posId, rposShopId: shopId, lastSyncStatus: 'error', lastSyncError: err.message },
    });
  }
}

// Les 18 serveurs RPOS sont des hôtes distincts (pas de contention partagée entre eux) : traités
// tous en parallèle. À l'intérieur d'un même serveur, les magasins partagent le même hôte RPOS,
// donc une concurrence modérée évite de le saturer tout en restant bien plus rapide que le
// traitement strictement séquentiel d'avant (audit performance : ce job tourne toutes les 15 min,
// un cycle trop long sur beaucoup de magasins finissait par chevaucher le suivant).
const SHOP_CONCURRENCY_PER_SERVER = 4;

async function runSalesSync() {
  const servers = await rposServers.listServers();
  const activeServers = servers.filter((s) => s.isActive && s.rposUser && s.rposPassword);

  // Restriction optionnelle à une liste de magasins précise (Paramètres > Synchronisation des
  // ventes) : vide = comportement historique, tous les magasins actifs de tous les serveurs.
  const shopIdsConfig = await systemConfig.getValue(systemConfig.KEYS.SALES_SYNC_SHOP_IDS);
  const restrictedShopIds = shopIdsConfig ? shopIdsConfig.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const restrictToShops = restrictedShopIds.length > 0;

  console.log(`[salesSyncJob] Synchronisation démarrée sur ${activeServers.length} serveur(s)` +
    (restrictToShops ? ` (restreinte à ${restrictedShopIds.length} magasin(s))` : '') + '...');

  await Promise.all(activeServers.map(async (server) => {
    let shops;
    try {
      shops = await rpos.getShops(server.posId);
    } catch (err) {
      console.error(`[salesSyncJob] Impossible de lister les magasins de ${server.posId}:`, err.message);
      return;
    }
    if (restrictToShops) shops = shops.filter((shop) => restrictedShopIds.includes(shop.id));
    await mapWithConcurrency(shops, SHOP_CONCURRENCY_PER_SERVER, (shop) => syncShop(server.posId, shop));
  }));

  console.log('[salesSyncJob] Synchronisation terminée.');
}

function toSalesLineRows(lines, posId, shopId) {
  // Ne filtre plus les EAN non-numériques (ex: "D10130999999" - articles génériques RPOS) : ces
  // ventes sont réelles et doivent être stockées pour que le CA total du magasin reste exact (même
  // correctif que salesBackfillService.js, cf. son commentaire). Le filtre EAN numérique reste
  // appliqué au moment du calcul Pareto/réassort (proposalService.js).
  //
  // Bug corrigé le 22/09/2026 (écarts constatés en prod : "17619 ventes réelles, 17617
  // synchronisées", CA différent en conséquence) : deux ventes RÉELLES et DISTINCTES (même EAN,
  // même quantité, même montant, à LA MÊME SECONDE — un magasin avec plusieurs caisses actives en
  // même temps) produisaient l'ancienne dedupKey identique (`shop|ean|date|qté|montant`), donc la
  // seconde était silencieusement perdue par le skipDuplicates de createMany (contrainte unique en
  // base, dedupKey). Pire : une resynchronisation ne corrigeait jamais ce cas précis, puisqu'elle
  // retombait exactement sur la même collision à chaque nouvelle tentative.
  //
  // receipt.id (ticket de caisse, ajouté le 16/09/2026) aurait été le désambiguïsant naturel, mais
  // n'est pas fourni par tous les serveurs RPOS (constaté : 0% des lignes en ont un sur ce serveur,
  // même après son ajout) — donc jamais fiable seul. À la place : un index de collision calculé ICI
  // sur l'ensemble du lot reçu de RPOS (avant toute pagination), qui numérote chaque occurrence
  // supplémentaire d'un même (ean, date, quantité, montant) dans CE lot. La toute première
  // occurrence garde EXACTEMENT l'ancienne dedupKey (compatibilité totale avec les lignes déjà
  // synchronisées avant ce correctif — cf. commentaire historique retiré ci-dessus, qui redoutait à
  // raison de casser la déduplication existante) ; seules les occurrences suivantes (2e, 3e...)
  // reçoivent un suffixe `#n` qui les distingue, sans jamais changer la clé des lignes déjà en base.
  const collisionCount = new Map();
  return lines
    .filter((l) => l.ean)
    .map((l) => {
      const ean = String(l.ean).trim();
      const date = new Date(l.date).toISOString();
      const quantity = parseFloat(String(l.quantity || 0).replace(',', '.')) || 0;
      const revenueExclTax = parseFloat(String(l.total_excl_tax || 0).replace(',', '.')) || 0;
      // total_incl_tax n'est pas garanti présent selon la version/config RPOS d'un serveur donné :
      // null plutôt que 0 si absent, pour ne pas afficher un TTC faux à 0 CFA.
      const revenueInclTax = l.total_incl_tax !== undefined && l.total_incl_tax !== null
        ? parseFloat(String(l.total_incl_tax).replace(',', '.')) || 0
        : null;
      const baseKey = `${shopId}|${ean}|${date}|${quantity}|${revenueExclTax}`;
      const occurrence = collisionCount.get(baseKey) || 0;
      collisionCount.set(baseKey, occurrence + 1);
      return {
        rposPosId: posId,
        rposShopId: shopId,
        ean,
        label: l.label_1 || null,
        date: new Date(date),
        quantity,
        revenueExclTax,
        revenueInclTax,
        // Ticket de caisse (receipt.id) : ajouté le 16/09/2026 pour compter le vrai nombre de
        // ventes (tickets distincts), pas juste le nombre de lignes d'articles — null si RPOS ne le
        // renvoie pas (config/version de serveur différente), jamais une valeur inventée.
        receiptId: l.receipt && l.receipt.id ? String(l.receipt.id) : null,
        dedupKey: occurrence === 0 ? baseKey : `${baseKey}|#${occurrence}`,
      };
    });
}

/**
 * Backfill initial pour un magasin : à utiliser une seule fois (manuellement) pour peupler
 * l'historique avant d'activer la synchro incrémentale régulière, sous peine que celle-ci ne
 * couvre que les dernières 24h faute de SalesSyncState existant.
 *
 * Découpe la période totale en tranches de `chunkDays` jours, traitées séquentiellement : un
 * magasin à fort volume (ex: 8000+ lignes/jour) dépasse vite la limite RPOS par appel
 * (MAX_SALES_LINES_PER_GENERATION, 20000) si on demande 90 jours d'un coup — en tranches de
 * quelques jours, chaque appel individuel reste sous la limite, quel que soit le volume total
 * demandé au final. Callback de progression optionnel : onProgress(daysDone, totalDays, lineCount).
 */
async function runInitialBackfillForShop(posId, shopId, shopReference, days = 90, chunkDays = 1, onProgress) {
  const now = new Date();
  const totalStart = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  console.log(`[salesSyncJob] Backfill initial ${shopReference || shopId} (${posId}) sur ${days} jours, par tranches de ${chunkDays} jour(s)...`);

  let totalLines = 0;
  let chunkEnd = now;

  while (chunkEnd > totalStart) {
    const chunkStart = new Date(Math.max(totalStart.getTime(), chunkEnd.getTime() - chunkDays * 24 * 60 * 60 * 1000));

    const lines = await rpos.getProductLinesForPeriod(
      posId,
      shopId,
      chunkStart.toISOString().slice(0, 19),
      chunkEnd.toISOString().slice(0, 19)
    );

    await prisma.$transaction([
      prisma.salesLine.deleteMany({ where: { rposShopId: shopId, date: { gte: chunkStart, lte: chunkEnd } } }),
      prisma.salesLine.createMany({ data: toSalesLineRows(lines, posId, shopId), skipDuplicates: true }),
    ]);

    totalLines += lines.length;
    const daysDone = Math.round((now.getTime() - chunkStart.getTime()) / (24 * 60 * 60 * 1000));
    console.log(`[salesSyncJob] Tranche ${chunkStart.toISOString()} -> ${chunkEnd.toISOString()} : ${lines.length} ligne(s) (${totalLines} au total)`);
    if (onProgress) onProgress(daysDone, days, totalLines);

    chunkEnd = chunkStart;
  }

  await prisma.salesSyncState.upsert({
    where: { rposShopId: shopId },
    update: { lastSyncedUntil: now, lastSyncStatus: 'ok', lastSyncError: null },
    create: { rposPosId: posId, rposShopId: shopId, lastSyncedUntil: now, lastSyncStatus: 'ok' },
  });

  console.log(`[salesSyncJob] Backfill terminé : ${totalLines} ligne(s) pour ${shopReference || shopId}.`);
  return totalLines;
}

module.exports = { runSalesSync, runInitialBackfillForShop };
