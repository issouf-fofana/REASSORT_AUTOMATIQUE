import { useEffect, useState } from 'react';
import { ReassortConfigSection } from './ReassortConfigSection';
import { SalesFilesSection } from './SalesFilesSection';
import { RposSecuritySection } from './RposSecuritySection';
import { SchedulingSection } from './SchedulingSection';
import { SyncSection } from './SyncSection';
import { AiSection } from './AiSection';

const TABS = [
  { id: 'tab-reassort', label: 'Réassort', icon: 'solar:tuning-2-bold-duotone' },
  { id: 'tab-files', label: 'Fichiers de ventes', icon: 'solar:folder-bold-duotone' },
  { id: 'tab-rpos', label: 'RPOS & Sécurité', icon: 'solar:server-square-bold-duotone' },
  { id: 'tab-cron', label: 'Planification', icon: 'solar:clock-circle-bold-duotone' },
  { id: 'tab-sync', label: 'Synchronisation des ventes', icon: 'solar:refresh-square-bold-duotone' },
  { id: 'tab-ai', label: 'IA', icon: 'solar:magic-stick-3-bold-duotone' },
] as const;

type TabId = (typeof TABS)[number]['id'];

function tabFromHash(): TabId {
  const hash = window.location.hash.replace('#', '');
  return (TABS.find((t) => t.id === hash)?.id ?? 'tab-reassort') as TabId;
}

/**
 * Reproduit la barre d'onglets Bootstrap + le routage par hash (#tab-xxx) de settings.old.html
 * (openTabFromHash/hashchange) — les liens de la sidebar pointent déjà vers /settings#tab-xxx,
 * ce routage doit rester compatible sans modifier la sidebar. Contrairement à l'ancienne page, les
 * 6 onglets sont toujours visibles ici : AdminGuard bloque déjà tout le composant aux non-ADMIN,
 * la logique de masquage par rôle par onglet (réservée à ADMIN de toute façon) n'a plus lieu d'être.
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
      <ul className="nav nav-tabs nav-bordered mb-4" role="tablist">
        {TABS.map((tab) => (
          <li className="nav-item" key={tab.id}>
            <a
              className={`nav-link ${activeTab === tab.id ? 'active' : ''}`}
              href={`#${tab.id}`}
              role="tab"
              onClick={(e) => {
                e.preventDefault();
                selectTab(tab.id);
              }}
            >
              <iconify-icon icon={tab.icon} className="fs-18 align-middle me-1"></iconify-icon>
              {tab.label}
            </a>
          </li>
        ))}
      </ul>

      <div className="tab-content">
        {activeTab === 'tab-reassort' && (
          <div className="tab-pane show active">
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
      </div>
    </div>
  );
}
