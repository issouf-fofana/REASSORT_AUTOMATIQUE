import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { Bell, ChevronDown, LogOut, PanelLeftOpen, User as UserIcon } from 'lucide-react';
import { NotchLeftWing, NotchRightWing } from './notch/notch-wings';
import { NAV_GROUPS, activeEntryId, flattenEntries, type NavEntry, type NavGroup } from '../nav/navConfig';
import { useAuth } from '../auth/AuthProvider';
import { cn } from '../lib/utils';

// Portage fidèle de react-app-notch-nav/src/ReassortNotch.tsx (style "île flottante", mega-menu au
// survol) — remplace la version MINIMALE posée au socle du shell (12/10/2026, liste à plat sans
// style, volontairement provisoire) une fois cette seconde barre de navigation réellement utilisée
// par l'utilisateur (signalé le 12/10/2026 : "le style de la notch bare corrige stp"). Adapté au
// shell : navigate() de React Router au lieu de window.location.href (jamais de rechargement
// complet de page pour une navigation interne, l'intérêt même de la fusion SPA), NAV_GROUPS/
// activeEntryId partagés avec <Sidebar/> (jamais une 2e liste de pages à maintenir en parallèle,
// contrairement à l'ancien react-app-notch-nav/src/navConfig.ts, désormais obsolète), useAuth() du
// shell au lieu de window.reassortGetUser() direct.
//
// theme-override.css force border-radius:0 !important partout sur le site ("aucun coin arrondi",
// règle globale documentée) — exception accordée uniquement à cette barre notch (style "île
// flottante"), via [data-radius] scopé à .reassort-notch-root (règle déjà présente dans
// theme-override.css, chargé par le shell).
function radius(value: string): CSSProperties {
  return { '--radius-override': value } as CSSProperties;
}

