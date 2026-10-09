import { useEffect, useState } from 'react';
import { apiFetch } from '../../api/client';

// Logo/favicon du SITE (demande du 28/09/2026 : "donne la possibilité de modifier le logo, favicon
// sur mon ui" ; séparés en deux images distinctes le 09/10/2026 — "je veux mettre deux logo
// different", jusque-là un seul fichier statique servait aux deux usages, voir l'ancienne version de
// ce composant). Distinct de la signature/logo des emails (MailSection.tsx). Chaque image est
// stockée en base (SystemConfig) et servie dynamiquement par sa propre route backend publique (GET
// /api/site-logo ou /api/site-favicon, hors authentification — un logo/favicon doit s'afficher même
// sur la page de login), que nginx interroge en priorité avant de retomber sur le fichier statique
// d'origine si rien n'est configuré (voir frontend/nginx.conf, location =
// /assets/images/logo-reassort.png et /assets/images/favicon-reassort.png).
interface ImageSlotConfig {
  key: 'logo' | 'favicon';
  title: string;
  description: string;
  statusPath: string;
  uploadPath: string;
  fieldName: string;
  resetConfirm: string;
}

const SLOTS: ImageSlotConfig[] = [
  {
    key: 'logo',
    title: 'Logo',
    description: 'Affiché dans la sidebar et les widgets (Assistant IA) sur tout le site. Format carré recommandé (ex: 512×512), fond transparent ou uni.',
    statusPath: '/site-logo/status',
    uploadPath: '/site-logo',
    fieldName: 'logo',
    resetConfirm: 'Revenir au logo d\'origine du site ?',
  },
  {
    key: 'favicon',
    title: 'Favicon',
    description: 'Affiché dans l\'onglet du navigateur. Format carré recommandé (ex: 64×64 ou 512×512), fond transparent ou uni — un favicon trop détaillé devient illisible à cette petite taille.',
    statusPath: '/site-favicon/status',
    uploadPath: '/site-favicon',
    fieldName: 'favicon',
    resetConfirm: 'Revenir au favicon d\'origine du site ?',
  },
];

function ImageUploadCard({ config }: { config: ImageSlotConfig }) {
  const [hasCustom, setHasCustom] = useState<boolean | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function load() {
    try {
      const data = await apiFetch<{ hasCustom: boolean }>(config.statusPath);
      setHasCustom(data.hasCustom);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Aperçu récupéré en blob : l'image personnalisée (comme l'originale) doit rester visible sans
  // authentification pour tout le site, donc la route est publique — un simple <img src> direct
  // fonctionnerait ici, mais passer par un blob authentifié évite de dépendre de l'URL publique du
  // backend qui peut différer de celle utilisée par le reste de l'app (REASSORT_BACKEND_URL).
  useEffect(() => {
    if (!hasCustom) {
      setPreviewUrl(null);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    (async () => {
      try {
        const apiBase = (window.REASSORT_BACKEND_URL || `${window.location.protocol}//${window.location.hostname}:3001`) + '/api';
        const res = await fetch(`${apiBase}${config.uploadPath}`);
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
  }, [hasCustom, config.uploadPath]);

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
      formData.append(config.fieldName, file);
      const res = await fetch(`${apiBase}${config.uploadPath}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      const json: { success: boolean; message?: string } = await res.json();
      if (!json.success) throw new Error(json.message);
      setSuccess(`${config.title} mis à jour — peut prendre quelques secondes à apparaître partout (cache navigateur).`);
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  }

  async function handleReset() {
    if (!(await window.reassortConfirm(config.resetConfirm))) return;
    try {
      await apiFetch(config.uploadPath, { method: 'DELETE' });
      setSuccess(`${config.title} d'origine restauré.`);
      load();
    } catch (err) {
      window.reassortToast('Erreur : ' + (err as Error).message, 'error');
    }
  }

  if (hasCustom === null) return null;

  return (
    <div className="mb-4">
      <h6 className="mb-1">{config.title}</h6>
      <div className="alert alert-light border small mb-3">{config.description}</div>
      {error && <div className="alert alert-danger small">{error}</div>}
      {success && <div className="alert alert-success small">{success}</div>}

      <div className="d-flex align-items-center gap-3 mb-2">
        {previewUrl && (
          <img
            src={previewUrl}
            alt={`${config.title} actuel`}
            style={{ maxHeight: 80, maxWidth: 120, border: '1px solid #e5e5e5', padding: 8, background: '#ffffff' }}
          />
        )}
        <div>
          <input type="file" accept="image/*" className="form-control form-control-sm" style={{ maxWidth: 260 }} onChange={handleChange} disabled={uploading} />
          <div className="form-text">{hasCustom ? `${config.title} personnalisé actif.` : `${config.title} d'origine du site (jamais personnalisé).`}</div>
        </div>
        {hasCustom && (
          <button type="button" className="btn btn-sm btn-outline-danger" onClick={handleReset}>
            Revenir à l'original
          </button>
        )}
      </div>
    </div>
  );
}

export function SiteBrandingSection() {
  return (
    <div className="card mb-3">
      <div className="card-header">
        <h5 className="card-title mb-0">Logo / favicon du site</h5>
      </div>
      <div className="card-body">
        <div className="alert alert-light border small mb-3">
          Deux images indépendantes : le logo (sidebar, widgets) et le favicon (onglet du navigateur)
          peuvent désormais être différents.
        </div>
        {SLOTS.map((config) => (
          <ImageUploadCard key={config.key} config={config} />
        ))}
      </div>
    </div>
  );
}
