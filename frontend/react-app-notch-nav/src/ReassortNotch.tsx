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
      style={{ transformOrigin: 'top' }}
      // Une seule ligne, les 7 colonnes (Pilotage/Réassort/IA/Commande/Mail/Utilisateur/Paramètres,
      // cf. navConfig.ts) côte à côte plutôt que sur plusieurs lignes — demande explicite du
      // 26/09/2026 avec exemple de mise en page ("je veux que tout soit sur la même ligne [...] les
      // sous-infos en bas de chaque"). Colonnes plus étroites qu'avant (160px) pour que 7 tiennent
      // sur un écran classique ; overflow-x-auto en secours sur un écran vraiment trop étroit plutôt
      // que de forcer un retour à la ligne qui romprait la mise en page demandée.
      // Pleine largeur collée aux 2 bords de l'écran, fusionnée visuellement avec la bande noire du
      // haut (demande explicite du 26/09/2026, "il faut coller à la barre noire qui est en haut au
      // long à gauche et à droite") — plus un panneau centré flottant sous l'île : fixed inset-x-0
      // top-full plutôt que positionné par rapport à l'île elle-même, pour ignorer sa largeur propre
      // (bien plus étroite que l'écran) et s'étendre d'un bord à l'autre comme la bande du haut.
      // justify-center : les colonnes restent groupées au centre à l'intérieur de cette pleine
      // largeur, jamais étirées jusqu'aux bords elles-mêmes (resterait illisible sur un grand écran).
      // Coins carrés (pas de data-radius/rounded-*) : demande du 26/09/2026, "il faut faire le modale
      // qui s'affiche là en bordure carrée" — seul le mega-menu revient à la règle du site "aucun coin
      // arrondi", l'île compacte au-dessus garde volontairement ses coins arrondis/ailes incurvées.
      // top-[44px] plutôt que top-full : un espace résiduel restait visible malgré pb-1 retiré
      // (commit précédent, insuffisant) — top-full dépend de la hauteur totale du conteneur racine,
      // fragile à toute variation (line-height, rendu du texte tronqué du bouton central...) qui
      // changerait cette hauteur de quelques pixels sans qu'on le remarque. Valeur fixe et explicite
      // à la place : pt-3 (12px) + hauteur de l'île (h-8, 32px) = 44px, les deux seules dimensions qui
      // déterminent réellement où l'île se termine.
      className="absolute inset-x-0 top-[44px] z-50 flex flex-wrap justify-center gap-6 overflow-x-auto bg-zinc-950 p-4 shadow-lg"
    >
      {groups.map((group) => (
        <div key={group.label} className="flex w-[160px] shrink-0 flex-col gap-0.5">
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
                className={cn(
                  'flex w-full cursor-pointer items-start gap-2 px-2.5 py-2 text-left text-sm outline-none transition-colors select-none',
                  isActive ? 'bg-zinc-800 font-semibold text-zinc-50' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200',
                )}
              >
                <Icon className={cn('size-4 shrink-0 mt-0.5', isActive ? 'text-zinc-50' : 'text-zinc-400')} />
                <span className="leading-tight">{entry.label}</span>
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
    // groupe cliqué un par un. pt-3 : espace au-dessus pour que les ailes incurvées (débordent vers
    // le haut, cf. notch-wings.tsx) restent visibles sans être rognées par le conteneur parent —
    // réduit le 26/09/2026 (avec la bande et l'île elle-même) suite à "la barre est trop grosse".
    // sticky top-0 : demande explicite du 26/09/2026 ("quand je scroll il doit rester, pas se fermer
    // [disparaître]") — ce conteneur est monté directement dans <body> (#notch-nav-slot), en dehors
    // du flux de <main class="content"> qui défile, donc position:relative laissait la barre remonter
    // hors écran avec le reste de la page. z-[100] : même valeur que .navbar-top dans
    // theme-override.css, pour rester au-dessus du contenu de page sans dépendre d'un ordre DOM.
    <div
      // onMouseEnter/onMouseLeave posés ici plutôt que sur l'île seule : le mega-menu est maintenant
      // rendu comme FRÈRE de l'île (cf. commentaire plus bas, nécessaire pour qu'il colle pleine
      // largeur à l'écran) — s'ils restaient sur l'île uniquement, déplacer la souris de l'île vers le
      // mega-menu traverserait un onMouseLeave avant même d'atteindre ce dernier, le refermant
      // instantanément. Posés sur ce conteneur qui englobe les deux, le survol reste continu.
      onMouseEnter={openMenu}
      onMouseLeave={scheduleClose}
      // pb-1 retiré (26/09/2026) : le mega-menu pleine largeur (top-full, cf. plus bas) se positionne
      // par rapport à la hauteur TOTALE de ce conteneur, padding inclus — un pb-1 ici décalait donc
      // le mega-menu de 4px sous le bas réel de l'île, recréant l'espace qu'on cherche justement à
      // supprimer. Le padding sert uniquement à faire de la place pour les ailes qui débordent EN
      // BAS de l'île (aucune ici), donc sans utilité réelle — jamais remarqué avant que le mega-menu
      // ne devienne sensible à cette hauteur.
      className="sticky top-0 z-[100] flex w-full items-start justify-center px-2 pt-3"
    >
      {/* Bande pleine largeur derrière l'île, demande explicite du 26/09/2026 ("il faut ajouter une
          barre noire en haut [...] pour ne pas qu'on voie les coins") puis "il y a un espace entre
          la barre noire et notre sidebar en haut, corrige ça" : volontairement plus haute que pt-3
          (déborde légèrement sous le sommet de l'île) pour absorber tout écart résiduel — peu
          importe sa source exacte (line-height, marge d'un ancêtre...), aucun pixel du fond de page
          ne doit rester visible entre le haut de l'écran et l'île. */}
      <div className="absolute inset-x-0 top-0 h-6 bg-zinc-950" />
      <div
        data-radius
        style={radius('0 0 14px 14px')}
        className="relative flex h-8 w-auto max-w-full items-center gap-2.5 rounded-b-2xl bg-zinc-950 px-2.5 text-zinc-50"
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
          className="flex size-6 shrink-0 items-center justify-center rounded-full text-zinc-400 outline-none transition-colors hover:bg-zinc-800 hover:text-zinc-50"
        >
          <PanelLeftOpen className="size-4" />
        </button>

        <div className="h-5 w-px shrink-0 bg-zinc-800" />

        <button
          type="button"
          aria-haspopup="true"
          aria-expanded={isOpen}
          onClick={() => setIsOpen((v) => !v)}
          data-radius
          style={radius('9999px')}
          className="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-3 text-sm font-semibold outline-none transition-colors hover:bg-zinc-900"
        >
          {ActiveIcon && <ActiveIcon className="size-4 shrink-0 text-zinc-300" />}
          <span className="max-w-[220px] truncate leading-none">{activeEntry?.label}</span>
          <ChevronDown className={cn('size-3.5 text-zinc-400 transition-transform duration-200', isOpen && 'rotate-180')} />
        </button>

        <div className="h-5 w-px shrink-0 bg-zinc-800" />

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
              className="relative flex size-6 items-center justify-center rounded-full text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50 outline-none"
            >
              <Bell className="size-4" />
            </button>
            {/* notifications-bell.js cherche `.dropdown-menu` comme frère de #page-header-notifications-dropdown
                et écrit son innerHTML lui-même — laissé vide ici, jamais dupliqué. */}
            <div data-radius style={radius('0.75rem')} className="dropdown-menu absolute right-0 top-full mt-2 hidden w-80 rounded-xl bg-white p-0 text-sm text-zinc-900 shadow-lg" />
          </div>

          <div className="flex items-center gap-2 border-l border-zinc-800 pl-3">
            <span data-radius style={radius('9999px')} className="flex size-5 items-center justify-center rounded-full bg-zinc-800 text-zinc-300">
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
              className="flex size-5 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-800 hover:text-red-400 outline-none"
            >
              <LogOut className="size-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Rendu comme frère de l'île (pas comme enfant) : positionné par rapport au conteneur racine
          sticky ci-dessus (pleine largeur), pas par rapport à l'île elle-même (bien plus étroite) —
          seul moyen pour que "inset-x-0" colle réellement aux 2 bords de l'écran plutôt qu'aux 2
          bords de l'île. */}
      <AnimatePresence>{isOpen && <MegaMenu groups={groups} activeId={activeId} onSelect={navigateTo} />}</AnimatePresence>
    </div>
  );
}
