const { Agent } = require('undici');
const systemConfig = require('./systemConfigService');
const rposServers = require('./rposServersService');
const crypto = require('./cryptoService');

// Marqueur ajouté systématiquement au début de external_reference sur les commandes
// créées par cette plateforme, pour les distinguer des commandes créées manuellement dans RPOS.
const PLATFORM_MARKER = '[REASSORT-IA]';

// L'environnement RPOS utilise un certificat auto-signé (cf. test_api.py: verify=False).
// undici (fetch natif de Node) ignore l'option `agent` classique: il faut un `dispatcher`.
const insecureDispatcher = new Agent({ connect: { rejectUnauthorized: false } });

// Petit cache mémoire (30s) par serveur : les identifiants de chaque posId sont lus depuis la
// base à chaque requête sinon. Un admin qui vient de changer des identifiants attend au plus 30s.
const serverCache = new Map(); // posId -> { config, cachedAt }
const retryCache = { value: null, cachedAt: 0 };
const CACHE_TTL_MS = 30_000;

async function getServerConfig(posId) {
  const now = Date.now();
  const cached = serverCache.get(posId);
  if (cached && now - cached.cachedAt < CACHE_TTL_MS) return cached.config;

  const server = await rposServers.getServer(posId);
  if (!server) throw new Error(`Serveur RPOS inconnu: ${posId}`);
  if (!server.rposUser || !server.rposPassword) {
    throw new Error(`Aucun identifiant configuré pour le serveur ${posId} (${server.label})`);
  }

  // rposPassword est stocké chiffré en base (cf. rposServersService.js) : déchiffré ici, au point
  // d'usage réel (auth HTTP Basic vers RPOS), jamais conservé en clair au-delà de ce cache mémoire
  // de courte durée (CACHE_TTL_MS).
  const config = { baseUrl: server.baseUrl, user: server.rposUser, password: crypto.decrypt(server.rposPassword) };
  serverCache.set(posId, { config, cachedAt: now });
  return config;
}

async function getRetryConfig() {
  const now = Date.now();
  if (retryCache.value && now - retryCache.cachedAt < CACHE_TTL_MS) return retryCache.value;

  const [retryAttempts, retryDelayMs] = await Promise.all([
    systemConfig.getValue(systemConfig.KEYS.RPOS_RETRY_ATTEMPTS),
    systemConfig.getValue(systemConfig.KEYS.RPOS_RETRY_DELAY_MS),
  ]);
  retryCache.value = { retryAttempts: parseInt(retryAttempts, 10) || 3, retryDelayMs: parseInt(retryDelayMs, 10) || 500 };
  retryCache.cachedAt = now;
  return retryCache.value;
}

/** Invalide le cache immédiatement (appelé après modification des identifiants d'un serveur depuis l'UI). */
function invalidateRposConfigCache(posId) {
  if (posId) serverCache.delete(posId);
  else serverCache.clear();
  retryCache.value = null;
}

