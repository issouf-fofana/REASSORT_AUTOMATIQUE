// Variante de layout.js pour les pages migrées vers la barre de navigation "notch" (notch-nav.js,
// pilote du 26/09/2026 sur Guide du projet) : ne gère plus l'injection sidebar/topbar (notch-nav.js
// s'en charge lui-même, montage React sur #notch-nav-slot) ni les fonctions propres à cet ancien
// habillage (liens actifs par data-nav-item, groupes repliables, masquage sidebar desktop) — garde
// uniquement ce dont d'autres scripts dépendent réellement : titre de page, contexte magasin,
// remontée d'erreurs JS au Journal d'audit, retrait de l'écran de chargement.
(function () {
  // Titre de page (repris par ReassortNotch.tsx via #page-title, mais laissé ici pour compatibilité
  // si un script tiers lit document.title/#page-title avant le montage React).
  document.title = (document.body.dataset.pageTitle || document.title);

  window.reassortSetShopContext = function (posLabel, shopName, shopReference) {
    const el = document.getElementById('page-shop-context');
    if (!el) return;
    const user = window.reassortGetUser && window.reassortGetUser();
    if (!shopName || (user && !window.reassortIsSingleShopRole(user.role))) { el.style.display = 'none'; el.textContent = ''; return; }
    el.textContent = (posLabel ? posLabel + ' : ' : '') + shopName + (shopReference ? ' (' + shopReference + ')' : '');
    el.style.display = '';
  };

  // Debug global (Conseiller d'amélioration IA) — copié à l'identique de layout.js, cf. son
  // commentaire pour le détail (anti-bruit, dédup 60s, plafond 20 envois par page).
  (function initClientErrorReporting() {
    if (!window.fetch || !window.REASSORT_API_BASE) return;
    const seen = new Map();
    let sent = 0;
    function shouldSend(key) {
      const now = Date.now();
      if (seen.get(key) && now - seen.get(key) < 60000) return false;
      if (sent >= 20) return false;
      seen.set(key, now);
      return true;
    }
    function send(message, stack) {
      try {
        const token = localStorage.getItem('reassort_token');
        if (!token) return;
        const page = window.location.pathname;
        if (!shouldSend(page + '|' + String(message).slice(0, 200))) return;
        sent += 1;
        fetch(window.REASSORT_API_BASE + '/reassort/error-reports', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({ page: page, message: String(message).slice(0, 1000), stack: String(stack || '').slice(0, 2000) }),
          keepalive: true,
        }).catch(function () {});
      } catch (e) { /* le debug ne doit jamais casser la page */ }
    }
    window.addEventListener('error', function (e) {
      if (String(e.filename || '').indexOf('/error-reports') !== -1) return;
      send(e.message || 'Erreur JS inconnue', e.error && e.error.stack);
    });
    window.addEventListener('unhandledrejection', function (e) {
      const reason = e.reason;
      send((reason && (reason.message || String(reason))) || 'Promesse rejetée non capturée', reason && reason.stack);
    });
    window.reassortReportError = send;
  })();

  if (window.hideLoadingOverlay) setTimeout(window.hideLoadingOverlay, 100);
})();
