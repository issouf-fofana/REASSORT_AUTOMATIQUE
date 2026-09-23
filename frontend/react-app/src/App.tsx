import { AdminGuard } from './auth/AdminGuard';
import { ReassortConfigSection } from './components/settings/ReassortConfigSection';

// Étape 5 du plan de migration (voir /home/youssef/.claude/plans/compressed-roaming-orbit.md) :
// ReassortConfigSection, RposSecuritySection et SchedulingSection sont maintenant validées
// séparément (chacune testée isolément avant son commit). Remonté ici temporairement en attendant
// SettingsTabs, qui assemblera les 6 sections avec la vraie barre d'onglets.
export default function App() {
  return (
    <AdminGuard>
      <ReassortConfigSection />
    </AdminGuard>
  );
}