function authHeader(user, password) {
  const token = Buffer.from(`${user}:${password}`).toString('base64');
  return `Basic ${token}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Sans ce timeout, un appel RPOS lancé alors que le réseau Prosuma est injoignable (VPN coupé, hors
// site) pouvait rester en attente très longtemps avant que Node ne détecte l'échec (contrairement à
// une résolution DNS qui échoue vite avec ENOTFOUND, une connexion qui ne répond jamais côté réseau
// ne déclenche pas systématiquement d'erreur rapide) — bloquant par exemple le panneau "Analyser"
// d'un article, qui dépend d'un appel RPOS (profil d'activité du magasin) avant même d'atteindre le
// LLM. 15s laisse largement le temps à RPOS de répondre en usage normal (quelques centaines de ms à
// quelques secondes) tout en donnant un échec rapide et clair en cas de réseau réellement coupé.
const RPOS_REQUEST_TIMEOUT_MS = 15000;

/**
 * RPOS retourne parfois des 502/503 transitoires sous charge, sans lien avec la validité de la
 * requête (observé de façon reproductible sur des requêtes par ailleurs identiques et valides).
 * On retente automatiquement ces statuts avant d'abandonner.
 */
async function rposGet(posId, path, params = {}) {
  const { baseUrl, user, password } = await getServerConfig(posId);
  const { retryAttempts, retryDelayMs } = await getRetryConfig();
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }

  for (let attempt = 1; attempt <= retryAttempts; attempt++) {
    let res;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), RPOS_REQUEST_TIMEOUT_MS);
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: authHeader(user, password) },
        dispatcher: insecureDispatcher,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      // fetch échoue avant même d'obtenir une réponse HTTP (DNS injoignable, connexion refusée,
      // pas de réseau, timeout...) : sans ce catch, l'erreur brute undici ("fetch failed", cause
      // dans err.cause) remontait telle quelle jusqu'à l'UI, peu compréhensible pour l'utilisateur.
      const cause = err.cause;
      // UND_ERR_CONNECT_TIMEOUT : timeout de connexion natif d'undici (le serveur ne répond pas du
      // tout au niveau TCP, ex: réseau Prosuma injoignable) — distinct de mon propre AbortController
      // ci-dessus (RPOS_REQUEST_TIMEOUT_MS), qui se déclenche plus tard si la connexion s'établit
      // mais que la réponse HTTP elle-même ne vient jamais. Les deux sont des absences de réseau du
      // point de vue de l'utilisateur, à traiter pareil (retry rapide, puis message clair).
      const isTimeout = err.name === 'AbortError' || cause?.code === 'UND_ERR_CONNECT_TIMEOUT';
      const isNetworkError = isTimeout || (cause && ['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN'].includes(cause.code));
      // Une seule retentative rapide (pas le nombre complet de retryAttempts avec délai croissant) :
      // contrairement à un 502/503 (le serveur répond mais est temporairement indisponible, où
      // patienter un peu aide), une résolution DNS/connexion qui échoue ne se rétablit typiquement
      // pas en 500ms-1s. Sur une page qui interroge 18 serveurs (ex: GET /servers), l'ancien
      // comportement (jusqu'à 3 tentatives × délai croissant PAR serveur) pouvait faire attendre
      // l'utilisateur 15-20+ secondes avant d'afficher une simple erreur réseau.
      if (isNetworkError && attempt === 1 && retryAttempts > 1) {
        console.warn(`[rposClient] GET ${path} -> réseau injoignable (${isTimeout ? 'timeout' : cause.code}), 1 nouvel essai rapide dans 300ms...`);
        await sleep(300);
        continue;
      }
      if (isNetworkError) {
        throw new Error(`Serveur RPOS "${posId}" injoignable (${isTimeout ? `aucune réponse après ${RPOS_REQUEST_TIMEOUT_MS / 1000}s` : cause.code === 'ENOTFOUND' ? 'nom d\'hôte introuvable' : 'connexion impossible'}) — vérifiez la connexion réseau/VPN.`);
      }
      throw err;
    }
    clearTimeout(timeoutId);

    if (res.ok) {
      if (attempt > 1) console.log(`[rposClient] GET ${path} OK après ${attempt} tentative(s)`);
      return res.json();
    }

    const isTransient = res.status === 502 || res.status === 503 || res.status === 504;
    if (isTransient && attempt < retryAttempts) {
      console.warn(`[rposClient] GET ${path} -> ${res.status} (tentative ${attempt}/${retryAttempts}), nouvel essai dans ${retryDelayMs * attempt}ms...`);
      await sleep(retryDelayMs * attempt);
      continue;
    }

    const text = await res.text().catch(() => '');
    console.error(`[rposClient] GET ${path} -> ${res.status} définitivement en échec après ${attempt} tentative(s)`);
    throw new Error(`RPOS GET ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  }
}

