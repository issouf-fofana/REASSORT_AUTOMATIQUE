import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { apiFetch } from '../../api/client';
import { saveSystemConfigKey } from '../../api/systemConfig';

interface RposServer {
  posId: string;
  label: string;
  baseUrl?: string;
  rposUser?: string;
  hasCredentials: boolean;
  source?: 'local' | 'live';
  error?: string;
}

function serverStatusLabel(s: RposServer): string {
  // Sans ?refresh=true (par défaut), aucun appel RPOS direct n'a été fait : le statut "actif/erreur"
  // en temps réel n'est pas connu, on affiche juste "configuré" pour ne pas laisser croire à une
  // vérification qui n'a pas eu lieu — reproduit tel quel depuis settings.old.html loadRposServers().
  if (!s.hasCredentials) return 'inactif';
  if (s.source === 'local') return 'configuré, non vérifié';
  return s.error ? 'erreur' : 'actif';
}

/** Petite carte "réglage(s) + bouton Enregistrer + alertes erreur/succès", motif répété 5 fois
 * dans cette section (retry RPOS, volume max, cache insight, seuil rupture, sécurité JWT). */
function SettingsCard({
  icon,
  iconClass = 'text-primary',
  title,
  intro,
  children,
  onSave,
  saveLabel = 'Enregistrer',
}: {
  icon: string;
  iconClass?: string;
  title: string;
  intro?: string;
  children: ReactNode;
  onSave: () => Promise<void>;
  saveLabel?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleClick() {
    setError(null);
    setSuccess(null);
    setSaving(true);
    try {
      await onSave();
      setSuccess('Réglage(s) enregistré(s).');
    } catch (err) {
      setError('Erreur : ' + (err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card">
      <div className="card-header">
        <h4 className="card-title d-flex align-items-center gap-1">
          <iconify-icon icon={icon} className={`${iconClass} fs-20`} />
          {title}
        </h4>
      </div>
      <div className="card-body">
        {intro && (
          <div className="alert alert-light border mb-3 small" dangerouslySetInnerHTML={{ __html: intro }} />
        )}
        {children}
        <button type="button" className="btn btn-primary" disabled={saving} onClick={handleClick}>
          {saving ? 'Enregistrement…' : saveLabel}
        </button>
        {error && <div className="alert alert-danger mt-3">{error}</div>}
        {success && <div className="alert alert-success mt-3">{success}</div>}
      </div>
    </div>
  );
}

export function RposSecuritySection() {
  // --- Carte 1 : serveurs RPOS ---
  const [servers, setServers] = useState<RposServer[]>([]);
  const [selectedPosId, setSelectedPosId] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [rposUser, setRposUser] = useState('');
  const [rposPassword, setRposPassword] = useState('');
  const [applyAll, setApplyAll] = useState(false);
  const [rposError, setRposError] = useState<string | null>(null);
  const [rposSuccess, setRposSuccess] = useState<string | null>(null);
  const [rposSaving, setRposSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const selectRef = useRef<HTMLSelectElement>(null);

  async function loadRposServers(refresh: boolean, silent = false) {
    try {
      const data = await apiFetch<RposServer[]>(`/reassort/servers${refresh ? '?refresh=true' : ''}`);
      setServers(data);
      setSelectedPosId((prev) => {
        const keep = prev && data.some((s) => s.posId === prev);
        const next = keep ? prev : data[0]?.posId || '';
        const found = data.find((s) => s.posId === next);
        setBaseUrl(found?.baseUrl || '');
        setRposUser(found?.rposUser || '');
        setRposPassword('');
        return next;
      });
    } catch (err) {
      if (!silent) setRposError((err as Error).message);
    }
  }

  useEffect(() => {
    loadRposServers(false).then(() => {
      // Vérification RPOS réelle en arrière-plan (même comportement que
      // refreshRposServersInBackground dans settings.old.html) : la liste locale s'affiche
      // d'abord instantanément, puis le vrai statut de connexion se met à jour silencieusement —
      // sauf si l'utilisateur a le menu déroulant ouvert au même instant (évite un glitch visuel).
      if (document.activeElement !== selectRef.current) {
        loadRposServers(true, true);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleSelectServer(posId: string) {
    setSelectedPosId(posId);
    const found = servers.find((s) => s.posId === posId);
    setBaseUrl(found?.baseUrl || '');
    setRposUser(found?.rposUser || '');
    setRposPassword('');
  }

  async function handleRefreshClick() {
    setRefreshing(true);
    try {
      await loadRposServers(true);
    } finally {
      setRefreshing(false);
    }
  }

  async function handleSaveRposServer() {
    setRposError(null);
    setRposSuccess(null);
    if (!selectedPosId) return;
    setRposSaving(true);
    try {
      if (applyAll) {
        const body: Record<string, string> = { rposUser };
        if (rposPassword) body.rposPassword = rposPassword;
        const data = await apiFetch<unknown[]>('/reassort/servers/apply-all', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        setRposSuccess(`Identifiant appliqué à tous les serveurs (${data.length}).`);
      } else {
        const body: Record<string, string> = { baseUrl, rposUser };
        if (rposPassword) body.rposPassword = rposPassword;
        await apiFetch(`/reassort/servers/${encodeURIComponent(selectedPosId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        setRposSuccess('Serveur enregistré.');
      }
      loadRposServers(false);
    } catch (err) {
      setRposError((err as Error).message);
    } finally {
      setRposSaving(false);
    }
  }

  // --- Cartes 2 à 5 : réglages système simples (retry, volume, cache, seuil) ---
  const [retryAttempts, setRetryAttempts] = useState('3');
  const [retryDelay, setRetryDelay] = useState('500');
  const [lastSaleWindows, setLastSaleWindows] = useState('31,93,366,1830,7320');
  const [maxSalesLines, setMaxSalesLines] = useState('20000');
  const [insightCacheTtl, setInsightCacheTtl] = useState('24');
  const [stockoutThreshold, setStockoutThreshold] = useState('30');
  const [jwtSecret, setJwtSecret] = useState('');
  const [jwtExpires, setJwtExpires] = useState('7d');

  useEffect(() => {
    apiFetch<Record<string, string>>('/reassort/system-config')
      .then((d) => {
        setRetryAttempts(d.RPOS_RETRY_ATTEMPTS || '3');
        setRetryDelay(d.RPOS_RETRY_DELAY_MS || '500');
        setLastSaleWindows(d.LAST_SALE_SEARCH_WINDOWS_DAYS || '31,93,366,1830,7320');
        setMaxSalesLines(d.MAX_SALES_LINES_PER_GENERATION || '20000');
        setInsightCacheTtl(d.PRODUCT_INSIGHT_CACHE_TTL_HOURS || '24');
        setStockoutThreshold(String(Math.round((parseFloat(d.ADMIN_DASHBOARD_STOCKOUT_ALERT_THRESHOLD) || 0.3) * 100)));
        setJwtExpires(d.JWT_EXPIRES_IN || '7d');
      })
      // Silencieux si non-admin (route protégée), même comportement que loadSystemConfig().
      .catch(() => {});
  }, []);

  return (
    <div className="row">
      <div className="col-xl-8">
        <div className="card">
          <div className="card-header">
            <h4 className="card-title d-flex align-items-center gap-1">
              <iconify-icon icon="solar:server-square-bold-duotone" className="text-primary fs-20" />
              Connexion RPOS
            </h4>
          </div>
          <div className="card-body">
            <div className="alert alert-light border mb-3 small">
              <strong>À quoi ça sert :</strong> Prosuma possède plusieurs serveurs RPOS (un par groupe de
              magasins). Chaque serveur a sa propre adresse et ses propres identifiants. Choisissez un serveur
              ci-dessous pour voir/modifier sa connexion. Ce sont exactement les mêmes identifiants que ceux
              utilisés pour se connecter à l'interface d'administration RPOS de ce serveur.
              <br />
              <strong>En cas d'erreur :</strong> si les identifiants d'un serveur sont incorrects ou absents, tous
              les magasins qui en dépendent resteront inactifs (aucune proposition, aucun historique) jusqu'à
              correction ici.
            </div>
            <div className="mb-3">
              <label className="form-label fw-semibold d-flex align-items-center justify-content-between">
                <span>Serveur RPOS</span>
                <span>
                  <button
                    type="button"
                    className="btn btn-sm btn-outline-secondary"
                    disabled={refreshing}
                    onClick={handleRefreshClick}
                  >
                    {refreshing ? (
                      <>
                        <span className="spinner-border spinner-border-sm align-middle" /> Vérification…
                      </>
                    ) : (
                      <>
                        <iconify-icon icon="solar:refresh-circle-bold-duotone" className="align-middle" /> Actualiser
                        depuis RPOS
                      </>
                    )}
                  </button>
                </span>
              </label>
              <select
                ref={selectRef}
                className="form-select"
                value={selectedPosId}
                onChange={(e) => handleSelectServer(e.target.value)}
              >
                {servers.map((s) => (
                  <option key={s.posId} value={s.posId}>
                    {s.posId} — {s.label} ({serverStatusLabel(s)})
                  </option>
                ))}
              </select>
              <div className="form-text">
                Sélectionnez le serveur à configurer. Les serveurs sans identifiants sont marqués "inactif" et ne
                seront jamais interrogés. La liste s'affiche d'abord depuis la base locale (rapide), puis une
                vérification en direct de l'état de connexion RPOS se lance automatiquement en arrière-plan et
                met à jour le statut ci-dessus.
              </div>
            </div>
            <div className="mb-3">
              <label className="form-label fw-semibold">URL du serveur RPOS</label>
              <input
                type="text"
                className="form-control"
                placeholder="https://pos1-prod-prosuma.prosuma.pos"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
              <div className="form-text">Adresse de ce serveur RPOS (ex: https://pos1-prod-prosuma.prosuma.pos).</div>
            </div>
            <div className="row g-3 mb-3">
              <div className="col-md-6">
                <label className="form-label fw-semibold">Utilisateur RPOS</label>
                <input type="text" className="form-control" value={rposUser} onChange={(e) => setRposUser(e.target.value)} />
              </div>
              <div className="col-md-6">
                <label className="form-label fw-semibold">Mot de passe RPOS</label>
                <input
                  type="password"
                  className="form-control"
                  placeholder="Laisser vide pour ne pas changer"
                  value={rposPassword}
                  onChange={(e) => setRposPassword(e.target.value)}
                />
                <div className="form-text">Par sécurité, le mot de passe actuel n'est jamais affiché. Laissez vide pour le conserver.</div>
              </div>
            </div>
            <div className="form-check mb-3">
              <input
                type="checkbox"
                id="rpos-apply-all"
                className="form-check-input"
                checked={applyAll}
                onChange={(e) => setApplyAll(e.target.checked)}
              />
              <label htmlFor="rpos-apply-all" className="form-check-label">
                Appliquer cet utilisateur/mot de passe à <strong>tous les serveurs RPOS</strong> (pos1 à pos18)
              </label>
              <div className="form-text">
                À cocher seulement si un même compte RPOS est valide sur toutes les plateformes Prosuma — ne
                change pas l'URL de chaque serveur, seulement l'identifiant/mot de passe.
              </div>
            </div>
            <button type="button" className="btn btn-primary" disabled={rposSaving} onClick={handleSaveRposServer}>
              {rposSaving ? 'Enregistrement…' : 'Enregistrer ce serveur'}
            </button>
            {rposError && <div className="alert alert-danger mt-3">{rposError}</div>}
            {rposSuccess && <div className="alert alert-success mt-3">{rposSuccess}</div>}
          </div>
        </div>

        <SettingsCard
          icon="solar:refresh-square-bold-duotone"
          title="Fiabilité des appels RPOS"
          intro="<strong>À quoi ça sert :</strong> ces réglages s'appliquent à tous les serveurs RPOS. RPOS retourne parfois des erreurs temporaires (502/503) sans lien avec la requête ; le système réessaie automatiquement."
          onSave={async () => {
            await saveSystemConfigKey('RPOS_RETRY_ATTEMPTS', retryAttempts);
            await saveSystemConfigKey('RPOS_RETRY_DELAY_MS', retryDelay);
            await saveSystemConfigKey('LAST_SALE_SEARCH_WINDOWS_DAYS', lastSaleWindows);
          }}
        >
          <div className="row g-3 mb-3">
            <div className="col-md-6">
              <label className="form-label fw-semibold">Tentatives en cas d'erreur serveur</label>
              <input
                type="number"
                className="form-control"
                min={1}
                max={10}
                value={retryAttempts}
                onChange={(e) => setRetryAttempts(e.target.value)}
              />
            </div>
            <div className="col-md-6">
              <label className="form-label fw-semibold">Délai entre tentatives (ms)</label>
              <input
                type="number"
                className="form-control"
                min={100}
                step={100}
                value={retryDelay}
                onChange={(e) => setRetryDelay(e.target.value)}
              />
              <div className="form-text">Temps d'attente entre deux tentatives, en millisecondes. Augmente à chaque tentative.</div>
            </div>
          </div>
          <div className="mb-3">
            <label className="form-label fw-semibold">Fenêtres de recherche de la dernière vente (jours)</label>
            <input
              type="text"
              className="form-control"
              placeholder="31,93,366,1830,7320"
              value={lastSaleWindows}
              onChange={(e) => setLastSaleWindows(e.target.value)}
            />
            <div className="form-text">
              Pour retrouver la dernière vente d'un magasin, le système élargit progressivement la fenêtre de
              recherche par ces paliers (en jours), jusqu'à trouver une vente. Liste de nombres séparés par des
              virgules, du plus court au plus long. Évite les timeouts RPOS sur une recherche trop large d'un
              coup.
            </div>
          </div>
        </SettingsCard>

        <SettingsCard
          icon="solar:danger-triangle-bold-duotone"
          iconClass="text-warning"
          title="Limite de volume par génération"
          intro="<strong>À quoi ça sert :</strong> RPOS se dégrade fortement en profondeur de pagination (une page proche du début répond en quelques secondes, une page tardive peut prendre 10 à 15 secondes). Sur un magasin à très fort volume de ventes sans fichier local disponible, une génération peut ainsi rester bloquée plusieurs dizaines de minutes sans jamais échouer ni prévenir.<br><strong>Effet :</strong> si le nombre de lignes de vente à télécharger dépasse ce seuil, la génération échoue immédiatement avec un message explicite, plutôt que de tourner indéfiniment. Le magasin concerné devra alors utiliser un export CSV local (onglet Fichiers de ventes) ou réduire sa période d'analyse."
          onSave={() => saveSystemConfigKey('MAX_SALES_LINES_PER_GENERATION', maxSalesLines)}
        >
          <div className="mb-3" style={{ maxWidth: 300 }}>
            <label className="form-label fw-semibold">Nombre maximal de lignes par génération</label>
            <input
              type="number"
              className="form-control"
              min={1000}
              step={1000}
              value={maxSalesLines}
              onChange={(e) => setMaxSalesLines(e.target.value)}
            />
          </div>
        </SettingsCard>

        <SettingsCard
          icon="solar:clock-circle-bold-duotone"
          title="Cache dernier achat / dernière vente"
          intro="<strong>À quoi ça sert :</strong> sur la page Proposition de commande, &quot;Dernier achat&quot; et &quot;Dernière vente&quot; sont mis en cache pour éviter de resolliciter RPOS à chaque rechargement de page. La première consultation dans la durée choisie ci-dessous interroge RPOS ; les suivantes lisent le cache.<br><strong>Effet d'un changement :</strong> une durée courte (ex: 1h) garde les données plus à jour mais sollicite davantage RPOS ; une durée longue (ex: 24h) réduit la charge mais peut afficher une info légèrement obsolète pendant cette durée."
          onSave={() => saveSystemConfigKey('PRODUCT_INSIGHT_CACHE_TTL_HOURS', insightCacheTtl)}
        >
          <div className="mb-3" style={{ maxWidth: 300 }}>
            <label className="form-label fw-semibold">Durée de validité du cache</label>
            <div className="input-group">
              <input
                type="number"
                className="form-control"
                min={1}
                value={insightCacheTtl}
                onChange={(e) => setInsightCacheTtl(e.target.value)}
              />
              <span className="input-group-text">heure(s)</span>
            </div>
          </div>
        </SettingsCard>

        <SettingsCard
          icon="solar:global-bold-duotone"
          title="Vue globale (admin)"
          intro="<strong>À quoi ça sert :</strong> sur la page &quot;Vue globale&quot;, le tableau &quot;Performance par magasin&quot; met en évidence en rouge les magasins dont le taux de rupture dépasse ce seuil, pour repérer rapidement les magasins qui ont besoin d'attention."
          onSave={() => saveSystemConfigKey('ADMIN_DASHBOARD_STOCKOUT_ALERT_THRESHOLD', (parseFloat(stockoutThreshold) / 100).toString())}
        >
          <div className="mb-3" style={{ maxWidth: 300 }}>
            <label className="form-label fw-semibold">Seuil d'alerte du taux de rupture</label>
            <div className="input-group">
              <input
                type="number"
                className="form-control"
                min={1}
                max={100}
                value={stockoutThreshold}
                onChange={(e) => setStockoutThreshold(e.target.value)}
              />
              <span className="input-group-text">%</span>
            </div>
          </div>
        </SettingsCard>
      </div>

      <div className="col-xl-4">
        <div className="card">
          <div className="card-header">
            <h4 className="card-title d-flex align-items-center gap-1">
              <iconify-icon icon="solar:shield-keyhole-bold-duotone" className="text-primary fs-20" />
              Sécurité
            </h4>
          </div>
          <div className="card-body">
            <div className="alert alert-light border mb-3 small">
              <strong>À quoi ça sert :</strong> quand un utilisateur se connecte, le serveur lui délivre un
              "jeton" (token) signé avec cette clé, qui prouve son identité à chaque action sans redemander le
              mot de passe.
            </div>
            <div className="mb-3">
              <label className="form-label fw-semibold">Clé de signature des sessions (JWT)</label>
              <input
                type="password"
                className="form-control"
                placeholder="Laisser vide pour ne pas changer"
                value={jwtSecret}
                onChange={(e) => setJwtSecret(e.target.value)}
              />
              <div className="form-text text-danger">
                La modifier déconnecte immédiatement tous les utilisateurs (tous les tokens existants deviennent
                invalides). Ne la changez que si vous suspectez qu'elle a été compromise.
              </div>
            </div>
            <div className="mb-3">
              <label className="form-label fw-semibold">Durée de session</label>
              <input
                type="text"
                className="form-control"
                placeholder="7d"
                value={jwtExpires}
                onChange={(e) => setJwtExpires(e.target.value)}
              />
              <div className="form-text">
                Durée pendant laquelle un utilisateur reste connecté sans avoir à se reconnecter. Format : "7d"
                (7 jours), "12h" (12 heures), "30m" (30 minutes). Plus court = plus sécurisé mais plus de
                reconnexions.
              </div>
            </div>
            <SecuritySaveButton
              jwtSecret={jwtSecret}
              jwtExpires={jwtExpires}
              onSecretCleared={() => setJwtSecret('')}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function SecuritySaveButton({
  jwtSecret,
  jwtExpires,
  onSecretCleared,
}: {
  jwtSecret: string;
  jwtExpires: string;
  onSecretCleared: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleClick() {
    setError(null);
    setSuccess(null);
    if (jwtSecret) {
      const confirmed = await window.reassortConfirm(
        'Changer la clé de session va déconnecter tous les utilisateurs actuellement connectés (vous y compris). Continuer ?',
        { danger: true, okLabel: 'Continuer' }
      );
      if (!confirmed) return;
    }
    setSaving(true);
    try {
      if (jwtSecret) await saveSystemConfigKey('JWT_SECRET', jwtSecret);
      await saveSystemConfigKey('JWT_EXPIRES_IN', jwtExpires);
      onSecretCleared();
      setSuccess('Paramètres de sécurité mis à jour.' + (jwtSecret ? ' Reconnexion nécessaire.' : ''));
      if (jwtSecret) setTimeout(() => window.reassortLogout(), 2000);
    } catch (err) {
      setError('Erreur : ' + (err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button type="button" className="btn btn-primary" disabled={saving} onClick={handleClick}>
        {saving ? 'Enregistrement…' : 'Enregistrer'}
      </button>
      {error && <div className="alert alert-danger mt-3">{error}</div>}
      {success && <div className="alert alert-success mt-3">{success}</div>}
    </>
  );
}
