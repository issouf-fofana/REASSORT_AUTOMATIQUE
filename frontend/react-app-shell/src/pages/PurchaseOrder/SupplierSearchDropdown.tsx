import { useEffect, useMemo, useRef, useState } from 'react';

export interface SupplierOption {
  value: string;
  label: string;
  sublabel?: string;
}

// Variante de CompactDropdown (../../shared/components/CompactDropdown.tsx) avec un champ de
// recherche en tête de liste — demande du 28/10/2026 ("fais en sorte que je puisse chercher") après
// que la liste des fournisseurs d'une proposition se soit révélée trop longue pour un simple
// <select>/dropdown statique à parcourir visuellement. Même mécanique (bouton + panneau React, clic
// extérieur pour fermer) et mêmes couleurs que CompactDropdown, pour rester visuellement identique
// au reste de cet écran plutôt que d'introduire un nouveau style de menu.
export function SupplierSearchDropdown({
  value,
  options,
  onChange,
  placeholder = 'Tous les fournisseurs',
}: {
  value: string;
  options: SupplierOption[];
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    // Focus différé (après le rendu du panneau) : un focus immédiat perdait la main au profit du
    // clic qui vient d'ouvrir le menu sur certains navigateurs.
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onClickOutside);
    };
  }, [open]);

  const current = options.find((o) => o.value === value);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  return (
    <div ref={rootRef} style={{ position: 'relative', minWidth: 220, flexShrink: 0 }}>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          background: '#ffffff', border: '1px solid #D6DEEA', borderRadius: 8,
          padding: '.4rem .75rem', fontSize: '.82rem', fontWeight: 600, color: '#1B2A4A', textAlign: 'left',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {current ? current.label : placeholder}
        </span>
        <iconify-icon
          icon="solar:alt-arrow-down-linear"
          style={{ fontSize: 14, color: '#9099a8', flexShrink: 0, transform: open ? 'rotate(180deg)' : undefined, transition: 'transform .12s' }}
        ></iconify-icon>
      </button>
      {open && (
        <div
          style={{
            position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 1050,
            minWidth: 280, maxWidth: 360,
            background: '#ffffff', border: '1px solid #D6DEEA', borderRadius: 10,
            boxShadow: '0 8px 24px rgba(27,42,74,.14)',
          }}
        >
          <div style={{ padding: '.5rem .5rem 0' }}>
            <div style={{ position: 'relative' }}>
              <iconify-icon
                icon="solar:magnifer-linear"
                style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 14, color: '#9099a8' }}
              ></iconify-icon>
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setOpen(false);
                }}
                placeholder="Rechercher un fournisseur..."
                style={{
                  width: '100%', boxSizing: 'border-box',
                  border: '1px solid #D6DEEA', borderRadius: 7, background: '#F7F9FC',
                  padding: '.4rem .6rem .4rem 2rem', fontSize: '.8rem', color: '#1B2A4A',
                }}
              />
            </div>
          </div>
          <div style={{ maxHeight: 260, overflowY: 'auto', padding: 4 }}>
            <button
              type="button"
              onClick={() => {
                onChange('');
                setOpen(false);
              }}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                background: value === '' ? '#F5A623' : 'transparent',
                color: value === '' ? '#1B2A4A' : '#33415C',
                fontWeight: value === '' ? 600 : 400,
                border: 'none', borderRadius: 6, padding: '.4rem .6rem', fontSize: '.82rem', cursor: 'pointer',
              }}
              onMouseEnter={(e) => { if (value !== '') e.currentTarget.style.background = '#F7F9FC'; }}
              onMouseLeave={(e) => { if (value !== '') e.currentTarget.style.background = 'transparent'; }}
            >
              Tous les fournisseurs
            </button>
            {filtered.length === 0 && (
              <div style={{ padding: '.6rem', fontSize: '.78rem', color: '#9099a8', textAlign: 'center' }}>
                Aucun fournisseur ne correspond à « {query} ».
              </div>
            )}
            {filtered.map((o) => {
              const active = o.value === value;
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left',
                    background: active ? '#F5A623' : 'transparent',
                    color: active ? '#1B2A4A' : '#33415C',
                    fontWeight: active ? 600 : 400,
                    border: 'none', borderRadius: 6, padding: '.4rem .6rem', fontSize: '.82rem', cursor: 'pointer',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}
                  onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = '#F7F9FC'; }}
                  onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
