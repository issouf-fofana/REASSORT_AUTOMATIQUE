import { AdminGuard } from './auth/AdminGuard';
import { AiMastery } from './AiMastery';

export default function App() {
  return (
    <AdminGuard>
      <AiMastery />
    </AdminGuard>
  );
}
