import { useEffect, useState } from 'react';
import { AdminGuard } from './auth/AdminGuard';
import { apiFetch } from './api/client';

// Étape 1 du plan de migration (voir /home/youssef/.claude/plans/compressed-roaming-orbit.md) :
// valider toute la chaîne technique (build Vite → nginx /settings-app/ → auth → appel API réel)
// AVANT d'investir dans les 6 sections de Paramètres. Ce composant sera remplacé par
// <SettingsTabs /> une fois cette chaîne confirmée fonctionnelle de bout en bout.
function SettingsBootstrapCheck() {
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState<string>('');

  useEffect(() => {
    apiFetch<Record<string, unknown>>('/reassort/system-config')
      .then(() => setStatus('ok'))
      .catch((err: Error) => {
        setStatus('error');
        setErrorMessage(err.message);
      });
  }, []);

  return (
    <div className="card">
      <div className="card-header">
        <h4 className="card-title mb-0">Paramètres (migration React — étape 1/6)</h4>
      </div>
      <div className="card-body">
        {status === 'loading' && <p className="text-muted mb-0">Vérification de la chaîne technique…</p>}
        {status === 'ok' && (
          <div className="alert alert-success mb-0">
            Chaîne technique validée : build Vite servi par nginx, authentification lue, appel réel à
            l'API backend réussi (GET /reassort/system-config).
          </div>
        )}
        {status === 'error' && (
          <div className="alert alert-danger mb-0">Erreur d'appel API : {errorMessage}</div>
        )}
      </div>
    </div>
  );
}

export default function App() {
  return (
    <AdminGuard>
      <SettingsBootstrapCheck />
    </AdminGuard>
  );
}
