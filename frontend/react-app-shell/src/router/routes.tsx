import { Route, Routes } from 'react-router-dom';
import { AppLayout } from '../shared/components/AppLayout';
import { UserGuide } from '../pages/UserGuide/UserGuide';

// Route TEMPORAIRE /user-guide-next (cf. plan de migration, point 5) — jamais /user-guide lui-même
// tant que la validation complète (7 critères du plan) n'est pas faite, pour ne jamais entrer en
// conflit avec la version actuelle de cette page toujours servie séparément par nginx.
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppLayout pageTitle="Guide d'utilisation" />}>
        <Route path="/user-guide-next" element={<UserGuide />} />
      </Route>
    </Routes>
  );
}
