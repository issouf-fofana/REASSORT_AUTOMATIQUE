import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './shared/auth/AuthProvider';
import { AppRoutes } from './router/routes';

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  );
}
