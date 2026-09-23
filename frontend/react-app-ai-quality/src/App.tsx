import { AdminGuard } from './auth/AdminGuard';
import { QualityTabs } from './QualityTabs';

export default function App() {
  return (
    <AdminGuard>
      <QualityTabs />
    </AdminGuard>
  );
}