async function rposPost(posId, path, body) {
  const { baseUrl, user, password } = await getServerConfig(posId);
  const url = new URL(path, baseUrl);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: authHeader(user, password),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    dispatcher: insecureDispatcher,
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }

  if (!res.ok) {
    const err = new Error(`RPOS POST ${path} -> ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

async function rposPatch(posId, path, body) {
  const { baseUrl, user, password } = await getServerConfig(posId);
  const url = new URL(path, baseUrl);
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: authHeader(user, password),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    dispatcher: insecureDispatcher,
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }

  if (!res.ok) {
    const err = new Error(`RPOS PATCH ${path} -> ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

// Cache mémoire de la liste des magasins d'un serveur : change très rarement, pas la peine de
// resolliciter RPOS à chaque chargement de page (sélecteur de magasin admin/superviseur affiché
// sur presque toutes les pages).
const shopsCache = new Map(); // posId -> { shops, cachedAt }
const SHOPS_CACHE_TTL_MS = 5 * 60 * 1000;

async function getShops(posId) {
  const cached = shopsCache.get(posId);
  if (cached && Date.now() - cached.cachedAt < SHOPS_CACHE_TTL_MS) return cached.shops;

  const data = await rposGet(posId, '/api/shop/', { page_size: 100, fields: 'id,reference,name' });
  const shops = data.results || [];
  shopsCache.set(posId, { shops, cachedAt: Date.now() });
  return shops;
}

/** Récupère les infos produit (stock, unité de commande, commandable) pour un EAN sur un magasin. */
async function getProductByEan(posId, shopId, ean) {
  const data = await rposGet(posId, '/api/product/', { shop: shopId, ean });
  const results = data.results || [];
  return results[0] || null;
}

// Filtre ean__in supporté par /api/product/ (confirmé par test direct) : sur un magasin à cache
// froid (1000+ articles Pareto), un appel par lot de ~200 EAN remplace ~200 appels individuels,
// principal goulot de la génération de proposition (audit performance). page_size doit couvrir la
// taille du lot pour ne pas tronquer silencieusement la réponse.
const PRODUCT_BATCH_SIZE = 200;

async function getProductsByEans(posId, shopId, eans) {
  const byEan = new Map();
  for (let i = 0; i < eans.length; i += PRODUCT_BATCH_SIZE) {
    const batch = eans.slice(i, i + PRODUCT_BATCH_SIZE);
    const data = await rposGet(posId, '/api/product/', {
      shop: shopId,
      ean__in: batch.join(','),
      page_size: PRODUCT_BATCH_SIZE,
    });
    for (const product of data.results || []) {
      if (product.ean) byEan.set(String(product.ean).trim(), product);
    }
  }
  return byEan;
}

// Cache mémoire du nom de rayon principal (racine de la hiérarchie department) par serveur+id :
// il y a très peu de rayons distincts par magasin (une dizaine), pas la peine de refaire l'appel
// hiérarchie RPOS pour chaque article qui partage le même sous-rayon.
const departmentRootCache = new Map(); // `${posId}:${departmentId}` -> { name, cachedAt }
const DEPARTMENT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Nom du rayon principal (premier niveau de la hiérarchie department) pour un article, utilisé
 * pour regrouper les commandes fournisseur par rayon (readme §11). Le produit RPOS ne renvoie que
 * le sous-rayon direct ; il faut remonter la hiérarchie complète (path[0]) pour le vrai rayon.
 */
async function getDepartmentRootName(posId, departmentId) {
  if (!departmentId) return 'Sans rayon';

  const cacheKey = `${posId}:${departmentId}`;
  const cached = departmentRootCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < DEPARTMENT_CACHE_TTL_MS) return cached.name;

  const department = await rposGet(posId, `/api/department/${departmentId}/`, {});
  const rootName = department.path?.[0]?.name || department.name || 'Sans rayon';
  departmentRootCache.set(cacheKey, { name: rootName, cachedAt: Date.now() });
  return rootName;
}

// Cache mémoire distinct pour la hiérarchie secteur+rayon (2 premiers niveaux), utilisée par la
// vue "secteur > rayon" de la page Proposition de commande — même principe que
// departmentRootCache mais garde aussi le niveau intermédiaire (path[1]).
const departmentHierarchyCache = new Map(); // `${posId}:${departmentId}` -> { sector, rayon, cachedAt }

/**
 * Secteur (path[0], ex: "PRODUITS SECS", "BAZAR") et rayon (path[1], ex: "LIQUIDES",
 * "EPICERIE FINE SEC") d'un article, pour la navigation à deux niveaux demandée : un responsable
 * de secteur clique sur son secteur, puis choisit le rayon précis à l'intérieur. La hiérarchie
 * RPOS peut avoir plus de 2 niveaux au total (jusqu'à 4 observés), mais seuls les deux premiers
 * sont exploités ici — le reste (sous-rayon, article) n'est pas affiché séparément.
 */
async function getDepartmentHierarchy(posId, departmentId) {
  if (!departmentId) return { sector: 'Sans secteur', rayon: 'Sans rayon' };

  const cacheKey = `${posId}:${departmentId}`;
  const cached = departmentHierarchyCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < DEPARTMENT_CACHE_TTL_MS) {
    return { sector: cached.sector, rayon: cached.rayon };
  }

  const department = await rposGet(posId, `/api/department/${departmentId}/`, {});
  const path = department.path || [];
  const sector = path[0]?.name || department.name || 'Sans secteur';
  // Si l'article n'a qu'un seul niveau de hiérarchie, le rayon se confond avec le secteur —
  // plutôt que d'afficher "Sans rayon" pour un article qui a bien un classement, juste peu profond.
  const rayon = path[1]?.name || sector;

  departmentHierarchyCache.set(cacheKey, { sector, rayon, cachedAt: Date.now() });
  return { sector, rayon };
}

async function createSupplierOrder(posId, { shopId, supplierId, date, deliveryDate, externalReference, comment }) {
  const taggedReference = `${PLATFORM_MARKER} ${externalReference || ''}`.trim();
  return rposPost(posId, '/api/supplier_order/', {
    shop: shopId,
    supplier: supplierId,
    date,
    delivery_date: deliveryDate,
    external_reference: taggedReference,
    hide_buying_prices: true,
    extras: comment ? { commentaire: comment } : {},
  });
}

/**
 * Ajoute une ligne à une commande fournisseur RPOS.
 *
 * BUG CRITIQUE DÉCOUVERT ET CORRIGÉ ICI (07/09/2026) : le champ `quantity` du payload POST est
 * silencieusement IGNORÉ par RPOS — confirmé par test direct (envoi de quantity=2 puis quantity=5
 * sur un article de colisage 12 : dans les deux cas RPOS a créé la ligne avec quantity=12,
 * c'est-à-dire 1 seul colis, quelle que soit la valeur envoyée). RPOS calcule en réalité
 * `quantity = ordering_unit_envoyé × colisage_produit`, où `ordering_unit` est le nombre de COLIS
 * ("Quantité UC" dans l'UI RPOS), pas le champ `quantity`. Résultat concret : depuis la mise en
 * production de ce système, TOUTES les commandes envoyées à RPOS ont livré 1 seul colis par
 * article (le minimum RPOS), indépendamment du besoin réellement calculé — potentiellement des
 * mois de sous-approvisionnement silencieux.
 *
 * @param {number} quantity - besoin en UNITÉS INDIVIDUELLES, déjà arrondi à un multiple du
 *   colisage par computeQuantityToOrder (ex: 24 pour 2 colis de 12). `quantity` reste requis dans
 *   le payload (RPOS renvoie 400 sans lui) mais sa valeur n'a aucun effet sur la quantité réelle.
 * @param {number} orderingUnit - colisage du produit (ProductCache.orderingUnit / product.ordering_unit),
 *   nécessaire pour convertir `quantity` (unités) en nombre de colis à envoyer dans `ordering_unit`.
 */
