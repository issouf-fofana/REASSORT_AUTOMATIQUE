import { AdminGuard } from './auth/AdminGuard';
import { OrderAnomalies } from './OrderAnomalies';

export default function App() {
  return (
    <AdminGuard>
      <OrderAnomalies />
    </AdminGuard>
  );
}
