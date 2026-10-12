import { Route, Routes } from 'react-router-dom';
import { AppLayout } from '../shared/components/AppLayout';
import { UserGuide } from '../pages/UserGuide/UserGuide';
import { ProjectGuide } from '../pages/ProjectGuide/ProjectGuide';

// /user-guide — première page réellement basculée vers la SPA (cf. plan de migration, point 8).
// /project-guide — deuxième page (vague 1), 12/10/2026.
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/user-guide" element={<UserGuide />} />
        <Route path="/project-guide" element={<ProjectGuide />} />
      </Route>
    </Routes>
  );
}
