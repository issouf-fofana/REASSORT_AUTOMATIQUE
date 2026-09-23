import { AdminGuard } from './auth/AdminGuard';
import { ReassortConfigSection } from './components/settings/ReassortConfigSection';

// Étape 5 du plan de migration (voir /home/youssef/.claude/plans/compressed-roaming-orbit.md) :
// section "Réassort" implémentée en premier (risque le plus faible). Les 5 autres sections
// (Fichiers de ventes, RPOS & Sécurité, Planification, Synchronisation, IA) et la barre d'onglets
// (SettingsTabs) suivront une par une, chacune testée avant la suivante.
export default function App() {
  return (
    <AdminGuard>
      <ReassortConfigSection />
    </AdminGuard>
  );
}
