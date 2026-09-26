import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Bell, ChevronDown, LogOut, Menu, User as UserIcon } from 'lucide-react';
import { NotchLeftWing, NotchRightWing } from './components/ui/notch-wings';
import { NAV_GROUPS, activeEntryId, type NavEntry, type NavGroup } from './navConfig';
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

// Barre compacte affichée uniquement en ÉTAT 2 (sidebar repliée par l'utilisateur via
// #sidebar-visibility-btn, cf. layout-collapsible.js) — jamais visible en même temps que la sidebar
// complète. Style à 3 îlots noirs distincts (logo / navigation / actions) avec coins "ailes"
// incurvés reliant chaque îlot, demande explicite du 26/09/2026 reproduisant le composant
// adaptive-notch-navigation-bar fourni par l'utilisateur — un seul bloc uniforme auparavant.
function NavGroupFlyout({
  group,
  isOpen,
  activeId,
  onEnter,
  onLeave,
  onToggleClick,
  onSelect,
}: {
  group: NavGroup;
  isOpen: boolean;
  activeId: string;
  onEnter?: () => void;
  onLeave?: () => void;
  // Mobile (< md) : le survol n'a pas de sens sur tactile, le flyout s'ouvre/se ferme au clic sur le
  // bouton lui-même plutôt qu'au survol du conteneur — jamais les deux mécanismes en même temps sur
  // le même écran (onEnter/onLeave omis quand onToggleClick est fourni).
  onToggleClick?: () => void;
  onSelect: (entry: NavEntry) => void;
}) {
  const hasActive = group.entries.some((e) => e.id === activeId);
  return (
    <div className="relative" onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={isOpen}
        onClick={onToggleClick}
        data-radius
        style={radius('9999px')}
        className={cn(
          'flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-3.5 text-sm font-medium outline-none transition-colors select-none',
          hasActive ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200',
        )}
      >
        {group.label}
        {onToggleClick && <ChevronDown className={cn('size-3.5 transition-transform', isOpen && 'rotate-180')} />}
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
            style={{ transformOrigin: 'top', ...radius('1rem') }}
            data-radius
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
  const activeGroup = groups.find((g) => g.entries.some((e) => e.id === activeId)) ?? groups[0] ?? null;

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
    // Une seule île noire centrée (logo | navigation | actions), pas 3 blocs séparés — demande
    // explicite du 26/09/2026 avec capture de référence ("comme le haut d'écran de l'iPhone X") :
    // la première version à 3 îlots indépendants (justify-between) les écartait aux extrémités de
    // l'écran, laissant un grand vide blanc au centre au lieu d'une seule pilule compacte. pt-4 :
    // espace au-dessus pour que les ailes incurvées (débordent vers le haut, cf. notch-wings.tsx)
    // restent visibles sans être rognées par le conteneur parent.
    <div className="relative flex w-full items-start justify-center px-2 pt-4 pb-1">
      <div
        data-radius
        style={radius('0 0 24px 24px')}
        className="relative flex h-11 w-auto max-w-full items-center gap-1 rounded-b-3xl bg-zinc-950 px-2 text-zinc-50"
      >
        {/* Ailes uniquement sur les 2 bords EXTÉRIEURS de l'île entière, jamais entre les sections
            internes (logo/nav/actions) — sinon on retrouve visuellement 3 îlots séparés. */}
        <NotchLeftWing />
        <NotchRightWing />

        {/* Section logo + bouton de réouverture de la sidebar complète — seul chemin de retour à
            l'ÉTAT 1, cf. règle absolue "jamais les deux ensemble". */}
        <div className="flex shrink-0 items-center gap-2 pr-1">
          <button
            type="button"
            onClick={() => window.reassortExpandSidebar?.()}
            aria-label="Afficher le menu latéral"
            title="Afficher le menu latéral"
            data-radius
            style={radius('9999px')}
            className="flex size-7 shrink-0 items-center justify-center rounded-full text-zinc-300 outline-none transition-colors hover:bg-zinc-800 hover:text-zinc-50"
          >
            <Menu className="size-4" />
          </button>
          <img src="/assets/images/logo-reassort.png" alt="Réassort Automatique" className="hidden h-5 w-auto sm:block" />
        </div>

        <div className="h-6 w-px shrink-0 bg-zinc-800" />

        {/* Groupes de navigation (desktop) : flyout au survol — jamais de clic nécessaire pour voir
            le contenu, cf. demande explicite. */}
        <nav className="hidden items-center gap-1 px-1 md:flex">
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
        {/* Mobile (<md) : pas assez de place pour tous les groupes côte à côte — un seul bouton
            listant le groupe de la page active, ouvert au CLIC (le survol n'a pas de sens sur
            tactile). */}
        {activeGroup && (
          <nav className="flex items-center px-1 md:hidden">
            <NavGroupFlyout
              group={activeGroup}
              isOpen={openGroup === activeGroup.label}
              activeId={activeId}
              onToggleClick={() => setOpenGroup((cur) => (cur === activeGroup.label ? null : activeGroup.label))}
              onSelect={navigateTo}
            />
          </nav>
        )}

        <div className="h-6 w-px shrink-0 bg-zinc-800" />

        {/* Magasin (global-shop-selector.js), notifications (notifications-bell.js), utilisateur/
            déconnexion — mêmes IDs que topbar.html pour que ces scripts existants continuent de
            fonctionner sans modification (contrat DOM inchangé, juste son enrobage visuel qui
            change). */}
        <div className="flex shrink-0 items-center gap-3 pl-1">
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
