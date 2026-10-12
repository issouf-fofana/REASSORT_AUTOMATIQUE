import { Route, Routes } from 'react-router-dom';
import { AppLayout } from '../shared/components/AppLayout';
import { UserGuide } from '../pages/UserGuide/UserGuide';

// /user-guide — première page réellement basculée vers la SPA (cf. plan de migration, point 8),
// après validation complète des 7 critères sur l'ancienne route temporaire /user-guide-next
// (retirée, nginx.conf pointe maintenant directement /user-guide vers ce bundle).
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppLayout pageTitle="Guide d'utilisation" />}>
        <Route path="/user-guide" element={<UserGuide />} />
      </Route>
    </Routes>
  );
}
