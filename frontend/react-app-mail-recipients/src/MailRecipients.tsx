import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from './api/client';

interface RecipientUser {
  id: string;
  email: string;
  name: string;
  mailAlertsEnabled: boolean;
}

interface ShopRecipients {
  shop: { reference: string; name: string };
  recipients: RecipientUser[];
}

interface MailRecipientsData {
  shops: ShopRecipients[];
  admins: RecipientUser[];
}

// Marine/orange déjà utilisés par le reste de l'application (sidebar #1B2A4A, accent #ff6c2f,
// cf. frontend/assets/css/app.min.css) — repris ici plutôt qu'une nouvelle palette, pour que cette
// page reste visuellement cohérente avec le tableau de bord qui l'entoure.
const MARINE = '#1B2A4A';
const MARINE_SOFT = '#eef1f6';
const ACCENT = '#ff6c2f';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase();
}

// Couleur d'avatar dérivée du nom (hash simple) : donne à chaque personne une identité visuelle
// stable d'une session à l'autre, sans dépendre d'une donnée stockée en base pour ça.
const AVATAR_PALETTE = ['#1B2A4A', '#2A3E66', '#8a6d3b', '#3b6e8a', '#6d4c8a', '#4c8a5c'];
function avatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}

export function MailRecipients() {
  const [data, setData] = useState<MailRecipientsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [onlyEmpty, setOnlyEmpty] = useState(false);
  // Comptes en cours de bascule (demande du 26/09/2026 : "ajouter la possibilité de cocher/décocher
  // par personne") — désactive la case le temps de l'appel pour éviter un double-clic qui enverrait
  // deux requêtes concurrentes sur le même compte.
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  // Magasin ouvert dans le panneau de détail (demande du 12/10/2026, "grille de carte... quand je
  // clique j'ai les personnes du magasin") : la grille ne montre plus les destinataires directement,
  // seulement un compte — le détail (liste réelle, cases à cocher) s'ouvre au clic sur une carte.
  const [openShopRef, setOpenShopRef] = useState<string | null>(null);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const result = await apiFetch<MailRecipientsData>('/reassort/mail-recipients');
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function toggleUser(user: RecipientUser) {
    const nextEnabled = !user.mailAlertsEnabled;
    setSavingIds((prev) => new Set(prev).add(user.id));
    try {
      await window.reassortFetch(`/reassort/mail-recipients/${user.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      // Mise à jour optimiste locale plutôt qu'un rechargement complet : cette même personne peut
      // apparaître dans plusieurs magasins (superviseur) et dans le bloc admin — un seul état à
      // synchroniser partout, sans reperdre le scroll/filtre en cours.
      setData((prev) => {
        if (!prev) return prev;
        const patchUser = (u: RecipientUser) => (u.id === user.id ? { ...u, mailAlertsEnabled: nextEnabled } : u);
        return {
          admins: prev.admins.map(patchUser),
          shops: prev.shops.map((s) => ({ ...s, recipients: s.recipients.map(patchUser) })),
        };
      });
      window.reassortToast(nextEnabled ? `${user.name} recevra à nouveau les alertes.` : `${user.name} ne recevra plus les alertes.`, 'success');
    } catch (err) {
      window.reassortToast(err instanceof Error ? err.message : 'Erreur lors de la mise à jour.', 'error');
    } finally {
      setSavingIds((prev) => {
        const next = new Set(prev);
        next.delete(user.id);
        return next;
      });
    }
  }

  const filteredShops = (data?.shops || []).filter((s) => {
    if (onlyEmpty && s.recipients.length > 0) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      s.shop.reference.toLowerCase().includes(q) ||
      s.shop.name.toLowerCase().includes(q) ||
      s.recipients.some((r) => r.name.toLowerCase().includes(q) || r.email.toLowerCase().includes(q))
    );
  });

  const openShop = data?.shops.find((s) => s.shop.reference === openShopRef) || null;

  // Fermeture au clavier (Échap), cohérent avec le comportement attendu d'une modale.
  useEffect(() => {
    if (!openShopRef) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpenShopRef(null);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [openShopRef]);

  // Indicateurs résumant l'état global d'un coup d'œil (demande du 12/10/2026, "fais un style pro
  // pour ici") : combien de magasins restent sans aucun destinataire, combien de comptes au total
  // reçoivent réellement des alertes — invisible dans la version précédente sans compter soi-même
  // chaque ligne du tableau.
  const stats = useMemo(() => {
    if (!data) return null;
    const shopsWithoutRecipient = data.shops.filter((s) => s.recipients.length === 0).length;
    const activeAdmins = data.admins.filter((a) => a.mailAlertsEnabled).length;
    const allRecipientIds = new Set<string>();
    for (const s of data.shops) for (const r of s.recipients) if (r.mailAlertsEnabled) allRecipientIds.add(r.id);
    for (const a of data.admins) if (a.mailAlertsEnabled) allRecipientIds.add(a.id);
    return {
      totalShops: data.shops.length,
      shopsWithoutRecipient,
      activeAdmins,
      totalAdmins: data.admins.length,
      activeRecipients: allRecipientIds.size,
    };
  }, [data]);

  function renderUserChip(user: RecipientUser, variant: 'inline' | 'block' = 'inline') {
    const disabled = !user.mailAlertsEnabled;
    return (
      <label
        key={user.id}
        className={variant === 'block' ? 'mr-chip-block' : 'mr-chip'}
        style={{
          opacity: savingIds.has(user.id) ? 0.6 : 1,
          backgroundColor: disabled ? '#fbeae7' : MARINE_SOFT,
          borderColor: disabled ? '#f0c4bc' : '#dde1e8',
        }}
        title={disabled ? 'Cocher pour réactiver les alertes email pour cette personne' : 'Décocher pour exclure cette personne des alertes email'}
      >
        <input
          type="checkbox"
          checked={user.mailAlertsEnabled}
          disabled={savingIds.has(user.id)}
          onChange={() => toggleUser(user)}
          className="mr-chip-checkbox"
        />
        <span className="mr-chip-avatar" style={{ backgroundColor: disabled ? '#c0392b' : avatarColor(user.name) }}>
          {initials(user.name)}
        </span>
        <span className="mr-chip-text">
          <span className="mr-chip-name" style={disabled ? { textDecoration: 'line-through', color: '#c0392b' } : undefined}>
            {user.name}
          </span>
          <span className="mr-chip-email">{user.email}</span>
        </span>
      </label>
    );
  }

  return (
    <div className="mr-page">
      <style>{`
        .mr-page { font-feature-settings: "tnum"; }
        .mr-header-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; flex-wrap: wrap; margin-bottom: 24px; }
        .mr-header-text h2 { font-size: 1.375rem; font-weight: 700; color: ${MARINE}; margin-bottom: 6px; }
        .mr-header-text p { color: #6b7280; max-width: 760px; font-size: 0.9rem; line-height: 1.55; margin: 0; }

        .mr-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 14px; margin-bottom: 28px; }
        .mr-stat-card { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 16px 18px; display: flex; flex-direction: column; gap: 4px; position: relative; overflow: hidden; }
        .mr-stat-card::before { content: ''; position: absolute; top: 0; left: 0; width: 4px; height: 100%; background: var(--mr-accent, ${MARINE}); }
        .mr-stat-value { font-size: 1.75rem; font-weight: 700; color: ${MARINE}; line-height: 1; }
        .mr-stat-label { font-size: 0.78rem; color: #6b7280; }

        .mr-admins-card { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; margin-bottom: 20px; overflow: hidden; }
        .mr-admins-head { padding: 16px 20px; border-bottom: 1px solid #eef0f3; display: flex; align-items: center; gap: 10px; }
        .mr-admins-head h3 { font-size: 0.95rem; font-weight: 700; color: ${MARINE}; margin: 0; }
        .mr-admins-sub { font-size: 0.78rem; color: #9099a8; margin-left: auto; }
        .mr-admins-body { padding: 16px 20px; display: flex; flex-wrap: wrap; gap: 8px; }

        .mr-toolbar { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; margin-bottom: 16px; }
        .mr-search { position: relative; flex: 1; min-width: 260px; }
        .mr-search input { width: 100%; padding: 9px 14px 9px 38px; border: 1px solid #d8dce3; border-radius: 8px; font-size: 0.9rem; outline: none; transition: border-color .15s, box-shadow .15s; }
        .mr-search input:focus { border-color: ${MARINE}; box-shadow: 0 0 0 3px rgba(27,42,74,0.08); }
        .mr-search-icon { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: #9099a8; pointer-events: none; }
        .mr-filter-toggle { display: flex; align-items: center; gap: 7px; font-size: 0.85rem; color: #4b5563; white-space: nowrap; cursor: pointer; user-select: none; }
        .mr-filter-toggle input { accent-color: ${MARINE}; width: 15px; height: 15px; cursor: pointer; }

        .mr-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 12px; }
        .mr-shop-card { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 16px 18px; text-align: left; cursor: pointer; transition: border-color .12s, box-shadow .12s, transform .12s; position: relative; overflow: hidden; }
        .mr-shop-card::before { content: ''; position: absolute; top: 0; left: 0; width: 100%; height: 3px; background: var(--mr-card-accent, #d8dce3); }
        .mr-shop-card:hover { border-color: #c7cce0; box-shadow: 0 4px 14px rgba(27,42,74,0.08); transform: translateY(-1px); }
        .mr-shop-card:focus-visible { outline: 2px solid ${MARINE}; outline-offset: 2px; }
        .mr-shop-ref { font-weight: 700; color: ${MARINE}; font-size: 0.88rem; margin-bottom: 2px; }
        .mr-shop-name { font-size: 0.78rem; color: #6b7280; margin-bottom: 12px; min-height: 2.2em; }

        .mr-card-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .mr-recipient-count { display: inline-flex; align-items: center; gap: 6px; font-size: 0.78rem; font-weight: 600; color: ${MARINE}; }
        .mr-recipient-avatars { display: flex; }
        .mr-mini-avatar { width: 22px; height: 22px; border-radius: 50%; color: #fff; font-size: 0.6rem; font-weight: 700; display: flex; align-items: center; justify-content: center; border: 2px solid #fff; margin-left: -8px; }
        .mr-mini-avatar:first-child { margin-left: 0; }
        .mr-mini-more { background: #eef1f6; color: #6b7280; }

        .mr-empty-badge { display: inline-flex; align-items: center; gap: 6px; font-size: 0.76rem; font-weight: 600; color: #c0392b; }
        .mr-empty-dot { width: 6px; height: 6px; border-radius: 50%; background: #c0392b; flex-shrink: 0; }

        .mr-modal-backdrop { position: fixed; inset: 0; background: rgba(15,20,35,0.45); display: flex; align-items: center; justify-content: center; padding: 20px; z-index: 1000; }
        .mr-modal { background: #fff; border-radius: 14px; max-width: 540px; width: 100%; max-height: 80vh; display: flex; flex-direction: column; box-shadow: 0 20px 50px rgba(0,0,0,0.25); }
        .mr-modal-head { padding: 20px 24px 16px; border-bottom: 1px solid #eef0f3; display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
        .mr-modal-head h3 { font-size: 1.05rem; font-weight: 700; color: ${MARINE}; margin: 0 0 3px; }
        .mr-modal-head p { font-size: 0.82rem; color: #6b7280; margin: 0; }
        .mr-modal-close { background: none; border: none; color: #9099a8; cursor: pointer; font-size: 20px; line-height: 1; padding: 4px; flex-shrink: 0; }
        .mr-modal-close:hover { color: #26303f; }
        .mr-modal-body { padding: 18px 24px 24px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }

        .mr-chip { display: inline-flex; align-items: center; gap: 7px; padding: 4px 10px 4px 4px; border-radius: 20px; border: 1px solid; cursor: pointer; font-size: 0.8rem; line-height: 1.2; transition: filter .1s; }
        .mr-chip:hover { filter: brightness(0.97); }
        .mr-chip-block { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-radius: 10px; border: 1px solid; cursor: pointer; transition: filter .1s; width: 100%; }
        .mr-chip-block:hover { filter: brightness(0.97); }
        .mr-chip-block .mr-chip-checkbox { width: 15px; height: 15px; }
        .mr-chip-block .mr-chip-avatar { width: 30px; height: 30px; font-size: 0.7rem; }
        .mr-chip-block .mr-chip-name { font-size: 0.85rem; }
        .mr-chip-block .mr-chip-email { font-size: 0.74rem; }
        .mr-chip-checkbox { width: 13px; height: 13px; accent-color: ${ACCENT}; cursor: pointer; flex-shrink: 0; }
        .mr-chip-avatar { width: 22px; height: 22px; border-radius: 50%; color: #fff; font-size: 0.62rem; font-weight: 700; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .mr-chip-text { display: flex; flex-direction: column; line-height: 1.25; }
        .mr-chip-name { font-weight: 600; color: #26303f; }
        .mr-chip-email { font-size: 0.68rem; color: #9099a8; }

        .mr-no-result { text-align: center; color: #9099a8; padding: 40px 20px; font-size: 0.88rem; }
      `}</style>

      <div className="mr-header-row">
        <div className="mr-header-text">
          <h2>Destinataires des alertes email</h2>
          <p>
            Pour chaque magasin, les comptes qui reçoivent l'alerte de nouvelle proposition (rattachement direct + superviseurs).
            Les administrateurs reçoivent un récap global unique en fin de génération nocturne et de relance, plutôt qu'une
            alerte par magasin. Décochez une personne pour l'exclure de toutes les alertes email — cela ne change ni son rôle
            ni son accès à l'application.
          </p>
        </div>
      </div>

      {error && <div className="alert alert-danger">{error}</div>}

      {loading ? (
        <div className="text-center text-muted py-5">Chargement...</div>
      ) : data && stats ? (
        <>
          <div className="mr-stats">
            <div className="mr-stat-card" style={{ ['--mr-accent' as string]: MARINE }}>
              <span className="mr-stat-value">{stats.totalShops}</span>
              <span className="mr-stat-label">Magasins suivis</span>
            </div>
            <div className="mr-stat-card" style={{ ['--mr-accent' as string]: stats.shopsWithoutRecipient > 0 ? '#c0392b' : '#2f9e44' }}>
              <span className="mr-stat-value">{stats.shopsWithoutRecipient}</span>
              <span className="mr-stat-label">Magasins sans destinataire</span>
            </div>
            <div className="mr-stat-card" style={{ ['--mr-accent' as string]: ACCENT }}>
              <span className="mr-stat-value">{stats.activeAdmins} / {stats.totalAdmins}</span>
              <span className="mr-stat-label">Administrateurs actifs</span>
            </div>
            <div className="mr-stat-card" style={{ ['--mr-accent' as string]: MARINE }}>
              <span className="mr-stat-value">{stats.activeRecipients}</span>
              <span className="mr-stat-label">Comptes recevant des alertes</span>
            </div>
          </div>

          <div className="mr-admins-card">
            <div className="mr-admins-head">
              <iconify-icon icon="solar:shield-user-bold-duotone" style={{ color: MARINE, fontSize: 20 }}></iconify-icon>
              <h3>Administrateurs — récap global</h3>
              <span className="mr-admins-sub">{data.admins.length} compte{data.admins.length > 1 ? 's' : ''}</span>
            </div>
            <div className="mr-admins-body">
              {data.admins.length === 0 ? (
                <span className="text-muted small">Aucun administrateur actif.</span>
              ) : (
                data.admins.map((a) => renderUserChip(a))
              )}
            </div>
          </div>

          <div className="mr-toolbar">
            <div className="mr-search">
              <iconify-icon icon="solar:magnifer-linear" className="mr-search-icon" style={{ fontSize: 16 }}></iconify-icon>
              <input
                type="text"
                placeholder="Rechercher un magasin ou un destinataire..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <label className="mr-filter-toggle">
              <input type="checkbox" checked={onlyEmpty} onChange={(e) => setOnlyEmpty(e.target.checked)} />
              Magasins sans aucun destinataire
            </label>
          </div>

          {filteredShops.length === 0 ? (
            <div className="mr-no-result">Aucun résultat pour ce filtre.</div>
          ) : (
            <div className="mr-grid">
              {filteredShops.map((s) => {
                const hasRecipients = s.recipients.length > 0;
                const visibleAvatars = s.recipients.slice(0, 3);
                const extraCount = s.recipients.length - visibleAvatars.length;
                return (
                  <button
                    type="button"
                    key={s.shop.reference}
                    className="mr-shop-card"
                    style={{ ['--mr-card-accent' as string]: hasRecipients ? MARINE : '#c0392b' }}
                    onClick={() => setOpenShopRef(s.shop.reference)}
                  >
                    <div className="mr-shop-ref">{s.shop.reference}</div>
                    <div className="mr-shop-name">{s.shop.name}</div>
                    <div className="mr-card-footer">
                      {hasRecipients ? (
                        <>
                          <span className="mr-recipient-count">
                            <iconify-icon icon="solar:users-group-rounded-bold-duotone" style={{ fontSize: 16 }}></iconify-icon>
                            {s.recipients.length} destinataire{s.recipients.length > 1 ? 's' : ''}
                          </span>
                          <div className="mr-recipient-avatars">
                            {visibleAvatars.map((r) => (
                              <span key={r.id} className="mr-mini-avatar" style={{ backgroundColor: r.mailAlertsEnabled ? avatarColor(r.name) : '#c0392b' }}>
                                {initials(r.name)}
                              </span>
                            ))}
                            {extraCount > 0 && <span className="mr-mini-avatar mr-mini-more">+{extraCount}</span>}
                          </div>
                        </>
                      ) : (
                        <span className="mr-empty-badge">
                          <span className="mr-empty-dot" />
                          Aucun destinataire
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {openShop && (
            <div className="mr-modal-backdrop" onClick={() => setOpenShopRef(null)}>
              <div className="mr-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`Destinataires du magasin ${openShop.shop.reference}`}>
                <div className="mr-modal-head">
                  <div>
                    <h3>{openShop.shop.reference} — {openShop.shop.name}</h3>
                    <p>{openShop.recipients.length} destinataire{openShop.recipients.length > 1 ? 's' : ''} d'alerte email</p>
                  </div>
                  <button type="button" className="mr-modal-close" onClick={() => setOpenShopRef(null)} aria-label="Fermer">
                    <iconify-icon icon="solar:close-circle-linear"></iconify-icon>
                  </button>
                </div>
                <div className="mr-modal-body">
                  {openShop.recipients.length === 0 ? (
                    <span className="text-muted small">Aucun compte rattaché à ce magasin ne reçoit d'alerte email pour l'instant.</span>
                  ) : (
                    openShop.recipients.map((r) => renderUserChip(r, 'block'))
                  )}
                </div>
              </div>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
