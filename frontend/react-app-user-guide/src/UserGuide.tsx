import { useEffect, useRef, useState } from 'react';
import { apiFetch } from './api/client';

interface GuideImage {
  id: string;
  caption: string | null;
  order: number;
  createdAt: string;
}

interface GuideSection {
  id: string;
  title: string;
  content: string | null;
  updatedBy: string | null;
  updatedAt: string;
  images: GuideImage[];
}

// Image servie derrière requireAuth (pas publique comme le logo du site) : impossible de pointer un
// <img src> directement dessus sans le header Authorization — chargée en blob via apiFetch/
// reassortFetch puis transformée en URL locale, même pattern que SiteBrandingSection.tsx pour
// l'aperçu du logo avant upload.
function GuideImageThumb({ imageId, canEdit, onDeleted }: { imageId: string; canEdit: boolean; onDeleted: (id: string) => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    (async () => {
      try {
        const res = await window.reassortFetch(`/reassort/user-guide/images/${imageId}`);
        if (!res.ok) return;
        const blob = await res.blob();
        objectUrl = URL.createObjectURL(blob);
        if (!cancelled) setSrc(objectUrl);
      } catch {
        // échec silencieux : la vignette reste vide plutôt que de casser toute la section
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [imageId]);

  async function handleDelete() {
    setDeleting(true);
    try {
      await apiFetch(`/reassort/user-guide/images/${imageId}`, { method: 'DELETE' });
      onDeleted(imageId);
    } catch (err) {
      window.reassortToast('Erreur : ' + (err instanceof Error ? err.message : String(err)), 'error');
      setDeleting(false);
    }
  }

  return (
    <div className="ug-image-thumb">
      {src ? <img src={src} alt="" /> : <div className="ug-image-placeholder" />}
      {canEdit && (
        <button type="button" className="ug-image-delete" title="Supprimer cette capture" disabled={deleting} onClick={handleDelete}>
          <iconify-icon icon="solar:trash-bin-trash-bold-duotone"></iconify-icon>
        </button>
      )}
    </div>
  );
}

function SectionBlock({
  section,
  canEdit,
  onUpdated,
}: {
  section: GuideSection;
  canEdit: boolean;
  onUpdated: (next: GuideSection) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(section.content || '');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function saveContent() {
    setSaving(true);
    try {
      const updated = await apiFetch<GuideSection>(`/reassort/user-guide/${section.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: draft }),
      });
      onUpdated(updated);
      setEditing(false);
    } catch (err) {
      window.reassortToast('Erreur : ' + (err instanceof Error ? err.message : String(err)), 'error');
    } finally {
      setSaving(false);
    }
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('image', file);
      const res = await window.reassortFetch(`/reassort/user-guide/${section.id}/images`, {
        method: 'POST',
        body: formData,
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.message || 'Échec de l\'envoi');
      onUpdated({ ...section, images: [...section.images, json.data] });
    } catch (err) {
      window.reassortToast('Erreur : ' + (err instanceof Error ? err.message : String(err)), 'error');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function handleImageDeleted(imageId: string) {
    onUpdated({ ...section, images: section.images.filter((i) => i.id !== imageId) });
  }

  return (
    <section className="ug-section" id={section.id}>
      <div className="ug-section-header">
        <iconify-icon icon="solar:book-2-bold-duotone"></iconify-icon>
        <h3 className="ug-section-title">{section.title}</h3>
      </div>

      {editing ? (
        <div className="ug-edit-box">
          <textarea
            className="form-control"
            rows={5}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Expliquez ici comment utiliser cette page..."
          />
          <div className="ug-edit-actions">
            <button type="button" className="btn btn-sm ug-btn-outline" onClick={() => { setEditing(false); setDraft(section.content || ''); }}>
              Annuler
            </button>
            <button type="button" className="btn btn-sm ug-btn-navy" disabled={saving} onClick={saveContent}>
              {saving ? 'Enregistrement...' : 'Enregistrer'}
            </button>
          </div>
        </div>
      ) : (
        <>
          {section.content ? (
            <p className="ug-section-content">{section.content}</p>
          ) : (
            <p className="ug-section-empty">Aucune explication pour cette page pour le moment.</p>
          )}
          {canEdit && (
            <button type="button" className="btn btn-sm ug-btn-outline ug-edit-only" onClick={() => setEditing(true)}>
              <iconify-icon icon="solar:pen-bold-duotone"></iconify-icon> Modifier le texte
            </button>
          )}
        </>
      )}

      {section.images.length > 0 && (
        <div className="ug-image-grid">
          {section.images.map((img) => (
            <GuideImageThumb key={img.id} imageId={img.id} canEdit={canEdit} onDeleted={handleImageDeleted} />
          ))}
        </div>
      )}

      {canEdit && (
        <div className="ug-add-image">
          <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFileChange} />
          <button type="button" className="btn btn-sm ug-btn-outline" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
            <iconify-icon icon="solar:gallery-add-bold-duotone"></iconify-icon> {uploading ? 'Envoi...' : 'Ajouter une image'}
          </button>
        </div>
      )}
    </section>
  );
}

export function UserGuide() {
  const [sections, setSections] = useState<GuideSection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newSectionOpen, setNewSectionOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newId, setNewId] = useState('');
  const [creating, setCreating] = useState(false);

  const user = window.reassortGetUser ? window.reassortGetUser() : null;
  const isAdmin = user?.role === 'ADMIN';

  async function load() {
    try {
      const data = await apiFetch<GuideSection[]>('/reassort/user-guide');
      setSections(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    load();
  }, []);

  function updateSection(next: GuideSection) {
    setSections((prev) => (prev ? prev.map((s) => (s.id === next.id ? next : s)) : prev));
  }

  function slugify(title: string): string {
    return title
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  async function createSection() {
    const id = newId.trim() || slugify(newTitle);
    if (!id || !newTitle.trim()) return;
    setCreating(true);
    try {
      const created = await apiFetch<GuideSection>('/reassort/user-guide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, title: newTitle.trim() }),
      });
      setSections((prev) => (prev ? [...prev, created] : [created]));
      setNewSectionOpen(false);
      setNewTitle('');
      setNewId('');
    } catch (err) {
      window.reassortToast('Erreur : ' + (err instanceof Error ? err.message : String(err)), 'error');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <style>{`
        .ug-intro {
          background: #F7F9FC; border: 1px solid #e9ecf2; border-radius: 12px;
          padding: 1.1rem 1.35rem; margin-bottom: 1.5rem; font-size: .87rem; color: #44516B; line-height: 1.6;
        }
        .ug-intro strong { color: #1B2A4A; }
        .ug-toolbar { display: flex; justify-content: flex-end; gap: .5rem; margin-bottom: 1rem; }
        .ug-btn-navy { background: #1B2A4A; border: 1px solid #1B2A4A; color: #fff; }
        .ug-btn-navy:hover { background: #14203a; border-color: #14203a; color: #fff; }
        .ug-btn-outline { background: transparent; border: 1px solid #DCE3F0; color: #1B2A4A; }
        .ug-btn-outline:hover { background: #1B2A4A; border-color: #1B2A4A; color: #fff; }
        .ug-section {
          background: #ffffff; border: 1px solid #e9ecf2; border-radius: 14px;
          padding: 1.25rem 1.5rem; margin-bottom: 1.25rem; box-shadow: 0 1px 3px rgba(27,42,74,.05);
        }
        .ug-section-header { display: flex; align-items: center; gap: .6rem; margin-bottom: .75rem; padding-bottom: .6rem; border-bottom: 1px solid #e9ecf2; }
        .ug-section-header iconify-icon { font-size: 1.2rem; color: #1B2A4A; }
        .ug-section-title { font-size: 1.05rem; font-weight: 700; margin: 0; color: #1B2A4A; }
        .ug-section-content { font-size: .9rem; color: #33415C; line-height: 1.6; white-space: pre-line; margin-bottom: .75rem; }
        .ug-section-empty { font-size: .85rem; color: #8a93a8; font-style: italic; margin-bottom: .75rem; }
        .ug-edit-box textarea { font-size: .88rem; margin-bottom: .6rem; }
        .ug-edit-actions { display: flex; gap: .5rem; justify-content: flex-end; }
        .ug-image-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: .75rem; margin: .75rem 0; }
        .ug-image-thumb { position: relative; border-radius: 10px; overflow: hidden; border: 1px solid #e9ecf2; background: #F7F9FC; aspect-ratio: 16/10; }
        .ug-image-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
        .ug-image-placeholder { width: 100%; height: 100%; background: #EDF1F7; }
        .ug-image-delete {
          position: absolute; top: .4rem; right: .4rem; width: 26px; height: 26px; border-radius: 6px;
          background: rgba(27,42,74,.85); color: #fff; border: none; display: flex; align-items: center; justify-content: center;
        }
        .ug-image-delete:hover { background: #1B2A4A; }
        .ug-add-image { margin-top: .5rem; }
        .ug-new-section-box { background: #F7F9FC; border: 1px dashed #c7d2e8; border-radius: 12px; padding: 1rem 1.25rem; margin-bottom: 1.25rem; }
        .ug-new-section-box .row { align-items: flex-end; }

        /* Impression (01/10/2026, "comment je veux imprimer il faut ajouter") : masque tout ce qui
           n'a pas de sens sur papier (sidebar, topbar, barre d'outils, boutons d'édition par
           section, zone d'ajout de section) — ne garde que le titre de chaque section, son texte et
           ses images, avec un saut de page avant chaque section pour une lecture claire imprimée. */
        @media print {
          .sidebar, #layout-topbar-slot, #notch-nav-slot, .ug-toolbar, .ug-new-section-box,
          .ug-add-image, .ug-image-delete, .ug-edit-only {
            display: none !important;
          }
          main.content { margin-left: 0 !important; }
          .ug-section { break-inside: avoid; page-break-after: always; box-shadow: none; border: none; }
          .ug-section:last-child { page-break-after: auto; }
        }
      `}</style>

      <div className="ug-intro">
        <strong>À quoi ça sert :</strong> ce guide explique comment utiliser chaque page de
        l'application au quotidien (Tableau de bord, Assistant IA, Proposition de commande...),
        avec des captures d'écran pour s'y retrouver facilement.
      </div>

      <div className="ug-toolbar">
        <button type="button" className="btn btn-sm ug-btn-outline" onClick={() => window.print()}>
          <iconify-icon icon="solar:printer-bold-duotone"></iconify-icon> Imprimer
        </button>
        {isAdmin && (
          <button type="button" className="btn btn-sm ug-btn-outline" onClick={() => setNewSectionOpen((v) => !v)}>
            <iconify-icon icon="solar:add-circle-bold-duotone"></iconify-icon> Ajouter une section
          </button>
        )}
      </div>

      {isAdmin && newSectionOpen && (
        <div className="ug-new-section-box">
          <div className="row g-2">
            <div className="col-md-6">
              <label className="form-label small">Titre de la section</label>
              <input className="form-control form-control-sm" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Ex: Qualité & IA" />
            </div>
            <div className="col-md-4">
              <label className="form-label small">Identifiant (optionnel)</label>
              <input className="form-control form-control-sm" value={newId} onChange={(e) => setNewId(e.target.value)} placeholder={slugify(newTitle) || 'auto'} />
            </div>
            <div className="col-md-2">
              <button type="button" className="btn btn-sm ug-btn-navy w-100" disabled={creating || !newTitle.trim()} onClick={createSection}>
                {creating ? '...' : 'Créer'}
              </button>
            </div>
          </div>
        </div>
      )}

      {error && <div className="alert alert-danger">Erreur : {error}</div>}
      {!sections && !error && <div className="text-center text-muted py-4">Chargement...</div>}
      {sections?.map((s) => (
        <SectionBlock key={s.id} section={s} canEdit={isAdmin} onUpdated={updateSection} />
      ))}
    </div>
  );
}
