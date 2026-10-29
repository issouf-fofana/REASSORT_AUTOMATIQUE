import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../../../shared/api/client';
import { saveSystemConfigKey } from '../api/systemConfig';

/** Bandeau de renvoi vers la supervision complète des jobs (Administration > Supervision des
 * tâches) — remplace l'ancien JobsHealthPanel (25/09/2026, 12 jobs sur 26 suivis, un seul statut
 * sans historique ni logs) suite à la demande explicite du 26/10/2026 d'une "interface
 * d'administration centralisée" avec statut, logs, historique et suivi temps réel pour les 26 jobs
 * planifiés — cette nouvelle page vit sous Administration plutôt que dans Paramètres, qui garde ici
 * uniquement la configuration (cron/activation) de chaque job. */
function JobsHealthPanel() {
  return (
    <div className="card">
      <div className="card-body d-flex justify-content-between align-items-center flex-wrap gap-2">
        <div className="d-flex align-items-center gap-2">
          <iconify-icon icon="solar:heart-pulse-bold-duotone" className="text-primary fs-20" />
          <div>
            <div className="fw-semibold">Supervision des tâches planifiées</div>
            <div className="small text-muted">Statut, historique, logs en direct et prochaine exécution des 26 tâches — désormais dans Administration.</div>
          </div>
        </div>
        <Link to="/jobs-admin" className="btn btn-sm btn-outline-primary">
          Ouvrir la supervision
        </Link>
      </div>
    </div>
  );
}

/**
 * Interrupteur "Actif" d'un job : sauvegarde IMMÉDIATE au changement (pas de bouton "Enregistrer"
 * séparé), avec annulation visuelle si l'enregistrement échoue — reproduit exactement
 * wireJobEnabledSwitch de settings.old.html.
 */
function JobEnabledSwitch({ configKey, initialChecked }: { configKey: string; initialChecked: boolean }) {
  const [checked, setChecked] = useState(initialChecked);

  useEffect(() => setChecked(initialChecked), [initialChecked]);

  async function handleChange(next: boolean) {
    setChecked(next);
    try {
      await saveSystemConfigKey(configKey, next ? 'true' : 'false');
    } catch (err) {
      window.reassortToast('Erreur : ' + (err as Error).message, 'error');
      setChecked(!next); // annule visuellement si l'enregistrement a échoué
    }
  }

  return (
    <div className="form-check form-switch mb-0">
      <input
        className="form-check-input"
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(e) => handleChange(e.target.checked)}
      />
      <label className="form-check-label small">Actif</label>
    </div>
  );
}

/** Carte "planification d'un job" : interrupteur actif/inactif + expression cron (+ options
 * supplémentaires via children) + bouton Enregistrer + bouton "Exécuter maintenant". */
