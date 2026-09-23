import { AdminGuard } from './auth/AdminGuard';
import { SalesHistory } from './SalesHistory';

export default function App() {
  return (
    <AdminGuard>
      <SalesHistory />
    </AdminGuard>
  );
}