async function addSupplierOrderLine(posId, { orderId, productId, quantity, orderingUnit }) {
  const unit = orderingUnit || 1;
  // Math.ceil (jamais Math.round) : RPOS n'accepte que des colis entiers ("ordering_unit" arrondi
  // côté RPOS de toute façon si on lui envoyait une fraction, cf. test direct), et on ne veut
  // jamais arrondir VERS LE BAS un besoin réel — un colis entamé compte pour un colis complet,
  // quitte à légèrement sur-livrer plutôt que sous-livrer. `quantity` est normalement déjà un
  // multiple exact du colisage (computeQuantityToOrder arrondit en amont), donc ce Math.ceil est
  // une sécurité pour les cas limites (quantité corrigée manuellement, arrondi flottant), pas le
  // chemin normal. Minimum 1 colis dès qu'un besoin non nul a été calculé (RPOS refuse 0).
  const nbColis = Math.max(1, Math.ceil(quantity / unit));
  return rposPost(posId, '/api/supplier_order_line/', {
    order: orderId,
    product: productId,
    quantity,
    ordering_unit: nbColis,
  });
}

/**
 * Valide une commande fournisseur sur RPOS : passe son statut de 1 ("en préparation") à
 * 2 ("en attente de livraison"), ce qui la transmet à l'entrepôt. Confirmé par inspection directe
 * de l'API (OPTIONS sur /api/supplier_order/{id}/ : champ "status" écrivable, choix 2 = "en attente
 * de livraison") et testé avec succès sur une commande réelle.
 */
async function validateSupplierOrder(posId, { orderId, deliveryDate }) {
  const body = { status: 2 };
  if (deliveryDate) body.delivery_date = deliveryDate;
  return rposPatch(posId, `/api/supplier_order/${orderId}/`, body);
}

/**
 * Annule une commande fournisseur sur RPOS (statut 6 = "annulée"). Utile pour nettoyer des
 * commandes créées par erreur ou pour un test, sans laisser une commande fantôme "en préparation"
 * qui bloquerait ensuite la génération de nouvelles propositions (cf. getPendingPlatformOrderedEans).
 */
async function cancelSupplierOrder(posId, orderId) {
  return rposPatch(posId, `/api/supplier_order/${orderId}/`, { status: 6 });
}

/**
 * Récupère l'ensemble des EAN déjà présents dans une commande de notre plateforme non livrée
 * (statut "en préparation" ou "en attente de livraison") pour un magasin.
 * Sert à éviter de reproposer un article déjà commandé mais pas encore réceptionné,
 * car RPOS ne reflète pas toujours cela dans current_ordered_quantity côté produit.
 */
/**
 * Quantité en transit par EAN pour les commandes de cette plateforme non encore reçues (statut
 * RPOS 1 ou 2). Utilise quantity_to_be_delivered plutôt que quantity brute : sur une réception
 * partielle (statut 3), une partie de la commande est déjà arrivée et ne doit plus compter comme
 * "en transit". Retourne une Map<ean, quantité en transit> plutôt qu'un simple Set, pour permettre
 * d'afficher la quantité déjà en commande au lieu de juste exclure l'article silencieusement.
 */
async function getPendingPlatformOrderedEans(posId, shopId) {
  const data = await rposGet(posId, '/api/supplier_order/', {
    shop: shopId,
    is_deleted: 'false',
    external_reference__icontains: PLATFORM_MARKER,
    status__in: '1,2,3,4', // en préparation, en attente de livraison, livrée/finalisée partiellement
    page_size: 250,
  });

  const orders = data.results || [];
  const quantityByEan = new Map();
  // Référence + date de la commande la plus récente par EAN, pour afficher "déjà commandé dans
  // la commande X du [date]" plutôt qu'un badge sans indication d'où retrouver cette commande.
  const orderInfoByEan = new Map();

  for (const order of orders) {
    const linesData = await rposGet(posId, '/api/supplier_order_line/', {
      order: order.id,
      page_size: 250,
    });
    for (const line of linesData.results || []) {
      if (!line.ean) continue;
      const inTransit = line.quantity_to_be_delivered !== undefined
        ? Number(line.quantity_to_be_delivered)
        : Number(line.quantity) - Number(line.delivered_quantity || 0);
      if (inTransit <= 0) continue; // entièrement reçue : ne compte plus comme en transit
      quantityByEan.set(line.ean, (quantityByEan.get(line.ean) || 0) + inTransit);
      const existing = orderInfoByEan.get(line.ean);
      if (!existing || new Date(order.date) > new Date(existing.date)) {
        orderInfoByEan.set(line.ean, { reference: order.reference, date: order.date });
      }
    }
  }

  return { quantityByEan, orderInfoByEan };
}

