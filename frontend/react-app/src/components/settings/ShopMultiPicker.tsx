import { useMemo, useState } from 'react';

export interface ShopOption {
  id: string;
  posId: string;
  reference: string;
  label: string;
}

interface ShopMultiPickerProps {
  shops: ShopOption[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  showSelectAllNone?: boolean;
}

/**
 * Reproduit la checklist déroulante (recherche + cases à cocher) au-dessus d'un <select multiple>
 * caché de settings.old.html (renderSalesSyncShopChecklist / renderBackfillShopChecklist /
 * renderPurgeShopChecklist — même patron dupliqué 3 fois côté HTML, factorisé ici en un seul
 * composant réutilisé par les 3 usages de la section Synchronisation).
 */
export function ShopMultiPicker({ shops, selectedIds, onChange, showSelectAllNone }: ShopMultiPickerProps) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return shops;
    return shops.filter((s) => `${s.reference} ${s.label}`.toLowerCase().includes(q));
  }, [shops, search]);

  const label =
    selectedIds.length === 0
      ? 'Magasins'
      : selectedIds.length === 1
        ? shops.find((s) => s.id === selectedIds[0])?.reference || '1 magasin'
        : `${selectedIds.length} magasins`;

  function toggle(id: string) {
    if (selectedIds.includes(id)) onChange(selectedIds.filter((x) => x !== id));
    else onChange([...selectedIds, id]);
  }

  function setAllVisible(selected: boolean) {
    const visibleIds = filtered.map((s) => s.id);
    if (selected) {
      onChange(Array.from(new Set([...selectedIds, ...visibleIds])));
    } else {
      onChange(selectedIds.filter((id) => !visibleIds.includes(id)));
    }
  }

  return (
    <div className={`dropdown ${open ? 'show' : ''}`}>
      <button
        className="btn btn-sm btn-outline-secondary dropdown-toggle"
        type="button"
        onClick={() => setOpen((o) => !o)}
      >
        {label}
      </button>
      <div className={`dropdown-menu p-2 ${open ? 'show' : ''}`} style={{ minWidth: 320 }}>
        <input
          type="text"
          className="form-control form-control-sm mb-2"
          placeholder="Rechercher par POS, code ou nom..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {showSelectAllNone && (
          <div className="d-flex gap-2 mb-2">
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary flex-fill"
              onClick={() => setAllVisible(true)}
            >
              Tout cocher
            </button>
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary flex-fill"
              onClick={() => setAllVisible(false)}
            >
              Tout décocher
            </button>
          </div>
        )}
        <div style={{ maxHeight: 280, overflowY: 'auto' }}>
          {filtered.length === 0 && <div className="text-muted small p-2">Aucun magasin trouvé.</div>}
          {filtered.map((s) => (
            <div className="form-check" key={s.id}>
              <input
                className="form-check-input"
                type="checkbox"
                id={`shop-check-${s.id}`}
                checked={selectedIds.includes(s.id)}
                onChange={() => toggle(s.id)}
              />
              <label className="form-check-label" htmlFor={`shop-check-${s.id}`}>
                {s.reference} - {s.label}
              </label>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