// Mega-menu unique ouvert au survol de TOUTE la barre (pas un flyout par groupe) : une colonne par
// section (Pilotage/Réassort/Administration/Paramètres), toutes les pages listées d'un coup.
function MegaMenu({ groups, activeId, onSelect }: { groups: NavGroup[]; activeId: string; onSelect: (entry: NavEntry) => void }) {
  return (
    <motion.div
      role="menu"
      aria-label="Navigation"
      initial={{ opacity: 0, y: -6, scaleY: 0.96 }}
      animate={{ opacity: 1, y: 0, scaleY: 1 }}
      exit={{ opacity: 0, y: -6, scaleY: 0.96 }}
      transition={{ type: 'spring' as const, stiffness: 420, damping: 32 }}
      style={{ transformOrigin: 'top' }}
      className="absolute inset-x-0 top-[32px] z-50 flex flex-wrap justify-center gap-6 overflow-x-auto bg-[#1B2A4A] p-4 shadow-lg"
    >
      {groups.map((group) => {
        // Un groupe à plus de 4 entrées (ex: Paramètres, 6 sous-onglets) se répartit sur 2 colonnes
        // internes plutôt qu'une liste verticale longue.
        const useTwoCols = group.entries.length > 4;
        return (
          <div key={group.label} className={cn('flex shrink-0 flex-col gap-0.5', useTwoCols ? 'w-[300px]' : 'w-[160px]')}>
            <div className="px-2.5 pb-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500">{group.label}</div>
            <div className={useTwoCols ? 'grid grid-cols-2 gap-x-2 gap-y-0.5' : 'flex flex-col gap-0.5'}>
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
                      'flex w-full cursor-pointer items-start gap-2 px-2.5 py-2 text-left text-sm outline-none transition-colors select-none',
                      isActive ? 'bg-[#2A3E66] font-semibold text-zinc-50' : 'text-zinc-400 hover:bg-[#24355A] hover:text-zinc-200',
                    )}
                  >
                    <Icon className={cn('size-4 shrink-0 mt-0.5', isActive ? 'text-zinc-50' : 'text-zinc-400')} />
                    <span className="leading-tight">{entry.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </motion.div>
  );
}

export function NotchNav({ onToggleNav }: { onToggleNav: () => void }) {
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const isAdmin = user?.role === 'ADMIN';

  const groups = useMemo(
    () => NAV_GROUPS.map((g) => ({ ...g, entries: g.entries.filter((e) => !e.adminOnly || isAdmin) })).filter((g) => g.entries.length > 0),
    [isAdmin],
  );
  const entries = useMemo(() => flattenEntries(groups), [groups]);
  const activeId = activeEntryId(groups, location.pathname, location.hash);
  const activeEntry = entries.find((e) => e.id === activeId) ?? entries[0];
  const ActiveIcon = activeEntry?.icon;

  const [isOpen, setIsOpen] = useState(false);
  const closeTimer = useRef<number | null>(null);

  // Même rattrapage que l'ancienne topbar Volt (cf. layout.js) : global-shop-selector.js tente son
  // premier rendu avant que ce composant ne soit monté, donc avant que #global-shop-selector-btn
  // n'existe — on le redéclenche une fois que ce bouton existe réellement dans le DOM.
  useEffect(() => {
    window.reassortRenderShopSelector?.();
  }, []);

  // Petit délai à la sortie de la souris (pas à l'entrée) : passer du bouton central au mega-menu
  // juste en dessous traverse un pixel de vide sans lui, qui referme le menu avant même d'y arriver.
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
    navigate(entry.href);
  }

  return (
    // Île noire compacte et centrée (logo | page active | actions), sticky pour rester visible au
    // scroll (montée hors du flux de <main class="content"> qui défile).
    //
    // id="notch-nav-slot" : global-shop-selector.js détecte le mode notch via
    // btn.closest('#notch-nav-slot') (jamais une prop/classe) pour afficher la seule référence du
    // magasin plutôt que "NOM (référence)" (trop long pour cette barre compacte) — sans cet id,
    // le bouton affichait le nom complet comme en mode sidebar classique (bug signalé le
    // 12/10/2026, capture utilisateur : "CASH IVOIRE..." au lieu du numéro de magasin).
    <div
      id="notch-nav-slot"
      onMouseEnter={openMenu}
      onMouseLeave={scheduleClose}
      className="reassort-notch-root sticky top-0 z-[100] flex w-full items-start justify-center px-2"
    >
      {/* Bande pleine largeur derrière l'île : masque le fond de la page sur les côtés de l'île
          (bien plus étroite que l'écran), crée l'effet "encoche iPhone" avec les coins arrondis de
          l'île qui dépassent sous la bande. */}
      <div className="absolute inset-x-0 top-0 h-6 bg-[#1B2A4A]" />
      <div
        data-radius
        style={radius('0 0 14px 14px')}
        className="relative flex h-8 w-auto max-w-full items-center gap-2.5 rounded-b-2xl bg-[#1B2A4A] px-2.5 text-zinc-50"
      >
        <NotchLeftWing />
        <NotchRightWing />

        <img src="/assets/images/logo-reassort.png" alt="Réassort Automatique" className="hidden h-5 w-auto shrink-0 sm:block" />
        <button
          type="button"
          onClick={onToggleNav}
          aria-label="Afficher le menu latéral"
          title="Afficher le menu latéral"
          data-radius
          style={radius('9999px')}
          className="flex size-6 shrink-0 items-center justify-center rounded-full text-zinc-400 outline-none transition-colors hover:bg-[#2A3E66] hover:text-zinc-50"
        >
          <PanelLeftOpen className="size-4" />
        </button>

        <div className="h-5 w-px shrink-0 bg-[#2A3E66]" />

        <button
          type="button"
          aria-haspopup="true"
          aria-expanded={isOpen}
          onClick={() => setIsOpen((v) => !v)}
          data-radius
          style={radius('9999px')}
          className="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-3 text-sm font-semibold outline-none transition-colors hover:bg-[#2A3E66]"
        >
          {ActiveIcon && <ActiveIcon className="size-4 shrink-0 text-zinc-300" />}
          <span className="max-w-[220px] truncate leading-none">{activeEntry?.label}</span>
          <ChevronDown className={cn('size-3.5 text-zinc-400 transition-transform duration-200', isOpen && 'rotate-180')} />
        </button>

        <div className="h-5 w-px shrink-0 bg-[#2A3E66]" />

        {/* Magasin (global-shop-selector.js), utilisateur/déconnexion — même id que topbar.html pour
            que ce script existant continue de fonctionner sans modification. Cloche de notification
            volontairement OMISE ici (contrairement à l'original) : notifications-bell.js cherche
            #page-header-notifications-dropdown sur DOMContentLoaded, déjà passé au moment où React
            monte ce composant dans le shell — jamais de rattrapage prévu dans ce script contrairement
            à global-shop-selector.js (reassortRenderShopSelector), donc resterait inerte si ajouté
            tel quel ; la Topbar classique du shell n'a pas non plus de cloche fonctionnelle
            actuellement, pas une régression propre à ce composant. */}
        <div className="flex shrink-0 items-center gap-3">
          <div className="flex flex-col items-end leading-tight max-w-[160px]">
            <div id="page-shop-context" style={{ display: 'none' }} className="text-[11px] text-zinc-400 truncate max-w-[160px]" />
            <button type="button" id="global-shop-selector-btn" style={{ display: 'none' }} className="text-xs font-medium text-zinc-300 hover:text-zinc-50 truncate max-w-[160px]" />
          </div>

          <div className="relative">
            <button
              type="button"
              aria-haspopup="true"
              aria-expanded="false"
              disabled
              title="Notifications (bientôt disponible dans ce mode)"
              data-radius
              style={radius('9999px')}
              className="relative flex size-6 items-center justify-center rounded-full text-zinc-500 outline-none cursor-default"
            >
              <Bell className="size-4" />
            </button>
          </div>

          <div className="flex items-center gap-2 border-l border-[#2A3E66] pl-3">
            <span data-radius style={radius('9999px')} className="flex size-5 items-center justify-center rounded-full bg-[#2A3E66] text-zinc-300">
              <UserIcon className="size-3.5" />
            </span>
            <span className="hidden lg:inline text-xs font-semibold text-zinc-200 max-w-[90px] truncate">
              {user?.name || 'Mon compte'}
            </span>
            <button
              type="button"
              onClick={logout}
              aria-label="Déconnexion"
              title="Déconnexion"
              data-radius
              style={radius('9999px')}
              className="flex size-5 items-center justify-center rounded-full text-zinc-400 hover:bg-[#2A3E66] hover:text-red-400 outline-none"
            >
              <LogOut className="size-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Rendu comme frère de l'île (pas comme enfant) : positionné par rapport au conteneur racine
          sticky ci-dessus (pleine largeur), pas par rapport à l'île elle-même (bien plus étroite). */}
      <AnimatePresence>{isOpen && <MegaMenu groups={groups} activeId={activeId} onSelect={navigateTo} />}</AnimatePresence>
    </div>
  );
}
