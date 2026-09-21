/**
 * Conseiller d'amélioration IA (première brique de l'AI Center, CAHIER_DES_CHARGES.md §44).
 *
 * Principe : le backend calcule déjà beaucoup, mais certains problèmes restent SILENCIEUX
 * (prédictions jamais évaluables, jobs qui dérivent, biais systématiques, questions chatbot sans
 * réponse...) — personne ne les voit sans creuser la base. Ce service les détecte de façon
 * DÉTERMINISTE (requêtes Prisma, aucun LLM pour les constats : un chiffre ne s'invente pas),
 * puis demande au LLM de proposer, pour les constats importants, une action d'exploitation ET
 * une recommandation dev (fichiers concernés) — §53 : le backend mesure, l'IA interprète.
 *
 * Boucle d'apprentissage : chaque constat fige sa métrique (metricBefore) ; quand la reco est
 * marquée APPLIED, une exécution ultérieure recalcule la métrique (metricAfter) et statue
 * IMPROVED (baisse ≥10%) ou NO_EFFECT. Le système apprend ce qui marche vraiment au lieu
 * d'empiler des recommandations jamais vérifiées.
 */
const prisma = require('../utils/prisma');
const { getJobsHealth } = require('./jobHealthService');
const systemConfig = require('./systemConfigService');
const { streamWithFallback } = require('./aiForecastService');
const { groupErrorReports, pruneErrorReports } = require('./errorReportService');
const { mapWithConcurrency } = require('../utils/concurrency');
const correctionRecordService = require('./correctionRecordService');

const DAY_MS = 24 * 60 * 60 * 1000;
// Nombre max de constats enrichis par LLM par exécution : borne le coût/quota API, les constats
// INFO gardent leur texte déterministe (suffisant pour un simple signalement).
const MAX_LLM_ENRICHMENTS = 5;
// Délai après application avant de juger de l'effet : laisse le temps aux jobs (quotidiens)
// de produire de nouvelles mesures.
const EVALUATION_DELAY_MS = 24 * 60 * 60 * 1000;
// Baisse relative de la métrique (toutes nos métriques sont "plus bas = mieux") pour conclure
// à une vraie amélioration plutôt qu'au bruit de mesure.
const IMPROVEMENT_RATIO = 0.9;

// Priorités de traitement (spec 14/09/2026) : tri et filtre côté UI.
// Par défaut dérivées de la sévérité : CRITICAL→CRITICAL, WARNING→HIGH, INFO→LOW.
const PRIORITY_RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
const SEVERITY_PRIORITY = { CRITICAL: 'CRITICAL', WARNING: 'HIGH', INFO: 'LOW' };
// Statuts "ouverts" (anti-doublons) : tout ce qui n'est ni clôturé par évaluation ni ignoré.
const OPEN_STATUSES = ['PROPOSED', 'IN_PROGRESS', 'TO_VERIFY', 'APPLIED'];
// Transitions autorisées (IMPROVED/NO_EFFECT sont posés par le système seul, jamais à la main).
const ALLOWED_TRANSITIONS = {
  PROPOSED: ['IN_PROGRESS', 'TO_VERIFY', 'APPLIED', 'DISMISSED'],
  IN_PROGRESS: ['TO_VERIFY', 'APPLIED', 'DISMISSED', 'PROPOSED'],
  TO_VERIFY: ['APPLIED', 'DISMISSED', 'IN_PROGRESS'],
  APPLIED: ['IN_PROGRESS', 'DISMISSED'],
  DISMISSED: ['IN_PROGRESS', 'PROPOSED'],
  IMPROVED: ['IN_PROGRESS'],
  NO_EFFECT: ['IN_PROGRESS', 'DISMISSED'],
};

// ---------------------------------------------------------------------------
// Métriques recalculables (utilisées à la détection ET à l'évaluation d'effet)
// ---------------------------------------------------------------------------
async function metricDegradedJobFailures(ev) {
  const health = await getJobsHealth();
  const job = health.find((j) => j.jobName === ev.jobName);
  return job ? job.consecutiveFailures || 0 : 0;
}

async function metricUnevaluablePredictions() {
  return prisma.aIPrediction.count({
    where: { targetPeriodEnd: null, predictionDate: { gte: new Date(Date.now() - 90 * DAY_MS) } },
  });
}

async function metricStuckEvaluations() {
  return prisma.aIPrediction.count({
    where: { targetPeriodEnd: { not: null, lt: new Date(Date.now() - 3 * DAY_MS) }, outcome: null },
  });
}

