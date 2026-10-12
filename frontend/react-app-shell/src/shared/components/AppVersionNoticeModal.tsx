import { useAppVersionNotice } from '../hooks/useAppVersionNotice';

// Pop-up "nouvelle version disponible" (demande du 13/10/2026) — montée une seule fois dans
// App.tsx, hors de <Routes/>, pour apparaître quelle que soit la page sur laquelle l'utilisateur
// atterrit après sa connexion. Les notes sont un texte brut multi-lignes (jamais du HTML, cf.
// publicAssets.js) — chaque ligne non vide devient une ligne de changelog encadrée (demande
// explicite du 13/10/2026 : "affiché un message bien encadré... avec les tiret", la simple liste à
// puces <ul> d'origine jugée trop nue).
export function AppVersionNoticeModal() {
  const { notice, dismiss } = useAppVersionNotice();

  if (!notice) return null;

  const lines = notice.notes.split('\n').map((l) => l.trim()).filter(Boolean);

  return (
    <>
      <div className="modal fade show" style={{ display: 'block' }} tabIndex={-1} role="dialog">
        <div className="modal-dialog modal-dialog-centered" role="document">
          <div className="modal-content">
            <div className="modal-header" style={{ backgroundColor: '#1B2A4A', border: 'none' }}>
              <div className="d-flex align-items-center gap-2">
                <span
                  style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 32, height: 32, borderRadius: 8, flexShrink: 0,
                    background: '#F5A623', color: '#1B2A4A', fontSize: '1.1rem',
                  }}
                >
                  <iconify-icon icon="solar:magic-stick-3-bold-duotone"></iconify-icon>
                </span>
                <div>
                  <h5 className="modal-title text-white mb-0">Nouvelle version disponible</h5>
                  <span className="text-white-50" style={{ fontSize: '.78rem' }}>v{notice.version}</span>
                </div>
              </div>
              <button type="button" className="btn-close" style={{ filter: 'invert(1)' }} onClick={dismiss} aria-label="Fermer"></button>
            </div>
            <div className="modal-body" style={{ backgroundColor: '#F7F9FC' }}>
              {lines.length > 0 ? (
                <div className="d-flex flex-column gap-2">
                  {lines.map((line, i) => (
                    <div
                      key={i}
                      className="d-flex align-items-start gap-2"
                      style={{
                        background: '#ffffff', border: '1px solid #e9ecf2', borderRadius: 10,
                        padding: '.65rem .85rem',
                      }}
                    >
                      <span style={{ color: '#F5A623', fontWeight: 700, lineHeight: 1.4, flexShrink: 0 }}>—</span>
                      <span style={{ color: '#33415C', fontSize: '.9rem', lineHeight: 1.4 }}>{line}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-muted mb-0">Une nouvelle version de l'application est disponible.</p>
              )}
            </div>
            <div className="modal-footer" style={{ backgroundColor: '#F7F9FC', border: 'none' }}>
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
