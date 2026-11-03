// Groupes de magasins partageant la même configuration de réassort (demande du 03/11/2026 : "donne
// la possibilité de cree un groupe pour les mag qui son similaire") — un magasin rattaché via
// ReassortConfig.groupId hérite en TOTALITÉ des champs ci-dessous (configService.resolveEffectiveConfig),
// voir le commentaire sur ReassortConfigGroup dans schema.prisma pour le détail de cette logique.
const prisma = require('../utils/prisma');

// Champs métier acceptés en écriture (POST/PUT) — exclut explicitement id/name (name est séparé,
// toujours requis)/createdAt/updatedAt/updatedBy/shops, qui ne sont jamais fournis par le client de
// cette façon. Même liste que ReassortConfigGroup moins ces champs techniques.
const WRITABLE_FIELDS = [
  'paretoThreshold', 'safetyStockRatio', 'periodMode', 'customStart', 'customEnd',
  'treatNegativeStockAsZero', 'ignoreRposStockInCalculation', 'revenueSharePeriodDays',
  'overstockThresholdMultiplier', 'splitOrdersByDepartment', 'forecastAccuracyWindowDays',
  'forecastAccuracyThresholdPct', 'seasonalityComparisonEnabled', 'seasonalityLookbackYears',
  'seasonalityAdjustmentThresholdPct', 'receptionLeadTimeDays', 'weekendDeliveryDay',
  'useReceptionLeadTimeInCalculation', 'orderDays', 'excludeGenericArticlesBelowPrice',
  'recentOrderMaxAgeDays', 'forecastEnabled', 'forecastAlpha',
];

function pickWritableFields(body) {
  const data = {};
  for (const field of WRITABLE_FIELDS) {
    if (body[field] !== undefined) {
      data[field] = field === 'customStart' || field === 'customEnd'
        ? (body[field] ? new Date(body[field]) : null)
        : body[field];
    }
  }
  return data;
}

async function listGroups() {
  return prisma.reassortConfigGroup.findMany({
    orderBy: { name: 'asc' },
    include: { shops: { select: { rposShopId: true } } },
  });
}

async function getGroup(id) {
  return prisma.reassortConfigGroup.findUnique({
    where: { id },
    include: { shops: { select: { rposShopId: true } } },
  });
}

async function createGroup(body, updatedBy) {
  if (!body.name || !body.name.trim()) {
    throw Object.assign(new Error('name est requis'), { statusCode: 400 });
  }
  return prisma.reassortConfigGroup.create({
    data: { name: body.name.trim(), ...pickWritableFields(body), updatedBy },
  });
}

async function updateGroup(id, body, updatedBy) {
  const data = pickWritableFields(body);
  if (body.name !== undefined) {
    if (!body.name.trim()) throw Object.assign(new Error('name ne peut pas être vide'), { statusCode: 400 });
    data.name = body.name.trim();
  }
  return prisma.reassortConfigGroup.update({ where: { id }, data: { ...data, updatedBy } });
}

// La suppression DÉTACHE automatiquement tous les magasins rattachés (onDelete: SetNull sur
// ReassortConfig.groupId, schema.prisma) — ils reprennent leur configuration individuelle
// (receptionLeadTimeDays/orderDays propres, déjà présents en base, jamais effacés par ce rattachement
// ni par ce détachement), jamais une suppression en cascade de leur ReassortConfig.
async function deleteGroup(id) {
  return prisma.reassortConfigGroup.delete({ where: { id } });
}

// Rattache/détache un magasin à ce groupe (demande du 03/11/2026 : UI de gestion des magasins d'un
// groupe) — upsert car un magasin peut ne pas encore avoir de ReassortConfig du tout.
async function attachShop(groupId, shopId, updatedBy) {
  return prisma.reassortConfig.upsert({
    where: { rposShopId: shopId },
    update: { groupId, updatedBy },
    create: { rposShopId: shopId, groupId, updatedBy },
  });
}

async function detachShop(shopId, updatedBy) {
  return prisma.reassortConfig.updateMany({ where: { rposShopId: shopId }, data: { groupId: null, updatedBy } });
}

module.exports = { listGroups, getGroup, createGroup, updateGroup, deleteGroup, attachShop, detachShop, WRITABLE_FIELDS };
