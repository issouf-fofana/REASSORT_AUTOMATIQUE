import { useEffect, useRef, useState } from 'react';
import {
  AI_CAPABILITIES,
  AI_ROLE_DEFAULTS,
  DEPARTMENT_SCOPED_ROLES,
  SINGLE_SHOP_ROLES,
  groupShopsByPos,
  loadRayonsFor,
  sortedPosIds,
  type Shop,
} from './shared';

export interface RoleScopedState {
  shopId: string;
  departments: string[];
  supervisedShopIds: string[];
  aiPermCustom: Record<string, boolean>;
}

interface Props {
  idPrefix: string;
  role: string;
  shops: Shop[];
  state: RoleScopedState;
  onChange: (next: RoleScopedState) => void;
  /** Rayons déjà assignés à précocher au premier rendu (édition uniquement). */
  initialCheckedDepartments?: string[];
}

/**
 * Reproduit les 3 blocs conditionnels par rôle de users-list.html (magasin unique + rayons /
 * magasins supervisés / permissions IA), partagés à l'identique par le formulaire de création ET
 * la modale d'édition dans la page d'origine — factorisés ici en un seul composant réutilisé par
 * les deux, pour ne jamais dupliquer cette logique.
 */
export function RoleScopedFields({ idPrefix, role, shops, state, onChange, initialCheckedDepartments }: Props) {
  const [rayons, setRayons] = useState<string[] | null>(null);
  const rayonsTokenRef = useRef(0);
  const appliedInitialRef = useRef(false);

  const byPos = groupShopsByPos(shops);

  useEffect(() => {
    if (!DEPARTMENT_SCOPED_ROLES.has(role) || !state.shopId) {
      setRayons(null);
      return;
    }
    const token = ++rayonsTokenRef.current;
    setRayons(null);
    loadRayonsFor(state.shopId)
      .then((names) => {
        if (rayonsTokenRef.current !== token) return;
        setRayons(names);
        // Précoche les rayons déjà assignés uniquement au tout premier chargement pour ce montage
        // (édition d'un compte existant) — jamais après, pour ne pas re-précocher après un
        // changement manuel de magasin par l'utilisateur.
        if (!appliedInitialRef.current && initialCheckedDepartments?.length) {
          appliedInitialRef.current = true;
          const checkedSet = new Set(initialCheckedDepartments);
          onChange({ ...state, departments: names.filter((n) => checkedSet.has(n)) });
        }
      })
      .catch(() => {
        if (rayonsTokenRef.current === token) setRayons([]);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, state.shopId]);

  function toggleDepartment(name: string) {
    const next = state.departments.includes(name) ? state.departments.filter((d) => d !== name) : [...state.departments, name];
    onChange({ ...state, departments: next });
  }

  function toggleSupervised(shopId: string) {
    const next = state.supervisedShopIds.includes(shopId)
      ? state.supervisedShopIds.filter((id) => id !== shopId)
      : [...state.supervisedShopIds, shopId];
    onChange({ ...state, supervisedShopIds: next });
  }

  function toggleAiPerm(key: string, checked: boolean) {
    onChange({ ...state, aiPermCustom: { ...state.aiPermCustom, [key]: checked } });
  }

  const defaults = AI_ROLE_DEFAULTS[role] || AI_ROLE_DEFAULTS.DIRECTOR;

  return (
    <>
      {SINGLE_SHOP_ROLES.has(role) && (
        <div className="mb-3">
          <label className="form-label">Magasin assigné</label>
          <select
            className="form-select"
            required
            value={state.shopId}
            onChange={(e) => onChange({ ...state, shopId: e.target.value, departments: [] })}
          >
            <option value="">Sélectionner...</option>
            {sortedPosIds(byPos).map((posId) => (
              <optgroup label={byPos[posId][0]?.posLabel || posId} key={posId}>
                {byPos[posId]
                  .slice()
                  .sort((a, b) => (a.reference || '').localeCompare(b.reference || ''))
                  .map((s) => (
                    <option value={s.id} key={s.id}>
                      {s.reference} - {s.name}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </div>
      )}

      {DEPARTMENT_SCOPED_ROLES.has(role) && (
        <div className="mb-3">
          <label className="form-label">{role === 'SHELF_STOCKER' ? 'Rayon(s) assigné(s)' : 'Département assigné'}</label>
          <div className="border rounded p-2 small" style={{ maxHeight: 220, overflowY: 'auto' }}>
            {!state.shopId && <div className="text-muted small">Sélectionnez un magasin pour charger ses rayons...</div>}
            {state.shopId && rayons === null && <div className="text-muted small">Chargement des rayons...</div>}
            {state.shopId && rayons !== null && rayons.length === 0 && (
              <div className="text-muted small">Aucun rayon trouvé pour ce magasin.</div>
            )}
            {rayons?.map((name, i) => (
              <div className="form-check" key={name}>
                <input
                  className="form-check-input"
                  type="checkbox"
                  id={`${idPrefix}-dept-${i}`}
                  checked={state.departments.includes(name)}
                  onChange={() => toggleDepartment(name)}
                />
                <label className="form-check-label" htmlFor={`${idPrefix}-dept-${i}`}>
                  {name}
                </label>
              </div>
            ))}
          </div>
          {idPrefix === 'new' && (
            <div className="form-text">
              Rayons réels du magasin choisi ci-dessus (synchronisés depuis RPOS) — pour un Rayonniste couvrant
              plusieurs rayons, cochez-en plusieurs.
            </div>
          )}
        </div>
      )}

      {role === 'SUPERVISOR' && (
        <div className="mb-3">
          <label className="form-label">Magasins supervisés</label>
          <div className="border rounded p-2" style={{ maxHeight: 220, overflowY: 'auto' }}>
            {shops.map((s) => (
              <div className="form-check" key={s.id}>
                <input
                  className="form-check-input"
                  type="checkbox"
                  id={`${idPrefix}-sup-${s.id}`}
                  checked={state.supervisedShopIds.includes(s.id)}
                  onChange={() => toggleSupervised(s.id)}
                />
                <label className="form-check-label" htmlFor={`${idPrefix}-sup-${s.id}`}>
                  {s.reference} - {s.name}
                </label>
              </div>
            ))}
          </div>
        </div>
      )}

      {role !== 'ADMIN' && (
        <div className="mb-3">
          <label className="form-label">Permissions Assistant IA</label>
          <div className="border rounded p-2 small">
            {AI_CAPABILITIES.map((cap) => {
              const checked = state.aiPermCustom[cap.key] ?? defaults[cap.key];
              return (
                <div className="form-check" key={cap.key}>
                  <input
                    className="form-check-input"
                    type="checkbox"
                    id={`${idPrefix}-ai-${cap.key}`}
                    checked={checked}
                    onChange={(e) => toggleAiPerm(cap.key, e.target.checked)}
                  />
                  <label className="form-check-label" htmlFor={`${idPrefix}-ai-${cap.key}`}>
                    {cap.label}
                  </label>
                </div>
              );
            })}
          </div>
          {idPrefix === 'new' && (
            <div className="form-text">Pré-cochées selon le rôle choisi — décochez pour restreindre davantage cet utilisateur précis.</div>
          )}
        </div>
      )}
    </>
  );
}