async function metricShopAvgError(ev) {
  const outcomes = await prisma.aIPredictionOutcome.findMany({
    where: { evaluatedAt: { gte: new Date(Date.now() - 30 * DAY_MS) }, prediction: { rposShopId: ev.rposShopId } },
    select: { percentageError: true },
    take: 10000,
  });
  const withPct = outcomes.filter((o) => o.percentageError !== null);
  if (!withPct.length) return 0;
  return withPct.reduce((s, o) => s + Math.abs(o.percentageError), 0) / withPct.length;
}

async function metricStaleGenerated() {
  return prisma.proposal.count({
    where: { status: 'GENERATED', generatedAt: { lt: new Date(Date.now() - 7 * DAY_MS) } },
  });
}

async function metricSalesSyncDisabled() {
  const enabled = await systemConfig.getValue(systemConfig.KEYS.SALES_SYNC_ENABLED);
  return enabled === 'false' ? 1 : 0;
}

async function metricSalesGapHours() {
  const agg = await prisma.salesLine.aggregate({ _max: { date: true } });
  if (!agg._max.date) return 9999;
  return (Date.now() - agg._max.date.getTime()) / (60 * 60 * 1000);
}

async function metricChatbotGaps() {
  return prisma.chatbotMessage.count({
    where: { role: 'assistant', toolUsed: null, createdAt: { gte: new Date(Date.now() - 30 * DAY_MS) } },
  });
}
async function metricRecurringAnomalyMax() {
  const lines = await prisma.proposalLine.findMany({
    where: { anomalies: { not: null }, proposal: { generatedAt: { gte: new Date(Date.now() - 14 * DAY_MS) } } },
    select: { ean: true },
    take: 5000,
  });
  const byEan = new Map();
  for (const l of lines) byEan.set(l.ean, (byEan.get(l.ean) || 0) + 1);
  return byEan.size ? Math.max(...byEan.values()) : 0;
}

// Pic d'erreurs applicatives (debug global) : occurrences du groupe le plus fréquent sur 7j.
// "Plus bas = mieux" comme les autres métriques : après correction, le groupe doit retomber.
async function metricAppErrorMax() {
  const rows = await prisma.errorReport.findMany({
    where: { createdAt: { gte: new Date(Date.now() - 7 * DAY_MS) } },
    take: 5000,
  });
  const groups = groupErrorReports(rows);
  return groups.length ? groups[0].count : 0;
}

const METRICS = {
  degraded_job_failures: metricDegradedJobFailures,
  sales_sync_disabled: metricSalesSyncDisabled,
  unevaluable_predictions: metricUnevaluablePredictions,
  stuck_evaluations: metricStuckEvaluations,
  shop_avg_error: metricShopAvgError,
  stale_generated: metricStaleGenerated,
  sales_gap_hours: metricSalesGapHours,
  chatbot_gaps: metricChatbotGaps,
  recurring_anomaly_max: metricRecurringAnomalyMax,
  app_error_max_count: metricAppErrorMax,
};

async function recomputeMetric(metricName, evidence) {
  const fn = METRICS[metricName];
  if (!fn) return null;
  return fn(evidence || {});
}

// ---------------------------------------------------------------------------
// Détecteurs (constats déterministes)
// ---------------------------------------------------------------------------
async function detectDegradedJobs() {
  const findings = [];
  const health = await getJobsHealth();
  for (const job of health) {
    const failures = job.consecutiveFailures || 0;
    const bad = job.status === 'degraded' || job.status === 'error' || failures > 0;
    if (!bad) continue;
    // Message d'erreur EXACT (spec §2) : tel que le job l'a enregistré, jamais reformulé.
    findings.push({
      type: 'JOB_HEALTH',
      severity: job.status === 'degraded' ? 'CRITICAL' : 'WARNING',
      priority: job.status === 'degraded' ? 'CRITICAL' : 'HIGH',
      title: `Job "${job.jobName}" en échec (${failures} consécutif(s))`,
      detail: `Dernier run : ${job.lastRunAt || 'jamais'}. Vérifier les logs puis relancer depuis Paramètres > Planification.`,
      errorMessage: job.lastError || null,
      devRecommendation: 'Voir backend/src/jobs/cronManager.js (planification) et le job concerné dans backend/src/jobs/.',
      evidence: { jobName: job.jobName, lastRunAt: job.lastRunAt, lastError: job.lastError || null },
      scope: 'global',
      metricName: 'degraded_job_failures',
      metricValue: failures,
    });
  }
  return findings;
}

