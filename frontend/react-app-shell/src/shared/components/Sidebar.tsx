import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';
import { NAV_GROUPS, activeEntryId } from '../nav/navConfig';
import { useAuth } from '../auth/AuthProvider';
import { useAppVersion } from '../hooks/useAppVersion';

// Reproduit le markup/visuel de assets/partials/sidebar.html (classes Volt : .sidebar, .nav-link,
// .sidebar-heading...) en composant React — remplace l'injection XHR synchrone de layout.js pour
// les pages migrées dans la SPA. État des groupes repliables en localStorage, MÊME clé de préfixe
// que l'ancien mécanisme (sidebar-collapsed-<group>) pour ne jamais perdre la préférence déjà
// enregistrée par un utilisateur sur les pages non-SPA.
const COLLAPSE_KEY_PREFIX = 'sidebar-collapsed-';

function isGroupCollapsed(group: string): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY_PREFIX + group) !== '0';
  } catch {
    return true;
  }
}

function setGroupCollapsed(group: string, collapsed: boolean): void {
  try {
    localStorage.setItem(COLLAPSE_KEY_PREFIX + group, collapsed ? '1' : '0');
  } catch {
    // État non persistant si le stockage est indisponible — jamais bloquant.
  }
}

// Correspondance libellé de groupe -> clé de collapse, reprise de sidebar.html
// (data-collapse-group="reassort"/"admin") — Pilotage et Paramètres restent toujours visibles.
const COLLAPSIBLE_GROUPS: Record<string, string> = {
  'Réassort': 'reassort',
  'Administration': 'admin',
};

