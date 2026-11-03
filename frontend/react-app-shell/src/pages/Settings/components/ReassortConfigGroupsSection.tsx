import { useEffect, useState } from 'react';
import { apiFetch } from '../../../shared/api/client';
import { useShopsFlat } from './useShopsFlat';
import { ShopMultiPicker } from './ShopMultiPicker';
import { REASSORT_FIELDS } from './reassortFields';

// Groupes de magasins partageant la même configuration de réassort (demande du 03/11/2026 : "donne
// la possibilité de cree un groupe pour les mag qui son similaire", étendu le 03/11/2026 : "donne la
// possibilité de modifier le groupe, nom...") — un magasin rattaché hérite EN TOTALITÉ de la config
// du groupe ci-dessous (configService.resolveEffectiveConfig côté backend), sauf Mode Auto/
// Génération nocturne qui restent toujours réglés individuellement par magasin (section "Paramètres
// de réassort" ci-dessus, même rattaché à un groupe) — d'où GROUP_FIELDS qui exclut
// nightlyGenerationEnabled de REASSORT_FIELDS (autoOrderEnabled/autoOrderValidateAfterCreate n'y
// sont déjà pas, gérés par ModeAutoPanel séparément dans ReassortConfigSection).
const GROUP_FIELDS = REASSORT_FIELDS.filter((f) => f.id !== 'nightlyGenerationEnabled');

// Même champs stockés en FRACTION côté backend (0.8) mais affichés en POURCENTAGE (80) que
// ReassortConfigSection.tsx — jamais une seconde logique de conversion divergente.
const PERCENT_STORED_AS_FRACTION = new Set(['paretoThreshold', 'safetyStockRatio']);

interface ReassortConfigGroup {
  id: string;
  name: string;
  orderDays: string[];
  receptionLeadTimeDays: number;
  useReceptionLeadTimeInCalculation: boolean;
  shops: { rposShopId: string }[];
  [key: string]: unknown;
}

type GroupFormValues = Record<string, string | number | boolean>;

function groupToFormValues(group: ReassortConfigGroup): GroupFormValues {
  const values: GroupFormValues = {};
  for (const field of GROUP_FIELDS) {
    const raw = group[field.id];
    if (raw === undefined || raw === null) continue;
    if (PERCENT_STORED_AS_FRACTION.has(field.id) && typeof raw === 'number') {
      values[field.id] = Math.round(raw * 100);
    } else if (typeof raw === 'boolean') {
      values[field.id] = raw ? 'true' : 'false';
    } else {
      values[field.id] = raw as string | number;
    }
  }
  values.forecastEnabled = !!group.forecastEnabled;
  values.forecastAlpha = (group.forecastAlpha as number) ?? 0.3;
  values.customStart = (group.customStart as string) || '';
  values.customEnd = (group.customEnd as string) || '';
  return values;
}

const WEEKDAYS: { value: string; label: string }[] = [
  { value: 'LUNDI', label: 'Lun' },
  { value: 'MARDI', label: 'Mar' },
  { value: 'MERCREDI', label: 'Mer' },
  { value: 'JEUDI', label: 'Jeu' },
  { value: 'VENDREDI', label: 'Ven' },
  { value: 'SAMEDI', label: 'Sam' },
  { value: 'DIMANCHE', label: 'Dim' },
];

