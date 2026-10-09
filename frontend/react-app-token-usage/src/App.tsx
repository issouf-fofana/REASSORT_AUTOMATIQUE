import { AdminGuard } from './auth/AdminGuard';
import { TokenUsagePage } from './TokenUsagePage';

export default function App() {
  return (
    <AdminGuard>
      <TokenUsagePage />
    </AdminGuard>
  );
}