// Pas de data-simplebar ici : [data-simplebar] (volt.css) pose position:fixed + flex-wrap:wrap
// directement sur l'élément, en attendant que simplebar.min.js construise sa structure de wrapper
// divs — jamais chargé dans le shell. Sans ce JS, cette CSS écrase .sidebar (position:fixed;
// overflow-y:auto, qui suffit seule) et vide visuellement la sidebar (bug trouvé le 12/10/2026,
// capture utilisateur : sidebar bleu marine entièrement vide sur /feature-requests et
// /mail-recipients).
//
// Pas de classe "collapse" non plus (12/10/2026, round 2 du même bug visuel — persistait sur TOUTES
// les pages migrées après le fix data-simplebar) : Tailwind génère sa PROPRE classe utilitaire
// .collapse { visibility: collapse } (pensée pour les lignes de <table>), qui entre en collision
// directe avec la classe .collapse de Bootstrap/Volt (display:none tant que .show n'est pas posé).
// Les deux coexistent dans le bundle du shell (contrairement aux 19 apps isolées, jamais de
// Tailwind là où Volt est utilisé) — confirmé via `grep .collapse` sur le CSS compilé
// (`.collapse{visibility:collapse}`, la règle Tailwind, pas celle de Volt). Sans conséquence ici :
// .collapse sans son JS Bootstrap (jamais chargé dans le shell, cf. Topbar.tsx) ne pilotait de
// toute façon aucun comportement réel — d-lg-block (display:block !important) suffit seul à garder
// la sidebar visible.
export function Sidebar() {
  const { user } = useAuth();
  const location = useLocation();
  const activeId = activeEntryId(NAV_GROUPS, location.pathname, location.hash);
  const [, forceRender] = useState(0);
  const appVersion = useAppVersion();

  const isAdmin = user?.role === 'ADMIN';

  function toggleGroup(group: string) {
    setGroupCollapsed(group, !isGroupCollapsed(group));
    forceRender((n) => n + 1);
  }

  // Déplie automatiquement le groupe contenant la page active si jamais il était replié — reprend
  // isCurrentPage de initCollapsibleSidebarSections (layout-collapsible.js) : sans ça, un groupe
  // replié par défaut (reassort/admin, cf. COLLAPSE_KEY_PREFIX ci-dessus) reste replié même en
  // arrivant directement sur une de ses pages via un lien externe/un favori, masquant tous ses
  // sous-liens (bug trouvé le 12/10/2026, capture utilisateur sur /settings#tab-files : la sidebar
  // n'affichait ni "Réassort" ni "Administration", groupes jamais dépliés manuellement avant).
  useEffect(() => {
    const activeGroup = NAV_GROUPS.find((g) => g.entries.some((e) => e.id === activeId));
    const collapseKey = activeGroup ? COLLAPSIBLE_GROUPS[activeGroup.label] : undefined;
    if (collapseKey && isGroupCollapsed(collapseKey)) {
      setGroupCollapsed(collapseKey, false);
      forceRender((n) => n + 1);
    }
  }, [activeId]);

  return (
    <nav id="sidebarMenu" className="sidebar d-lg-block bg-gray-800 text-white">
      <div className="sidebar-inner px-4 pt-3">
        <div className="sidebar-brand d-flex flex-column align-items-center justify-content-center py-3">
          <img src="/assets/images/logo-reassort.png" alt="Réassort Automatique" height={40} />
          {/* Lue depuis SystemConfig (useAppVersion, GET /api/app-version) — modifiable depuis
              Paramètres > Réassort (SiteBrandingSection.tsx), jamais codée en dur ni recalculée
              automatiquement (demande explicite du 13/10/2026 : "si je suis sûr que c'est bon je
              met à jour la valeur sur le UI dans les config"). Rien affiché tant que la valeur
              n'est pas encore revenue du serveur, plutôt qu'un flash "v1.0.0" visiblement faux. */}
          {appVersion && <small className="text-white-50 mt-1" style={{ fontSize: '0.7rem' }}>v{appVersion}</small>}
        </div>
        <ul className="nav flex-column pt-3 pt-md-0">
          {NAV_GROUPS.map((group) => {
            const collapseKey = COLLAPSIBLE_GROUPS[group.label];
            const collapsed = collapseKey ? isGroupCollapsed(collapseKey) : false;
            const visibleEntries = group.entries.filter((e) => !e.adminOnly || isAdmin);
            if (!visibleEntries.length) return null;

            return (
              <li key={group.label} style={{ listStyle: 'none' }}>
                <ul className="nav flex-column" style={{ padding: 0 }}>
                  <li
                    className={`sidebar-heading${collapseKey ? ' sidebar-heading-collapsible' : ''}${collapsed ? ' collapsed' : ''} d-flex align-items-center justify-content-between`}
                    onClick={collapseKey ? () => toggleGroup(collapseKey) : undefined}
                    style={collapseKey ? { cursor: 'pointer' } : undefined}
                  >
                    {group.label}
                    {/* Flèche ouvert/fermé ajoutée le 25/10/2026 (demande explicite : "il faut
                        metre fleche si les option son fermer ou pas... on ne sans pas si c'est
                        fermé") — seuls les groupes repliables (Réassort/Administration, cf.
                        COLLAPSIBLE_GROUPS) en ont une ; les autres restent toujours dépliés sans
                        affordance trompeuse. Pointe vers le bas replié (plus à découvrir), vers le
                        haut déplié — même sens que ChevronDown déjà utilisé dans NotchNav.tsx. */}
                    {collapseKey && (
                      <ChevronDown
                        className="icon icon-xs"
                        width={16}
                        height={16}
                        style={{ transition: 'transform .15s', transform: collapsed ? 'rotate(0deg)' : 'rotate(180deg)' }}
                      />
                    )}
                  </li>
                  {(!collapseKey || !collapsed) &&
                    visibleEntries.map((entry) => {
                      const Icon = entry.icon;
                      return (
                        <li className={`nav-item${entry.id === activeId ? ' active' : ''}`} key={entry.id}>
                          {/* La surbrillance ambre (theme-override.css: .sidebar .nav-item.active >
                              .nav-link) cible .nav-item.active, PAS .nav-link.active — classe posée
                              au mauvais endroit depuis la création de ce composant (bug signalé le
                              12/10/2026 : "il faut qu'il soit en surbrillance jaune... comme avant"),
                              jamais remarqué car le lien restait quand même visuellement
                              identifiable par sa position dans le menu. */}
                          <Link
                            to={entry.href}
                            className="nav-link d-flex align-items-center"
                          >
                            <span className="sidebar-icon">
                              {/* 20px = 1.25rem, exactement la valeur que .icon.icon-xs (volt.css)
                                  fixe en CSS pour `height` SEUL (jamais `width`) — un vrai <svg>
                                  d'origine suit son ratio naturel sans largeur fixée, mais
                                  lucide-react pose toujours width/height=24 par défaut sinon, ce qui
                                  écrase la largeur réelle et casse le ratio/l'alignement (bug visuel
                                  trouvé le 12/10/2026). Carré 20x20 explicite plutôt que "1em"
                                  (dépendrait du font-size hérité, non garanti égal à 1.25rem ici). */}
                              <Icon className="icon icon-xs me-2" width={20} height={20} />
                            </span>
                            <span className="sidebar-text" title={entry.label}>{entry.label}</span>
                          </Link>
                        </li>
                      );
                    })}
                </ul>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
