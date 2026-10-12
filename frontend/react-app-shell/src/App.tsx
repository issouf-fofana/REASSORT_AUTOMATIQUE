import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './shared/auth/AuthProvider';
import { AppRoutes } from './router/routes';
import { AppVersionNoticeModal } from './shared/components/AppVersionNoticeModal';

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppRoutes />
        {/* Pop-up "nouvelle version" (demande du 13/10/2026) — montée une seule fois ici, hors de
            <AppRoutes/>, pour apparaître sur n'importe quelle page après connexion plutôt que
            d'être dupliquée dans chaque route. Toujours rendue (son propre hook décide si elle
            doit réellement s'afficher — jamais sur /login, où useAuth().user est null). */}
        <AppVersionNoticeModal />
      </BrowserRouter>
    </AuthProvider>
  );
}