// Au-delà de ce délai, une commande fournisseur RPOS jamais marquée "livrée" n'est plus un
// signal fiable de besoin déjà couvert : sur les commandes centrales, RPOS ne reflète jamais la
// réception réelle (cf. receptionSyncJob.js), donc des commandes très anciennes (parfois
// plusieurs mois) restent indéfiniment "en attente" et masqueraient un vrai besoin de recommander
// si on les prenait en compte sans limite de date. Valeur par défaut si aucune n'est fournie par
// l'appelant (cf. ReassortConfig.recentOrderMaxAgeDays, réglable par magasin dans Paramètres).
const DEFAULT_RECENT_UNDELIVERED_ORDER_MAX_AGE_DAYS = 3;

/**
 * Quantité récemment commandée pour un article et non encore marquée livrée, en ne comptant que
 * les commandes des maxAgeDays derniers jours. Retourne aussi la commande la plus récente
 * (référence + date) pour affichage.
 *
 * IMPORTANT : le filtre RPOS order__date__gte sur /api/supplier_order_line/ est silencieusement
 * ignoré par l'API (vérifié : renvoie le même total avec ou sans ce paramètre) — le filtrage par
 * âge de commande doit donc se faire côté client, sur order.date de chaque ligne reçue. Ce bug
 * faisait qu'une commande vieille de plusieurs mois bloquait indéfiniment le réassort d'un article
 * pourtant épuisé depuis longtemps.
 */
async function getRecentUndeliveredOrderedQuantity(posId, shopId, productId, maxAgeDays) {
  const effectiveMaxAgeDays = maxAgeDays || DEFAULT_RECENT_UNDELIVERED_ORDER_MAX_AGE_DAYS;
  const minDate = new Date(Date.now() - effectiveMaxAgeDays * 24 * 60 * 60 * 1000);
  // is_delivered est silencieusement ignoré par RPOS (confirmé par test direct : filtrer sur
  // is_delivered=true, qui ne devrait renvoyer aucune ligne sur ce produit, renvoyait quand même
  // les 26 lignes is_delivered=false réelles — même bug que order__date__gte déjà connu sur ce
  // même endpoint). Filtrage client-side ci-dessous, comme déjà fait pour la date.
  const data = await rposGet(posId, '/api/supplier_order_line/', {
    shop: shopId,
    product: productId,
    page_size: 250,
    ordering: '-order__date',
  });
  const results = (data.results || []).filter((line) => {
    if (line.is_delivered) return false;
    const orderDate = line.order?.date;
    return orderDate && new Date(orderDate) >= minDate;
  });
  let quantity = 0;
  const orders = [];
  for (const line of results) {
    const remaining = line.quantity_to_be_delivered !== undefined
      ? Number(line.quantity_to_be_delivered)
      : Number(line.quantity) - Number(line.delivered_quantity || 0);
    if (remaining <= 0) continue;
    quantity += remaining;
    orders.push({
      id: line.order?.id ?? null,
      reference: line.order?.reference || null,
      date: line.order?.date || null,
      quantity: Number(line.quantity),
      quantityRemaining: remaining,
    });
  }
  const mostRecent = orders[0];

  // Statut RPOS de la commande bloquante (1=en préparation, 2=en attente de livraison/"validée",
  // 6=annulée — cf. validateSupplierOrder/cancelSupplierOrder) : demandé côté UI pour distinguer
  // "déjà commandé et validé" de "commande créée mais pas encore transmise à l'entrepôt", plutôt
  // que d'afficher seulement la référence/date sans dire si la commande est allée plus loin.
  let mostRecentStatus = null;
  if (mostRecent?.id) {
    try {
      mostRecentStatus = await getSupplierOrderStatus(posId, mostRecent.id);
    } catch {
      mostRecentStatus = null; // ne bloque jamais le calcul de quantité pour un statut indisponible
    }
  }

  return {
    quantity,
    orderCount: orders.length,
    orders,
    mostRecentDate: mostRecent?.date || null,
    mostRecentReference: mostRecent?.reference || null,
    mostRecentStatus,
  };
}

/** Dernière ligne de commande fournisseur pour un produit donné (date + quantité du dernier achat). */
async function getLastPurchaseForProduct(posId, shopId, productId) {
  const data = await rposGet(posId, '/api/supplier_order_line/', {
    shop: shopId,
    product: productId,
    page_size: 1,
    // Trié sur la date réelle de la commande (et non created_at, qui reflète l'instant où la ligne
    // a été insérée dans RPOS) : sinon une commande de test créée aujourd'hui masquerait le vrai
    // dernier achat historique du magasin.
    ordering: '-order__date',
  });
  const results = data.results || [];
  if (!results.length) return null;
  const line = results[0];
  return {
    date: line.order?.date || line.created_at,
    quantity: line.quantity,
    orderReference: line.order?.reference,
  };
}

