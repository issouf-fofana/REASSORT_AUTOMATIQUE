import { useEffect, useState } from 'react';
import { ImprovementsTab } from './components/ImprovementsTab';
import { CorrectionsTab } from './components/CorrectionsTab';
import { ErrorLogTab } from './components/ErrorLogTab';
import { AutonomyTab } from './components/AutonomyTab';
import { DecisionLogTab } from './components/DecisionLogTab';
import { NotchTabBar } from './components/ui/NotchTabBar';
import './index.css';

const TABS = [
  { id: 'tab-improvements', label: 'Améliorations IA', icon: 'solar:bolt-bold-duotone' },
  { id: 'tab-corrections', label: 'Journal des corrections', icon: 'solar:clipboard-check-bold-duotone' },
  { id: 'tab-errors', label: 'Journal des erreurs', icon: 'solar:danger-triangle-bold-duotone' },
  { id: 'tab-autonomy', label: "Préparation à l'autonomie", icon: 'solar:medal-star-bold-duotone' },
  { id: 'tab-decision-log', label: 'Journal des décisions', icon: 'solar:document-text-bold-duotone' },
] as const;

type TabId = (typeof TABS)[number]['id'];

function tabFromHash(): TabId {
  const hash = window.location.hash.replace('#', '');
  return (TABS.find((t) => t.id === hash)?.id ?? 'tab-improvements') as TabId;
}

/**
 * Reproduit la barre d'onglets Bootstrap + le routage par hash (#tab-xxx) de ai-quality.html
 * (fusion du 22/09/2026 de 4 pages en une seule) — contrairement à Paramètres, la barre d'onglets
 * est VISIBLE en page ici (demande explicite de l'utilisateur, cf. commentaire dans le HTML
 * d'origine), pas masquée au profit de sous-liens sidebar.
 */
export function QualityTabs() {
  const [activeTab, setActiveTab] = useState<TabId>(tabFromHash());
  const [decisionLogVisited, setDecisionLogVisited] = useState(activeTab === 'tab-decision-log');

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
    if (id === 'tab-decision-log') setDecisionLogVisited(true);
  }

  return (
    <div>
      <style>{`.aiq-tabs-wrap { margin-bottom: 1.75rem; }`}</style>
      <div className="aiq-tabs-wrap">
        <NotchTabBar tabs={TABS} activeId={activeTab} onActiveChange={(id) => selectTab(id as TabId)} />
      </div>

      <div className="tab-content">
        {activeTab === 'tab-improvements' && (
          <div className="tab-pane show active">
            <ImprovementsTab />
          </div>
        )}
        {activeTab === 'tab-corrections' && (
          <div className="tab-pane show active">
            <CorrectionsTab />
          </div>
        )}
        {activeTab === 'tab-errors' && (
          <div className="tab-pane show active">
            <ErrorLogTab />
          </div>
        )}
        {activeTab === 'tab-autonomy' && (
          <div className="tab-pane show active">
            <AutonomyTab />
          </div>
        )}
        {activeTab === 'tab-decision-log' && (
          <div className="tab-pane show active">
            <DecisionLogTab active={decisionLogVisited} />
          </div>
        )}
      </div>
    </div>
  );
}
