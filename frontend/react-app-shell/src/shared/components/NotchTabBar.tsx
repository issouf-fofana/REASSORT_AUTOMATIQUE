import { motion } from 'motion/react';
import { cn } from '../lib/utils';

// Copié depuis react-app-project-guide/src/components/ui/NotchTabBar.tsx (lui-même copié depuis
// react-app/src/components/ui/NotchTabBar.tsx, Paramètres) — barre d'onglets "pilule" animée
// partagée par plusieurs pages (Paramètres, Qualité IA, Guide du projet...). Utilise <iconify-icon>
// (string), pas lucide-react, pour rester cohérent avec le reste du site.
export interface NotchTab {
  id: string;
  label: string;
  icon?: string;
}

export interface NotchTabBarProps {
  tabs: readonly NotchTab[];
  activeId: string;
  onActiveChange: (id: string) => void;
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
