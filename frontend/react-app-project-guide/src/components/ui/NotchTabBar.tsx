import { motion } from 'motion/react';
import { cn } from '../../lib/utils';

// Copié depuis react-app/src/components/ui/NotchTabBar.tsx (Paramètres) — demande du 25/09/2026 de
// généraliser cette barre d'onglets "pilule" animée à toutes les pages à onglets du site. Adapté
// pour prendre une icône Iconify (string) plutôt qu'un composant React d'icône : ce projet, comme
// le reste du site, utilise <iconify-icon> partout, jamais lucide-react/heroicons.
export interface NotchTab {
  id: string;
  label: string;
  icon?: string;
}

export interface NotchTabBarProps {
  tabs: readonly NotchTab[];
  activeId: string;
  onActiveChange: (id: string) => void;
  // 'sm' : demande du 26/09/2026 (Guide du projet, libellés bien plus longs que ceux de Paramètres —
  // "Récupération des données (RPOS)" vs "Réassort" — rendant la barre par défaut visuellement trop
  // grosse). Jamais le comportement par défaut de Paramètres, pour rester identique là où ce
  // composant a été validé le 25/09/2026.
  size?: 'md' | 'sm';
}

export function NotchTabBar({ tabs, activeId, onActiveChange, size = 'md' }: NotchTabBarProps) {
  const isSmall = size === 'sm';
  return (
    <div className={cn('reassort-tabs-root relative flex flex-wrap items-center gap-1 bg-zinc-100 rounded-full w-fit', isSmall ? 'p-1' : 'p-1.5')}>
      {tabs.map((tab) => {
        const isActive = activeId === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onActiveChange(tab.id)}
            className={cn(
              'relative z-10 flex cursor-pointer items-center gap-2 rounded-full font-medium transition-colors outline-none select-none',
              isSmall ? 'h-7 px-3 text-xs' : 'h-8 px-4 text-sm',
              isActive ? 'text-zinc-50' : 'text-zinc-500 hover:text-zinc-700',
            )}
          >
            {isActive && (
              <motion.span
                layoutId="notch-tab-active"
                className="absolute inset-0 rounded-full bg-zinc-950"
                transition={{ type: 'spring' as const, stiffness: 400, damping: 30 }}
              />
            )}
            <span className="relative z-10 flex items-center gap-2">
              {tab.icon && <iconify-icon icon={tab.icon} style={{ fontSize: '1.05rem' }}></iconify-icon>}
              <span className="leading-none">{tab.label}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
