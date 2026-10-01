import { useEffect, useState } from 'react';
import {
  Settings,
  Folder,
  Server,
  Clock,
  RefreshCw,
  Sparkles,
  Mail,
} from 'lucide-react';

import { NotchTabBar } from '@/components/ui/NotchTabBar';
import { ReassortConfigSection } from './ReassortConfigSection';
import { SiteBrandingSection } from './SiteBrandingSection';
import { SalesFilesSection } from './SalesFilesSection';
import { RposSecuritySection } from './RposSecuritySection';
import { SchedulingSection } from './SchedulingSection';
import { SyncSection } from './SyncSection';
import { AiSection } from './AiSection';
import { MailSection } from './MailSection';

const TABS = [
  { id: 'tab-reassort', label: 'Réassort', icon: Settings },
  { id: 'tab-files', label: 'Fichiers de ventes', icon: Folder },
  { id: 'tab-rpos', label: 'RPOS & Sécurité', icon: Server },
  { id: 'tab-cron', label: 'Planification', icon: Clock },
  { id: 'tab-sync', label: 'Synchronisation', icon: RefreshCw },
  { id: 'tab-ai', label: 'Config IA', icon: Sparkles },
  { id: 'tab-mail', label: 'Comptes mail', icon: Mail },
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
  const [activeTab, setActiveTab] = useState<TabId>(tabFromHash());

  useEffect(() => {
    function onHashChange() {
      setActiveTab(tabFromHash());
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  function selectTab(id: TabId) {
    window.location.hash = '#' + id;
    setActiveTab(id);
  }

  return (
    <div>
      <style>{`
        /* NotchTabBar (partagée avec Qualité & IA/Guide du projet) en zinc-950 par défaut —
           surchargée ici en marine/ambre (01/10/2026, "applique le style aussi"). */
        .settings-tabs-wrap .reassort-tabs-root { background-color: #EDF1F7; }
        .settings-tabs-wrap .reassort-tabs-root [role="tab"].text-zinc-500 { color: #5B6B85; }
        .settings-tabs-wrap .reassort-tabs-root [role="tab"]:hover.text-zinc-500 { color: #1B2A4A; }
        .settings-tabs-wrap .reassort-tabs-root .bg-zinc-950 { background-color: #1B2A4A !important; }
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