/**
 * Historique des commandes fournisseur passées pour un article (toutes, pas seulement la
 * dernière), pour marquer les points de commande sur la courbe d'évolution d'un article
 * ("à quel moment il y a eu plusieurs achats sur un article").
 *
 * order__date__gte/__lte sont silencieusement ignorés par RPOS (même bug déjà constaté sur
 * getRecentUndeliveredOrderedQuantity) : sans filtrage client-side, RPOS renvoie ses 250
 * dernières lignes toutes périodes confondues, ce qui rendait le graphique d'évolution lent à
 * l'ouverture ET pouvait afficher des commandes hors de la période demandée.
 */
async function getPurchaseHistoryForProduct(posId, shopId, productId, dateStart, dateEnd) {
  const data = await rposGet(posId, '/api/supplier_order_line/', {
    shop: shopId,
    product: productId,
    page_size: 250,
    ordering: '-order__date',
  });
  const start = new Date(dateStart);
  const end = new Date(dateEnd);
  return (data.results || [])
    .map((line) => ({
      date: line.order?.date || line.created_at,
      quantity: Number(line.quantity) || 0,
      orderReference: line.order?.reference,
    }))
    .filter((o) => o.date && new Date(o.date) >= start && new Date(o.date) <= end);
}

/** Dernière ligne de vente enregistrée pour un article donné (date + quantité de la dernière vente). */
async function getLastSaleForProduct(posId, shopId, ean) {
  const data = await rposGet(posId, '/api/product_line/', {
    shop: shopId,
    ean,
    page_size: 1,
    ordering: '-date',
    fields: 'date,quantity',
  });
  const results = data.results || [];
  if (!results.length) return null;
  const line = results[0];
  return { date: line.date, quantity: line.quantity };
}

/**
 * Somme des quantités vendues d'un article sur une période donnée (readme §17, précision des
 * prévisions). Contrairement à getProductLinesForPeriod (toutes les ventes du magasin), on filtre
 * ici par EAN pour ne récupérer que les lignes de l'article concerné, en paginant si besoin.
 */
async function getSalesQuantityForProductInPeriod(posId, shopId, ean, dateStart, dateEnd) {
  const pageSize = 250;
  let page = 1;
  let sum = 0;

  do {
    const data = await rposGet(posId, '/api/product_line/', {
      shop: shopId,
      ean,
      date_0: dateStart,
      date_1: dateEnd,
      page_size: pageSize,
      page,
      fields: 'quantity',
    });
    for (const line of data.results || []) {
      sum += Number(line.quantity) || 0;
    }
    if (!data.next_page) break;
    page = data.next_page;
  } while (page);

  return sum;
}

/**
 * Détail des ventes d'un article sur une période, ligne par ligne (date + quantité), pour
 * construire une courbe d'évolution (évolution demandée : "je dois avoir sur un article
 * l'évolution d'achat sur la période"). Contrairement à getSalesQuantityForProductInPeriod (une
 * seule somme), on garde chaque vente individuelle — l'agrégation par jour/semaine/mois se fait
 * ensuite côté appelant selon la durée de la période demandée.
 */
const salesHistoryCache = new Map();
const SALES_HISTORY_CACHE_TTL_MS = 5 * 60 * 1000;

async function getSalesHistoryForProduct(posId, shopId, ean, dateStart, dateEnd) {
  const cacheKey = `${posId}|${shopId}|${ean}|${dateStart}|${dateEnd}`;
  const cached = salesHistoryCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < SALES_HISTORY_CACHE_TTL_MS) return cached.lines;

  const pageSize = 1000;
  let page = 1;
  const lines = [];

  do {
    const data = await rposGet(posId, '/api/product_line/', {
      shop: shopId,
      ean,
      date_0: dateStart,
      date_1: dateEnd,
      page_size: pageSize,
      page,
      fields: 'date,quantity,total_excl_tax',
    });
    for (const line of data.results || []) {
      lines.push({ date: line.date, quantity: Number(line.quantity) || 0, revenue: Number(line.total_excl_tax) || 0 });
    }
    if (!data.next_page) break;
    page = data.next_page;
  } while (page);

  salesHistoryCache.set(cacheKey, { lines, cachedAt: Date.now() });
  return lines;
}

/** Vérifie si une commande fournisseur RPOS existe toujours (non supprimée). */
/**
 * Date de la PREMIÈRE vente jamais enregistrée pour un magasin (ISO string), ou null si aucune —
 * symétrique de getLastSaleDate ci-dessus, mais RPOS n'expose aucune limite de rétention connue à
 * l'avance : on ne peut la découvrir qu'en interrogeant réellement le serveur. Un seul appel léger
 * (page_size:1, ordering:'date' ascendant, fenêtre ouverte jusqu'à "maintenant") suffit : RPOS
 * retourne directement la ligne la plus ancienne de tout l'historique disponible pour ce magasin,
 * sans avoir besoin de sonder par paliers comme getLastSaleDate (qui élargit progressivement pour
 * éviter un timeout sur une vente récente — ici on veut justement l'extrémité la plus large).
 * Sert à répondre à la question "jusqu'où puis-je encore remonter avec la récupération initiale ?"
 * (page Paramètres > Fichiers de ventes), plutôt que de laisser l'utilisateur deviner une valeur.
 */
