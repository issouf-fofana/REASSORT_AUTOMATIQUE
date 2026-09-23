import { AdminGuard } from './auth/AdminGuard';
import { AdminDashboard } from './AdminDashboard';

export default function App() {
  return (
    <AdminGuard>
      <AdminDashboard />
    </AdminGuard>
  );
}
