import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Bell, ChevronDown, LogOut, PanelLeftOpen, User as UserIcon } from 'lucide-react';
import { NotchLeftWing, NotchRightWing } from './components/ui/notch-wings';
import { NAV_GROUPS, activeEntryId, flattenEntries, type NavEntry, type NavGroup } from './navConfig';
import { cn } from '@/lib/utils';

// theme-override.css force border-radius:0 !important partout sur le site ("aucun coin arrondi",
// règle globale documentée) — exception accordée le 26/09/2026 uniquement à cette barre notch
// (style "île flottante" demandé explicitement), via [data-radius] scopé à .reassort-notch-root.
// Le composant reste l'unique source de vérité sur la valeur d'arrondi de chaque élément : la classe
// Tailwind rounded-* documente l'intention dans le JSX, ce style porte la valeur RÉELLEMENT
// appliquée (Tailwind seul ne suffit pas ici, cf. commentaire CSS).
function radius(value: string): CSSProperties {
  return { '--radius-override': value } as CSSProperties;
}

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

// Mega-menu unique ouvert au survol de TOUTE la barre (pas un flyout par groupe) — demande explicite
// du 26/09/2026 avec exemple fourni : une colonne par section de la sidebar (Pilotage/Réassort/
// Administration...), toutes les pages listées d'un coup plutôt que devoir survoler chaque groupe un
// par un.
function MegaMenu({ groups, activeId, onSelect }: { groups: NavGroup[]; activeId: string; onSelect: (entry: NavEntry) => void }) {
  return (
    <motion.div
      role="menu"
      aria-label="Navigation"
      initial={{ opacity: 0, y: -6, scaleY: 0.96 }}
      animate={{ opacity: 1, y: 0, scaleY: 1 }}
      exit={{ opacity: 0, y: -6, scaleY: 0.96 }}
      transition={{ type: 'spring', stiffness: 420, damping: 32 }}
      style={{ transformOrigin: 'top', ...radius('1.25rem') }}
      data-radius
      className="absolute left-1/2 top-full z-50 mt-2 flex w-max max-w-[min(90vw,880px)] -translate-x-1/2 gap-6 rounded-2xl bg-zinc-950 p-4 shadow-lg"
    >
      {groups.map((group) => (
        <div key={group.label} className="flex min-w-[180px] flex-1 flex-col gap-0.5">
          <div className="px-2.5 pb-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500">{group.label}</div>
          {group.entries.map((entry) => {
            const Icon = entry.icon;
            const isActive = entry.id === activeId;
            return (
              <button
                key={entry.id}
                type="button"
                role="menuitem"
                onClick={() => onSelect(entry)}
                data-radius
                style={radius('0.75rem')}
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
        </div>
      ))}
    </motion.div>
  );
}

export function ReassortNotch() {
  const [user] = useState<ReassortUser | null>(() => (window.reassortGetUser ? window.reassortGetUser() : null));
  const isAdmin = user?.role === 'ADMIN';

  const groups = useMemo(
    () => NAV_GROUPS.map((g) => ({ ...g, entries: g.entries.filter((e) => !e.adminOnly || isAdmin) })).filter((g) => g.entries.length > 0),
    [isAdmin],
  );
  const entries = useMemo(() => flattenEntries(groups), [groups]);

  const [activeId, setActiveId] = useState(() => activeEntryId(groups));
  const [isOpen, setIsOpen] = useState(false);
  const closeTimer = useRef<number | null>(null);

  const activeEntry = entries.find((e) => e.id === activeId) ?? entries[0];
  const ActiveIcon = activeEntry?.icon;

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

  // Petit délai à la sortie de la souris (pas à l'entrée) : passer du bouton central au mega-menu
  // juste en dessous traverse un pixel de vide sans lui, qui referme le menu avant même d'y arriver.
  // Jamais de délai à l'ouverture, cf. demande explicite "quand je met le curseur dessus".
  function openMenu() {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    setIsOpen(true);
  }
  function scheduleClose() {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setIsOpen(false), 150);
  }

  function navigateTo(entry: NavEntry) {
    setIsOpen(false);
    window.location.href = entry.href;
  }

  return (
    // Une seule île noire compacte et centrée (logo | page active | actions), pas étalée en largeur
    // — demande explicite du 26/09/2026 avec capture de référence ("comme le haut d'écran de
    // l'iPhone X", "il faut être affiché en largeur et non en longueur"). Le survol de TOUTE la
    // barre ouvre un mega-menu listant toutes les pages en colonnes par section, pas un flyout par
    // groupe cliqué un par un. pt-4 : espace au-dessus pour que les ailes incurvées (débordent vers
    // le haut, cf. notch-wings.tsx) restent visibles sans être rognées par le conteneur parent.
    <div className="relative flex w-full items-start justify-center px-2 pt-4 pb-1">
      <div
        onMouseEnter={openMenu}
        onMouseLeave={scheduleClose}
        data-radius
        style={radius('0 0 24px 24px')}
        className="relative flex h-11 w-auto max-w-full items-center gap-3 rounded-b-3xl bg-zinc-950 px-3 text-zinc-50"
      >
        <NotchLeftWing />
        <NotchRightWing />

        {/* Logo (marque, pas de bouton) — le nom de la page active + chevron est le seul déclencheur
            du mega-menu, cf. capture de référence "Acme | Dashboard ⌄ | Sign out". Bouton séparé pour
            rouvrir la sidebar complète : seul chemin de retour à l'ÉTAT 1, cf. règle absolue "jamais
            les deux ensemble" — gardé même dans ce style, juste déplacé à côté du logo. */}
        <img src="/assets/images/logo-reassort.png" alt="Réassort Automatique" className="hidden h-5 w-auto shrink-0 sm:block" />
        <button
          type="button"
          onClick={() => window.reassortExpandSidebar?.()}
          aria-label="Afficher le menu latéral"
          title="Afficher le menu latéral"
          data-radius
          style={radius('9999px')}
          className="flex size-7 shrink-0 items-center justify-center rounded-full text-zinc-400 outline-none transition-colors hover:bg-zinc-800 hover:text-zinc-50"
        >
          <PanelLeftOpen className="size-4" />
        </button>

        <div className="h-6 w-px shrink-0 bg-zinc-800" />

        <button
          type="button"
          aria-haspopup="true"
          aria-expanded={isOpen}
          onClick={() => setIsOpen((v) => !v)}
          data-radius
          style={radius('9999px')}
          className="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-3 text-sm font-semibold outline-none transition-colors hover:bg-zinc-900"
        >
          {ActiveIcon && <ActiveIcon className="size-4 shrink-0 text-zinc-300" />}
          <span className="max-w-[160px] truncate leading-none">{activeEntry?.label}</span>
          <ChevronDown className={cn('size-3.5 text-zinc-400 transition-transform duration-200', isOpen && 'rotate-180')} />
        </button>

        <AnimatePresence>{isOpen && <MegaMenu groups={groups} activeId={activeId} onSelect={navigateTo} />}</AnimatePresence>

        <div className="h-6 w-px shrink-0 bg-zinc-800" />

        {/* Magasin (global-shop-selector.js), notifications (notifications-bell.js), utilisateur/
            déconnexion — mêmes IDs que topbar.html pour que ces scripts existants continuent de
            fonctionner sans modification (contrat DOM inchangé, juste son enrobage visuel qui
            change). */}
        <div className="flex shrink-0 items-center gap-3">
          <div className="hidden flex-col items-end leading-tight md:flex max-w-[160px]">
            <div id="page-shop-context" className="hidden text-[11px] text-zinc-400 truncate max-w-[160px]" />
            <button type="button" id="global-shop-selector-btn" className="hidden text-xs font-medium text-zinc-300 hover:text-zinc-50 truncate max-w-[160px]" />
          </div>

          <div className="relative">
            <button
              type="button"
              id="page-header-notifications-dropdown"
              aria-haspopup="true"
              aria-expanded="false"
              data-radius
              style={radius('9999px')}
              className="relative flex size-7 items-center justify-center rounded-full text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50 outline-none"
            >
              <Bell className="size-4" />
            </button>
            {/* notifications-bell.js cherche `.dropdown-menu` comme frère de #page-header-notifications-dropdown
                et écrit son innerHTML lui-même — laissé vide ici, jamais dupliqué. */}
            <div data-radius style={radius('0.75rem')} className="dropdown-menu absolute right-0 top-full mt-2 hidden w-80 rounded-xl bg-white p-0 text-sm text-zinc-900 shadow-lg" />
          </div>

          <div className="flex items-center gap-2 border-l border-zinc-800 pl-3">
            <span data-radius style={radius('9999px')} className="flex size-6 items-center justify-center rounded-full bg-zinc-800 text-zinc-300">
              <UserIcon className="size-3.5" />
            </span>
            <span id="user-menu-name" className="hidden lg:inline text-xs font-semibold text-zinc-200 max-w-[90px] truncate">
              {user?.name || 'Mon compte'}
            </span>
            <button
              type="button"
              onClick={() => window.reassortLogout?.()}
              aria-label="Déconnexion"
              title="Déconnexion"
              data-radius
              style={radius('9999px')}
              className="flex size-6 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-800 hover:text-red-400 outline-none"
            >
              <LogOut className="size-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
