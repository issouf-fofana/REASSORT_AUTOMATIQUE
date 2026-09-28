import { useEffect, useState } from 'react';
import { apiFetch } from '../../api/client';

// Logo/favicon du SITE (demande du 28/09/2026 : "donne la possibilité de modifier le logo, favicon
// sur mon ui") — distinct de la signature/logo des emails (MailSection.tsx). Un seul fichier
// statique (frontend/assets/images/logo-reassort.png) sert à la fois de logo dans la sidebar ET de
// favicon dans l'onglet du navigateur sur tout le site : un seul réglage suffit. Stocké en base
// (SystemConfig) et servi dynamiquement par une route backend publique (GET /api/site-logo, hors
// authentification — un logo doit s'afficher même sur la page de login), que nginx interroge en
// priorité avant de retomber sur le fichier statique d'origine si rien n'est configuré (voir
// frontend/nginx.conf, location = /assets/images/logo-reassort.png).
export function SiteBrandingSection() {
  const [hasCustomLogo, setHasCustomLogo] = useState<boolean | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function load() {
    try {
      const data = await apiFetch<{ hasCustomLogo: boolean }>('/site-logo/status');
      setHasCustomLogo(data.hasCustomLogo);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  // Aperçu récupéré en blob : le logo personnalisé (comme l'original) doit rester visible sans
  // authentification pour tout le site, donc /api/site-logo est public — un simple <img src> direct
  // fonctionnerait ici, mais passer par un blob authentifié évite de dépendre de l'URL publique du
  // backend qui peut différer de celle utilisée par le reste de l'app (REASSORT_BACKEND_URL).
  useEffect(() => {
    if (!hasCustomLogo) {
      setPreviewUrl(null);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    (async () => {
      try {
        const apiBase = (window.REASSORT_BACKEND_URL || `${window.location.protocol}//${window.location.hostname}:3001`) + '/api';
        const res = await fetch(`${apiBase}/site-logo`);
        if (!res.ok) return;
        const blob = await res.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setPreviewUrl(objectUrl);
      } catch {
        // best-effort : un échec laisse simplement l'aperçu absent
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [hasCustomLogo]);

  async function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    setSuccess(null);
    try {
      const token = window.reassortGetToken() || '';
      const apiBase = (window.REASSORT_BACKEND_URL || `${window.location.protocol}//${window.location.hostname}:3001`) + '/api';
      const formData = new FormData();
      formData.append('logo', file);
      const res = await fetch(`${apiBase}/site-logo`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      const json: { success: boolean; message?: string } = await res.json();
      if (!json.success) throw new Error(json.message);
      setSuccess('Logo/favicon mis à jour — peut prendre quelques secondes à apparaître partout (cache navigateur).');
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  }

  async function handleReset() {
    if (!(await window.reassortConfirm('Revenir au logo/favicon d\'origine du site ?'))) return;
    try {
      await apiFetch('/site-logo', { method: 'DELETE' });
      setSuccess('Logo/favicon d\'origine restauré.');
      load();
    } catch (err) {
      window.reassortToast('Erreur : ' + (err as Error).message, 'error');
    }
  }

  if (hasCustomLogo === null) return null;

  return (
    <div className="card mb-3">
      <div className="card-header">
        <h5 className="card-title mb-0">Logo / favicon du site</h5>
      </div>
      <div className="card-body">
        <div className="alert alert-light border small mb-3">
          Un seul fichier sert à la fois de logo (sidebar) et de favicon (onglet du navigateur) sur
          tout le site. Format carré recommandé (ex: 512×512), fond transparent ou uni.
        </div>
        {error && <div className="alert alert-danger small">{error}</div>}
        {success && <div className="alert alert-success small">{success}</div>}

        <div className="d-flex align-items-center gap-3 mb-2">
          {previewUrl && (
            <img
              src={previewUrl}
              alt="Logo du site actuel"
              style={{ maxHeight: 80, maxWidth: 120, border: '1px solid #e5e5e5', padding: 8, background: '#ffffff' }}
            />
          )}
          <div>
            <input type="file" accept="image/*" className="form-control form-control-sm" style={{ maxWidth: 260 }} onChange={handleChange} disabled={uploading} />
            <div className="form-text">{hasCustomLogo ? 'Logo personnalisé actif.' : 'Logo d\'origine du site (jamais personnalisé).'}</div>
          </div>
          {hasCustomLogo && (
            <button type="button" className="btn btn-sm btn-outline-danger" onClick={handleReset}>
              Revenir à l'original
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
