import { AdminGuard } from './auth/AdminGuard';
import { ReassortConfigSection } from './components/settings/ReassortConfigSection';

// Étape 5 du plan de migration (voir /home/youssef/.claude/plans/compressed-roaming-orbit.md) :
// ReassortConfigSection, RposSecuritySection, SchedulingSection, AiSection (couverture partielle)
// et SalesFilesSection sont maintenant validées séparément. Remonté ici temporairement en attendant
// SettingsTabs, qui assemblera les sections avec la vraie barre d'onglets.
export default function App() {
  return (
    <AdminGuard>
      <ReassortConfigSection />
    </AdminGuard>
  );
}