export function ReassortConfigGroupsSection() {
  const { shops } = useShopsFlat();
  const [groups, setGroups] = useState<ReassortConfigGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [newGroupName, setNewGroupName] = useState('');
  const [creating, setCreating] = useState(false);
  // Brouillon d'édition par groupe déplié (03/11/2026) : nom + REASSORT_FIELDS, modifiables
  // librement avant un clic explicite sur "Enregistrer" — jamais sauvegardé à chaque frappe
  // (contrairement aux jours de commande/magasins rattachés, toggle immédiat car sans saisie libre).
  const [editName, setEditName] = useState('');
  const [editValues, setEditValues] = useState<GroupFormValues>({});
  const [saving, setSaving] = useState(false);

  function reload() {
    setLoading(true);
    apiFetch<ReassortConfigGroup[]>('/reassort/config-groups')
      .then(setGroups)
      .catch((err: Error) => setError('Erreur de chargement : ' + err.message))
      .finally(() => setLoading(false));
  }

  useEffect(reload, []);

  function toggleExpand(group: ReassortConfigGroup) {
    if (expandedId === group.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(group.id);
    setEditName(group.name);
    setEditValues(groupToFormValues(group));
  }

  function setEditField(id: string, value: string | number | boolean) {
    setEditValues((prev) => ({ ...prev, [id]: value }));
  }

  async function handleSaveGroup(group: ReassortConfigGroup) {
    if (!editName.trim()) {
      setError('Le nom du groupe ne peut pas être vide.');
      return;
    }
    setSaving(true);
    setError(null);
    const isBooleanSelect = (field: (typeof GROUP_FIELDS)[number]) =>
      field.kind === 'select' && (field.options || []).every((o) => o.value === 'true' || o.value === 'false');

    const payload: Record<string, unknown> = { name: editName.trim() };
    for (const field of GROUP_FIELDS) {
      const raw = editValues[field.id];
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
    payload.forecastEnabled = !!editValues.forecastEnabled;
    payload.forecastAlpha = Number(editValues.forecastAlpha);
    payload.customStart = editValues.periodMode === 'CUSTOM' ? editValues.customStart || null : null;
    payload.customEnd = editValues.periodMode === 'CUSTOM' ? editValues.customEnd || null : null;
    // orderDays géré séparément par handleToggleOrderDay (sauvegarde immédiate) — jamais réécrasé
    // ici par une valeur de brouillon potentiellement périmée si l'utilisateur a coché des jours
    // avant de modifier d'autres champs puis de sauvegarder.
    payload.orderDays = group.orderDays;

    try {
      await apiFetch(`/reassort/config-groups/${group.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      setSuccess('Groupe mis à jour.');
      reload();
    } catch (err) {
      setError('Erreur : ' + (err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleCreate() {
    if (!newGroupName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await apiFetch('/reassort/config-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newGroupName.trim() }),
      });
      setNewGroupName('');
      setSuccess('Groupe créé.');
      reload();
    } catch (err) {
      setError('Erreur : ' + (err as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id: string, name: string) {
    if (!window.confirm(`Supprimer le groupe "${name}" ? Les magasins rattachés reprendront leur configuration individuelle.`)) return;
    setError(null);
    try {
      await apiFetch(`/reassort/config-groups/${id}`, { method: 'DELETE' });
      setSuccess('Groupe supprimé.');
      reload();
    } catch (err) {
      setError('Erreur : ' + (err as Error).message);
    }
  }

  async function handleToggleOrderDay(group: ReassortConfigGroup, day: string) {
    const next = group.orderDays.includes(day) ? group.orderDays.filter((d) => d !== day) : [...group.orderDays, day];
    setError(null);
    try {
      await apiFetch(`/reassort/config-groups/${group.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderDays: next }),
      });
      reload();
    } catch (err) {
      setError('Erreur : ' + (err as Error).message);
    }
  }

  async function handleShopsChange(group: ReassortConfigGroup, nextShopIds: string[]) {
    const currentShopIds = group.shops.map((s) => s.rposShopId);
    const toAttach = nextShopIds.filter((id) => !currentShopIds.includes(id));
    const toDetach = currentShopIds.filter((id) => !nextShopIds.includes(id));
    setError(null);
    try {
      if (toAttach.length) {
        await apiFetch(`/reassort/config-groups/${group.id}/shops`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shopIds: toAttach }),
        });
      }
      for (const shopId of toDetach) {
        await apiFetch(`/reassort/config-groups/${group.id}/shops/${shopId}`, { method: 'DELETE' });
      }
      reload();
    } catch (err) {
      setError('Erreur : ' + (err as Error).message);
    }
  }

  return (
    <div className="card mt-4">
      <div className="card-header">
        <h4 className="card-title d-flex align-items-center gap-1">
          <iconify-icon icon="solar:users-group-rounded-bold-duotone" className="text-primary fs-20" />
          Groupes de magasins
        </h4>
      </div>
      <div className="card-body">
        <p className="text-muted small">
          Un groupe permet de configurer plusieurs magasins similaires EN UNE FOIS (jours de commande, seuils de
          calcul...) : un magasin rattaché hérite automatiquement de tous les réglages du groupe, et toute
          modification du groupe s'applique immédiatement à tous ses magasins. Mode Auto et Génération nocturne
          restent toujours réglés individuellement par magasin, même rattaché à un groupe.
        </p>

        {error && <div className="alert alert-danger">{error}</div>}
        {success && <div className="alert alert-success">{success}</div>}

        <div className="d-flex gap-2 mb-4">
          <input
            type="text"
            className="form-control"
            style={{ maxWidth: 300 }}
            placeholder="Nom du nouveau groupe (ex: Magasins Abidjan)"
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          />
          <button type="button" className="btn btn-primary" disabled={creating || !newGroupName.trim()} onClick={handleCreate}>
            Créer un groupe
          </button>
        </div>

        {loading && <p className="text-muted">Chargement...</p>}
        {!loading && groups.length === 0 && <p className="text-muted">Aucun groupe créé pour l'instant.</p>}

        {groups.map((group) => (
          <div className="card mb-3" key={group.id}>
            <div
              className="card-header d-flex justify-content-between align-items-center"
              style={{ cursor: 'pointer' }}
              onClick={() => toggleExpand(group)}
            >
              <div>
                <strong>{group.name}</strong>
                <span className="text-muted small ms-2">{group.shops.length} magasin(s)</span>
              </div>
              <div className="d-flex align-items-center gap-2">
                <button
                  type="button"
                  className="btn btn-sm btn-outline-danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(group.id, group.name);
                  }}
                >
                  Supprimer
                </button>
                <iconify-icon icon={expandedId === group.id ? 'solar:alt-arrow-up-bold' : 'solar:alt-arrow-down-bold'} />
              </div>
            </div>
            {expandedId === group.id && (
              <div className="card-body">
                <label className="form-label fw-semibold">Nom du groupe</label>
                <input
                  type="text"
                  className="form-control mb-3"
                  style={{ maxWidth: 300 }}
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                />

                <label className="form-label fw-semibold">Jours de commande du groupe</label>
                <div className="d-flex flex-wrap gap-3 mb-3">
                  {WEEKDAYS.map((day) => (
                    <div className="form-check" key={day.value}>
                      <input
                        type="checkbox"
                        className="form-check-input"
                        id={`group-${group.id}-day-${day.value}`}
                        checked={group.orderDays.includes(day.value)}
                        onChange={() => handleToggleOrderDay(group, day.value)}
                      />
                      <label className="form-check-label" htmlFor={`group-${group.id}-day-${day.value}`}>
                        {day.label}
                      </label>
                    </div>
                  ))}
                </div>

                <label className="form-label fw-semibold">Magasins rattachés</label>
                <ShopMultiPicker
                  shops={shops}
                  selectedIds={group.shops.map((s) => s.rposShopId)}
                  onChange={(ids) => handleShopsChange(group, ids)}
                  showSelectAllNone
                />

                <hr className="my-4" />
                <h5 className="mb-3">Autres paramètres du groupe</h5>
                {GROUP_FIELDS.map((field) => (
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
                          value={editValues[field.id] as number}
                          onChange={(e) => setEditField(field.id, e.target.value === '' ? '' : Number(e.target.value))}
                        />
                        {field.unit && <span className="input-group-text">{field.unit}</span>}
                      </div>
                    )}

                    {field.kind === 'select' && (
                      <select
                        className="form-select"
                        style={{ maxWidth: 300 }}
                        value={String(editValues[field.id])}
                        onChange={(e) => setEditField(field.id, e.target.value)}
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

                    {field.id === 'periodMode' && editValues.periodMode === 'CUSTOM' && (
                      <div className="row g-3 mt-1">
                        <div className="col-md-6">
                          <label className="form-label">Date de début</label>
                          <input
                            type="date"
                            className="form-control"
                            value={editValues.customStart as string}
                            onChange={(e) => setEditField('customStart', e.target.value)}
                          />
                        </div>
                        <div className="col-md-6">
                          <label className="form-label">Date de fin</label>
                          <input
                            type="date"
                            className="form-control"
                            value={editValues.customEnd as string}
                            onChange={(e) => setEditField('customEnd', e.target.value)}
                          />
                        </div>
                      </div>
                    )}

                    {field.id === 'safetyStockRatio' && (
                      <div className="mt-4">
                        <label className="form-label fw-semibold">Prévision de vente (lissage exponentiel)</label>
                        <div className="form-check form-switch mb-2">
                          <input
                            type="checkbox"
                            className="form-check-input"
                            id={`group-${group.id}-forecast-enabled`}
                            checked={!!editValues.forecastEnabled}
                            onChange={(e) => setEditField('forecastEnabled', e.target.checked)}
                          />
                          <label className="form-check-label" htmlFor={`group-${group.id}-forecast-enabled`}>
                            Activer la prévision par lissage exponentiel
                          </label>
                        </div>
                        {!!editValues.forecastEnabled && (
                          <div>
                            <label className="form-label small">Réactivité (alpha)</label>
                            <div className="d-flex align-items-center gap-2" style={{ maxWidth: 400 }}>
                              <input
                                type="range"
                                className="form-range"
                                min={0.1}
                                max={0.9}
                                step={0.05}
                                value={editValues.forecastAlpha as number}
                                onChange={(e) => setEditField('forecastAlpha', Number(e.target.value))}
                              />
                              <span className="badge bg-secondary" style={{ minWidth: 48 }}>
                                {Number(editValues.forecastAlpha).toFixed(2)}
                              </span>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}

                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={saving}
                  onClick={() => handleSaveGroup(group)}
                >
                  {saving ? 'Enregistrement…' : 'Enregistrer le groupe'}
                </button>

                <div className="alert alert-light border mt-3 mb-0 small">
                  Ces réglages s'appliquent immédiatement à tous les magasins rattachés ci-dessus (lecture seule
                  pour eux dans "Paramètres de réassort" tant qu'ils restent dans ce groupe).
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
