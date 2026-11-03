import { useEffect, useState } from 'react';
import { apiFetch } from '../../../shared/api/client';
import { useShopSelector } from '../auth/useShopSelector';
import { REASSORT_FIELDS } from './reassortFields';

// Champs stockés en FRACTION côté backend (0.8) mais affichés/saisis en POURCENTAGE (80) — cas
// spécial hors du modèle générique reassortFields.ts, reproduit tel quel depuis settings.old.html
// (`parseFloat(...) / 100` à la sauvegarde, `Math.round(c.paretoThreshold * 100)` au chargement).
const PERCENT_STORED_AS_FRACTION = new Set(['paretoThreshold', 'safetyStockRatio']);

type ConfigValues = Record<string, string | number | boolean>;

// Jours de commande (03/11/2026) : sélection libre, aucun jour pré-coché — demande explicite de
// l'utilisateur ("il faut lister tout les jour et le mag va chosir les jour de commande tu vois ne
// fixe pas samedi,mardi,jeudi"). Mêmes libellés que WEEKDAY_ORDER/VALID_ORDER_DAYS côté backend
// (proposalService.js / routes/reassort/config.js), jamais une liste divergente.
const WEEKDAYS: { value: string; label: string }[] = [
  { value: 'LUNDI', label: 'Lundi' },
  { value: 'MARDI', label: 'Mardi' },
  { value: 'MERCREDI', label: 'Mercredi' },
  { value: 'JEUDI', label: 'Jeudi' },
  { value: 'VENDREDI', label: 'Vendredi' },
  { value: 'SAMEDI', label: 'Samedi' },
  { value: 'DIMANCHE', label: 'Dimanche' },
];

const DEFAULT_VALUES: ConfigValues = {
  nightlyGenerationEnabled: 'true',
  paretoThreshold: 80,
  safetyStockRatio: 50,
  // Doit rester identique à configService.js DEFAULTS.periodMode côté backend (changé à
  // LAST_365_DAYS le 28/09/2026) — cette valeur ne sert que d'affichage initial avant le premier
  // chargement réel de la config (cf. useEffect plus bas), jamais la vraie source de vérité.
  periodMode: 'LAST_365_DAYS',
  treatNegativeStockAsZero: 'true',
  ignoreRposStockInCalculation: 'false',
  revenueSharePeriodDays: 1,
  overstockThresholdMultiplier: 1.5,
  splitOrdersByDepartment: 'true',
  autoOrderEnabled: 'false',
  autoOrderValidateAfterCreate: 'false',
  forecastAccuracyWindowDays: 7,
  forecastAccuracyThresholdPct: 20,
  seasonalityComparisonEnabled: 'false',
  seasonalityLookbackYears: 1,
  seasonalityAdjustmentThresholdPct: 15,
  receptionLeadTimeDays: 1,
  useReceptionLeadTimeInCalculation: 'false',
  excludeGenericArticlesBelowPrice: 2,
  recentOrderMaxAgeDays: 3,
  forecastEnabled: false,
  forecastAlpha: 0.3,
  customStart: '',
  customEnd: '',
};

