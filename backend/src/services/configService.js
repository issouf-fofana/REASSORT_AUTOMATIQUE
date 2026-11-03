const prisma = require('../utils/prisma');


const DEFAULTS = {
  paretoThreshold: 0.80,
  safetyStockRatio: 0.5,
  // Changé de LAST_30_DAYS à LAST_365_DAYS le 28/09/2026 (demande explicite : "je veux que l'analyse
  // par défaut soit sur 1 an") — période glissante sur la dernière vente réelle, jamais bloquante si
  // le magasin a moins d'un an d'historique : le calcul se fait alors simplement sur les données
  // réellement disponibles dans cette fenêtre (cf. periodService.js resolvePeriod). N'affecte que
  // les magasins SANS configuration personnalisée en base (ReassortConfig) — un magasin déjà réglé
  // explicitement sur un autre mode garde son réglage, inchangé par ce changement de défaut.
  periodMode: 'LAST_365_DAYS',
  customStart: null,
  customEnd: null,
  treatNegativeStockAsZero: true,
  revenueSharePeriodDays: 1,
  overstockThresholdMultiplier: 1.5,
  splitOrdersByDepartment: true,
  forecastAccuracyWindowDays: 7,
  forecastAccuracyThresholdPct: 20,
  seasonalityComparisonEnabled: false,
  seasonalityLookbackYears: 1,
  seasonalityAdjustmentThresholdPct: 15,
  receptionLeadTimeDays: 1,
  weekendDeliveryDay: 'LUNDI',
  useReceptionLeadTimeInCalculation: false,
  // Jours de commande du magasin (03/11/2026) : vide par défaut, aucune valeur suggérée — voir le
  // commentaire sur ReassortConfig.orderDays (schema.prisma) pour la logique complète.
  orderDays: [],
  // groupId délibérément absent de DEFAULTS (pas groupId: null) : upsertConfig (ci-dessous) spread
  // DEFAULTS dans le `create` Prisma, donc un groupId explicitement null ici forçait Prisma à le
  // passer sur CHAQUE création de ReassortConfig — déclenchait une erreur runtime Prisma ("Unknown
  // argument groupId. Did you mean group?", bug trouvé le 03/11/2026 en testant le premier
  // enregistrement d'un magasin jamais configuré) due à l'ambiguïté XOR<CreateInput,
  // UncheckedCreateInput> de Prisma quand groupId est fourni explicitement à null plutôt qu'omis — un
  // champ relation optionnel absent du payload retombe de toute façon sur null en base sans problème.
  excludeGenericArticlesBelowPrice: 2,
  recentOrderMaxAgeDays: 3,
  forecastEnabled: false,
  forecastAlpha: 0.3,
  // Si vrai, la génération n'appelle jamais RPOS pour le stock/prix/colisage d'un article déjà vu
  // au moins une fois (ProductCache utilisé même très périmé, TTL ignoré) — permet de générer une
  // proposition en étant hors du réseau Prosuma, au prix d'un stock potentiellement obsolète (mis à
  // 0 dans le calcul, jamais utilisé comme une vraie valeur non fiable). Un article jamais vu (aucun
  // cache) reste exclu, faute de prix/colisage connus. Off par défaut : le stock réel reste le
  // comportement normal et le plus fiable, à activer explicitement en connaissance de cause.
  ignoreRposStockInCalculation: false,
  // Mode Auto (23/09/2026) : off par défaut, n'affecte aucun magasin sans activation explicite.
  autoOrderEnabled: false,
  autoOrderValidateAfterCreate: false,
  // Génération automatique nocturne (30/09/2026) : true par défaut, pour ne changer le comportement
  // d'aucun magasin existant — avant ce champ, tous les magasins étaient traités sans filtre.
  nightlyGenerationEnabled: true,
  // Résolution fournisseur par historique (mission "Logique de gestion des fournisseurs et des
  // commandes", 07/10/2026) : true par défaut — pour un article non rattaché au fournisseur
  // central, tente de retrouver le fournisseur de sa dernière commande (2 appels RPOS par article
  // concerné, mesuré ~700ms-1.3s chacun, atténué par un cache par référence de commande). À
  // désactiver (false) uniquement si le coût RPOS s'avère trop élevé sur un magasin à fort
  // catalogue hors-central — le fallback par délai de livraison le plus court reste alors seul
  // utilisé, sans appel RPOS supplémentaire.
  useSupplierHistoryResolution: true,
};

