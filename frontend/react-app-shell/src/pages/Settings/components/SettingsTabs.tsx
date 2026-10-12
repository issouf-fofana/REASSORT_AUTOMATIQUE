import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';

import { NotchTabBar } from '../../../shared/components/NotchTabBar';
import { ReassortConfigSection } from './ReassortConfigSection';
import { SiteBrandingSection } from './SiteBrandingSection';
import { SalesFilesSection } from './SalesFilesSection';
import { RposSecuritySection } from './RposSecuritySection';
import { SchedulingSection } from './SchedulingSection';
import { SyncSection } from './SyncSection';
import { AiSection } from './AiSection';
import { MailSection } from './MailSection';

// Icônes en chaîne Iconify (solar:*), pas des composants lucide-react : le NotchTabBar partagé
// (shared/components/NotchTabBar.tsx, repris de Guide du projet) prend un prop `icon?: string`,
// pas `React.ComponentType` comme l'ancienne version locale de ce fichier — jamais deux variantes
// de NotchTabBar à maintenir en parallèle dans le shell.
const TABS = [
  { id: 'tab-reassort', label: 'Réassort', icon: 'solar:settings-bold-duotone' },
  { id: 'tab-files', label: 'Fichiers de ventes', icon: 'solar:folder-bold-duotone' },
  { id: 'tab-rpos', label: 'RPOS & Sécurité', icon: 'solar:server-bold-duotone' },
  { id: 'tab-cron', label: 'Planification', icon: 'solar:clock-circle-bold-duotone' },
  { id: 'tab-sync', label: 'Synchronisation', icon: 'solar:refresh-bold-duotone' },
  { id: 'tab-ai', label: 'Config IA', icon: 'solar:magic-stick-3-bold-duotone' },
  { id: 'tab-mail', label: 'Comptes mail', icon: 'solar:letter-bold-duotone' },
] as const;

type TabId = (typeof TABS)[number]['id'];

function tabFromHash(): TabId {
  const hash = window.location.hash.replace('#', '');
  return (TABS.find((t) => t.id === hash)?.id ?? 'tab-reassort') as TabId;
}

/**
 * Barre de navigation en style NotchTabBar (boutons pill avec indicateur actif)
 * remplace la barre d'onglets Bootstrap nav-tabs de l'ancienne page settings.old.html.
 * Le routage par hash (#tab-xxx) reste compatible avec les liens de la sidebar.
 */
export function SettingsTabs() {
  const location = useLocation();
  const [activeTab, setActiveTab] = useState<TabId>(tabFromHash());

  // location.hash (React Router) plutôt que l'event natif hashchange : un <Link to="/settings#..."/>
  // cliqué depuis la sidebar alors qu'on est DÉJÀ sur /settings passe par history.pushState en
  // interne, qui NE DÉCLENCHE PAS hashchange (seule une affectation directe à window.location.hash,
  // ou le bouton précédent/suivant du navigateur, le fait) — bug trouvé le 12/10/2026 : cliquer un
  // sous-lien Paramètres depuis la sidebar changeait l'URL mais jamais l'onglet affiché. location
  // (fournie par React Router, qui re-render ce composant à chaque navigation interne, hash compris)
  // est la source fiable ici, l'event natif reste utile pour le bouton précédent/suivant.
  useEffect(() => {
    setActiveTab(tabFromHash());
  }, [location]);

  function selectTab(id: TabId) {
    window.location.hash = '#' + id;
    setActiveTab(id);
  }

  return (
    <div>
      <style>{`
        /* NotchTabBar (partagée avec Qualité & IA/Guide du projet) en zinc-950 par défaut —
           surchargée ici en ambre/marine (01/10/2026) pour matcher le style de l'onglet actif de
           la sidebar (fond ambre #F5A623, texte/icône marine), signalé différent sur capture.
           Le composant ne porte PAS de classe "reassort-tabs-root" (vérifié dans le DOM rendu) :
           les anciens sélecteurs ci-dessous ne matchaient donc jamais rien, d'où le pill resté
           noir malgré ce bloc — ciblage corrigé sur la vraie structure (bg-zinc-100 + bg-zinc-950). */
        .settings-tabs-wrap .bg-zinc-100 { background-color: #EDF1F7; }
        .settings-tabs-wrap [role="tab"].text-zinc-500 { color: #5B6B85; }
        .settings-tabs-wrap [role="tab"]:hover.text-zinc-500 { color: #1B2A4A; }
        .settings-tabs-wrap .bg-zinc-950 { background-color: #F5A623 !important; }
        .settings-tabs-wrap [role="tab"][aria-selected="true"] { color: #1B2A4A !important; }
        .settings-tabs-wrap [role="tab"][aria-selected="true"] svg { color: #1B2A4A !important; }
      `}</style>
      <div className="mb-6 settings-tabs-wrap">
        <NotchTabBar
          tabs={TABS}
          activeId={activeTab}
          onActiveChange={(id) => selectTab(id as TabId)}
        />
      </div>

      <div className="tab-content">
        {activeTab === 'tab-reassort' && (
          <div className="tab-pane show active">
            <SiteBrandingSection />
            <ReassortConfigSection />
          </div>
        )}
        {activeTab === 'tab-files' && (
          <div className="tab-pane show active">
            <SalesFilesSection />
          </div>
        )}
        {activeTab === 'tab-rpos' && (
          <div className="tab-pane show active">
            <RposSecuritySection />
          </div>
        )}
        {activeTab === 'tab-cron' && (
          <div className="tab-pane show active">
            <SchedulingSection />
          </div>
        )}
        {activeTab === 'tab-sync' && (
          <div className="tab-pane show active">
            <SyncSection />
          </div>
        )}
        {activeTab === 'tab-ai' && (
          <div className="tab-pane show active">
            <AiSection />
          </div>
        )}
        {activeTab === 'tab-mail' && (
          <div className="tab-pane show active">
            <MailSection />
          </div>
        )}
      </div>
    </div>
  );
}
