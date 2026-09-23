import { useState } from 'react';
import { apiFetch } from './api/client';
import { AI_ROLE_DEFAULTS, DEPARTMENT_SCOPED_ROLES, SINGLE_SHOP_ROLES, type ReassortUserRecord, type Shop } from './shared';
import { RoleScopedFields, type RoleScopedState } from './RoleScopedFields';

function initialScopedState(u: ReassortUserRecord): RoleScopedState {
  let aiPermCustom: Record<string, boolean> = {};
  if (u.aiPermissionsJson) {
    try {
      aiPermCustom = JSON.parse(u.aiPermissionsJson);
    } catch {
      aiPermCustom = {};
    }
  }
  return {
    shopId: u.rposShopId || '',
    departments: (u.assignedDepartment || '')
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean),
    supervisedShopIds: (u.supervisedShops || []).map((s) => s.rposShopId),
    aiPermCustom,
  };
}

export function EditUserModal({
  user,
  shops,
  onClose,
  onSaved,
}: {
  user: ReassortUserRecord;
  shops: Shop[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [role, setRole] = useState(user.role);
  const [scoped, setScoped] = useState<RoleScopedState>(initialScopedState(user));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Rayons déjà assignés à précocher : seulement pertinent si le rôle édité correspond toujours à
  // celui d'origine (un changement manuel de rôle dans la modale repart d'une sélection vierge,
  // comme dans la page HTML d'origine).
  const initialCheckedDepartments = role === user.role ? scoped.departments : undefined;

  function handleRoleChange(nextRole: string) {
    // Changement manuel de rôle : repart du défaut (permissions IA) et d'une sélection vierge
    // (départements/rayons), jamais de l'ancien custom — même comportement que la page HTML.
    setRole(nextRole);
    setScoped((prev) => ({ ...prev, departments: [], aiPermCustom: {} }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const payload: Record<string, unknown> = { role };

    if (SINGLE_SHOP_ROLES.has(role)) {
      const shop = shops.find((s) => s.id === scoped.shopId);
      if (shop) {
        payload.rposShopId = shop.id;
        payload.rposShopReference = shop.reference;
        payload.rposShopName = shop.name;
        payload.rposPosId = shop.posId;
      }
    }
    if (DEPARTMENT_SCOPED_ROLES.has(role)) {
      payload.assignedDepartment = scoped.departments.join(',');
      if (!payload.assignedDepartment) {
        setError('Sélectionnez au moins un rayon assigné.');
        return;
      }
    }
    if (role !== 'ADMIN') {
      const defaults = AI_ROLE_DEFAULTS[role] || AI_ROLE_DEFAULTS.DIRECTOR;
      const custom: Record<string, boolean> = {};
      for (const [key, checked] of Object.entries(scoped.aiPermCustom)) {
        if (checked !== !!defaults[key]) custom[key] = checked;
      }
      payload.aiPermissionsJson = Object.keys(custom).length ? custom : null;
    } else {
      payload.aiPermissionsJson = null;
    }
    if (role === 'SUPERVISOR') {
      const supervisedShops = scoped.supervisedShopIds
        .map((id) => shops.find((s) => s.id === id))
        .filter((s): s is Shop => !!s)
        .map((s) => ({ rposShopId: s.id, rposShopReference: s.reference, rposShopName: s.name, rposPosId: s.posId }));
      if (supervisedShops.length === 0) {
        setError('Sélectionnez au moins un magasin à superviser.');
        return;
      }
      payload.supervisedShops = supervisedShops;
    }

    setSaving(true);
    try {
      await apiFetch(`/users/${user.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="modal fade show" style={{ display: 'block' }} tabIndex={-1} role="dialog">
        <div className="modal-dialog" role="document">
          <div className="modal-content">
            <div className="modal-header">
              <h5 className="modal-title">Modifier le compte</h5>
              <button type="button" className="btn-close" onClick={onClose}></button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="modal-body">
                <p className="text-muted">
                  Compte : {user.name} ({user.email})
                </p>
                {error && <div className="alert alert-danger">{error}</div>}
                <div className="mb-3">
                  <label className="form-label">Rôle</label>
                  <select className="form-select" value={role} onChange={(e) => handleRoleChange(e.target.value)}>
                    <option value="SHELF_STOCKER">Rayonniste (un ou plusieurs rayons)</option>
                    <option value="DEPARTMENT_HEAD">Chef de département (un département)</option>
                    <option value="DIRECTOR">Directeur (un magasin entier)</option>
                    <option value="SUPERVISOR">Superviseur (plusieurs magasins choisis)</option>
                    <option value="ADMIN">Administrateur (tous les magasins + configuration)</option>
                  </select>
                </div>
                <RoleScopedFields
                  idPrefix="edit"
                  role={role}
                  shops={shops}
                  state={scoped}
                  onChange={setScoped}
                  initialCheckedDepartments={initialCheckedDepartments}
                />
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-light" onClick={onClose}>
                  Annuler
                </button>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  Enregistrer
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
      <div className="modal-backdrop fade show"></div>
    </>
  );
}