// Champs qui restent TOUJOURS individuels par magasin même quand il est rattaché à un groupe
// (demande du 03/11/2026, après retour utilisateur explicite : activer l'auto-validation sans
// supervision humaine sur toute une chaîne de magasins d'un coup serait trop risqué pour être
// groupé) — exclus de l'héritage dans resolveEffectiveConfig ci-dessous, voir aussi le commentaire
// sur ReassortConfigGroup dans schema.prisma.
const GROUP_EXCLUDED_FIELDS = ['autoOrderEnabled', 'autoOrderValidateAfterCreate', 'nightlyGenerationEnabled'];

/**
 * Fusionne la config individuelle du magasin (shopConfig) avec celle de son groupe (groupConfig),
 * si rattaché — héritage TOTAL (demande du 03/11/2026 : "il faut Héritage total") : tous les champs du
 * groupe écrasent ceux du magasin, SAUF GROUP_EXCLUDED_FIELDS ci-dessus qui restent ceux du
 * magasin quoi qu'il arrive. Sans groupe (groupConfig null), shopConfig est retourné tel quel.
 */
function resolveEffectiveConfig(shopConfig, groupConfig) {
  if (!groupConfig) return shopConfig;
  const merged = { ...shopConfig, ...groupConfig };
  for (const field of GROUP_EXCLUDED_FIELDS) merged[field] = shopConfig[field];
  // Identité/clés techniques : toujours celles du magasin, jamais celles du groupe (id, rposShopId,
  // groupId lui-même) — seuls les champs de RÉGLAGE métier du groupe doivent être repris.
  merged.id = shopConfig.id;
  merged.rposShopId = shopConfig.rposShopId;
  merged.groupId = shopConfig.groupId;
  return merged;
}

/** Récupère la config EFFECTIVE d'un magasin (héritée de son groupe si rattaché), ou les valeurs
 * par défaut si aucune config individuelle n'a été personnalisée. */
async function getConfig(shopId) {
  const config = await prisma.reassortConfig.findUnique({ where: { rposShopId: shopId }, include: { group: true } });
  if (!config) return { rposShopId: shopId, ...DEFAULTS };
  const { group, ...shopConfig } = config;
  return resolveEffectiveConfig(shopConfig, group);
}

// Bug préexistant trouvé le 03/11/2026 en testant le premier enregistrement d'un magasin jamais
// configuré (jusque-là upsertConfig prenait toujours la branche `update`, jamais `create`, donc ce
// problème n'avait jamais été déclenché) : useSupplierHistoryResolution vit dans DEFAULTS et est lu
// en runtime (proposalService.js) mais n'a JAMAIS existé comme colonne ReassortConfig côté Prisma —
// le spread ...DEFAULTS dans `create` l'envoyait quand même, Prisma rejetait avec "Unknown argument".
// Exclu explicitement ici plutôt que retiré de DEFAULTS (resterait alors indisponible pour le reste
// du code qui le lit via getConfig()).
const PRISMA_UNKNOWN_DEFAULTS_FIELDS = ['useSupplierHistoryResolution'];

async function upsertConfig(shopId, data, updatedBy) {
  const createDefaults = { ...DEFAULTS };
  for (const field of PRISMA_UNKNOWN_DEFAULTS_FIELDS) delete createDefaults[field];
  return prisma.reassortConfig.upsert({
    where: { rposShopId: shopId },
    update: { ...data, updatedBy },
    create: { rposShopId: shopId, ...createDefaults, ...data, updatedBy },
  });
}

module.exports = { getConfig, upsertConfig, DEFAULTS, resolveEffectiveConfig, GROUP_EXCLUDED_FIELDS };
