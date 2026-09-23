import { AdminGuard } from './auth/AdminGuard';
import { UsersPage } from './UsersPage';

export default function App() {
  return (
    <AdminGuard>
      <UsersPage />
    </AdminGuard>
  );
}
