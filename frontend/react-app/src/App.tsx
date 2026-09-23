import { AdminGuard } from './auth/AdminGuard';
import { SettingsTabs } from './components/settings/SettingsTabs';

// Étape 6 (finale) du plan de migration (voir /home/youssef/.claude/plans/compressed-roaming-orbit.md) :
// les 6 sections sont validées individuellement, assemblées ici avec la vraie barre d'onglets et le
// routage par hash (#tab-xxx), compatible avec les liens existants de la sidebar.
export default function App() {
  return (
    <AdminGuard>
      <SettingsTabs />
    </AdminGuard>
  );
}