export function ReassortConfigSection() {
  const { shops, selectedShopIds, toggleShop, selectAll, deselectAll, isSingleShop, isBulk } = useShopSelector();
  const [values, setValues] = useState<ConfigValues>(DEFAULT_VALUES);
  const [orderDays, setOrderDays] = useState<string[]>([]);
  // Groupe actuellement rattaché au magasin sélectionné (03/11/2026) : null si aucun, ou l'objet
  // groupe complet (id + name) pour afficher "config héritée du groupe X" — chargé depuis
  // GET /reassort/config (champ group, inclus côté backend via getConfig -> resolveEffectiveConfig,
  // mais le NOM du groupe lui-même vient du champ brut groupId + un second appel config-groups, cf.
  // useEffect ci-dessous : getConfig ne renvoie que les champs fusionnés, pas l'objet groupe).
  const [groupInfo, setGroupInfo] = useState<{ id: string; name: string } | null>(null);
  const [allGroups, setAllGroups] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [shopSearch, setShopSearch] = useState('');

  // Liste des groupes existants (pour le sélecteur "Rattacher à un groupe" ci-dessous) — chargée une
  // fois, indépendamment du magasin sélectionné.
  useEffect(() => {
    apiFetch<{ id: string; name: string }[]>('/reassort/config-groups')
      .then(setAllGroups)
      .catch(() => setAllGroups([]));
  }, []);

  // En mode bulk (plusieurs magasins cochés), on n'affiche jamais leur config actuelle (elle peut
  // diverger entre magasins) — comportement identique à settings.old.html
  // (loadReassortConfig: "if (shopIds.length !== 1) return;").
  useEffect(() => {
    if (isBulk || selectedShopIds.length !== 1) return;
    setError(null);
    apiFetch<Record<string, unknown>>(`/reassort/config?shop=${encodeURIComponent(selectedShopIds[0])}`)
      .then((c) => {
        const next: ConfigValues = { ...DEFAULT_VALUES };
        for (const key of Object.keys(DEFAULT_VALUES)) {
          const raw = c[key];
          if (raw === undefined || raw === null) continue;
          if (PERCENT_STORED_AS_FRACTION.has(key) && typeof raw === 'number') {
            next[key] = Math.round(raw * 100);
          } else if (typeof raw === 'boolean' && key !== 'forecastEnabled') {
            next[key] = raw ? 'true' : 'false';
          } else {
            next[key] = raw as string | number | boolean;
          }
        }
        setValues(next);
        // orderDays/groupId (03/11/2026) : hors de DEFAULT_VALUES (types différents — tableau et
        // identifiant de relation, pas un champ de formulaire scalaire comme les autres).
        setOrderDays(Array.isArray(c.orderDays) ? (c.orderDays as string[]) : []);
        const groupId = c.groupId as string | null | undefined;
        setGroupInfo(groupId ? (allGroups.find((g) => g.id === groupId) || { id: groupId, name: groupId }) : null);
      })
      .catch((err: Error) => setError('Erreur de chargement : ' + err.message));
  }, [selectedShopIds, isBulk, allGroups]);

  function setField(id: string, value: string | number | boolean) {
    setValues((prev) => ({ ...prev, [id]: value }));
  }

  async function handleSave() {
    if (selectedShopIds.length === 0) {
      setError('Sélectionnez au moins un magasin.');
      return;
    }
    setError(null);
    setSuccess(null);
    setSaving(true);

    // Un champ "select" n'est pas forcément un booléen déguisé (options 'true'/'false', ex:
    // treatNegativeStockAsZero) : periodMode est AUSSI kind: 'select' mais ses options sont des
    // valeurs énumérées (LAST_365_DAYS, CUSTOM...) — bug trouvé le 28/09/2026 (config bulk plantait
    // en base avec periodMode: false) car ce cas traitait TOUT champ select comme un booléen sans
    // vérifier que ses options étaient réellement 'true'/'false'.
    const isBooleanSelect = (field: (typeof REASSORT_FIELDS)[number]) =>
      field.kind === 'select' && (field.options || []).every((o) => o.value === 'true' || o.value === 'false');

    // Magasin rattaché à un groupe (03/11/2026) : tous ces champs sont verrouillés/grisés dans le
    // formulaire (hérités du groupe, resolveEffectiveConfig côté backend) — ne jamais les envoyer
    // dans ce cas, pour ne pas écrire en base une valeur que l'utilisateur n'a pas vraiment choisie
    // de modifier (champ disabled, mais `values` garde quand même la dernière valeur affichée).
    const payload: Record<string, unknown> = {};
    if (!groupInfo) {
      for (const field of REASSORT_FIELDS) {
        if (field.id === 'nightlyGenerationEnabled') continue; // envoyé séparément ci-dessous, toujours
        const raw = values[field.id];
        if (isBooleanSelect(field)) {
          payload[field.id] = raw === 'true';
        } else if (field.kind === 'select') {
          payload[field.id] = raw;
        } else if (PERCENT_STORED_AS_FRACTION.has(field.id)) {
          payload[field.id] = Number(raw) / 100;
        } else {
          payload[field.id] = Number(raw);
        }
      }
      payload.forecastEnabled = !!values.forecastEnabled;
      payload.forecastAlpha = Number(values.forecastAlpha);
      // Efface les dates personnalisées résiduelles hors du mode CUSTOM, pour ne pas laisser de
      // valeurs fantômes en base (même logique que settings.old.html).
      payload.customStart = values.periodMode === 'CUSTOM' ? values.customStart || null : null;
      payload.customEnd = values.periodMode === 'CUSTOM' ? values.customEnd || null : null;
      payload.orderDays = orderDays;
    }
    // Mode Auto/Génération nocturne restent TOUJOURS individuels, même magasin rattaché à un groupe
    // (GROUP_EXCLUDED_FIELDS côté backend) — envoyés dans tous les cas, jamais verrouillés ici.
    payload.autoOrderEnabled = values.autoOrderEnabled === 'true';
    payload.autoOrderValidateAfterCreate = values.autoOrderValidateAfterCreate === 'true';
    payload.nightlyGenerationEnabled = values.nightlyGenerationEnabled === 'true';

    try {
      if (selectedShopIds.length === 1) {
        await apiFetch(`/reassort/config?shop=${encodeURIComponent(selectedShopIds[0])}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } else {
        await apiFetch('/reassort/config/bulk', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shopIds: selectedShopIds, ...payload }),
        });
      }
      setSuccess(
        selectedShopIds.length === 1
          ? 'Configuration enregistrée.'
          : `Configuration appliquée à ${selectedShopIds.length} magasins.`
      );
    } catch (err) {
      setError('Erreur : ' + (err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  // Détache le magasin sélectionné (sélection d'UN SEUL, pas de sens en bulk) de son groupe actuel
  // (03/11/2026) : reprend aussitôt sa configuration individuelle, déjà conservée en base (jamais
  // effacée par le rattachement au groupe, cf. configGroupService.detachShop côté backend).
  async function handleDetachFromGroup() {
    if (selectedShopIds.length !== 1) return;
    setError(null);
    try {
      await apiFetch(`/reassort/config-groups/${groupInfo?.id}/shops/${selectedShopIds[0]}`, { method: 'DELETE' });
      setGroupInfo(null);
      setSuccess('Magasin détaché du groupe.');
    } catch (err) {
      setError('Erreur : ' + (err as Error).message);
    }
  }

  return (
    <div className="row">
      <div className="col-xl-8">
        <div className="card">
          <div className="d-flex card-header justify-content-between align-items-center">
            <h4 className="card-title d-flex align-items-center gap-1">
              <iconify-icon icon="solar:tuning-2-bold-duotone" className="text-primary fs-20" />
              Paramètres de réassort
            </h4>
            {!isSingleShop && (
              <div className="dropdown">
                <button
                  className="btn btn-sm btn-outline-secondary dropdown-toggle"
                  type="button"
                  data-bs-toggle="dropdown"
                  data-bs-auto-close="outside"
                >
                  {selectedShopIds.length === 0
                    ? 'Magasins'
                    : selectedShopIds.length === 1
                      ? shops.find((s) => s.id === selectedShopIds[0])?.reference
                      : `${selectedShopIds.length} magasins`}
                </button>
                <div className="dropdown-menu p-2" style={{ minWidth: 280, maxHeight: 320, overflowY: 'auto' }}>
                  <input
                    type="text"
                    className="form-control form-control-sm mb-2"
                    placeholder="Rechercher par code ou nom..."
                    value={shopSearch}
                    onChange={(e) => setShopSearch(e.target.value)}
                  />
                  <div className="d-flex gap-2 mb-2 pb-2 border-bottom">
                    <button type="button" className="btn btn-sm btn-link p-0" onClick={selectAll}>
                      Tout cocher
                    </button>
                    <span className="text-muted">·</span>
                    <button type="button" className="btn btn-sm btn-link p-0" onClick={deselectAll}>
                      Tout décocher
                    </button>
                  </div>
                  {shops
                    .filter((shop) => {
                      const q = shopSearch.trim().toLowerCase();
                      if (!q) return true;
                      return `${shop.reference} ${shop.name}`.toLowerCase().includes(q);
                    })
                    .map((shop) => (
                      <div className="form-check" key={shop.id}>
                        <input
                          className="form-check-input"
                          type="checkbox"
                          id={`shop-check-${shop.id}`}
                          checked={selectedShopIds.includes(shop.id)}
                          onChange={() => toggleShop(shop.id)}
                        />
                        <label className="form-check-label" htmlFor={`shop-check-${shop.id}`}>
                          {shop.reference} - {shop.name}
                        </label>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </div>
          <div className="card-body">
            {isBulk && (
              <div className="alert alert-info">
                Plusieurs magasins sélectionnés : les valeurs saisies ci-dessous seront appliquées à tous les
                magasins cochés, sans afficher leur configuration actuelle (qui peut différer d'un magasin à
                l'autre).
                <br />
                <strong>
                  Les champs ci-dessous repartent donc toujours de leur valeur par défaut, même après un
                  enregistrement réussi
                </strong>{' '}
                — par exemple « Génération automatique nocturne » réaffichera « Activée » au rechargement même
                si vous venez d'enregistrer « Désactivée » pour ces magasins : l'enregistrement a bien eu lieu
                (message de confirmation affiché), seul cet écran ne reflète jamais l'état réel en mode
                multi-magasins. Repassez en sélection d'UN SEUL magasin pour vérifier sa configuration actuelle.
              </div>
            )}
            {/* Champs verrouillés si ce magasin est rattaché à un groupe (03/11/2026) : modifier un
                seuil ici n'aurait servi à rien tant que le rattachement reste actif (écrasé par la
                config du groupe, resolveEffectiveConfig côté backend) — mieux vaut l'interdire
                explicitement que laisser croire qu'un changement a pris effet. */}
            {!isBulk && groupInfo && (
              <div className="alert alert-info d-flex justify-content-between align-items-center flex-wrap gap-2">
                <div>
                  <iconify-icon icon="solar:users-group-rounded-bold-duotone" className="align-middle me-1" />
                  Ce magasin est rattaché au groupe <strong>{groupInfo.name}</strong> : les réglages ci-dessous sont
                  hérités du groupe et non modifiables ici. Modifiez-les depuis la section "Groupes de magasins"
                  plus bas, ou détachez ce magasin du groupe pour reprendre une configuration individuelle.
                </div>
                <button type="button" className="btn btn-sm btn-outline-dark flex-shrink-0" onClick={handleDetachFromGroup}>
                  Détacher du groupe
                </button>
              </div>
            )}
            {error && <div className="alert alert-danger">{error}</div>}
            {success && <div className="alert alert-success">{success}</div>}

            {REASSORT_FIELDS.map((field) => (
              <div className="mb-4" key={field.id}>
                <label className="form-label fw-semibold">{field.label}</label>

                {field.kind === 'number' && (
                  <div className="input-group" style={{ maxWidth: 300 }}>
                    <input
                      type="number"
                      className="form-control"
                      min={field.min}
                      max={field.max}
                      step={field.step}
                      value={values[field.id] as number}
                      disabled={!!groupInfo && field.id !== 'nightlyGenerationEnabled'}
                      onChange={(e) => setField(field.id, e.target.value === '' ? '' : Number(e.target.value))}
                    />
                    {field.unit && <span className="input-group-text">{field.unit}</span>}
                  </div>
                )}

                {field.kind === 'select' && (
                  <select
                    className="form-select"
                    style={{ maxWidth: 300 }}
                    value={String(values[field.id])}
                    disabled={!!groupInfo && field.id !== 'nightlyGenerationEnabled'}
                    onChange={(e) => setField(field.id, e.target.value)}
                  >
                    {field.options!.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                )}

                <div
                  className="alert alert-light border mt-2 mb-0 small"
                  dangerouslySetInnerHTML={{ __html: field.helpHtml }}
                />
                {field.warningHtml && field.showWarningIf?.(values[field.id]) && (
                  <div
                    className="alert alert-warning mt-2 mb-0 small"
                    dangerouslySetInnerHTML={{ __html: field.warningHtml }}
                  />
                )}

                {/* Cas spécial : dates personnalisées, affichées juste après le sélecteur de période. */}
                {field.id === 'periodMode' && values.periodMode === 'CUSTOM' && (
                  <div className="row g-3 mt-1">
                    <div className="col-md-6">
                      <label className="form-label">Date de début</label>
                      <input
                        type="date"
                        className="form-control"
                        value={values.customStart as string}
                        onChange={(e) => setField('customStart', e.target.value)}
                      />
                    </div>
                    <div className="col-md-6">
                      <label className="form-label">Date de fin</label>
                      <input
                        type="date"
                        className="form-control"
                        value={values.customEnd as string}
                        onChange={(e) => setField('customEnd', e.target.value)}
                      />
                    </div>
                  </div>
                )}

                {/* Cas spécial : lissage exponentiel, affiché juste après le stock de sécurité comme
                    dans settings.old.html (ordre des champs reproduit à l'identique). */}
                {field.id === 'safetyStockRatio' && (
                  <div className="mt-4">
                    <label className="form-label fw-semibold">Prévision de vente (lissage exponentiel)</label>
                    <div className="form-check form-switch mb-2">
                      <input
                        type="checkbox"
                        className="form-check-input"
                        id="config-forecast-enabled"
                        checked={!!values.forecastEnabled}
                        onChange={(e) => setField('forecastEnabled', e.target.checked)}
                      />
                      <label className="form-check-label" htmlFor="config-forecast-enabled">
                        Activer la prévision par lissage exponentiel
                      </label>
                    </div>
                    {!!values.forecastEnabled && (
                      <div>
                        <label className="form-label small">Réactivité (alpha)</label>
                        <div className="d-flex align-items-center gap-2" style={{ maxWidth: 400 }}>
                          <input
                            type="range"
                            className="form-range"
                            min={0.1}
                            max={0.9}
                            step={0.05}
                            value={values.forecastAlpha as number}
                            onChange={(e) => setField('forecastAlpha', Number(e.target.value))}
                          />
                          <span className="badge bg-secondary" style={{ minWidth: 48 }}>
                            {Number(values.forecastAlpha).toFixed(2)}
                          </span>
                        </div>
                      </div>
                    )}
                    <div className="alert alert-light border mt-2 mb-0 small">
                      <strong>À quoi ça sert :</strong> par défaut, la vente moyenne prévue pour chaque article est
                      une moyenne plate sur toute la période d'analyse (chaque jour compte pareil). Le lissage
                      exponentiel donne plus de poids aux ventes récentes, donc réagit plus vite si le rythme de
                      vente d'un article accélère ou ralentit, au lieu d'attendre que la moyenne sur toute la
                      période ne finisse par bouger.
                      <br />
                      <strong>Alpha :</strong> plus proche de 0.9 = colle vite aux ventes des derniers jours
                      (réactif mais plus sensible aux à-coups) ; plus proche de 0.1 = lisse davantage (plus stable
                      mais réagit plus lentement). <strong>Par défaut : 0.3.</strong>
                      <br />
                      <strong>Sécurité :</strong> retombe automatiquement sur la moyenne plate habituelle si
                      l'historique de vente disponible est trop court (moins de 14 jours) pour que le lissage soit
                      fiable. Un badge "Prévision lissée" apparaît sur la page Proposition de commande pour les
                      articles concernés.
                    </div>
                  </div>
                )}

                {/* Cas spécial : Jours de commande (03/11/2026, demande explicite : "le mag passe
                    commande 3 fois en semaine... comment je peux géré ca ?") — sélection libre des 7
                    jours, aucun pré-coché. Désactivé si le magasin est rattaché à un groupe : les jours
                    se configurent alors sur le GROUPE (section "Groupes de magasins" plus bas), pas ici,
                    pour ne jamais donner l'impression qu'une modification ici s'appliquerait réellement
                    (elle serait silencieusement ignorée par le backend sinon). */}
                {field.id === 'useReceptionLeadTimeInCalculation' && (
                  <div className="mt-4">
                    <label className="form-label fw-semibold">Jours de commande</label>
                    {groupInfo ? (
                      <div className="alert alert-info small mb-2">
                        <iconify-icon icon="solar:users-group-rounded-bold-duotone" className="align-middle me-1" />
                        Ce magasin est rattaché au groupe <strong>{groupInfo.name}</strong> — les jours de commande
                        se configurent dans la section "Groupes de magasins" ci-dessous, pas ici. Détachez ce
                        magasin du groupe pour reprendre une configuration individuelle.
                      </div>
                    ) : (
                      <div className="d-flex flex-wrap gap-3 mb-2">
                        {WEEKDAYS.map((day) => (
                          <div className="form-check" key={day.value}>
                            <input
                              type="checkbox"
                              className="form-check-input"
                              id={`order-day-${day.value}`}
                              checked={orderDays.includes(day.value)}
                              onChange={(e) =>
                                setOrderDays((prev) =>
                                  e.target.checked ? [...prev, day.value] : prev.filter((d) => d !== day.value)
                                )
                              }
                            />
                            <label className="form-check-label" htmlFor={`order-day-${day.value}`}>
                              {day.label}
                            </label>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="alert alert-light border mt-2 mb-0 small">
                      <strong>À quoi ça sert :</strong> cochez les jours où ce magasin passe RÉELLEMENT commande
                      (ex: samedi, mardi et jeudi pour un magasin qui commande 3 fois par semaine). Le système
                      calcule alors automatiquement le nombre exact de jours à couvrir avant la PROCHAINE
                      commande du cycle (ex: commande le mardi, prochaine le jeudi → couvre 2 jours), au lieu
                      d'une semaine fixe ou d'un délai unique identique chaque jour.
                      <br />
                      <strong>Prime sur "Utiliser le délai dans le calcul du besoin" ci-dessus</strong> quand au
                      moins un jour est coché. Aucun jour coché = comportement inchangé (ce réglage précédent
                      continue de s'appliquer).
                    </div>
                  </div>
                )}

                {/* Cas spécial : Mode Auto, affiché après la séparation des commandes par rayon, avec
                    son panneau visuel dédié (badge d'état, encadré rouge pâle si activé — cf. style
                    ajouté le 23/09/2026 sur l'ancienne page). */}
                {field.id === 'splitOrdersByDepartment' && (
                  <ModeAutoPanel
                    enabled={values.autoOrderEnabled === 'true'}
                    validateAfterCreate={values.autoOrderValidateAfterCreate === 'true'}
                    onChangeEnabled={(v) => setField('autoOrderEnabled', v ? 'true' : 'false')}
                    onChangeValidate={(v) => setField('autoOrderValidateAfterCreate', v ? 'true' : 'false')}
                  />
                )}
              </div>
            ))}

            <button type="button" className="btn btn-primary" disabled={saving} onClick={handleSave}>
              {saving ? 'Enregistrement…' : 'Enregistrer'}
            </button>
          </div>
        </div>
      </div>

      <div className="col-xl-4">
        <div className="how-it-works-card">
          <div className="how-it-works-icon">
            <iconify-icon icon="solar:lightbulb-bold-duotone" />
          </div>
          <h4 className="how-it-works-title">Comment ça marche</h4>
          <p>
            Chaque nuit, le système analyse les ventes du magasin sur la période choisie, identifie les articles
            qui représentent le seuil Pareto configuré du chiffre d'affaires, puis calcule une quantité à
            commander pour chacun en fonction du stock actuel et de la vente moyenne.
          </p>
          <p className="mb-0">
            La proposition générée est ensuite disponible sur la page <strong>Proposition de commande</strong>{' '}
            pour validation avant envoi à RPOS.
          </p>
        </div>
      </div>
    </div>
  );
}

// Reproduit à l'identique le panneau "Mode Auto" ajouté le 23/09/2026 sur l'ancienne page (badge
// d'état + fond rouge pâle dès l'activation) — voir historique de session, style validé séparément
// avant cette migration.
function ModeAutoPanel({
  enabled,
  validateAfterCreate,
  onChangeEnabled,
  onChangeValidate,
}: {
  enabled: boolean;
  validateAfterCreate: boolean;
  onChangeEnabled: (v: boolean) => void;
  onChangeValidate: (v: boolean) => void;
}) {
  return (
    <div
      className={`mb-4 mode-auto-panel${enabled ? ' active' : ''}`}
    >
      <div className="d-flex justify-content-between align-items-start mb-3">
        <div>
          <div className="d-flex align-items-center gap-2 mb-1">
            <iconify-icon icon="solar:bolt-bold-duotone" className="fs-18 mode-auto-icon" />
            <span className="fw-semibold">Mode Auto</span>
            <span
              className={`badge mode-auto-badge${enabled ? ' active' : ' inactive'}`}
            >
              {enabled ? 'Actif' : 'Désactivé'}
            </span>
          </div>
          <div className="small text-muted">Commande automatique, sans validation humaine.</div>
        </div>
      </div>
      <div className="row g-2">
        <div className="col-md-6">
          <label className="form-label small mb-1">Activation</label>
          <select
            className="form-select form-select-sm"
            value={enabled ? 'true' : 'false'}
            onChange={(e) => onChangeEnabled(e.target.value === 'true')}
          >
            <option value="false">Désactivé (par défaut)</option>
            <option value="true">Activé</option>
          </select>
        </div>
        <div className="col-md-6">
          <label className="form-label small mb-1">Envoi à l'entrepôt</label>
          <select
            className="form-select form-select-sm"
            value={validateAfterCreate ? 'true' : 'false'}
            onChange={(e) => onChangeValidate(e.target.value === 'true')}
          >
            <option value="false">Crée sans valider sur RPOS</option>
            <option value="true">Crée et valide sur RPOS</option>
          </select>
        </div>
      </div>
      <div className="small text-muted mt-3 mb-0">
        Chaque nuit, la proposition générée pour ce magasin est transformée en commande en acceptant la quantité
        proposée par l'IA telle quelle sur tous les articles — <strong>sans la valider</strong> laisse la commande
        "en préparation" sur RPOS (recommandé pour tester) ; <strong>crée et valide</strong> l'envoie réellement à
        l'entrepôt sans relecture humaine. Un échec (total ou partiel) déclenche une alerte dans la cloche de
        notification et sur la page Qualité &amp; IA.
      </div>
    </div>
  );
}
