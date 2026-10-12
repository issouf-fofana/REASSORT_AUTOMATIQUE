import { useAppVersionNotice } from '../hooks/useAppVersionNotice';

// Pop-up "nouvelle version disponible" (demande du 13/10/2026) — montée une seule fois dans
// App.tsx, hors de <Routes/>, pour apparaître quelle que soit la page sur laquelle l'utilisateur
// atterrit après sa connexion. Les notes sont un texte brut multi-lignes (jamais du HTML, cf.
// publicAssets.js) — chaque ligne non vide devient une puce de la liste.
export function AppVersionNoticeModal() {
  const { notice, dismiss } = useAppVersionNotice();

  if (!notice) return null;

  const lines = notice.notes.split('\n').map((l) => l.trim()).filter(Boolean);

  return (
    <>
      <div className="modal fade show" style={{ display: 'block' }} tabIndex={-1} role="dialog">
        <div className="modal-dialog modal-dialog-centered" role="document">
          <div className="modal-content">
            <div className="modal-header" style={{ backgroundColor: '#1B2A4A' }}>
              <h5 className="modal-title text-white">Nouvelle version {notice.version}</h5>
              <button type="button" className="btn-close" style={{ filter: 'invert(1)' }} onClick={dismiss} aria-label="Fermer"></button>
            </div>
            <div className="modal-body">
              {lines.length > 0 ? (
                <ul className="mb-0 ps-3">
                  {lines.map((line, i) => (
                    <li key={i} className="mb-1">{line}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted mb-0">Une nouvelle version de l'application est disponible.</p>
              )}
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-dark" onClick={dismiss}>
                Compris
              </button>
            </div>
          </div>
        </div>
      </div>
      <div className="modal-backdrop fade show"></div>
    </>
  );
}
