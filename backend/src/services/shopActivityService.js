/**
 * Profil d'activité d'un magasin (CAHIER_DES_CHARGES.md — demande explicite : "l'IA doit être
 * capable de déterminer si le magasin fonctionne réellement sur la période analysée"), pour
 * distinguer un article peu vendu dans un magasin ACTIF d'un magasin qui ne fonctionne plus
 * (fermé, en pause, jamais démarré) — deux situations qui ne doivent jamais produire la même
 * interprétation d'un historique de ventes vide ou faible.
 *
 * Construit un statut générique, sans aucune règle câblée sur un magasin ou une date précise
 * (jamais "si shopId = X" ou "si année = 2025") : uniquement à partir de la présence/absence de
 * ventes réelles sur des fenêtres mensuelles échantillonnées.
 */
const prisma = require('../utils/prisma');
const rpos = require('./rposClient');
const { mapWithConcurrency } = require('../utils/concurrency');


// Le statut d'un magasin ne change pas d'heure en heure : un cache long évite de refaire
// l'échantillonnage RPOS (jusqu'à 24 appels légers) à chaque génération de proposition.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// Nombre de mois échantillonnés en arrière pour reconstituer l'historique d'activité — suffisant
// pour couvrir les cas décrits (magasin arrêté depuis plus d'un an, reprise récente) sans multiplier
// les appels RPOS indéfiniment.
const MONTHS_TO_SAMPLE = 24;

// En dessous de ce nombre de jours depuis la dernière vente connue, le magasin est considéré actif
// sans ambiguïté. Au-delà, on regarde le détail des mois échantillonnés pour qualifier plus finement
// (inactif, en reprise...).
// NOTE : seuil conservé pour documentation (valeur métier de référence = 14 jours) mais non
// appliqué directement par le code actuel — la qualification passe par MONTHS_TO_SAMPLE.
// eslint-disable-next-line no-unused-vars
const RECENT_ACTIVITY_THRESHOLD_DAYS = 14;

/** Un seul mois échantillonné : y a-t-il eu au moins une vente sur ce magasin durant ce mois ? */
async function hasSalesInMonth(posId, shopId, year, month) {
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 1));
  try {
    const data = await rpos.getMonthlySalesCount(posId, shopId, start.toISOString(), end.toISOString());
    return data > 0;
  } catch {
    return null; // échec réseau ponctuel sur ce mois : ne pas fausser le profil avec un "false" erroné
  }
}

/**
 * Construit le profil d'activité en échantillonnant mois par mois, du plus récent vers le plus
 * ancien, et s'arrête dès que suffisamment d'information est réunie (pas la peine de continuer à
 * remonter dans le temps une fois qu'on a trouvé où l'activité s'arrête ET qu'elle est stable).
 */
// Nombre d'appels RPOS lancés en parallèle lors de l'échantillonnage : ce profil se calcule au
// premier clic "Analyser" sur un magasin non encore mis en cache (jusqu'à 24h de TTL), donc un
// utilisateur attend en direct — 24 appels strictement séquentiels ont été mesurés à ~117 secondes
// (bloquant l'analyse IA d'un article sur un magasin jamais vu), largement au-dessus de ce qu'un
// clic "Analyser" doit prendre. Une petite concurrence borne le risque de saturer RPOS tout en
// ramenant le temps total à la durée du plus lent appel individuel plutôt qu'à leur somme.
const MONTH_SAMPLE_CONCURRENCY = 12;

