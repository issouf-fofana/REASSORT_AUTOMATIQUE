import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Bell, ChevronDown, LogOut, User as UserIcon } from 'lucide-react';
import { NAV_GROUPS, activeEntryId, flattenEntries, type NavEntry } from './navConfig';
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
  }
}

// Menu déroulant plein (tous les groupes, pas juste les items du notch central) : ouvert au clic
// sur l'entrée active du notch, reproduit la hiérarchie Pilotage/Réassort/Administration de
// sidebar.html — jamais un simple <select> plat, pour garder les mêmes repères visuels que
// l'ancienne sidebar malgré le nouveau format horizontal.
function NavMenu({
  entries,
  activeId,
  onSelect,
  groupLabels,
}: {
  entries: NavEntry[];
  activeId: string;
  onSelect: (entry: NavEntry) => void;
  groupLabels: Map<string, string>;
}) {
  let lastGroup = '';
  return (
    <div className="flex w-full flex-col gap-0.5 px-0.5 py-1.5 max-h-[70vh] overflow-y-auto">
      {entries.map((entry) => {
        const group = groupLabels.get(entry.id) ?? '';
        const showGroupHeading = group !== lastGroup;
        lastGroup = group;
        const Icon = entry.icon;
        const isActive = entry.id === activeId;
        return (
          <div key={entry.id}>
            {showGroupHeading && (
              <div className="px-3 pt-2 pb-1 text-[10px] font-bold uppercase tracking-wider text-zinc-500">{group}</div>
            )}
            <button
              type="button"
              role="option"
              aria-selected={isActive}
              onClick={() => onSelect(entry)}
              className={cn(
                'flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm outline-none transition-colors select-none',
                'focus-visible:ring-2 focus-visible:ring-zinc-400',
                isActive
                  ? 'bg-zinc-800 font-semibold text-zinc-50'
                  : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200 active:bg-zinc-800',
              )}
            >
              <Icon className={cn('size-4 shrink-0', isActive ? 'text-zinc-50' : 'text-zinc-400')} />
              <span>{entry.label}</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function ReassortNotch() {
  const [user] = useState<ReassortUser | null>(() => (window.reassortGetUser ? window.reassortGetUser() : null));
  const isAdmin = user?.role === 'ADMIN';

  const groups = useMemo(
    () => NAV_GROUPS.map((g) => ({ ...g, entries: g.entries.filter((e) => !e.adminOnly || isAdmin) })),
    [isAdmin],
  );
  const entries = useMemo(() => flattenEntries(groups), [groups]);
  const groupLabels = useMemo(() => {
    const map = new Map<string, string>();
    groups.forEach((g) => g.entries.forEach((e) => map.set(e.id, g.label)));
    return map;
  }, [groups]);

  const [activeId, setActiveId] = useState(() => activeEntryId(groups));
  const [menuOpen, setMenuOpen] = useState(false);

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

  // global-shop-selector.js s'exécute et tente son premier rendu AVANT que ce composant ne soit
  // monté (chargé en <head>, cf. son propre commentaire) : son tout premier appel à renderButton()
  // échoue donc silencieusement (#global-shop-selector-btn/#page-shop-context n'existent pas
  // encore). L'ancien layout.js le rappelait explicitement une fois la topbar injectée (XHR
  // synchrone) — ce composant reprend exactement ce rôle, une fois que #global-shop-selector-btn
  // existe réellement dans le DOM (juste après ce premier rendu).
  useEffect(() => {
    window.reassortRenderShopSelector?.();
  }, []);

  function navigateTo(entry: NavEntry) {
    setMenuOpen(false);
    window.location.href = entry.href;
  }

  const activeEntry = entries.find((e) => e.id === activeId) ?? entries[0];
  const ActiveIcon = activeEntry?.icon;

  return (
    <div className="reassort-notch flex w-full items-start justify-center gap-2 px-3 pt-2">
      {/* Logo — reproduit assets/images/logo-reassort.png de sidebar.html, dans son propre notch. */}
      <div className="hidden lg:flex h-11 shrink-0 items-center gap-2 rounded-b-[24px] bg-zinc-950 px-4 text-zinc-50">
        <img src="/assets/images/logo-reassort.png" alt="Réassort Automatique" className="h-6 w-auto" />
      </div>

      {/* Notch central : entrée active + menu déroulant complet (tous groupes), ouvert au clic —
          jamais seulement au survol (cf. consigne accessibilité : le hover ne doit pas être le seul
          moyen d'accès). */}
      <div className="relative">
        <button
          type="button"
          aria-expanded={menuOpen}
          aria-haspopup="listbox"
          aria-current="page"
          onClick={() => setMenuOpen((v) => !v)}
          className="flex h-11 items-center gap-2 rounded-b-[24px] bg-zinc-950 px-4 text-sm font-semibold text-zinc-50 outline-none transition-colors hover:bg-zinc-900 focus-visible:ring-2 focus-visible:ring-zinc-400"
        >
          {ActiveIcon && <ActiveIcon className="size-4 shrink-0 text-zinc-300" />}
          <span id="page-title" className="leading-none">
            {activeEntry?.label}
          </span>
          <ChevronDown className={cn('size-3.5 text-zinc-400 transition-transform duration-200', menuOpen && 'rotate-180')} />
        </button>

        <AnimatePresence>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} aria-hidden="true" />
              <motion.div
                role="listbox"
                aria-label="Navigation"
                initial={{ opacity: 0, y: -6, scaleY: 0.96 }}
                animate={{ opacity: 1, y: 0, scaleY: 1 }}
                exit={{ opacity: 0, y: -6, scaleY: 0.96 }}
                transition={{ type: 'spring', stiffness: 420, damping: 32 }}
                style={{ transformOrigin: 'top' }}
                className="absolute left-1/2 top-full z-50 mt-1 w-72 -translate-x-1/2 rounded-2xl bg-zinc-950 shadow-lg"
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setMenuOpen(false);
                }}
              >
                <NavMenu entries={entries} activeId={activeId} onSelect={navigateTo} groupLabels={groupLabels} />
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </div>

      {/* Actions à droite : magasin (global-shop-selector.js), notifications (notifications-bell.js),
          utilisateur/déconnexion — mêmes IDs que topbar.html pour que ces scripts existants
          continuent de fonctionner sans modification (contrat DOM inchangé, juste son enrobage
          visuel qui change). */}
      <div className="hidden md:flex h-11 shrink-0 items-center gap-3 rounded-b-[24px] bg-zinc-950 px-4 text-zinc-50">
        <div className="flex flex-col items-end leading-tight max-w-[220px]">
          <div id="page-shop-context" className="hidden text-[11px] text-zinc-400 truncate max-w-[220px]" />
          <button type="button" id="global-shop-selector-btn" className="hidden text-xs font-medium text-zinc-300 hover:text-zinc-50 truncate max-w-[220px]" />
        </div>

        <div className="relative">
          <button
            type="button"
            id="page-header-notifications-dropdown"
            aria-haspopup="true"
            aria-expanded="false"
            className="relative flex size-8 items-center justify-center rounded-full text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50 outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
          >
            <Bell className="size-4" />
          </button>
          {/* notifications-bell.js cherche `.dropdown-menu` comme frère de #page-header-notifications-dropdown
              et écrit son innerHTML lui-même — laissé vide ici, jamais dupliqué. Ouverture/fermeture
              gérées par ce même script (data-bs-toggle Bootstrap n'existe plus ici : à défaut, un
              clic simple bascule une classe .show, reproduit dans notch.css). */}
          <div className="dropdown-menu absolute right-0 top-full mt-2 hidden w-80 rounded-xl bg-white p-0 text-sm text-zinc-900 shadow-lg" />
        </div>

        <div className="flex items-center gap-2 border-l border-zinc-800 pl-3">
          <span className="flex size-7 items-center justify-center rounded-full bg-zinc-800 text-zinc-300">
            <UserIcon className="size-4" />
          </span>
          <span id="user-menu-name" className="hidden lg:inline text-xs font-semibold text-zinc-200 max-w-[120px] truncate">
            {user?.name || 'Mon compte'}
          </span>
          <button
            type="button"
            onClick={() => window.reassortLogout?.()}
            aria-label="Déconnexion"
            title="Déconnexion"
            className="flex size-7 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-800 hover:text-red-400 outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
          >
            <LogOut className="size-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
