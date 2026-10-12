import { Link, useLocation } from 'react-router-dom';
import { PanelLeftOpen } from 'lucide-react';
import { NAV_GROUPS, activeEntryId } from '../nav/navConfig';
import { useAuth } from '../auth/AuthProvider';

// Version MINIMALE du second mode de navigation (cf. plan de migration, 12/10/2026, "Deux modes de
// navigation à maintenir" — choix explicite de l'utilisateur de garder sidebar classique ET barre
// notch). Le composant d'origine (react-app-notch-nav/src/ReassortNotch.tsx) a un mega-menu animé
// complexe (framer-motion, colonnes dynamiques, style "île flottante") — volontairement NON porté
// fidèlement à cette étape du socle : l'objectif ici est de valider l'approche de fusion sur UNE
// page simple, pas de refaire le design final de la notch. Cette version liste simplement les
// entrées actives au clic, sans animation ; le vrai portage visuel fidèle est à faire quand une
// page utilisant réellement la notch en production sera migrée (vague 1+).
export function NotchNav({ onToggleNav }: { onToggleNav: () => void }) {
  const { user } = useAuth();
  const location = useLocation();
  const activeId = activeEntryId(NAV_GROUPS, location.pathname, location.hash);
  const isAdmin = user?.role === 'ADMIN';

  return (
    <nav className="reassort-notch-root" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 16px', background: '#1B2A4A', flexWrap: 'wrap' }}>
      {/* Seul chemin de retour vers la sidebar classique depuis la barre notch (reprend
          window.reassortExpandSidebar de layout-collapsible.js) — jamais porté jusqu'ici, bug
          trouvé le 12/10/2026 en même temps que le bouton de bascule manquant côté Topbar. */}
      <button
        type="button"
        onClick={onToggleNav}
        title="Afficher le menu latéral"
        aria-label="Afficher le menu latéral"
        style={{ display: 'flex', alignItems: 'center', background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', padding: 4 }}
      >
        <PanelLeftOpen size={18} />
      </button>
      {NAV_GROUPS.flatMap((g) => g.entries)
        .filter((e) => !e.adminOnly || isAdmin)
        .map((entry) => {
          const Icon = entry.icon;
          return (
            <Link
              key={entry.id}
              to={entry.href}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                color: entry.id === activeId ? '#ff6c2f' : '#fff',
                fontSize: 13,
                textDecoration: 'none',
              }}
            >
              <Icon size={14} />
              {entry.label}
            </Link>
          );
        })}
    </nav>
  );
}
