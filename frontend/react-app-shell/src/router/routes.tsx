import { Route, Routes } from 'react-router-dom';
import { AppLayout } from '../shared/components/AppLayout';
import { AdminGuard } from '../shared/auth/AdminGuard';
import { UserGuide } from '../pages/UserGuide/UserGuide';
import { ProjectGuide } from '../pages/ProjectGuide/ProjectGuide';
import { AiGuide } from '../pages/AiGuide/AiGuide';
import { FeatureRequests } from '../pages/FeatureRequests/FeatureRequests';
import { MailRecipients } from '../pages/MailRecipients/MailRecipients';

// Vague 1 du plan de migration (/home/youssef/.claude/plans/pure-singing-willow.md) : pages
// simples, faible trafic. /feature-requests et /mail-recipients réservées ADMIN (AdminGuard, même
// garde-fou cosmétique que les pages non-SPA — la vraie sécurité reste le backend).
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/user-guide" element={<UserGuide />} />
        <Route path="/project-guide" element={<ProjectGuide />} />
        <Route path="/ai-guide" element={<AiGuide />} />
        <Route path="/feature-requests" element={<AdminGuard><FeatureRequests /></AdminGuard>} />
        <Route path="/mail-recipients" element={<AdminGuard><MailRecipients /></AdminGuard>} />
      </Route>
    </Routes>
  );
}