async function detectUnevaluablePredictions() {
  const count = await metricUnevaluablePredictions();
  if (!count) return [];
  return [{
    type: 'SILENT_ANOMALY',
    severity: 'WARNING',
    priority: 'HIGH',
    title: `${count} prédiction(s) jamais évaluables (sans semaine cible)`,
    detail: `Ces prédictions n'ont pas de targetPeriodEnd (rattachement au plan hebdo échoué) : predictionOutcomeJob les ignore silencieusement, la mesure de précision est trouée. Chercher "ALERTE" dans les logs backend pour la cause.`,
    errorMessage: null,
    devRecommendation: 'Voir generateAndSaveProposal dans backend/src/services/proposalService.js (bloc weeklyPlanAttached) et attachProposalToWeeklyPlan dans backend/src/services/weeklyPlanService.js.',
    evidence: {},
    scope: 'global',
    metricName: 'unevaluable_predictions',
    metricValue: count,
  }];
}

async function detectStuckEvaluations() {
  const count = await metricStuckEvaluations();
  if (!count) return [];
  return [{
    type: 'SILENT_ANOMALY',
    severity: 'WARNING',
    priority: 'HIGH',
    title: `${count} prédiction(s) en attente d'évaluation (période terminée depuis >3j)`,
    detail: `Le job d'évaluation ne suit plus (désactivé ? en échec ?). Vérifier PREDICTION_OUTCOME_ENABLED et la santé du job dans Paramètres > Planification.`,
    errorMessage: null,
    devRecommendation: 'Voir backend/src/jobs/predictionOutcomeJob.js et backend/src/jobs/cronManager.js.',
    evidence: {},
    scope: 'global',
    metricName: 'stuck_evaluations',
    metricValue: count,
  }];
}

async function detectShopAccuracy() {
  const since = new Date(Date.now() - 30 * DAY_MS);
  const outcomes = await prisma.aIPredictionOutcome.findMany({
    where: { evaluatedAt: { gte: since } },
    select: {
      percentageError: true, forecastError: true, actualSales: true,
      prediction: { select: { rposShopId: true } },
    },
    take: 20000,
  });
  const byShop = new Map();
  for (const o of outcomes) {
    const shop = o.prediction.rposShopId;
    if (!byShop.has(shop)) byShop.set(shop, { errs: [], fe: 0, actual: 0 });
    const e = byShop.get(shop);
    if (o.percentageError !== null) e.errs.push(Math.abs(o.percentageError));
    e.fe += o.forecastError || 0;
    e.actual += o.actualSales || 0;
  }
  const findings = [];
  for (const [shop, e] of byShop) {
    if (e.errs.length < 10) continue; // pas assez de recul pour juger ce magasin
    const avgErr = e.errs.reduce((s, v) => s + v, 0) / e.errs.length;
    const bias = e.actual > 0 ? e.fe / e.actual : 0; // >0 = sous-estimation chronique
    if (avgErr <= 0.3 && Math.abs(bias) <= 0.2) continue;
    const critical = avgErr > 0.5;
    findings.push({
      type: 'ACCURACY',
      severity: critical ? 'CRITICAL' : 'WARNING',
      priority: critical ? 'CRITICAL' : 'HIGH',
      title: `Précision faible sur le magasin ${shop.slice(0, 8)}… (erreur moy. ${Math.round(avgErr * 100)}%)`,
      detail: `Erreur absolue moyenne ${Math.round(avgErr * 100)}% sur ${e.errs.length} prédictions (30j).` +
        (bias > 0.2 ? ` Biais : sous-estimation chronique (+${Math.round(bias * 100)}%) — le système commande trop peu.` :
          bias < -0.2 ? ` Biais : surestimation chronique (${Math.round(bias * 100)}%) — le système commande trop.` :
            ` Pas de biais systématique : erreurs dispersées (volatilité des ventes ?).`),
      devRecommendation: 'Voir computeConfidenceScore (backend/src/services/confidenceService.js) et forecastService.js (lissage exponentiel).',
      evidence: { rposShopId: shop, avgError: Math.round(avgErr * 1000) / 1000, bias: Math.round(bias * 1000) / 1000, samples: e.errs.length },
      scope: shop,
      metricName: 'shop_avg_error',
      metricValue: avgErr,
    });
  }
  return findings;
}

async function detectStaleProposals() {
  const stale = await prisma.proposal.findMany({
    where: { status: 'GENERATED', generatedAt: { lt: new Date(Date.now() - 7 * DAY_MS) } },
    select: { rposShopReference: true, generatedAt: true },
    take: 50,
  });
  if (!stale.length) return [];
  return [{
    type: 'WORKFLOW',
    severity: 'WARNING',
    priority: 'MEDIUM',
    title: `${stale.length} proposition(s) en attente depuis plus de 7 jours`,
    detail: `Ex: ${stale.slice(0, 3).map((s) => `${s.rposShopReference} (${s.generatedAt.toISOString().slice(0, 10)})`).join(', ')}. Une proposition qui dort = réassort non validé = risque de rupture. Relancer les responsables ou vérifier le job de réajustement.`,
    devRecommendation: null,
    evidence: { count: stale.length },
    scope: 'global',
    metricName: 'stale_generated',
    metricValue: stale.length,
  }];
}

