import { AdminGuard } from './auth/AdminGuard';
import { ReassortConfigSection } from './components/settings/ReassortConfigSection';

// Étape 5 du plan de migration (voir /home/youssef/.claude/plans/compressed-roaming-orbit.md) :
// ReassortConfigSection et RposSecuritySection sont maintenant validées séparément (chacune testée
// isolément avant son commit). Remonté ici temporairement en attendant SettingsTabs, qui assemblera
// les 6 sections avec la vraie barre d'onglets — seule la dernière section testée reste montée pour
// ne pas laisser App.tsx dans un état non testé entre deux sessions de travail.
export default function App() {
  return (
    <AdminGuard>
      <ReassortConfigSection />
    </AdminGuard>
  );
}
