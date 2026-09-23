import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { apiFetch } from '../../api/client';
import { saveSystemConfigKey } from '../../api/systemConfig';

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
}

export function SchedulingSection() {
  const [config, setConfig] = useState<SystemConfigData | null>(null);
  const [nightlyCron, setNightlyCron] = useState('0 4 * * *');
  const [dailyReviewCron, setDailyReviewCron] = useState('30 6 * * *');
  const [revisionThreshold, setRevisionThreshold] = useState('10');
  const [predictionOutcomeCron, setPredictionOutcomeCron] = useState('0 * * * *');

  useEffect(() => {
    apiFetch<SystemConfigData>('/reassort/system-config')
      .then((d) => {
        setConfig(d);
        setNightlyCron(d.NIGHTLY_PROPOSAL_CRON || '0 4 * * *');
        setDailyReviewCron(d.DAILY_REVIEW_CRON || '30 6 * * *');
        setRevisionThreshold(String(Math.round((parseFloat(d.REVISION_CHANGE_THRESHOLD || '') || 0.1) * 100)));
        setPredictionOutcomeCron(d.PREDICTION_OUTCOME_CRON || '0 * * * *');
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
      </div>
    </div>
  );
}