async function detectSalesSyncGap() {
  const findings = [];
  const enabled = await systemConfig.getValue(systemConfig.KEYS.SALES_SYNC_ENABLED);
  // Erreur exacte du job de synchro (spec §2) : reprise telle quelle depuis sa santé persistée.
  let syncLastError = null;
  try {
    const row = await prisma.systemConfig.findUnique({ where: { key: 'JOB_HEALTH_salesSync' } });
    if (row) syncLastError = JSON.parse(row.value).lastError || null;
  } catch { syncLastError = null; }
  if (enabled === 'false') {
    findings.push({
      type: 'DATA_QUALITY',
      severity: 'WARNING',
      priority: 'HIGH',
      title: 'Synchronisation des ventes désactivée',
      detail: 'SALES_SYNC_ENABLED=false : les SalesLine vieillissent, et avec elles toutes les prévisions. À réactiver (tous magasins ou liste restreinte SALES_SYNC_SHOP_IDS) sauf maintenance volontaire.',
      errorMessage: syncLastError,
      devRecommendation: null,
      evidence: {},
      scope: 'global',
      metricName: 'sales_sync_disabled',
      metricValue: 1,
    });
  }
  const gapHours = await metricSalesGapHours();
  if (gapHours > 48) {
    findings.push({
      type: 'DATA_QUALITY',
      severity: 'WARNING',
      priority: 'HIGH',
      title: `Données de ventes anciennes (dernière il y a ${Math.round(gapHours)}h)`,
      detail: 'Aucune vente synchronisée depuis plus de 48h : prévisions calculées sur du passé lointain. Vérifier salesSyncJob et la joignabilité RPOS.',
      errorMessage: syncLastError,
      devRecommendation: 'Voir backend/src/jobs/salesSyncJob.js et backend/src/services/rposClient.js.',
      evidence: { gapHours: Math.round(gapHours) },
      scope: 'global',
      metricName: 'sales_gap_hours',
      metricValue: gapHours,
    });
  }
  return findings;
}

async function detectChatbotGaps() {
  const count = await metricChatbotGaps();
  if (count < 5) return [];
  const samples = await prisma.chatbotMessage.findMany({
    where: { role: 'user' },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { content: true },
  });
  return [{
    type: 'CHATBOT_GAP',
    severity: 'INFO',
    title: `${count} réponse(s) chatbot sans données (30j)`,
    detail: `L'assistant a dû répondre sans outil de données (hors périmètre). Exemples récents : ${samples.map((s) => `"${(s.content || '').slice(0, 60)}"`).join(' ; ')}. Piste : ajouter l'outil manquant dans chatbotToolsService.js.`,
    devRecommendation: 'Voir detectIntent + chatbotToolsService.js (backend/src/services/) pour couvrir ces intentions.',
    evidence: { count },
    scope: 'global',
    metricName: 'chatbot_gaps',
    metricValue: count,
  }];
}

async function detectRecurringAnomalies() {
  const lines = await prisma.proposalLine.findMany({
    where: { anomalies: { not: null }, proposal: { generatedAt: { gte: new Date(Date.now() - 14 * DAY_MS) } } },
    select: { ean: true, label: true },
    take: 5000,
  });
  const byEan = new Map();
  for (const l of lines) {
    if (!byEan.has(l.ean)) byEan.set(l.ean, { ean: l.ean, label: l.label, count: 0 });
    byEan.get(l.ean).count += 1;
  }
  const top = [...byEan.values()].sort((a, b) => b.count - a.count)[0];
  if (!top || top.count < 4) return [];
  return [{
    type: 'SILENT_ANOMALY',
    severity: 'INFO',
    title: `Article en anomalie récurrente : ${top.label || top.ean} (${top.count} générations / 14j)`,
    detail: `Un article signalé à chaque génération n'est plus une anomalie ponctuelle mais un problème structurel (rupture invisible réelle ? EAN mal scanné ?). À vérifier physiquement en magasin (reco VERIFY_STOCK).`,
    devRecommendation: null,
    evidence: { ean: top.ean, label: top.label, occurrences: top.count },
    scope: 'global',
    metricName: 'recurring_anomaly_max',
    metricValue: top.count,
  }];
}

