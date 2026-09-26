import { AdminGuard } from './auth/AdminGuard';
import { MailRecipients } from './MailRecipients';

export default function App() {
  return (
    <AdminGuard>
      <MailRecipients />
    </AdminGuard>
  );
}
