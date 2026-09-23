import { AdminGuard } from './auth/AdminGuard';
import { ReassortConfigSection } from './components/settings/ReassortConfigSection';

// Étape 5 du plan de migration (voir /home/youssef/.claude/plans/compressed-roaming-orbit.md) :
// ReassortConfigSection, RposSecuritySection, SchedulingSection, AiSection (maintenant complète),
// SalesFilesSection et SyncSection sont toutes validées séparément. Remonté ici temporairement en
// attendant SettingsTabs, qui assemblera les 6 sections avec la vraie barre d'onglets.
export default function App() {
  return (
    <AdminGuard>
      <ReassortConfigSection />
    </AdminGuard>
  );
}
