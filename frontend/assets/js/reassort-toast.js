/**
 * Notification toast (remplace alert() natif, style système incohérent avec le reste de
 * l'application — demande du 15/09/2026). Noir/blanc avec un léger accent de couleur sémantique
 * (succès/erreur/info), cohérent avec le reste de l'appli (jamais de bleu comme accent principal).
 *
 * Usage : window.reassortToast(message, type) — type: 'success' | 'error' | 'info' (défaut 'info').
 */
(function () {
  const CSS = `
    #reassort-toast-container {
      position: fixed; bottom: 24px; right: 24px; z-index: 2000;
      display: flex; flex-direction: column; gap: .5rem; max-width: 380px;
    }
    .reassort-toast {
      background-color: #000000; color: #ffffff; padding: .85rem 1.1rem;
      border-radius: 4px; box-shadow: 0 4px 16px rgba(0,0,0,.25);
      font-size: .9rem; line-height: 1.4; display: flex; align-items: flex-start; gap: .6rem;
      animation: reassort-toast-in .2s ease;
    }
    .reassort-toast.hide { animation: reassort-toast-out .2s ease forwards; }
    @keyframes reassort-toast-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes reassort-toast-out { from { opacity: 1; } to { opacity: 0; transform: translateY(8px); } }
    .reassort-toast-icon { flex-shrink: 0; font-size: 1.1rem; line-height: 1; }
    .reassort-toast-success .reassort-toast-icon { color: #4ade80; }
    .reassort-toast-error .reassort-toast-icon { color: #f87171; }
    .reassort-toast-info .reassort-toast-icon { color: #9ca3af; }
    .reassort-toast-close { background: none; border: none; color: #9ca3af; cursor: pointer; margin-left: auto; padding: 0; font-size: 1rem; line-height: 1; flex-shrink: 0; }
    .reassort-toast-close:hover { color: #ffffff; }

    #reassort-confirm-overlay {
      position: fixed; inset: 0; background-color: rgba(0,0,0,.5); z-index: 2100;
      display: flex; align-items: center; justify-content: center; padding: 1rem;
      animation: reassort-confirm-fade .15s ease;
    }
    @keyframes reassort-confirm-fade { from { opacity: 0; } to { opacity: 1; } }
    .reassort-confirm-box {
      background-color: #ffffff; color: #111111; border-radius: 6px; max-width: 440px; width: 100%;
      box-shadow: 0 12px 40px rgba(0,0,0,.3); overflow: hidden;
    }
    .reassort-confirm-body { padding: 1.25rem 1.25rem 1rem; font-size: .92rem; line-height: 1.5; white-space: pre-line; }
    .reassort-confirm-footer { padding: .85rem 1.25rem; display: flex; justify-content: flex-end; gap: .5rem; border-top: 1px solid #eee; }
    .reassort-confirm-footer button { border: none; border-radius: 4px; padding: .45rem 1rem; font-size: .85rem; cursor: pointer; }
    .reassort-confirm-cancel { background-color: #f0f0f0; color: #333333; }
    .reassort-confirm-cancel:hover { background-color: #e2e2e2; }
    .reassort-confirm-ok { background-color: #000000; color: #ffffff; }
    .reassort-confirm-ok:hover { background-color: #262626; }
    .reassort-confirm-ok.danger { background-color: #dc2626; }
    .reassort-confirm-ok.danger:hover { background-color: #b91c1c; }
  `;

  const ICONS = { success: '✓', error: '✗', info: 'ℹ' };
  const AUTO_DISMISS_MS = 5000;

  function ensureContainer() {
    let container = document.getElementById('reassort-toast-container');
    if (container) return container;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    container = document.createElement('div');
    container.id = 'reassort-toast-container';
    document.body.appendChild(container);
    return container;
  }

  window.reassortToast = function (message, type) {
    type = ICONS[type] ? type : 'info';
    const container = ensureContainer();
    const toast = document.createElement('div');
    toast.className = 'reassort-toast reassort-toast-' + type;
    toast.innerHTML =
      '<span class="reassort-toast-icon">' + ICONS[type] + '</span>' +
      '<span></span>' +
      '<button type="button" class="reassort-toast-close" aria-label="Fermer">&times;</button>';
    toast.querySelector('span:nth-child(2)').textContent = message;
    container.appendChild(toast);

    function dismiss() {
      toast.classList.add('hide');
      setTimeout(function () { toast.remove(); }, 200);
    }
    toast.querySelector('.reassort-toast-close').addEventListener('click', dismiss);
    setTimeout(dismiss, AUTO_DISMISS_MS);
  };

  /**
   * Confirmation stylée (remplace confirm()/window.confirm() natifs). Retourne une Promise<boolean>.
   * Usage : const ok = await window.reassortConfirm(message, { danger: true, okLabel: 'Supprimer' });
   */
  window.reassortConfirm = function (message, options) {
    options = options || {};
    ensureContainer();
    return new Promise(function (resolve) {
      const overlay = document.createElement('div');
      overlay.id = 'reassort-confirm-overlay';
      overlay.innerHTML =
        '<div class="reassort-confirm-box">' +
        '<div class="reassort-confirm-body"></div>' +
        '<div class="reassort-confirm-footer">' +
        '<button type="button" class="reassort-confirm-cancel">' + (options.cancelLabel || 'Annuler') + '</button>' +
        '<button type="button" class="reassort-confirm-ok' + (options.danger ? ' danger' : '') + '">' + (options.okLabel || 'OK') + '</button>' +
        '</div></div>';
      overlay.querySelector('.reassort-confirm-body').textContent = message;
      document.body.appendChild(overlay);

      function close(result) {
        overlay.remove();
        resolve(result);
      }
      overlay.querySelector('.reassort-confirm-cancel').addEventListener('click', function () { close(false); });
      overlay.querySelector('.reassort-confirm-ok').addEventListener('click', function () { close(true); });
      overlay.addEventListener('click', function (e) { if (e.target === overlay) close(false); });
      document.addEventListener('keydown', function escHandler(e) {
        if (e.key === 'Escape') { document.removeEventListener('keydown', escHandler); close(false); }
      });
    });
  };
})();
