import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { apiFetch } from '../../api/client';
import { saveSystemConfigKey } from '../../api/systemConfig';

const PROVIDER_LABELS: Record<string, string> = {
  gemini: 'Google Gemini',
  openai: 'OpenAI',
  anthropic: 'Anthropic (Claude)',
};

interface AiKey {
  id: string;
  label: string;
  provider: string;
  model?: string;
  priority: number;
  maskedKey: string;
  isActive: boolean;
  lastUsedAt?: string;
  lastError?: string;
  lastErrorAt?: string;
}

interface AiUsage {
  totalTokens: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  callCount: number;
  trackingSince?: string;
  byProvider: { provider: string; callCount: number; totalTokens: number }[];
  byContext: { context: string; callCount: number; totalTokens: number }[];
}

function formatTokenCount(n: number): string {
  return (n || 0).toLocaleString('fr-FR');
}

// --- Carte "Clés API IA" ---

function AiKeyStatusBadge({ k }: { k: AiKey }) {
  if (k.lastError) {
    return (
      <span className="badge bg-danger-subtle text-danger" title={k.lastError}>
        Échec {k.lastErrorAt ? new Date(k.lastErrorAt).toLocaleString('fr-FR') : ''}
      </span>
    );
  }
  if (k.lastUsedAt) {
    return <span className="badge bg-success-subtle text-success">OK — {new Date(k.lastUsedAt).toLocaleString('fr-FR')}</span>;
  }
  return <span className="badge bg-secondary-subtle text-secondary">Jamais utilisée</span>;
}

interface KeyModalState {
  id: string;
  label: string;
  provider: string;
  apiKey: string;
  model: string;
  priority: string;
  valueHint: string;
}

const EMPTY_KEY_MODAL: KeyModalState = { id: '', label: '', provider: 'gemini', apiKey: '', model: '', priority: '0', valueHint: '' };

