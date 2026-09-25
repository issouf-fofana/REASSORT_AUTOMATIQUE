import { AdminGuard } from './auth/AdminGuard';
import { FeatureRequests } from './FeatureRequests';

export default function App() {
  return (
    <AdminGuard>
      <FeatureRequests />
    </AdminGuard>
  );
}
