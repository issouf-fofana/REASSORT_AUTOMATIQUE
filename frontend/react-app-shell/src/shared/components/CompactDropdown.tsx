import { useEffect, useRef, useState } from 'react';

export interface CompactDropdownOption {
  value: string;
  label: string;
  sublabel?: string;
}

// Remplace un <select> natif par un menu déroulant React compact (demande du 13/10/2026, signalée
// avec capture sur le sélecteur "Génération" de /purchase-order : "ce style n'est pas bon... un
// truc plus petit" — le <select> natif y affichait un panneau pleine largeur avec le bleu de
// surbrillance par défaut du navigateur, aucun contrôle possible sur sa taille/ses couleurs via
// CSS). Même mécanique que le menu utilisateur de Topbar.tsx (state React + clic extérieur pour
// fermer), pas data-bs-toggle : un <select> natif n'a de toute façon jamais cette dépendance à
// perdre, contrairement au bug du menu de déconnexion corrigé le 12/10/2026.
export function CompactDropdown({
  value,
  options,
  onChange,
  disabled,
  placeholder = '—',
  minWidth = 220,
}: {
  value: string;
  options: CompactDropdownOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  minWidth?: number;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  const current = options.find((o) => o.value === value);

  return (
    <div ref={rootRef} style={{ position: 'relative', minWidth, flexShrink: 0 }}>
      <button
        type="button"
        className="btn btn-sm"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          background: '#ffffff',
          border: '1px solid #d8dce3',
          borderRadius: 8,
          padding: '.3rem .6rem',
          fontSize: '.82rem',
          color: '#1B2A4A',
          textAlign: 'left',
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
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            zIndex: 1050,
            minWidth: '100%',
            maxHeight: 260,
            overflowY: 'auto',
            background: '#ffffff',
            border: '1px solid #e5e7eb',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(27,42,74,.12)',
            padding: 4,
          }}
        >
          {options.map((o) => {
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
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  background: active ? '#F5A623' : 'transparent',
                  color: active ? '#1B2A4A' : '#33415C',
                  fontWeight: active ? 600 : 400,
                  border: 'none',
                  borderRadius: 6,
                  padding: '.4rem .6rem',
                  fontSize: '.82rem',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
                onMouseEnter={(e) => {
                  if (!active) e.currentTarget.style.background = '#F7F9FC';
                }}
                onMouseLeave={(e) => {
                  if (!active) e.currentTarget.style.background = 'transparent';
                }}
              >
                {o.label}
                {o.sublabel && (
                  <span style={{ display: 'block', fontSize: '.72rem', color: active ? '#1B2A4A' : '#9099a8' }}>
                    {o.sublabel}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
