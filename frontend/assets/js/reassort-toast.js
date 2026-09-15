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
})();