/**
 * Erreurs applicatives (debug global, spec "trouver TOUTES les erreurs") : regroupe les
 * ErrorReport des 7 derniers jours (TOUTES les pages frontend via layout.js + TOUTES les
 * réponses API 5xx via le hook server.js) par signature. Seuls les groupes répétés (≥3)
 * deviennent des constats — un incident isolé reste journalisé mais ne pollue pas la liste.
 * Le message EXACT du groupe est conservé tel quel (spec §2).
 */
async function detectAppErrors() {
  const rows = await prisma.errorReport.findMany({
    where: { createdAt: { gte: new Date(Date.now() - 7 * DAY_MS) } },
    orderBy: { createdAt: 'desc' },
    take: 5000,
  });
  if (!rows.length) return [];
  const groups = groupErrorReports(rows).slice(0, 5);
  const findings = [];
  for (const g of groups) {
    if (g.count < 3) continue;
    const critical = g.count >= 20;
    const where = g.source === 'frontend' ? `page ${g.page || '?'}` : (g.url || 'API');
    const first = g.firstSeen.toISOString().slice(0, 16).replace('T', ' ');
    const last = g.lastSeen.toISOString().slice(0, 16).replace('T', ' ');
    findings.push({
      type: 'APP_ERROR',
      severity: critical ? 'CRITICAL' : 'WARNING',
      priority: critical ? 'CRITICAL' : g.count >= 8 ? 'HIGH' : 'MEDIUM',
      title: `${g.count}× “${g.signature.slice(0, 80)}” (${where})`,
      detail: `${g.count} occurrences du ${first} au ${last} sur ${where}.` +
        (g.sampleUser ? ` Dernier utilisateur touché : ${g.sampleUser}.` : '') +
        (g.sampleShop ? ` Magasin : ${g.sampleShop}.` : '') +
        ` Reproduire : ${g.source === 'frontend' ? `ouvrir ${g.page || '?'} et refaire l'action` : `rejouer ${g.method || ''} ${g.url || ''}`}.`,
      errorMessage: g.sampleMessage,
      devRecommendation: null, // l'enrichissement IA propose le correctif avec les vrais fichiers
      evidence: {
        groupKey: g.key, source: g.source, page: g.page, url: g.url, method: g.method,
        statusCode: g.statusCode, count: g.count, firstSeen: g.firstSeen, lastSeen: g.lastSeen,
        sampleStack: g.sampleStack, sampleUser: g.sampleUser, sampleShop: g.sampleShop,
      },
      scope: 'global',
      metricName: 'app_error_max_count',
      metricValue: g.count,
    });
  }
  return findings;
}

async function collectFindings() {
  const grouped = await Promise.all([
    detectDegradedJobs(),
    detectAppErrors(),
    detectUnevaluablePredictions(),
    detectStuckEvaluations(),
    detectShopAccuracy(),
    detectStaleProposals(),
    detectSalesSyncGap(),
    detectChatbotGaps(),
    detectRecurringAnomalies(),
  ]);
  return grouped.flat();
}

// ---------------------------------------------------------------------------
// Enrichissement LLM (reco exploitation + reco dev), avec repli déterministe
// ---------------------------------------------------------------------------
function buildEnrichmentPrompt(f) {
  return `Tu es un expert maintenance d'une plateforme de réassort (backend Node.js/Express/Prisma/Postgres, frontend HTML/Bootstrap vanilla, intégration ERP RPOS).
Fichiers réels du projet (ne cite QUE ceux-ci) : backend/src/jobs/ (nightlyProposalJob, salesSyncJob, dailyReplenishmentReviewJob, predictionOutcomeJob, receptionSyncJob, shopsSyncJob, cronManager), backend/src/services/ (proposalService, forecastService, confidenceService, anomalyService, chatbotService, chatbotToolsService, aiForecastService, rposClient, systemConfigService, weeklyPlanService, improvementService), backend/src/routes/reassort.js, frontend/ (purchase-order.html, settings.html, ai-predictions.html, ai-assistant.html, sales-history.html), docker-compose.yml. Clés de config : SALES_SYNC_ENABLED, SALES_SYNC_SHOP_IDS, REVISION_CHANGE_THRESHOLD, ANOMALY_MIN_DAILY_SALES, PREDICTION_OUTCOME_ENABLED, DAILY_REVIEW_CRON (réglables dans Paramètres, jamais en variables d'environnement).
Constat automatique du chien de garde :
- Titre : ${f.title}
- Détail : ${f.detail}
- Preuves : ${JSON.stringify(f.evidence || {})}

Réponds en français, 5 lignes max, format STRICT (rien d'autre) :
EXPLOITATION: <1 action concrète côté réglages ou exploitation (nommer la clé de config ou la page Paramètres si pertinent)>
DEV: <1 correctif code avec les fichiers concernés (chemins backend/src/... ou frontend/...), ou "RAS" si le constat ne relève pas du code>
CONFIANCE: <0-100, ton niveau de confiance dans cette analyse vu les preuves fournies>`;
}