async function buildActivityProfile(posId, shopId) {
  const now = new Date();
  const months = [];
  for (let i = 0; i < MONTHS_TO_SAMPLE; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, monthIndex: d.getUTCMonth() });
  }

  const results = await mapWithConcurrency(months, MONTH_SAMPLE_CONCURRENCY, (m) => hasSalesInMonth(posId, shopId, m.year, m.monthIndex));
  const monthlyActivity = months.map((m, idx) => ({ year: m.year, month: m.month, hasActivity: results[idx] })); // [{ year, month, hasActivity }], du plus récent au plus ancien

  // Dernier mois avec une activité confirmée (ignore les échecs réseau ponctuels, différents d'une
  // vraie absence de vente).
  const lastActiveIndex = monthlyActivity.findIndex((m) => m.hasActivity === true);
  const monthsSinceLastActivity = lastActiveIndex; // 0 = mois courant actif, 1 = actif le mois dernier mais pas ce mois-ci, etc.

  // Première activité connue dans la fenêtre échantillonnée (peut être plus ancienne si
  // MONTHS_TO_SAMPLE ne remonte pas assez loin — cf. hadActivityBeyondSampleWindow ci-dessous).
  let firstActiveIndexFromEnd = -1;
  for (let i = monthlyActivity.length - 1; i >= 0; i--) {
    if (monthlyActivity[i].hasActivity === true) { firstActiveIndexFromEnd = i; break; }
  }
  const hadActivityBeyondSampleWindow = firstActiveIndexFromEnd === monthlyActivity.length - 1;

  // Statut déduit uniquement de la présence/absence de ventes réelles — jamais de règle câblée sur
  // un magasin ou une date précise.
  let status;
  if (lastActiveIndex === -1) {
    status = 'NEVER_ACTIVE'; // aucune vente trouvée sur toute la fenêtre échantillonnée
  } else if (monthsSinceLastActivity <= 1) {
    status = 'ACTIVE'; // activité ce mois-ci ou le mois dernier
  } else {
    // Pas d'activité récente : distingue une reprise (activité présente il y a quelques mois puis
    // un trou, puis à nouveau récente — déjà couvert par ACTIVE ci-dessus si le trou est fini) d'un
    // arrêt qui dure encore. On regarde si l'activité a repris DEPUIS le dernier mois actif trouvé :
    // si lastActiveIndex pointe vers un mois qui n'est ni le mois courant ni le précédent, c'est
    // qu'aucune vente n'a eu lieu depuis — arrêt en cours.
    status = 'INACTIVE';
  }

  // Détecte une reprise : le magasin a un trou d'inactivité significatif suivi d'une activité
  // récente reprise (ex: inactif pendant plusieurs mois puis actif les 1-2 derniers mois).
  if (status === 'ACTIVE' && monthlyActivity.length > 3) {
    // Saute d'abord les mois actifs récents consécutifs (la reprise elle-même), puis cherche un
    // trou d'au moins 2 mois consécutifs sans activité juste après — signe que cette activité
    // récente fait suite à un arrêt, pas à une continuité normale.
    let i = monthsSinceLastActivity;
    while (i < monthlyActivity.length && monthlyActivity[i].hasActivity === true) i++;
    let gapLength = 0;
    while (i < monthlyActivity.length && monthlyActivity[i].hasActivity === false) {
      gapLength++;
      i++;
    }
    if (gapLength >= 2) status = 'RESUMED';
  }

  return {
    status, // ACTIVE | RESUMED | INACTIVE | NEVER_ACTIVE
    monthsSinceLastActivity: lastActiveIndex === -1 ? null : monthsSinceLastActivity,
    lastActiveMonth: lastActiveIndex >= 0 ? monthlyActivity[lastActiveIndex] : null,
    hadActivityBeyondSampleWindow,
    monthlyActivity,
    computedAt: new Date().toISOString(),
  };
}

/** Cache-aside en base (SystemConfig générique aurait pollué une table sans rapport — table dédiée). */
async function getShopActivityProfile(posId, shopId) {
  const cached = await prisma.shopActivityProfile.findUnique({ where: { rposShopId: shopId } });
  if (cached && Date.now() - cached.computedAt.getTime() < CACHE_TTL_MS) {
    return JSON.parse(cached.profileJson);
  }

  const profile = await buildActivityProfile(posId, shopId);
  const data = { rposPosId: posId, rposShopId: shopId, status: profile.status, profileJson: JSON.stringify(profile) };
  await prisma.shopActivityProfile.upsert({
    where: { rposShopId: shopId },
    update: data,
    create: data,
  });
  return profile;
}

module.exports = { getShopActivityProfile, buildActivityProfile };
