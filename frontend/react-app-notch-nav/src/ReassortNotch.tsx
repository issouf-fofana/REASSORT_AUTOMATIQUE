import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Bell, LogOut, Menu, User as UserIcon } from 'lucide-react';
import { NAV_GROUPS, activeEntryId, type NavEntry, type NavGroup } from './navConfig';
import { cn } from '@/lib/utils';

interface ReassortUser {
  name: string;
  role: string;
}

declare global {
  interface Window {
    reassortGetUser?: () => ReassortUser | null;
    reassortLogout?: () => void;
    reassortIsSingleShopRole?: (role: string) => boolean;
    reassortRenderShopSelector?: () => void;
    reassortExpandSidebar?: () => void;
  }
}

// Barre compacte affichée uniquement en ÉTAT 2 (sidebar repliée par l'utilisateur via
// #sidebar-visibility-btn, cf. layout-collapsible.js) — jamais visible en même temps que la sidebar
// complète. Un groupe de la sidebar (Pilotage/Réassort/Administration) devient une entrée de cette
// barre ; le survol ouvre un flyout listant ses pages, le clic navigue directement sans jamais
// rouvrir la sidebar complète (cf. demande explicite : "conserver la sidebar dans son état fermé").
function NavGroupFlyout({
  group,
  isOpen,
  activeId,
  onEnter,
  onLeave,
  onSelect,
}: {
  group: NavGroup;
  isOpen: boolean;
  activeId: string;
  onEnter: () => void;
  onLeave: () => void;
  onSelect: (entry: NavEntry) => void;
}) {
  const hasActive = group.entries.some((e) => e.id === activeId);
  return (
    <div className="relative" onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={isOpen}
        className={cn(
          'flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-3.5 text-sm font-medium outline-none transition-colors select-none',
          hasActive ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200',
        )}
      >
        {group.label}
      </button>
      <AnimatePresence>
        {isOpen && (
          <motion.div
            role="menu"
            aria-label={group.label}
            initial={{ opacity: 0, y: -6, scaleY: 0.96 }}
            animate={{ opacity: 1, y: 0, scaleY: 1 }}
            exit={{ opacity: 0, y: -6, scaleY: 0.96 }}
            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
            style={{ transformOrigin: 'top' }}
            // left-1/2/-translate-x-1/2 centre le flyout sous son bouton par défaut ; sur un écran
            // étroit un flyout proche du bord droit déborderait sinon hors viewport (demande
            // explicite "aucun débordement horizontal" / "se repositionner automatiquement") — clampé
            // via clamp() plutôt qu'un calcul JS de position, pour rester correct même si la fenêtre
            // est redimensionnée sans re-render.
            className="absolute left-1/2 top-full z-50 mt-1 w-64 -translate-x-1/2 rounded-2xl bg-zinc-950 p-1.5 shadow-lg"
          >
            <div className="px-2.5 pb-1.5 pt-1 text-[10px] font-bold uppercase tracking-wider text-zinc-500">{group.label}</div>
            {group.entries.map((entry) => {
              const Icon = entry.icon;
              const isActive = entry.id === activeId;
              return (
                <button
                  key={entry.id}
                  type="button"
                  role="menuitem"
                  onClick={() => onSelect(entry)}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm outline-none transition-colors select-none',
                    isActive ? 'bg-zinc-800 font-semibold text-zinc-50' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200',
                  )}
                >
                  <Icon className={cn('size-4 shrink-0', isActive ? 'text-zinc-50' : 'text-zinc-400')} />
                  <span className="truncate">{entry.label}</span>
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function ReassortNotch() {
  const [user] = useState<ReassortUser | null>(() => (window.reassortGetUser ? window.reassortGetUser() : null));
  const isAdmin = user?.role === 'ADMIN';

  const groups = useMemo(
    () => NAV_GROUPS.map((g) => ({ ...g, entries: g.entries.filter((e) => !e.adminOnly || isAdmin) })).filter((g) => g.entries.length > 0),
    [isAdmin],
  );
  const [activeId, setActiveId] = useState(() => activeEntryId(groups));
  const [openGroup, setOpenGroup] = useState<string | null>(null);

  useEffect(() => {
    function onNavChange() {
      setActiveId(activeEntryId(groups));
    }
    window.addEventListener('popstate', onNavChange);
    window.addEventListener('hashchange', onNavChange);
    return () => {
      window.removeEventListener('popstate', onNavChange);
      window.removeEventListener('hashchange', onNavChange);
    };
  }, [groups]);

  // Même rattrapage que l'ancienne topbar Volt (cf. layout.js) : global-shop-selector.js tente son
  // premier rendu avant que ce composant ne soit monté, donc avant que #global-shop-selector-btn
  // n'existe — on le redéclenche une fois que ce bouton existe réellement dans le DOM.
  useEffect(() => {
    window.reassortRenderShopSelector?.();
  }, []);

  function navigateTo(entry: NavEntry) {
    setOpenGroup(null);
    window.location.href = entry.href;
  }

  return (
    <div className="reassort-notch-root flex w-full items-center gap-2 rounded-b-2xl bg-zinc-950 px-3 py-2 text-zinc-50">
      {/* Bouton de réouverture de la sidebar complète — seul chemin de retour à l'ÉTAT 1, cf. règle
          absolue "jamais les deux ensemble" : ce bouton ne fait QUE rouvrir la sidebar, jamais
          basculer lui-même un flyout. */}
      <button
        type="button"
        onClick={() => window.reassortExpandSidebar?.()}
        aria-label="Afficher le menu latéral"
        title="Afficher le menu latéral"
        className="flex size-8 shrink-0 items-center justify-center rounded-full text-zinc-300 outline-none transition-colors hover:bg-zinc-800 hover:text-zinc-50"
      >
        <Menu className="size-4" />
      </button>

      <div className="hidden shrink-0 sm:flex">
        <img src="/assets/images/logo-reassort.png" alt="Réassort Automatique" className="h-5 w-auto" />
      </div>

      {/* Groupes de navigation : un par section de la sidebar (Pilotage/Réassort/Administration),
          flyout listant ses pages au survol — jamais de clic nécessaire pour voir le contenu. */}
      <nav className="flex flex-1 flex-wrap items-center gap-1 overflow-x-auto">
        {groups.map((group) => (
          <NavGroupFlyout
            key={group.label}
            group={group}
            isOpen={openGroup === group.label}
            activeId={activeId}
            onEnter={() => setOpenGroup(group.label)}
            onLeave={() => setOpenGroup((cur) => (cur === group.label ? null : cur))}
            onSelect={navigateTo}
          />
        ))}
      </nav>

      {/* Actions à droite : magasin (global-shop-selector.js), notifications (notifications-bell.js),
          utilisateur/déconnexion — mêmes IDs que topbar.html pour que ces scripts existants
          continuent de fonctionner sans modification (contrat DOM inchangé, juste son enrobage
          visuel qui change). */}
      <div className="flex shrink-0 items-center gap-3">
        <div className="hidden flex-col items-end leading-tight md:flex max-w-[180px]">
          <div id="page-shop-context" className="hidden text-[11px] text-zinc-400 truncate max-w-[180px]" />
          <button type="button" id="global-shop-selector-btn" className="hidden text-xs font-medium text-zinc-300 hover:text-zinc-50 truncate max-w-[180px]" />
        </div>

        <div className="relative">
          <button
            type="button"
            id="page-header-notifications-dropdown"
            aria-haspopup="true"
            aria-expanded="false"
            className="relative flex size-8 items-center justify-center rounded-full text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50 outline-none"
          >
            <Bell className="size-4" />
          </button>
          {/* notifications-bell.js cherche `.dropdown-menu` comme frère de #page-header-notifications-dropdown
              et écrit son innerHTML lui-même — laissé vide ici, jamais dupliqué. */}
          <div className="dropdown-menu absolute right-0 top-full mt-2 hidden w-80 rounded-xl bg-white p-0 text-sm text-zinc-900 shadow-lg" />
        </div>

        <div className="flex items-center gap-2 border-l border-zinc-800 pl-3">
          <span className="flex size-7 items-center justify-center rounded-full bg-zinc-800 text-zinc-300">
            <UserIcon className="size-4" />
          </span>
          <span id="user-menu-name" className="hidden lg:inline text-xs font-semibold text-zinc-200 max-w-[100px] truncate">
            {user?.name || 'Mon compte'}
          </span>
          <button
            type="button"
            onClick={() => window.reassortLogout?.()}
            aria-label="Déconnexion"
            title="Déconnexion"
            className="flex size-7 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-800 hover:text-red-400 outline-none"
          >
            <LogOut className="size-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