function AiKeysCard() {
  const [keys, setKeys] = useState<AiKey[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<KeyModalState | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  async function loadAiKeys() {
    setError(null);
    try {
      setKeys(await apiFetch<AiKey[]>('/reassort/ai/keys'));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    loadAiKeys();
  }, []);

  async function handleTest(id: string) {
    setTestingId(id);
    try {
      const data = await apiFetch<{ durationMs: number }>(`/reassort/ai/keys/${id}/test`, { method: 'POST' });
      window.reassortToast(`Clé valide — réponse reçue en ${data.durationMs} ms.`, 'success');
    } catch (err) {
      window.reassortToast('Échec du test : ' + (err as Error).message, 'error');
    } finally {
      setTestingId(null);
      loadAiKeys();
    }
  }

  async function handleDelete(id: string) {
    const confirmed = await window.reassortConfirm('Supprimer cette clé API ? Cette action est irréversible.', {
      danger: true,
      okLabel: 'Supprimer',
    });
    if (!confirmed) return;
    try {
      await apiFetch(`/reassort/ai/keys/${id}`, { method: 'DELETE' });
      loadAiKeys();
    } catch (err) {
      window.reassortToast('Erreur : ' + (err as Error).message, 'error');
    }
  }

  async function handleToggleActive(id: string, isActive: boolean) {
    // Optimiste : la case reflète le clic immédiatement, annulée (via loadAiKeys) si l'appel échoue.
    setKeys((prev) => prev.map((k) => (k.id === id ? { ...k, isActive } : k)));
    try {
      await apiFetch(`/reassort/ai/keys/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive }),
      });
    } catch (err) {
      window.reassortToast('Erreur : ' + (err as Error).message, 'error');
      loadAiKeys();
    }
  }

  async function handleSaveModal() {
    if (!modal) return;
    const label = modal.label.trim();
    const apiKey = modal.apiKey.trim();
    if (!label || (!modal.id && !apiKey)) {
      window.reassortToast('Le nom et la clé API sont requis.', 'error');
      return;
    }
    const payload: Record<string, unknown> = {
      label,
      provider: modal.provider,
      model: modal.model.trim(),
      priority: parseInt(modal.priority, 10) || 0,
    };
    if (apiKey) payload.apiKey = apiKey;
    try {
      await apiFetch(modal.id ? `/reassort/ai/keys/${modal.id}` : '/reassort/ai/keys', {
        method: modal.id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      setModal(null);
      loadAiKeys();
    } catch (err) {
      window.reassortToast('Erreur : ' + (err as Error).message, 'error');
    }
  }

  return (
    <div className="card">
      <div className="card-header">
        <h5 className="card-title mb-0">Clés API IA</h5>
      </div>
      <div className="card-body">
        <p className="text-muted small">
          Utilisées pour la prévision de commande par IA (bouton "Analyser avec l'IA" sur la page Proposition de
          commande). Plusieurs clés peuvent être ajoutées (même fournisseur ou non) : la génération essaie la clé
          de plus haute priorité (numéro le plus petit) en premier, et bascule automatiquement sur la suivante en
          cas d'échec (quota épuisé, erreur d'authentification).
        </p>
        {error && <div className="alert alert-danger">{error}</div>}
        <div className="table-responsive">
          <table className="table align-middle table-hover">
            <thead>
              <tr>
                <th>Priorité</th>
                <th>Nom</th>
                <th>Fournisseur</th>
                <th>Modèle</th>
                <th>Clé</th>
                <th>Statut</th>
                <th>Actif</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {keys.length === 0 ? (
                <tr>
                  <td colSpan={8} className="text-center text-muted py-3">
                    Aucune clé configurée. Ajoutez-en une pour activer l'analyse par IA.
                  </td>
                </tr>
              ) : (
                keys.map((k) => (
                  <tr key={k.id}>
                    <td>{k.priority}</td>
                    <td>{k.label}</td>
                    <td>{PROVIDER_LABELS[k.provider] || k.provider}</td>
                    <td className="text-muted">{k.model || '—'}</td>
                    <td className="text-muted">{k.maskedKey}</td>
                    <td>
                      <AiKeyStatusBadge k={k} />
                    </td>
                    <td>
                      <div className="form-check form-switch">
                        <input
                          type="checkbox"
                          className="form-check-input"
                          checked={k.isActive}
                          onChange={(e) => handleToggleActive(k.id, e.target.checked)}
                        />
                      </div>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-info"
                        disabled={testingId === k.id}
                        onClick={() => handleTest(k.id)}
                      >
                        {testingId === k.id ? 'Test...' : 'Tester'}
                      </button>{' '}
                      <button
                        type="button"
                        className="btn btn-sm btn-outline-secondary"
                        onClick={() =>
                          setModal({
                            id: k.id,
                            label: k.label,
                            provider: k.provider,
                            apiKey: '',
                            model: k.model || '',
                            priority: String(k.priority),
                            valueHint: 'Laissez vide pour garder la clé actuelle.',
                          })
                        }
                      >
                        <iconify-icon icon="solar:pen-bold" />
                      </button>{' '}
                      <button type="button" className="btn btn-sm btn-outline-danger" onClick={() => handleDelete(k.id)}>
                        <iconify-icon icon="solar:trash-bin-trash-bold" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setModal(EMPTY_KEY_MODAL)}>
          <iconify-icon icon="solar:add-circle-bold" className="align-middle me-1" />
          Ajouter une clé
        </button>
      </div>

      {modal && (
        <>
          <div className="modal fade show" style={{ display: 'block' }} tabIndex={-1}>
            <div className="modal-dialog">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">{modal.id ? 'Modifier la clé' : 'Ajouter une clé API'}</h5>
                  <button type="button" className="btn-close" onClick={() => setModal(null)} />
                </div>
                <div className="modal-body">
                  <div className="mb-3">
                    <label className="form-label">Nom</label>
                    <input
                      type="text"
                      className="form-control"
                      placeholder="ex: Gemini principal"
                      value={modal.label}
                      onChange={(e) => setModal({ ...modal, label: e.target.value })}
                    />
                  </div>
                  <div className="mb-3">
                    <label className="form-label">Fournisseur</label>
                    <select
                      className="form-select"
                      value={modal.provider}
                      onChange={(e) => setModal({ ...modal, provider: e.target.value })}
                    >
                      <option value="gemini">Google Gemini</option>
                      <option value="openai">OpenAI</option>
                      <option value="anthropic">Anthropic (Claude)</option>
                    </select>
                  </div>
                  <div className="mb-3">
                    <label className="form-label">Clé API</label>
                    <input
                      type="password"
                      className="form-control"
                      placeholder="Collez la clé ici"
                      value={modal.apiKey}
                      onChange={(e) => setModal({ ...modal, apiKey: e.target.value })}
                    />
                    <div className="form-text">{modal.valueHint}</div>
                  </div>
                  <div className="mb-3">
                    <label className="form-label">Modèle (optionnel)</label>
                    <input
                      type="text"
                      className="form-control"
                      placeholder="Laisser vide pour le défaut du fournisseur"
                      value={modal.model}
                      onChange={(e) => setModal({ ...modal, model: e.target.value })}
                    />
                  </div>
                  <div className="mb-3">
                    <label className="form-label">Priorité</label>
                    <input
                      type="number"
                      className="form-control"
                      min={0}
                      step={1}
                      value={modal.priority}
                      onChange={(e) => setModal({ ...modal, priority: e.target.value })}
                    />
                    <div className="form-text">Plus petit = essayé en premier.</div>
                  </div>
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn btn-light" onClick={() => setModal(null)}>
                    Annuler
                  </button>
                  <button type="button" className="btn btn-primary" onClick={handleSaveModal}>
                    Enregistrer
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show" />
        </>
      )}
    </div>
  );
}

// --- Carte "Consommation de tokens" ---

function AiUsageCard() {
  const [period, setPeriod] = useState('30');
  const [usage, setUsage] = useState<AiUsage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    const params = period === 'all' ? 'days=all' : `days=${encodeURIComponent(period)}`;
    apiFetch<AiUsage>(`/reassort/ai-usage?${params}`)
      .then(setUsage)
      .catch((err: Error) => setError(err.message));
  }, [period]);

  return (
    <div className="card mt-3">
      <div className="card-header d-flex justify-content-between align-items-center">
        <h5 className="card-title mb-0">Consommation de tokens</h5>
        <select className="form-select form-select-sm" style={{ width: 'auto' }} value={period} onChange={(e) => setPeriod(e.target.value)}>
          <option value="7">7 derniers jours</option>
          <option value="30">30 derniers jours</option>
          <option value="90">90 derniers jours</option>
          <option value="all">Depuis toujours</option>
        </select>
      </div>
      <div className="card-body">
        <div className="alert alert-light border small mb-3">
          <strong>À quoi ça sert :</strong> chaque appel IA réussi (chatbot, prévision de commande) consomme des
          tokens sur la clé utilisée — cette vue permet de suivre le volume consommé avant d'atteindre une limite
          de quota côté fournisseur.
        </div>
        {error && <div className="alert alert-danger">{error}</div>}
        <div className="row text-center mb-3">
          <div className="col">
            <div className="fs-4 fw-semibold">{usage ? formatTokenCount(usage.totalTokens) : '—'}</div>
            <div className="small text-muted">Total tokens</div>
          </div>
          <div className="col">
            <div className="fs-4 fw-semibold">{usage ? formatTokenCount(usage.totalPromptTokens) : '—'}</div>
            <div className="small text-muted">Tokens entrée</div>
          </div>
          <div className="col">
            <div className="fs-4 fw-semibold">{usage ? formatTokenCount(usage.totalCompletionTokens) : '—'}</div>
            <div className="small text-muted">Tokens sortie</div>
          </div>
          <div className="col">
            <div className="fs-4 fw-semibold">{usage ? formatTokenCount(usage.callCount) : '—'}</div>
            <div className="small text-muted">Appels</div>
          </div>
        </div>
        {usage && period === 'all' && usage.trackingSince && (
          <div className="small text-muted">Suivi depuis le {new Date(usage.trackingSince).toLocaleDateString('fr-FR')}</div>
        )}
        {usage && period !== 'all' && !usage.callCount && (
          <div className="text-center text-muted small py-2">Aucun appel IA sur cette période.</div>
        )}
        {usage && period !== 'all' && !!usage.callCount && (
          <div className="row">
            <div className="col-md-6">
              <h6 className="small text-muted">Par fournisseur</h6>
              <table className="table table-sm">
                <thead>
                  <tr>
                    <th>Fournisseur</th>
                    <th className="text-end">Appels</th>
                    <th className="text-end">Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.byProvider.map((p) => (
                    <tr key={p.provider}>
                      <td>{p.provider}</td>
                      <td className="text-end">{p.callCount}</td>
                      <td className="text-end">{formatTokenCount(p.totalTokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="col-md-6">
              <h6 className="small text-muted">Par usage</h6>
              <table className="table table-sm">
                <thead>
                  <tr>
                    <th>Usage</th>
                    <th className="text-end">Appels</th>
                    <th className="text-end">Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.byContext.map((c) => (
                    <tr key={c.context}>
                      <td>{c.context}</td>
                      <td className="text-end">{c.callCount}</td>
                      <td className="text-end">{formatTokenCount(c.totalTokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Cartes "Ajustement IA à la génération" / "Repli chatbot" (interrupteur simple) ---
// Ces deux réglages sont désactivés par défaut (=== 'true', pas !== 'false' comme les jobs cron) —
// reproduit tel quel depuis loadAiPromptTemplate() de settings.old.html.

function ToggleOnlyCard({
  title,
  configKey,
  initialChecked,
  children,
}: {
  title: string;
  configKey: string;
  initialChecked: boolean;
  children: ReactNode;
}) {
  const [checked, setChecked] = useState(initialChecked);

  useEffect(() => setChecked(initialChecked), [initialChecked]);

  async function handleChange(next: boolean) {
    setChecked(next);
    try {
      await saveSystemConfigKey(configKey, next ? 'true' : 'false');
    } catch (err) {
      window.reassortToast('Erreur : ' + (err as Error).message, 'error');
      setChecked(!next);
    }
  }

  return (
    <div className="card mt-3">
      <div className="card-header d-flex justify-content-between align-items-center">
        <h5 className="card-title mb-0">{title}</h5>
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
      </div>
      <div className="card-body">
        <div className="alert alert-light border small mb-0">{children}</div>
      </div>
    </div>
  );
}

// --- Carte "Détection d'anomalies" ---

function AnomalyThresholdCard({ initialValue }: { initialValue: string }) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => setValue(initialValue), [initialValue]);

  async function handleSave() {
    setError(null);
    setSuccess(null);
    const raw = parseFloat(value);
    if (!Number.isFinite(raw) || raw < 0) {
      setError('Erreur: Saisissez un nombre positif ou nul (ex: 1, 0.5, 0).');
      return;
    }
    setSaving(true);
    try {
      await saveSystemConfigKey('ANOMALY_MIN_DAILY_SALES', String(raw));
      setSuccess('Seuil enregistré — appliqué dès la prochaine génération.');
    } catch (err) {
      setError('Erreur: ' + (err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card mt-3">
      <div className="card-header">
        <h5 className="card-title mb-0">Détection d'anomalies</h5>
      </div>
      <div className="card-body">
        <div className="alert alert-light border small">
          <strong>À quoi ça sert :</strong> le système signale automatiquement les comportements anormaux
          (explosion ou chute brutale des ventes, stock disponible mais silence total des ventes = rupture
          invisible possible). Un article signalé voit son score de confiance pénalisé, pour éviter de commander
          sur une base douteuse.
        </div>
        <div className="mb-3">
          <label className="form-label fw-semibold">Vente habituelle min. pour signaler une rupture invisible</label>
          <div className="input-group" style={{ maxWidth: 220 }}>
            <input type="number" className="form-control" min={0} step={0.5} value={value} onChange={(e) => setValue(e.target.value)} />
            <span className="input-group-text">u/jour</span>
          </div>
          <div className="form-text">
            Exemple : avec 1, un article qui vend habituellement au moins 1 unité/jour mais n'a rien vendu sur les
            3 derniers jours malgré un stock disponible est signalé. Baissez à 0.5 pour surveiller aussi les
            articles lents (plus de faux positifs sur les intermittents).
          </div>
        </div>
        <button type="button" className="btn btn-primary btn-sm" disabled={saving} onClick={handleSave}>
          {saving ? 'Enregistrement…' : 'Enregistrer'}
        </button>
        {error && <div className="alert alert-danger mt-3">{error}</div>}
        {success && <div className="alert alert-success mt-3">{success}</div>}
      </div>
    </div>
  );
}

interface AiSystemConfig {
  AI_QUANTITY_ADJUSTMENT_ENABLED?: string;
  CHATBOT_LLM_FALLBACK_ENABLED?: string;
  ANOMALY_MIN_DAILY_SALES?: string;
}

export function AiSection() {
  const [config, setConfig] = useState<AiSystemConfig | null>(null);

  useEffect(() => {
    apiFetch<AiSystemConfig>('/reassort/system-config')
      .then(setConfig)
      // Silencieux si non-admin (route protégée), même comportement que loadAiPromptTemplate().
      .catch(() => {});
  }, []);

  if (!config) return null;

  return (
    <div>
      <AiKeysCard />
      <AiUsageCard />
      <ToggleOnlyCard
        title="Ajustement IA à la génération"
        configKey="AI_QUANTITY_ADJUSTMENT_ENABLED"
        initialChecked={config.AI_QUANTITY_ADJUSTMENT_ENABLED === 'true'}
      >
        <strong>À quoi ça sert :</strong> quand c'est actif, chaque génération de proposition (nocturne, manuelle,
        réajustement quotidien) envoie ses articles à l'IA pour vérifier et éventuellement ajuster la quantité
        calculée classiquement, avant de l'enregistrer comme "Qté proposée" — au lieu que ce calcul reste la
        valeur finale. <strong>Impact</strong> : chaque génération devient plus lente (appels au LLM configuré
        par lots) et consomme le quota de la clé API active. Un échec de l'IA (aucune clé configurée, réseau
        indisponible) ne bloque jamais une génération : les articles concernés gardent alors leur calcul
        classique. Sans cette option, l'IA reste disponible à la demande via le bouton "Analyser" sur chaque
        article.
      </ToggleOnlyCard>
      <ToggleOnlyCard
        title="Assistant IA — repli par function-calling"
        configKey="CHATBOT_LLM_FALLBACK_ENABLED"
        initialChecked={config.CHATBOT_LLM_FALLBACK_ENABLED === 'true'}
      >
        <strong>À quoi ça sert :</strong> quand une question posée à l'Assistant IA ne correspond à aucun mot-clé
        connu (Paramètres &gt; IA &gt; Règles de détection), active ce réglage pour laisser le LLM configuré
        choisir lui-même l'outil de données le plus pertinent, avant d'abandonner sur "je ne comprends pas".{' '}
        <strong>Impact</strong> : un appel LLM supplémentaire (non streamé) est fait pour chaque question non
        reconnue par les règles de mots-clés — coût et latence additionnels, uniquement sur ces questions-là. Un
        échec (LLM indisponible, réponse mal formée) ne bloque jamais la conversation : elle se comporte alors
        comme si ce réglage était désactivé.
      </ToggleOnlyCard>
      <AnomalyThresholdCard initialValue={config.ANOMALY_MIN_DAILY_SALES || '1'} />
    </div>
  );
}