async function getEarliestSaleDate(posId, shopId) {
  // Même stratégie par paliers croissants que getLastSaleDate (une fenêtre trop large dès le
  // premier essai peut faire timeout côté RPOS sur un gros volume) : on part d'une fenêtre passée
  // raisonnable et on l'élargit jusqu'à toucher le tout début de l'historique disponible.
  const now = new Date();
  const windowsConfig = await systemConfig.getValue(systemConfig.KEYS.LAST_SALE_SEARCH_WINDOWS_DAYS);
  const windowsInDays = windowsConfig.split(',').map((s) => parseInt(s.trim(), 10)).filter(Boolean);

  let earliestFound = null;
  for (const days of windowsInDays) {
    const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const data = await rposGet(posId, '/api/product_line/', {
      shop: shopId,
      date_0: start.toISOString().slice(0, 19),
      date_1: now.toISOString().slice(0, 19),
      page_size: 1,
      ordering: 'date',
      fields: 'date',
    });
    const results = data.results || [];
    if (!results.length) break; // aucune vente même sur cette fenêtre élargie : celle du palier précédent est la plus ancienne connue
    earliestFound = results[0].date;
    // Si la ligne la plus ancienne trouvée est nettement postérieure au début de la fenêtre
    // interrogée, l'historique s'arrête réellement là (pas juste une limite de la fenêtre) : pas
    // la peine d'élargir davantage.
    if (new Date(earliestFound).getTime() - start.getTime() > 7 * 24 * 60 * 60 * 1000) break;
  }
  return earliestFound;
}

/**
 * Nombre de ventes (toutes lignes confondues, tous articles) d'un magasin sur une période donnée
 * — appel volontairement léger (page_size:1, on ne lit que data.count) pour servir de sonde
 * d'activité mensuelle sans jamais télécharger le détail des ventes (shopActivityService.js,
 * échantillonnage sur 12-24 mois : un appel coûteux par mois ferait trop d'appels cumulés).
 */
async function getMonthlySalesCount(posId, shopId, dateStart, dateEnd) {
  const data = await rposGet(posId, '/api/product_line/', {
    shop: shopId,
    date_0: dateStart,
    date_1: dateEnd,
    page_size: 1,
    fields: 'id',
  });
  return data.count || 0;
}

async function supplierOrderExists(posId, orderId) {
  try {
    const data = await rposGet(posId, `/api/supplier_order/${orderId}/`, {});
    return !data.deleted_at || data.deleted_at === 0;
  } catch (err) {
    if (err.message.includes('404')) return false;
    throw err;
  }
}

/**
 * Statut RPOS courant d'une commande fournisseur (1-6, cf. validateSupplierOrder/cancelSupplierOrder),
 * pour synchroniser périodiquement l'état de réception d'une ProposalOrder. Retourne null si la
 * commande a été supprimée côté RPOS (pas une erreur : le suivi doit pouvoir gérer ce cas).
 */
/**
 * BUG CORRIGÉ ICI (07/09/2026) : `deleted_at` n'est PAS réservé à une vraie suppression de
 * commande — RPOS le renseigne avec un timestamp Unix dès qu'une commande passe au statut 6
 * (annulée), confirmé par test direct sur une commande annulée via cancelSupplierOrder (deleted_at
 * = 1788779259.78 alors que la commande existe toujours et son status.value = 6). L'ancien code
 * (`if (data.deleted_at) return null`) traitait donc TOUTE commande annulée comme "introuvable",
 * empêchant receptionSyncJob.js de jamais détecter une annulation (rposStatus === 6 n'était
 * jamais atteint) — les commandes annulées côté RPOS restaient indéfiniment affichées comme "en
 * préparation" côté application.
 */
async function getSupplierOrderStatus(posId, orderId) {
  try {
    const data = await rposGet(posId, `/api/supplier_order/${orderId}/`, {});
    return typeof data.status === 'object' ? data.status.value : data.status;
  } catch (err) {
    if (err.message.includes('404')) return null;
    throw err;
  }
}

/**
 * Liste les commandes fournisseur d'un magasin, les plus récentes en premier.
 * Filtre uniquement les commandes créées par notre plateforme (marqueur dans external_reference),
 * pour ne pas mélanger avec les commandes créées manuellement dans RPOS.
 */
async function getSupplierOrders(posId, { shopId, pageSize = 50, page = 1, platformOnly = true }) {
  const params = {
    shop: shopId,
    page_size: pageSize,
    page,
    is_deleted: 'false',
    ordering: '-date',
  };
  if (platformOnly) {
    params.external_reference__icontains = PLATFORM_MARKER;
  }
  return rposGet(posId, '/api/supplier_order/', params);
}

/**
 * Date de la dernière vente enregistrée pour un magasin (ISO string), ou null si aucune.
 * Sert de référence pour calculer les périodes relatives ("hier", "7 derniers jours") : on se
 * base sur la dernière activité réelle du magasin, pas sur la date système, pour rester correct
 * même sur un magasin fermé ou dont l'export RPOS a du retard.
 */