// Prompt modifiable depuis Paramètres > IA (IMPROVEMENTS_PROMPT_TEMPLATE) : {{title}}
// {{detail}} {{evidence}} {{files}}. Si le modèle est vide ou sans placeholders, repli sur
// le prompt codé en dur ci-dessus (jamais d'appel LLM avec un prompt vide).
const IMPROVEMENT_FILES_HINT = 'backend/src/jobs/ (nightlyProposalJob, salesSyncJob, dailyReplenishmentReviewJob, predictionOutcomeJob, receptionSyncJob, shopsSyncJob, cronManager), backend/src/services/ (proposalService, forecastService, confidenceService, anomalyService, chatbotService, chatbotToolsService, aiForecastService, rposClient, systemConfigService, weeklyPlanService, improvementService), backend/src/routes/reassort.js, frontend/ (purchase-order.html, settings.html, ai-predictions.html, ai-assistant.html, ai-improvements.html, sales-history.html), docker-compose.yml';

async function resolveEnrichmentPrompt(f) {
  const fallback = buildEnrichmentPrompt(f);
  try {
    const template = await systemConfig.getValue(systemConfig.KEYS.IMPROVEMENTS_PROMPT_TEMPLATE);
    if (!template || !template.includes('{{title}}')) return fallback;
    return template
      .split('{{title}}').join(f.title)
      .split('{{detail}}').join(f.detail)
      .split('{{evidence}}').join(JSON.stringify(f.evidence || {}))
      .split('{{files}}').join(IMPROVEMENT_FILES_HINT);
  } catch {
    return fallback;
  }
}

async function enrichWithAi(finding) {
  const prompt = await resolveEnrichmentPrompt(finding);
  try {
    const { fullText, providerUsed } = await streamWithFallback(prompt, null, 'improvement-enrichment');
    const expl = (fullText.match(/^EXPLOITATION:(.*)$/m) || [])[1];
    const dev = (fullText.match(/^DEV:(.*)$/m) || [])[1];
    const confRaw = (fullText.match(/^CONFIANCE:\s*(\d{1,3})/m) || [])[1];
    const aiConfidence = confRaw !== undefined ? Math.max(0, Math.min(100, parseInt(confRaw, 10))) : null;
    // Réponse hors format : on garde le texte brut plutôt que de le jeter — jamais de perte.
    if (!expl && !dev) return { detail: `${finding.detail}\n\n🤖 IA (${providerUsed || 'llm'}) : ${fullText.trim().slice(0, 800)}`, providerUsed, aiPrompt: prompt, aiError: null, aiConfidence };
    return {
      detail: expl ? `${finding.detail}\n\n🤖 IA : ${expl.trim()}` : finding.detail,
      devRecommendation: dev && dev.trim().toUpperCase() !== 'RAS' ? dev.trim() : finding.devRecommendation,
      providerUsed,
      aiPrompt: prompt,
      aiError: null,
      aiConfidence,
    };
  } catch (err) {
    // Pas de clé IA / quota épuisé / réseau : le constat déterministe reste utile tel quel,
    // et l'erreur est persistée (transparence) au lieu d'être avalée silencieusement.
    return { detail: finding.detail, providerUsed: null, aiPrompt: prompt, aiError: err.message, aiConfidence: null };
  }
}