function CronJobCard({
  icon,
  title,
  enabledConfigKey,
  enabledInitial,
  intro,
  children,
  onSave,
  onRunNow,
  runLabel = 'Exécuter le job maintenant',
  runningLabel = 'Exécution en cours...',
}: {
  icon: string;
  title: string;
  enabledConfigKey: string;
  enabledInitial: boolean;
  intro: string;
  children: ReactNode;
  onSave: () => Promise<void>;
  onRunNow: () => Promise<string>;
  runLabel?: string;
  runningLabel?: string;
}) {
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [runResult, setRunResult] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  async function handleSave() {
    setSaveError(null);
    setSaveSuccess(null);
    setSaving(true);
    try {
      await onSave();
      setSaveSuccess('Planification mise à jour.');
    } catch (err) {
      setSaveError('Erreur: ' + (err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleRunNow() {
    setRunResult(runningLabel);
    setRunning(true);
    try {
      setRunResult(await onRunNow());
    } catch (err) {
      setRunResult('Erreur: ' + (err as Error).message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="card">
      <div className="card-header d-flex justify-content-between align-items-center">
        <h4 className="card-title d-flex align-items-center gap-1 mb-0">
          <iconify-icon icon={icon} className="text-primary fs-20" />
          {title}
        </h4>
        <JobEnabledSwitch configKey={enabledConfigKey} initialChecked={enabledInitial} />
      </div>
      <div className="card-body">
        <div className="alert alert-light border mb-3 small" dangerouslySetInnerHTML={{ __html: intro }} />
        {children}
        <button type="button" className="btn btn-primary" disabled={saving} onClick={handleSave}>
          {saving ? 'Enregistrement…' : 'Enregistrer'}
        </button>
        {saveError && <div className="alert alert-danger mt-3">{saveError}</div>}
        {saveSuccess && <div className="alert alert-success mt-3">{saveSuccess}</div>}

        <hr className="my-4" />
        <button type="button" className="btn btn-outline-secondary" disabled={running} onClick={handleRunNow}>
          {runLabel}
        </button>
        {runResult && <div className="small mt-2">{runResult}</div>}
      </div>
    </div>
  );
}

interface SystemConfigData {
  NIGHTLY_PROPOSAL_CRON?: string;
  NIGHTLY_PROPOSAL_ENABLED?: string;
  DAILY_REVIEW_CRON?: string;
  DAILY_REVIEW_ENABLED?: string;
  REVISION_CHANGE_THRESHOLD?: string;
  PREDICTION_OUTCOME_CRON?: string;
  PREDICTION_OUTCOME_ENABLED?: string;
  PROPOSAL_REMINDER_CRON?: string;
  PROPOSAL_REMINDER_ENABLED?: string;
  END_OF_DAY_VALIDATION_RECAP_CRON?: string;
  END_OF_DAY_VALIDATION_RECAP_ENABLED?: string;
  TOKEN_USAGE_ALERT_CRON?: string;
  TOKEN_USAGE_ALERT_ENABLED?: string;
  TOKEN_USAGE_ALERT_THRESHOLD_TOKENS?: string;
  STOCKOUT_REACTION_DEADLINE_HOURS?: string;
  STOCKOUT_DELIVERY_DEADLINE_HOURS?: string;
  STOCKOUT_LOSS_METHOD?: string;
  STOCKOUT_LOSS_LOOKBACK_WEEKS?: string;
  STOCKOUT_LOSS_MIN_COMPARABLE_WEEKS?: string;
  STOCKOUT_LOSS_FALLBACK_TO_ALL_DAYS?: string;
  STOCKOUT_LOSS_MIN_COMPARABLE_DAYS_ALL?: string;
  STOCKOUT_ALERT_CRON?: string;
  STOCKOUT_SECTOR_BACKFILL_CRON?: string;
  STOCKOUT_SECTOR_BACKFILL_ENABLED?: string;
  STOCKOUT_ALERT_ENABLED?: string;
  OVERSTOCK_MIN_WEEKS_OF_COVERAGE?: string;
}

export function SchedulingSection() {
  const [config, setConfig] = useState<SystemConfigData | null>(null);
  const [nightlyCron, setNightlyCron] = useState('0 4 * * *');
  const [dailyReviewCron, setDailyReviewCron] = useState('30 6 * * *');
  const [revisionThreshold, setRevisionThreshold] = useState('10');
  const [predictionOutcomeCron, setPredictionOutcomeCron] = useState('0 * * * *');
  const [proposalReminderCron, setProposalReminderCron] = useState('0 10 * * *');
  const [endOfDayRecapCron, setEndOfDayRecapCron] = useState('30 16 * * *');
  const [tokenUsageAlertCron, setTokenUsageAlertCron] = useState('10 7 * * *');
  const [tokenUsageAlertThreshold, setTokenUsageAlertThreshold] = useState('2000000');
  const [stockoutReactionDeadline, setStockoutReactionDeadline] = useState('24');
  const [stockoutDeliveryDeadline, setStockoutDeliveryDeadline] = useState('48');
  const [stockoutDeadlinesSaving, setStockoutDeadlinesSaving] = useState(false);
  const [stockoutDeadlinesSaved, setStockoutDeadlinesSaved] = useState(false);
  const [stockoutLossLookbackWeeks, setStockoutLossLookbackWeeks] = useState('52');
  const [stockoutLossMinComparableWeeks, setStockoutLossMinComparableWeeks] = useState('8');
  // Méthode de calcul configurable (demande explicite du 19/10/2026 : "l'analyse peux ce faire sur
  // les meme jour, la la possiblité de configuré sur la validité des donner en fonction de la
  // moyenne global sur une periode").
  // Choix EXPLICITE de méthode (demande explicite du 19/10/2026, après clarification : "si tu dois
  // les meme jour c'est quoi les meme jour de la rupture ou c'est quoi ? [...] si je veux pas passer
  // sur les meme jour mais les 52 semaine") — 'SAME_WEEKDAY' ou 'ALL_DAYS', toujours appliqué tel
  // quel, pas juste un repli de dernier recours.
  const [stockoutLossMethod, setStockoutLossMethod] = useState<'SAME_WEEKDAY' | 'ALL_DAYS'>('SAME_WEEKDAY');
  const [stockoutLossFallbackToAllDays, setStockoutLossFallbackToAllDays] = useState(true);
  const [stockoutLossMinComparableDaysAll, setStockoutLossMinComparableDaysAll] = useState('14');
  const [stockoutAlertCron, setStockoutAlertCron] = useState('0 8 * * *');
  const [stockoutSectorBackfillCron, setStockoutSectorBackfillCron] = useState('30 */6 * * *');
  // Seuil de surstock (demande explicite du 29/10/2026 : "la condig est en dure ? je veux metre
  // dans les configuration sur le UI dans les parametre... je dois pouvoir les modifier") — codé en
  // dur à 2 semaines dans overstockReportService.js jusqu'ici, 4 par défaut (= 1 mois) désormais.
  const [overstockMinWeeksOfCoverage, setOverstockMinWeeksOfCoverage] = useState('4');
  const [overstockThresholdSaving, setOverstockThresholdSaving] = useState(false);
  const [overstockThresholdSaved, setOverstockThresholdSaved] = useState(false);

  useEffect(() => {
    apiFetch<SystemConfigData>('/reassort/system-config')
      .then((d) => {
        setConfig(d);
        setNightlyCron(d.NIGHTLY_PROPOSAL_CRON || '0 4 * * *');
        setDailyReviewCron(d.DAILY_REVIEW_CRON || '30 6 * * *');
        setRevisionThreshold(String(Math.round((parseFloat(d.REVISION_CHANGE_THRESHOLD || '') || 0.1) * 100)));
        setPredictionOutcomeCron(d.PREDICTION_OUTCOME_CRON || '0 * * * *');
        setProposalReminderCron(d.PROPOSAL_REMINDER_CRON || '0 10 * * *');
        setEndOfDayRecapCron(d.END_OF_DAY_VALIDATION_RECAP_CRON || '30 16 * * *');
        setTokenUsageAlertCron(d.TOKEN_USAGE_ALERT_CRON || '10 7 * * *');
        setTokenUsageAlertThreshold(d.TOKEN_USAGE_ALERT_THRESHOLD_TOKENS || '2000000');
        setStockoutReactionDeadline(d.STOCKOUT_REACTION_DEADLINE_HOURS || '24');
        setStockoutDeliveryDeadline(d.STOCKOUT_DELIVERY_DEADLINE_HOURS || '48');
        setStockoutLossLookbackWeeks(d.STOCKOUT_LOSS_LOOKBACK_WEEKS || '52');
        setStockoutLossMinComparableWeeks(d.STOCKOUT_LOSS_MIN_COMPARABLE_WEEKS || '8');
        setStockoutLossMethod(d.STOCKOUT_LOSS_METHOD === 'ALL_DAYS' ? 'ALL_DAYS' : 'SAME_WEEKDAY');
        setStockoutLossFallbackToAllDays(d.STOCKOUT_LOSS_FALLBACK_TO_ALL_DAYS !== 'false');
        setStockoutLossMinComparableDaysAll(d.STOCKOUT_LOSS_MIN_COMPARABLE_DAYS_ALL || '14');
        setStockoutAlertCron(d.STOCKOUT_ALERT_CRON || '0 8 * * *');
        setStockoutSectorBackfillCron(d.STOCKOUT_SECTOR_BACKFILL_CRON || '30 */6 * * *');
        setOverstockMinWeeksOfCoverage(d.OVERSTOCK_MIN_WEEKS_OF_COVERAGE || '4');
      })
      // Silencieux si non-admin (route protégée), même comportement que loadSystemConfig().
      .catch(() => {});
  }, []);

  // Attend que la config initiale soit chargée avant de monter les interrupteurs (sinon ils
  // démarreraient tous décochés puis "sauteraient" visuellement à leur vraie valeur).
  if (!config) return null;

  return (
    <div className="row">
      <div className="col-xl-8 d-flex flex-column gap-3">
        <JobsHealthPanel />
        <CronJobCard
          icon="solar:clock-circle-bold-duotone"
          title="Planification du job nocturne"
          enabledConfigKey="NIGHTLY_PROPOSAL_ENABLED"
          enabledInitial={config.NIGHTLY_PROPOSAL_ENABLED !== 'false'}
          intro="<strong>À quoi ça sert :</strong> chaque nuit, le système calcule automatiquement la proposition de réassort de tous les magasins actifs, pour qu'elle soit prête dès que le responsable magasin se connecte le matin. Désactivez l'interrupteur ci-dessus pour suspendre complètement ce job jusqu'à réactivation."
          onSave={() => saveSystemConfigKey('NIGHTLY_PROPOSAL_CRON', nightlyCron)}
          onRunNow={async () => {
            // Cas particulier : cette route renvoie { success, message } SANS champ `data` (contrairement
            // aux 2 autres run-now ci-dessous) — apiFetch (qui retourne json.data) donnerait undefined ici,
            // d'où un accès direct à la réponse plutôt que le helper générique.
            const res = await window.reassortFetch('/reassort/run-nightly-job', { method: 'POST' });
            const json: { success: boolean; message: string } = await res.json();
            if (!json.success) throw new Error(json.message);
            return 'Terminé : ' + json.message;
          }}
          runLabel="Exécuter le job maintenant"
          runningLabel="Exécution en cours (peut prendre plusieurs minutes)..."
        >
          <div className="mb-3">
            <label className="form-label fw-semibold">Expression cron</label>
            <input
              type="text"
              className="form-control"
              placeholder="0 4 * * *"
              style={{ maxWidth: 300 }}
              value={nightlyCron}
              onChange={(e) => setNightlyCron(e.target.value)}
            />
            <div className="form-text">
              Format standard cron : minute, heure, jour du mois, mois, jour de la semaine (* = tous).
              <br />
              Exemples : "0 4 * * *" = tous les jours à 4h00 • "0 4 * * 1-5" = du lundi au vendredi à 4h00 •
              "30 5 * * *" = tous les jours à 5h30.
            </div>
          </div>
        </CronJobCard>

        <CronJobCard
          icon="solar:refresh-circle-bold-duotone"
          title="Réajustement quotidien du réassort"
          enabledConfigKey="DAILY_REVIEW_ENABLED"
          enabledInitial={config.DAILY_REVIEW_ENABLED !== 'false'}
          intro="<strong>À quoi ça sert :</strong> chaque jour, le système recalcule les propositions de la semaine en cours qui n'ont pas encore été validées, en tenant compte des ventes et du stock observés depuis la dernière génération. Une nouvelle révision n'est créée que si la quantité totale change de plus du seuil configuré ci-dessous — sinon la proposition reste inchangée, pour éviter de multiplier les révisions sur des variations mineures."
          onSave={async () => {
            await saveSystemConfigKey('DAILY_REVIEW_CRON', dailyReviewCron);
            // Valeur toujours envoyée en chaîne (systemConfig.value est un champ String côté
            // Prisma) — bug déjà rencontré sur ce même réglage le 21/09/2026.
            await saveSystemConfigKey('REVISION_CHANGE_THRESHOLD', (parseFloat(revisionThreshold) / 100).toString());
          }}
          onRunNow={async () => {
            const d = await apiFetch<{ reviewed: number; revised: number; skipped: number; failed: number }>(
              '/reassort/run-daily-review',
              { method: 'POST' }
            );
            return `Terminé : ${d.reviewed} plan(s) revu(s), ${d.revised} révisé(s), ${d.skipped} inchangé(s), ${d.failed} échec(s).`;
          }}
          runLabel="Exécuter le réajustement maintenant"
          runningLabel="Exécution en cours (peut prendre plusieurs minutes par magasin à réviser)..."
        >
          <div className="mb-3">
            <label className="form-label fw-semibold">Expression cron</label>
            <input
              type="text"
              className="form-control"
              placeholder="30 6 * * *"
              style={{ maxWidth: 300 }}
              value={dailyReviewCron}
              onChange={(e) => setDailyReviewCron(e.target.value)}
            />
            <div className="form-text">
              Exemple : "30 6 * * *" = tous les jours à 6h30, après le job nocturne (4h) et la synchro des ventes
              de la nuit.
            </div>
          </div>
          <div className="mb-3">
            <label className="form-label fw-semibold">Seuil de changement pour créer une révision</label>
            <div className="input-group" style={{ maxWidth: 200 }}>
              <input
                type="number"
                className="form-control"
                min={0}
                max={100}
                value={revisionThreshold}
                onChange={(e) => setRevisionThreshold(e.target.value)}
              />
              <span className="input-group-text">%</span>
            </div>
            <div className="form-text">
              Exemple : avec 10%, une variation de quantité totale proposée inférieure à 10% ne crée pas de
              nouvelle révision.
            </div>
          </div>
        </CronJobCard>

        <CronJobCard
          icon="solar:chart-2-bold-duotone"
          title="Évaluation des prédictions"
          enabledConfigKey="PREDICTION_OUTCOME_ENABLED"
          enabledInitial={config.PREDICTION_OUTCOME_ENABLED !== 'false'}
          intro="<strong>À quoi ça sert :</strong> une fois la semaine cible d'une prédiction terminée, le système compare la quantité prévue aux ventes réellement observées et enregistre l'écart (erreur de prévision). Purement une mesure de fiabilité de l'IA dans le temps — aucune commande ni proposition n'est modifiée par ce job."
          onSave={() => saveSystemConfigKey('PREDICTION_OUTCOME_CRON', predictionOutcomeCron)}
          onRunNow={async () => {
            const d = await apiFetch<{ evaluated: number; failed: number }>('/reassort/run-prediction-outcome', {
              method: 'POST',
            });
            return `Terminé : ${d.evaluated} prédiction(s) évaluée(s), ${d.failed} échec(s).`;
          }}
          runLabel="Évaluer les prédictions maintenant"
        >
          <div className="mb-3">
            <label className="form-label fw-semibold">Expression cron</label>
            <input
              type="text"
              className="form-control"
              placeholder="0 * * * *"
              style={{ maxWidth: 300 }}
              value={predictionOutcomeCron}
              onChange={(e) => setPredictionOutcomeCron(e.target.value)}
            />
            <div className="form-text">
              Exemple : "0 * * * *" = toutes les heures (défaut depuis le 22/09/2026, pour que la précision IA et
              le score de confiance affichés sur Vue Globale se mettent à jour rapidement après chaque vente,
              plutôt qu'une seule fois par jour).
            </div>
          </div>
        </CronJobCard>

        <CronJobCard
          icon="solar:bell-bing-bold-duotone"
          title="Relance des propositions en attente"
          enabledConfigKey="PROPOSAL_REMINDER_ENABLED"
          enabledInitial={config.PROPOSAL_REMINDER_ENABLED !== 'false'}
          intro="<strong>À quoi ça sert :</strong> l'entrepôt ne reçoit plus les commandes après 13h — une commande envoyée après cette heure est traitée le lendemain. Ce job envoie un email de rappel (gravité plus marquée que l'alerte initiale) aux comptes rattachés à chaque magasin ayant encore une proposition non validée au moment où il s'exécute, pour laisser le temps de valider avant cette limite."
          onSave={() => saveSystemConfigKey('PROPOSAL_REMINDER_CRON', proposalReminderCron)}
          onRunNow={async () => {
            const d = await apiFetch<{ reminded: number; failed: number }>('/reassort/run-proposal-reminder', { method: 'POST' });
            return `Terminé : ${d.reminded} relance(s) envoyée(s), ${d.failed} échec(s).`;
          }}
          runLabel="Envoyer les relances maintenant"
        >
          <div className="mb-3">
            <label className="form-label fw-semibold">Expression cron</label>
            <input
              type="text"
              className="form-control"
              placeholder="0 10 * * *"
              style={{ maxWidth: 300 }}
              value={proposalReminderCron}
              onChange={(e) => setProposalReminderCron(e.target.value)}
            />
            <div className="form-text">
              Exemple : "0 10 * * *" = tous les jours à 10h00 (défaut, dans la fenêtre 9h-11h recommandée avant la
              limite de 13h de l'entrepôt).
            </div>
          </div>
        </CronJobCard>

        <CronJobCard
          icon="solar:clipboard-check-bold-duotone"
          title="Récap de fin de journée"
          enabledConfigKey="END_OF_DAY_VALIDATION_RECAP_ENABLED"
          enabledInitial={config.END_OF_DAY_VALIDATION_RECAP_ENABLED !== 'false'}
          intro="<strong>À quoi ça sert :</strong> juste après la fermeture de la fenêtre entrepôt (13h), ce job envoie un seul email aux administrateurs listant, pour chaque magasin ayant eu une proposition aujourd'hui, si elle a été validée ou non — un bilan de supervision, jamais envoyé aux magasins eux-mêmes."
          onSave={() => saveSystemConfigKey('END_OF_DAY_VALIDATION_RECAP_CRON', endOfDayRecapCron)}
          onRunNow={async () => {
            const d = await apiFetch<{ validated: number; pending: number }>('/reassort/run-end-of-day-validation-recap', { method: 'POST' });
            return `Terminé : ${d.validated} magasin(s) validé(s), ${d.pending} non validé(s).`;
          }}
          runLabel="Envoyer le récap maintenant"
        >
          <div className="mb-3">
            <label className="form-label fw-semibold">Expression cron</label>
            <input
              type="text"
              className="form-control"
              placeholder="30 16 * * *"
              style={{ maxWidth: 300 }}
              value={endOfDayRecapCron}
              onChange={(e) => setEndOfDayRecapCron(e.target.value)}
            />
            <div className="form-text">
              Exemple : "30 16 * * *" = tous les jours à 16h30 (défaut).
            </div>
          </div>
        </CronJobCard>

        <CronJobCard
          icon="solar:danger-triangle-bold-duotone"
          title="Chien de garde consommation de tokens"
          enabledConfigKey="TOKEN_USAGE_ALERT_ENABLED"
          enabledInitial={config.TOKEN_USAGE_ALERT_ENABLED !== 'false'}
          intro="<strong>À quoi ça sert :</strong> chaque jour, ce job compare la consommation de tokens IA (chatbot, prévisions...) des dernières 24h au seuil configuré ci-dessous, et envoie un email aux administrateurs en cas de dépassement — avec le détail de quel usage (prévision, chatbot...) en est responsable. Permet de réagir à un pic de consommation en heures plutôt qu'en le découvrant plusieurs jours plus tard sur la page Consommation de tokens."
          onSave={async () => {
            await saveSystemConfigKey('TOKEN_USAGE_ALERT_CRON', tokenUsageAlertCron);
            await saveSystemConfigKey('TOKEN_USAGE_ALERT_THRESHOLD_TOKENS', tokenUsageAlertThreshold);
          }}
          onRunNow={async () => {
            const d = await apiFetch<{ totalTokens: number; callCount: number; threshold: number; overThreshold: boolean; notified: boolean }>(
              '/reassort/run-token-usage-watchdog',
              { method: 'POST' }
            );
            if (d.overThreshold) {
              return `Terminé : ${d.totalTokens.toLocaleString('fr-FR')} tokens sur les dernières 24h (seuil ${d.threshold.toLocaleString('fr-FR')}) — ${d.notified ? 'alerte envoyée aux administrateurs.' : "échec d'envoi de l'alerte, voir les logs."}`;
            }
            return `Terminé : ${d.totalTokens.toLocaleString('fr-FR')} tokens sur les dernières 24h, en dessous du seuil (${d.threshold.toLocaleString('fr-FR')}) — aucune alerte envoyée.`;
          }}
          runLabel="Vérifier la consommation maintenant"
        >
          <div className="mb-3">
            <label className="form-label fw-semibold">Expression cron</label>
            <input
              type="text"
              className="form-control"
              placeholder="10 7 * * *"
              style={{ maxWidth: 300 }}
              value={tokenUsageAlertCron}
              onChange={(e) => setTokenUsageAlertCron(e.target.value)}
            />
            <div className="form-text">
              Exemple : "10 7 * * *" = tous les jours à 7h10 (défaut), juste après l'évaluation des prédictions.
            </div>
          </div>
          <div className="mb-3">
            <label className="form-label fw-semibold">Seuil d'alerte (tokens sur 24h)</label>
            <input
              type="number"
              className="form-control"
              min={0}
              step={100000}
              style={{ maxWidth: 220 }}
              value={tokenUsageAlertThreshold}
              onChange={(e) => setTokenUsageAlertThreshold(e.target.value)}
            />
            <div className="form-text">
              Exemple : 2 000 000 (défaut) — à ajuster selon votre consommation normale observée sur la page
              Consommation de tokens.
            </div>
          </div>
        </CronJobCard>

        {/* Seuils de délai du module Ruptures de stock — demande explicite du 17/10/2026 : "le delai
            max de livrason doit etre 48h mais il faut rendre ca modifiable sur les parametre". Pas
            un job planifié (pas de cron/onRunNow), donc carte simple plutôt que CronJobCard. */}
        <div className="card">
          <div className="card-header">
            <h4 className="card-title d-flex align-items-center gap-1">
              <iconify-icon icon="solar:box-minimalistic-bold-duotone" className="text-primary fs-20" />
              Délais du module Ruptures de stock
            </h4>
          </div>
          <div className="card-body">
            <div
              className="alert alert-light border small mb-3"
              dangerouslySetInnerHTML={{
                __html:
                  "<strong>À quoi ça sert :</strong> détermine quand une rupture passe de « en attente de commande » à « retard », puis à « magasin n'a pas réagi » (page Ruptures de stock), et au-delà de quelle durée totale la fiche d'une rupture affiche un bandeau d'alerte.",
              }}
            />
            <div className="row g-3">
              <div className="col-md-6">
                <label className="form-label fw-semibold">Délai de réaction attendu (commande)</label>
                <div className="input-group" style={{ maxWidth: 200 }}>
                  <input
                    type="number"
                    className="form-control"
                    min={1}
                    value={stockoutReactionDeadline}
                    onChange={(e) => setStockoutReactionDeadline(e.target.value)}
                  />
                  <span className="input-group-text">h</span>
                </div>
                <div className="form-text">
                  Sans commande passée avant ce délai (24h par défaut), une rupture passe au statut « Retard ».
                </div>
              </div>
              <div className="col-md-6">
                <label className="form-label fw-semibold">Délai de livraison maximum</label>
                <div className="input-group" style={{ maxWidth: 200 }}>
                  <input
                    type="number"
                    className="form-control"
                    min={1}
                    value={stockoutDeliveryDeadline}
                    onChange={(e) => setStockoutDeliveryDeadline(e.target.value)}
                  />
                  <span className="input-group-text">h</span>
                </div>
                <div className="form-text">
                  Sans commande passée après ce délai (48h par défaut), le magasin est considéré comme n'ayant pas
                  réagi. Sert aussi de seuil pour le bandeau d'alerte « durée inhabituelle » sur la fiche d'une
                  rupture.
                </div>
              </div>
            </div>

            <hr className="my-4" />

            <div
              className="alert alert-light border small mb-3"
              dangerouslySetInnerHTML={{
                __html:
                  "<strong>À quoi ça sert :</strong> le CA perdu estimé d'une rupture compare la vente moyenne du même jour de semaine (ex: vendredis contre vendredis) sur les semaines précédentes à ce qui a été réellement vendu pendant la rupture. Ces deux réglages déterminent la fenêtre de comparaison utilisée.",
              }}
            />
            <div className="row g-3">
              <div className="col-md-6">
                <label className="form-label fw-semibold">Fenêtre de comparaison (recul)</label>
                <div className="input-group" style={{ maxWidth: 200 }}>
                  <input
                    type="number"
                    className="form-control"
                    min={1}
                    value={stockoutLossLookbackWeeks}
                    onChange={(e) => setStockoutLossLookbackWeeks(e.target.value)}
                  />
                  <span className="input-group-text">sem.</span>
                </div>
                <div className="form-text">
                  Nombre de semaines de recul utilisées pour calculer la vente moyenne attendue (52 = 1 an par
                  défaut, capture la saisonnalité annuelle).
                </div>
              </div>
              <div className="col-md-6">
                <label className="form-label fw-semibold">Minimum de semaines comparables</label>
                <div className="input-group" style={{ maxWidth: 200 }}>
                  <input
                    type="number"
                    className="form-control"
                    min={1}
                    value={stockoutLossMinComparableWeeks}
                    onChange={(e) => setStockoutLossMinComparableWeeks(e.target.value)}
                  />
                  <span className="input-group-text">sem.</span>
                </div>
                <div className="form-text">
                  En dessous de ce nombre de semaines avec des ventes constatées, l'estimation est jugée trop
                  fragile et affichée comme « indisponible » plutôt qu'un chiffre peu fiable.
                </div>
              </div>
            </div>

            <hr className="my-4" />

            <div
              className="alert alert-light border small mb-3"
              dangerouslySetInnerHTML={{
                __html:
                  "<strong>Méthode de calcul :</strong> « Même jour de semaine » compare la rupture aux semaines précédentes DU MÊME JOUR (ex: une rupture démarrée un vendredi est comparée aux vendredis précédents, jamais aux autres jours) — plus précis mais exige plus d'historique. « Tous les jours confondus » fait une moyenne quotidienne sur toute la fenêtre de recul (52 semaines par défaut), sans distinguer les jours — moins précis (ignore qu'un samedi peut différer fortement d'un mardi) mais toujours disponible, même avec peu d'historique.",
              }}
            />
            <div className="row g-3 align-items-end mb-3">
              <div className="col-md-6">
                <label className="form-label fw-semibold">Méthode</label>
                <select
                  className="form-select"
                  value={stockoutLossMethod}
                  onChange={(e) => setStockoutLossMethod(e.target.value as 'SAME_WEEKDAY' | 'ALL_DAYS')}
                >
                  <option value="SAME_WEEKDAY">Même jour de semaine (recommandé)</option>
                  <option value="ALL_DAYS">Tous les jours confondus (moyenne sur toute la fenêtre)</option>
                </select>
              </div>
            </div>

            {stockoutLossMethod === 'SAME_WEEKDAY' && (
              <div className="row g-3 align-items-end">
                <div className="col-md-6">
                  <div className="form-check form-switch">
                    <input
                      className="form-check-input"
                      type="checkbox"
                      role="switch"
                      id="stockoutLossFallbackToAllDays"
                      checked={stockoutLossFallbackToAllDays}
                      onChange={(e) => setStockoutLossFallbackToAllDays(e.target.checked)}
                    />
                    <label className="form-check-label fw-semibold" htmlFor="stockoutLossFallbackToAllDays">
                      Autoriser le repli sur la moyenne tous jours confondus
                    </label>
                  </div>
                  <div className="form-text">
                    Si un article précis n'a pas assez de semaines comparables du même jour, bascule automatiquement
                    sur « tous les jours confondus » pour CET article seulement, plutôt que d'afficher « indisponible ».
                  </div>
                </div>
                <div className="col-md-6">
                  <label className="form-label fw-semibold">Minimum de jours comparables (repli)</label>
                  <div className="input-group" style={{ maxWidth: 200 }}>
                    <input
                      type="number"
                      className="form-control"
                      min={1}
                      disabled={!stockoutLossFallbackToAllDays}
                      value={stockoutLossMinComparableDaysAll}
                      onChange={(e) => setStockoutLossMinComparableDaysAll(e.target.value)}
                    />
                    <span className="input-group-text">j.</span>
                  </div>
                  <div className="form-text">
                    Nombre minimum de jours de vente constatés (tous jours confondus) requis pour accepter ce repli.
                  </div>
                </div>
              </div>
            )}

            <button
              type="button"
              className="btn btn-primary mt-3"
              disabled={stockoutDeadlinesSaving}
              onClick={async () => {
                setStockoutDeadlinesSaving(true);
                setStockoutDeadlinesSaved(false);
                try {
                  await saveSystemConfigKey('STOCKOUT_REACTION_DEADLINE_HOURS', stockoutReactionDeadline);
                  await saveSystemConfigKey('STOCKOUT_DELIVERY_DEADLINE_HOURS', stockoutDeliveryDeadline);
                  await saveSystemConfigKey('STOCKOUT_LOSS_LOOKBACK_WEEKS', stockoutLossLookbackWeeks);
                  await saveSystemConfigKey('STOCKOUT_LOSS_MIN_COMPARABLE_WEEKS', stockoutLossMinComparableWeeks);
                  await saveSystemConfigKey('STOCKOUT_LOSS_METHOD', stockoutLossMethod);
                  await saveSystemConfigKey('STOCKOUT_LOSS_FALLBACK_TO_ALL_DAYS', stockoutLossFallbackToAllDays ? 'true' : 'false');
                  await saveSystemConfigKey('STOCKOUT_LOSS_MIN_COMPARABLE_DAYS_ALL', stockoutLossMinComparableDaysAll);
                  setStockoutDeadlinesSaved(true);
                } finally {
                  setStockoutDeadlinesSaving(false);
                }
              }}
            >
              {stockoutDeadlinesSaving ? 'Enregistrement…' : 'Enregistrer'}
            </button>
            {stockoutDeadlinesSaved && <span className="text-success small ms-2">Enregistré.</span>}
          </div>
        </div>

        {/* Seuil de surstock (demande explicite du 29/10/2026 : "la condig est en dure ? je veux
            metre dans les configuration sur le UI dans les parametre... je dois pouvoir les
            modifier") — codé en dur à 2 semaines dans overstockReportService.js jusqu'ici, pas un
            job planifié, carte simple comme les délais de ruptures ci-dessus. */}
        <div className="card">
          <div className="card-header">
            <h4 className="card-title d-flex align-items-center gap-1">
              <iconify-icon icon="solar:box-minimalistic-bold-duotone" className="text-primary fs-20" />
              Seuil de surstock
            </h4>
          </div>
          <div className="card-body">
            <div
              className="alert alert-light border small mb-3"
              dangerouslySetInnerHTML={{
                __html:
                  "<strong>À quoi ça sert :</strong> détermine à partir de combien de semaines de couverture de stock (stock actuel ÷ vente moyenne hebdomadaire) un article est considéré « en surstock » sur la page Surstock et par l'assistant IA.",
              }}
            />
            <div className="row g-3 align-items-end">
              <div className="col-md-6">
                <label className="form-label fw-semibold">Seuil de surstock</label>
                <div className="input-group" style={{ maxWidth: 220 }}>
                  <input
                    type="number"
                    className="form-control"
                    min={0.5}
                    step={0.5}
                    value={overstockMinWeeksOfCoverage}
                    onChange={(e) => setOverstockMinWeeksOfCoverage(e.target.value)}
                  />
                  <span className="input-group-text">semaines de couverture ou plus</span>
                </div>
                <div className="form-text">Ex : 4 semaines ≈ 1 mois de couverture.</div>
              </div>
            </div>

            <button
              type="button"
              className="btn btn-primary mt-3"
              disabled={overstockThresholdSaving}
              onClick={async () => {
                setOverstockThresholdSaving(true);
                setOverstockThresholdSaved(false);
                try {
                  await saveSystemConfigKey('OVERSTOCK_MIN_WEEKS_OF_COVERAGE', overstockMinWeeksOfCoverage);
                  setOverstockThresholdSaved(true);
                } finally {
                  setOverstockThresholdSaving(false);
                }
              }}
            >
              {overstockThresholdSaving ? 'Enregistrement…' : 'Enregistrer'}
            </button>
            {overstockThresholdSaved && <span className="text-success small ms-2">Enregistré.</span>}
          </div>
        </div>

        {/* Alerte email des ruptures en cours (demande explicite du 18/10/2026 : "je veux quil ai
            une partie la possibilité de faire un mail auto au magasin sil ya des article qui son en
            rupture... il doit etre alecter pour ca aussi... meme si ya une propostion de commande")
            — contrairement à la relance de proposition, celle-ci alerte sur la RUPTURE elle-même,
            qu'une commande ait déjà été passée ou non. */}
        <CronJobCard
          icon="solar:letter-unread-bold-duotone"
          title="Alerte email des ruptures en cours"
          enabledConfigKey="STOCKOUT_ALERT_ENABLED"
          enabledInitial={config.STOCKOUT_ALERT_ENABLED !== 'false'}
          intro="<strong>À quoi ça sert :</strong> envoie à chaque magasin ayant des ruptures de stock EN COURS un récapitulatif par email (articles concernés, rayon, durée, statut commande/livraison). Contrairement à l'alerte de proposition, ce mail part même si une commande a déjà été passée sur l'article : tant qu'il n'est pas revenu en stock, la rupture reste signalée."
          onSave={() => saveSystemConfigKey('STOCKOUT_ALERT_CRON', stockoutAlertCron)}
          onRunNow={async () => {
            const d = await apiFetch<{ alerted: number; skipped: number }>('/reassort/run-stockout-alert', { method: 'POST' });
            return `Terminé : ${d.alerted} magasin(s) alerté(s), ${d.skipped} sans rupture ou sans destinataire.`;
          }}
          runLabel="Envoyer les alertes maintenant"
        >
          <div className="mb-3">
            <label className="form-label fw-semibold">Expression cron</label>
            <input
              type="text"
              className="form-control"
              placeholder="0 8 * * *"
              style={{ maxWidth: 300 }}
              value={stockoutAlertCron}
              onChange={(e) => setStockoutAlertCron(e.target.value)}
            />
            <div className="form-text">
              Exemple : "0 8 * * *" = tous les jours à 8h00 (défaut, avant l'ouverture).
            </div>
          </div>
        </CronJobCard>

        {/* Résolution secteur/rayon des ruptures — carte ajoutée le 18/10/2026 (le job existait
            déjà, mais sans carte dans Paramètres, donc aucun moyen de forcer un rattrapage immédiat
            depuis l'UI ; bug signalé : "en prod j'ai des sans secteur encore" — avec plusieurs
            milliers d'épisodes sur le réseau, attendre le prochain passage toutes les 6h est trop
            lent après un correctif). */}
        <CronJobCard
          icon="solar:tag-bold-duotone"
          title="Résolution du secteur/rayon des ruptures"
          enabledConfigKey="STOCKOUT_SECTOR_BACKFILL_ENABLED"
          enabledInitial={config.STOCKOUT_SECTOR_BACKFILL_ENABLED !== 'false'}
          intro="<strong>À quoi ça sert :</strong> une rupture d'article dont le secteur/rayon n'a jamais pu être résolu localement (article jamais vu par une proposition) s'affiche « Sans secteur ». Ce job interroge RPOS pour résoudre ces cas en continu, en filet de sécurité derrière la résolution faite à la création de chaque rupture."
          onSave={() => saveSystemConfigKey('STOCKOUT_SECTOR_BACKFILL_CRON', stockoutSectorBackfillCron)}
          onRunNow={async () => {
            const d = await apiFetch<{ total: number; resolved: number; stillNull: number }>('/reassort/run-stockout-sector-backfill', { method: 'POST' });
            return `Terminé : ${d.resolved}/${d.total} résolu(s), ${d.stillNull} resté(s) sans secteur.`;
          }}
          runLabel="Résoudre maintenant"
        >
          <div className="mb-3">
            <label className="form-label fw-semibold">Expression cron</label>
            <input
              type="text"
              className="form-control"
              placeholder="30 */6 * * *"
              style={{ maxWidth: 300 }}
              value={stockoutSectorBackfillCron}
              onChange={(e) => setStockoutSectorBackfillCron(e.target.value)}
            />
            <div className="form-text">
              Exemple : "30 */6 * * *" = toutes les 6 heures (défaut).
            </div>
          </div>
        </CronJobCard>
      </div>
    </div>
  );
}