async function getLastSaleDate(posId, shopId) {
  // Une fenêtre trop large (ex: depuis l'an 2000) fait timeout côté RPOS sur de gros volumes.
  // On élargit donc la fenêtre de recherche par paliers (configurable) jusqu'à trouver une vente,
  // ce qui reste rapide dans le cas courant (ventes récentes).
  const now = new Date();
  const windowsConfig = await systemConfig.getValue(systemConfig.KEYS.LAST_SALE_SEARCH_WINDOWS_DAYS);
  const windowsInDays = windowsConfig.split(',').map((s) => parseInt(s.trim(), 10)).filter(Boolean);

  for (const days of windowsInDays) {
    const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const data = await rposGet(posId, '/api/product_line/', {
      shop: shopId,
      date_0: start.toISOString().slice(0, 19),
      date_1: now.toISOString().slice(0, 19),
      page_size: 1,
      ordering: '-date',
      fields: 'date',
    });
    const results = data.results || [];
    if (results.length) return results[0].date;
  }

  return null;
}

/**
 * Récupère toutes les lignes de vente d'un magasin sur une période, avec pagination complète.
 */
/**
 * Récupère UNE SEULE page de lignes de vente RPOS, sans boucler sur toute la période — utilisé
 * par le backfill par tranches avec reprise (salesBackfillService.js) qui a besoin d'insérer et de
 * persister sa progression page par page, plutôt que d'accumuler tout en mémoire comme
 * getProductLinesForPeriod avant de tout retourner d'un coup.
 */
async function fetchProductLinesPage(posId, shopId, dateStart, dateEnd, page, pageSize = 250) {
  const data = await rposGet(posId, '/api/product_line/', {
    shop: shopId,
    date_0: dateStart,
    date_1: dateEnd,
    page_size: pageSize,
    page,
    fields: 'ean,label_1,quantity,total_incl_tax,total_excl_tax,date',
  });
  return { results: data.results || [], count: data.count || 0, nextPage: data.next_page || null };
}

async function getProductLinesForPeriod(posId, shopId, dateStart, dateEnd, onProgress) {
  const pageSize = 250;
  let page = 1;
  let allLines = [];
  let total = null;

  const maxLines = parseInt(await systemConfig.getValue(systemConfig.KEYS.MAX_SALES_LINES_PER_GENERATION), 10) || 20000;

  let pageIndex = 0;
  do {
    const pageStart = Date.now();
    const data = await rposGet(posId, '/api/product_line/', {
      shop: shopId,
      date_0: dateStart,
      date_1: dateEnd,
      page_size: pageSize,
      page,
      fields: 'ean,label_1,quantity,total_incl_tax,total_excl_tax,date',
    });
    total = data.count || 0;

    // RPOS se dégrade fortement avec la profondeur de pagination (offset élevé) : sur un
    // magasin à très fort volume, télécharger tout l'historique peut prendre plusieurs dizaines
    // de minutes. On échoue vite et clairement plutôt que de laisser tourner indéfiniment.
    if (pageIndex === 0 && total > maxLines) {
      throw new Error(
        `Volume de ventes trop important pour cette période (${total} lignes, limite ${maxLines}). ` +
        `Réduisez la période d'analyse, ou fournissez un export CSV local pour ce magasin (plus rapide que l'API RPOS).`
      );
    }

    allLines = allLines.concat(data.results || []);
    pageIndex += 1;
    // RPOS se dégrade fortement avec la profondeur de pagination (offset élevé) : loguer
    // périodiquement pour ne jamais rester silencieux sur un magasin à fort volume, où le
    // téléchargement complet peut prendre plusieurs dizaines de minutes.
    if (pageIndex === 1 || pageIndex % 10 === 0) {
      console.log(`[rposClient] getProductLinesForPeriod shop=${shopId} : page ${pageIndex} (${allLines.length}/${total} lignes) en ${Date.now() - pageStart}ms`);
    }
    if (onProgress) onProgress(allLines.length, total);
    if (!data.next_page) break;
    page = data.next_page;
  } while (allLines.length < total);

  return allLines;
}

module.exports = {
  getShops,
  getProductByEan,
  getProductsByEans,
  getDepartmentRootName,
  getDepartmentHierarchy,
  createSupplierOrder,
  addSupplierOrderLine,
  validateSupplierOrder,
  cancelSupplierOrder,
  getSupplierOrders,
  getPendingPlatformOrderedEans,
  getLastSaleDate,
  getEarliestSaleDate,
  getProductLinesForPeriod,
  fetchProductLinesPage,
  supplierOrderExists,
  getSupplierOrderStatus,
  getLastPurchaseForProduct,
  getRecentUndeliveredOrderedQuantity,
  getPurchaseHistoryForProduct,
  getLastSaleForProduct,
  getSalesQuantityForProductInPeriod,
  getSalesHistoryForProduct,
  getMonthlySalesCount,
  invalidateRposConfigCache,
};