// ---------------------------------------------------------------------------
// Génération (détecte, déduplique, persiste, enrichit, évalue)
// ---------------------------------------------------------------------------
async function generateImprovements(context) {
  const ctx = context || {};
  const actor = ctx.actor || 'system/cron';
  // Élagage du journal d'erreurs AVANT détection (rétention 30j, plafond 5000) : le debug
  // ne doit jamais faire gonfler la base indéfiniment.
  const pruned = await pruneErrorReports().catch(() => ({ deletedOld: 0, capped: 0 }));
  const findings = await collectFindings();
  let created = 0;
  let duplicates = 0;
  const fresh = [];

  for (const f of findings) {
    // Déduplication sur type + périmètre + métrique : le même problème ouvert n'est pas
    // re-créé à chaque analyse (ex: deux constats DATA_QUALITY globaux distincts — synchro
    // coupée vs données anciennes — ont des métriques différentes et restent séparés).
    const existing = await prisma.aIImprovement.findFirst({
      where: { type: f.type, scope: f.scope, metricName: f.metricName || null, status: { in: OPEN_STATUSES } },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      duplicates += 1;
      continue;
    }
    const row = await prisma.aIImprovement.create({
      data: {
        type: f.type,
        severity: f.severity,
        priority: f.priority || SEVERITY_PRIORITY[f.severity] || 'MEDIUM',
        title: f.title,
        detail: f.detail,
        errorMessage: f.errorMessage || null,
        devRecommendation: f.devRecommendation || null,
        evidence: f.evidence ? JSON.stringify(f.evidence) : null,
        scope: f.scope,
        metricName: f.metricName,
        metricBefore: f.metricValue ?? null,
        detectedBy: actor,
        detectedIp: ctx.ip || null,
        appVersion: ctx.appVersion || null,
        environment: ctx.environment || process.env.NODE_ENV || 'production',
      },
    });
    await prisma.aIImprovementEvent.create({
      data: { improvementId: row.id, actor, action: 'DETECTED', toStatus: 'PROPOSED', note: `Détecté par le chien de garde (${f.type}, périmètre ${f.scope}).` },
    });
    created += 1;
    fresh.push({ row, finding: f });
  }

  // Enrichissement IA : priorités de traitement d'abord, jamais les INFO/LOW.
  // En PARALLÈLE contrôlé (x3) : en séquentiel, 5 constats × 90s de timeout LLM pouvaient
  // figer le bouton "Analyser" plusieurs minutes en cas de fournisseur lent.
  fresh.sort((a, b) => PRIORITY_RANK[a.row.priority] - PRIORITY_RANK[b.row.priority]);
  let enriched = 0;
  await mapWithConcurrency(fresh.slice(0, MAX_LLM_ENRICHMENTS), 3, async ({ row, finding }) => {
    if (finding.severity === 'INFO') return;
    const ai = await enrichWithAi(finding);
    await prisma.aIImprovement.update({
      where: { id: row.id },
      data: {
        detail: ai.detail,
        devRecommendation: ai.devRecommendation || null,
        providerUsed: ai.providerUsed || null,
        aiPrompt: ai.aiPrompt || null,
        aiError: ai.aiError || null,
        aiConfidence: ai.aiConfidence ?? null,
      },
    });
    await prisma.aIImprovementEvent.create({
      data: {
        improvementId: row.id, actor: 'system', action: 'ENRICHED', fromStatus: 'PROPOSED', toStatus: 'PROPOSED',
        note: ai.providerUsed ? `Analyse IA (${ai.providerUsed}, confiance ${ai.aiConfidence ?? '—'}%).` : `Enrichissement IA échoué : ${ai.aiError || 'erreur inconnue'}.`,
      },
    });
    if (ai.providerUsed) enriched += 1;
  });

  const evaluation = await evaluateAppliedImprovements();

  return { findings: findings.length, created, duplicates, enriched, pruned, evaluation };
}

// ---------------------------------------------------------------------------
// Modification d'une recommandation (proposition IA ajustable par l'humain)
// ---------------------------------------------------------------------------
const EDITABLE_PRIORITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

async function updateImprovement(id, patch, { actor } = {}) {
  const imp = await prisma.aIImprovement.findUnique({ where: { id } });
  if (!imp) {
    const err = new Error('Recommandation introuvable');
    err.statusCode = 404;
    throw err;
  }
  if (['IMPROVED', 'APPLIED'].includes(imp.status)) {
    const err = new Error('Recommandation clôturée : rouvrez-la avant de la modifier');
    err.statusCode = 400;
    throw err;
  }
  const data = {};
  const changed = [];
  if (patch.detail !== undefined && patch.detail !== imp.detail) {
    if (!String(patch.detail || '').trim()) {
      const err = new Error('Le détail ne peut pas être vide');
      err.statusCode = 400;
      throw err;
    }
    data.detail = String(patch.detail).slice(0, 8000);
    changed.push('recommandation');
  }
  if (patch.devRecommendation !== undefined && (patch.devRecommendation || null) !== imp.devRecommendation) {
    data.devRecommendation = patch.devRecommendation ? String(patch.devRecommendation).slice(0, 8000) : null;
    changed.push('reco dev');
  }
  if (patch.priority !== undefined && patch.priority !== imp.priority) {
    if (!EDITABLE_PRIORITIES.includes(patch.priority)) {
      const err = new Error('Priorité invalide (CRITICAL, HIGH, MEDIUM, LOW)');
      err.statusCode = 400;
      throw err;
    }
    data.priority = patch.priority;
    changed.push(`priorité ${imp.priority} → ${patch.priority}`);
  }
  if (!changed.length) {
    const err = new Error('Aucune modification');
    err.statusCode = 400;
    throw err;
  }
  const who = actor || 'system';
  const updated = await prisma.aIImprovement.update({ where: { id }, data });
  await prisma.aIImprovementEvent.create({
    data: {
      improvementId: id, actor: who, action: 'EDITED',
      fromStatus: imp.status, toStatus: imp.status,
      note: `Proposition IA ajustée par ${who} : ${changed.join(', ')}.`,
    },
  });
  return { ...updated, evidence: updated.evidence ? JSON.parse(updated.evidence) : null };
}

// ---------------------------------------------------------------------------
// Transitions de statut (traçabilité complète : acteur, note, timeline)
// ---------------------------------------------------------------------------
async function setImprovementStatus(id, toStatus, { actor, note } = {}) {
  const imp = await prisma.aIImprovement.findUnique({ where: { id } });
  if (!imp) {
    const err = new Error('Recommandation introuvable');
    err.statusCode = 404;
    throw err;
  }
  // IMPROVED/NO_EFFECT sont posés par le système seul (évaluation), jamais à la main.
  const allowed = ALLOWED_TRANSITIONS[imp.status] || [];
  if (!allowed.includes(toStatus)) {
    const err = new Error(`Transition ${imp.status} → ${toStatus} non autorisée`);
    err.statusCode = 400;
    throw err;
  }
  const who = actor || 'system';
  const data = { status: toStatus };
  // Qui/quand/quoi : correction réellement effectuée (APPLIED) ou motif d'ignorance (DISMISSED).
  if (toStatus === 'APPLIED') {
    data.appliedAt = new Date();
    data.appliedBy = who;
    if (note) data.appliedNote = note;
  }
  if (toStatus === 'DISMISSED') {
    data.dismissedBy = who;
    if (note) data.dismissedReason = note;
  }
  const updated = await prisma.aIImprovement.update({ where: { id }, data });
  await prisma.aIImprovementEvent.create({
    data: {
      improvementId: id, actor: who, action: 'STATUS_CHANGED',
      fromStatus: imp.status, toStatus, note: note || null,
    },
  });
  return { ...updated, evidence: updated.evidence ? JSON.parse(updated.evidence) : null };
}

// ---------------------------------------------------------------------------
// Évaluation d'effet (boucle d'apprentissage)
// ---------------------------------------------------------------------------
async function evaluateAppliedImprovements() {
  const candidates = await prisma.aIImprovement.findMany({
    where: { status: 'APPLIED', appliedAt: { lt: new Date(Date.now() - EVALUATION_DELAY_MS) } },
    take: 50,
  });
  let improved = 0;
  let noEffect = 0;
  for (const imp of candidates) {
    if (!imp.metricName) continue;
    const current = await recomputeMetric(imp.metricName, imp.evidence ? JSON.parse(imp.evidence) : {});
    if (current === null) continue;
    const before = imp.metricBefore ?? current;
    const next = { metricAfter: current };
    // Toutes les métriques sont "plus bas = mieux" (comptes, erreurs, échecs, heures de retard).
    if (current <= before * IMPROVEMENT_RATIO) {
      next.status = 'IMPROVED';
      improved += 1;
      // Correction confirmée efficace (pas juste appliquée) : c'est le seul moment où on sait
      // vraiment qu'une correction a marché — entrée journalisée dans le journal unifié des
      // corrections (cf. correctionRecordService.js, demande du 17/09/2026). Ne bloque jamais
      // l'évaluation elle-même si la journalisation échoue (jamais vu en pratique, mais une table
      // annexe ne doit pas empêcher la boucle d'apprentissage principale de progresser).
      correctionRecordService.recordFromImprovement(imp, { metricBefore: before, metricAfter: current })
        .catch((err) => console.error(`[improvementService] Échec journalisation correction ${imp.id}:`, err.message));
    } else {
      next.status = 'NO_EFFECT';
      noEffect += 1;
    }
    await prisma.aIImprovement.update({ where: { id: imp.id }, data: next });
    await prisma.aIImprovementEvent.create({
      data: {
        improvementId: imp.id, actor: 'system', action: 'EVALUATED',
        fromStatus: 'APPLIED', toStatus: next.status,
        note: `Vérification automatique : ${imp.metricName} ${Math.round(before * 100) / 100} → ${Math.round(current * 100) / 100} ` +
          (next.status === 'IMPROVED' ? '(amélioration confirmée, problème résolu).' : '(pas d’amélioration mesurable — correctif à revoir).'),
      },
    });
  }
  return { evaluated: improved + noEffect, improved, noEffect };
}

module.exports = { collectFindings, generateImprovements, setImprovementStatus, updateImprovement, evaluateAppliedImprovements, recomputeMetric, PRIORITY_RANK, OPEN_STATUSES };
