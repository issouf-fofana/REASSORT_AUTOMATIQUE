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
}

export function NotchTabBar({ tabs, activeId, onActiveChange }: NotchTabBarProps) {
  return (
    <div className="reassort-tabs-root relative flex flex-wrap items-center gap-1 bg-zinc-100 rounded-full p-1.5 w-fit">
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
              'relative z-10 flex h-8 cursor-pointer items-center gap-2 rounded-full px-4 text-sm font-medium transition-colors outline-none select-none',
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
