import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { apiFetch } from '../../../shared/api/client';
import { saveSystemConfigKey } from '../api/systemConfig';

// Libellés lisibles pour les 9 jobs suivis par jobHealthService (trackJobRun, cf. cronManager.js) —
// noms techniques (nightlyProposal, salesSync...) traduits pour l'affichage, jamais montrés bruts.
const JOB_LABELS: Record<string, string> = {
  nightlyProposal: 'Génération nocturne des propositions',
  receptionSync: 'Synchronisation des réceptions',
  salesSync: 'Synchronisation des ventes',
  salesDailyRecap: 'Récap quotidien de couverture des ventes',
  productEolSync: 'Synchronisation des DLV',
  shopsSync: 'Synchronisation des magasins',
  dailyReplenishmentReview: 'Réajustement quotidien du réassort',
  predictionOutcome: 'Évaluation des prédictions',
  improvementWatchdog: "Chien de garde améliorations IA",
  proposalReminder: 'Relance des propositions en attente',
  endOfDayValidationRecap: 'Récap de fin de journée',
  tokenUsageWatchdog: 'Chien de garde consommation de tokens',
};

interface JobHealth {
  jobName: string;
  status: 'ok' | 'error' | 'degraded';
  lastRunAt?: string;
  consecutiveFailures?: number;
  lastError?: string;
}

const STATUS_META: Record<JobHealth['status'], { label: string; badge: string }> = {
  ok: { label: 'OK', badge: 'bg-success-subtle text-success' },
  error: { label: 'Erreur', badge: 'bg-warning-subtle text-warning' },
  degraded: { label: 'Dégradé', badge: 'bg-danger-subtle text-danger' },
};

function fmtDate(iso?: string): string {
  return iso ? new Date(iso).toLocaleString('fr-FR') : '—';
}

/** Suivi de santé des tâches planifiées (demande du 25/09/2026, section "Automatisation" du Guide
 * du projet marquée "en cours") : jobHealthService trackait déjà les 9 jobs côté backend
 * (cronManager.js), mais rien ne l'affichait — un job en échec répété restait invisible sans aller
 * lire les logs serveur. */
function JobsHealthPanel() {
  const [jobs, setJobs] = useState<JobHealth[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const data = await apiFetch<JobHealth[]>('/reassort/system-config/jobs-health');
      setJobs(data);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="card">
      <div className="card-header d-flex justify-content-between align-items-center">
        <h4 className="card-title d-flex align-items-center gap-1 mb-0">
          <iconify-icon icon="solar:heart-pulse-bold-duotone" className="text-primary fs-20" />
          Santé des tâches planifiées
        </h4>
        <button type="button" className="btn btn-sm btn-outline-secondary" onClick={load}>
          <iconify-icon icon="solar:refresh-bold-duotone" className="align-middle"></iconify-icon> Actualiser
        </button>
      </div>
      <div className="card-body">
        <div className="alert alert-light border mb-3 small">
          <strong>À quoi ça sert :</strong> chaque tâche automatique (synchronisation, génération nocturne, contrôles...) enregistre
          son dernier statut ici. Un job "Dégradé" a échoué au moins 3 fois de suite — une vérification manuelle est recommandée
          plutôt que d'attendre un signalement fortuit dans les logs serveur.
        </div>
        {error && <div className="alert alert-danger">{error}</div>}
        {!jobs && !error && <div className="text-muted small">Chargement...</div>}
        {jobs && jobs.length === 0 && (
          <div className="text-muted small">Aucune tâche n'a encore été exécutée depuis le démarrage du serveur.</div>
        )}
        {jobs && jobs.length > 0 && (
          <div className="table-responsive">
            <table className="table table-sm align-middle mb-0">
              <thead>
                <tr>
                  <th>Tâche</th>
                  <th>Statut</th>
                  <th>Dernière exécution</th>
                  <th>Échecs consécutifs</th>
                  <th>Dernière erreur</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => {
                  const meta = STATUS_META[j.status] || STATUS_META.ok;
                  return (
                    <tr key={j.jobName}>
                      <td>{JOB_LABELS[j.jobName] || j.jobName}</td>
                      <td>
                        <span className={`badge ${meta.badge}`}>{meta.label}</span>
                      </td>
                      <td className="small text-muted">{fmtDate(j.lastRunAt)}</td>
                      <td className="small">{j.consecutiveFailures || 0}</td>
                      <td className="small text-muted">{j.lastError || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
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
      </div>
    </div>
  );
}
