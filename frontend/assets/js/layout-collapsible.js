// Variante de layout.js avec DEUX états mutuellement exclusifs (demande explicite du 26/09/2026) :
//
//   ÉTAT 1 (par défaut) — sidebar/topbar Volt classiques, comme les 14 autres pages du site.
//   ÉTAT 2 — sidebar/topbar cachées, remplacées par la barre compacte "notch" (notch-nav.js) avec
//            flyouts au survol ; déclenché par le même bouton #sidebar-visibility-btn qui masquait
//            déjà la sidebar seule (cf. theme-override.css body.sidebar-hidden), mais qui affiche
//            maintenant la barre notch à la place plutôt que de laisser un vide.
//
// Les deux ne sont JAMAIS visibles en même temps : body.nav-collapsed pilote les deux à la fois
// (voir theme-override.css) — jamais deux classes indépendantes qui pourraient diverger.
(function () {
  function loadPartialSync(path) {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', path, false); // synchrone : volontaire, cf. layout.js pour le détail
    xhr.send(null);
    if (xhr.status !== 200 && xhr.status !== 0) {
      console.error('[layout-collapsible] Échec du chargement de ' + path + ' (HTTP ' + xhr.status + ')');
      return '';
    }
    return xhr.responseText;
  }

  const sidebarSlot = document.getElementById('layout-sidebar-slot');
  const topbarSlot = document.getElementById('layout-topbar-slot');
  const PARTIALS_VERSION = '2026-09-27-1';
  if (sidebarSlot) sidebarSlot.outerHTML = loadPartialSync('assets/partials/sidebar.html?v=' + PARTIALS_VERSION);
  if (topbarSlot) topbarSlot.outerHTML = loadPartialSync('assets/partials/topbar.html?v=' + PARTIALS_VERSION);

  // Sections repliables de la sidebar — identique à layout.js, cf. son commentaire pour le détail.
  (function initCollapsibleSidebarSections() {
    const COLLAPSE_KEY_PREFIX = 'sidebar-collapsed-';
    function isCollapsed(group) {
      try { return localStorage.getItem(COLLAPSE_KEY_PREFIX + group) !== '0'; } catch (err) { return true; }
    }
    function setCollapsed(group, collapsed) {
      try { localStorage.setItem(COLLAPSE_KEY_PREFIX + group, collapsed ? '1' : '0'); } catch (err) {}
    }
    function applyState(group) {
      const collapsed = isCollapsed(group);
      const heading = document.querySelector('[data-collapse-heading="' + group + '"]');
      if (heading) heading.classList.toggle('collapsed', collapsed);
      document.querySelectorAll('[data-collapse-group="' + group + '"]').forEach(function (li) {
        li.classList.toggle('sidebar-group-collapsed', collapsed);
      });
    }
    document.querySelectorAll('[data-collapse-heading]').forEach(function (heading) {
      const group = heading.dataset.collapseHeading;
      applyState(group);
      heading.addEventListener('click', function () {
        setCollapsed(group, !isCollapsed(group));
        applyState(group);
      });
    });
    let currentFile = window.location.pathname.split('/').pop() || 'index';
    currentFile = currentFile.replace(/\.html$/, '') || 'index';
    document.querySelectorAll('[data-collapse-group]').forEach(function (li) {
      const navItem = li.dataset.navItem ? li.dataset.navItem.replace(/\.html$/, '') : null;
      const isCurrentPage = navItem === currentFile || (li.dataset.navHref && currentFile === 'settings');
      if (isCurrentPage && isCollapsed(li.dataset.collapseGroup)) {
        setCollapsed(li.dataset.collapseGroup, false);
        applyState(li.dataset.collapseGroup);
      }
    });
  })();

  if (window.reassortRenderShopSelector) window.reassortRenderShopSelector();

  function stripHtmlExt(name) { return name.replace(/\.html$/, ''); }
  let currentPage = window.location.pathname.split('/').pop() || 'index';
  currentPage = stripHtmlExt(currentPage) || 'index';
  document.querySelectorAll('[data-nav-item]').forEach(function (li) {
    if (stripHtmlExt(li.dataset.navItem) === currentPage) li.classList.add('active');
  });
  document.querySelectorAll('.sidebar .sidebar-text').forEach(function (span) {
    if (!span.title) span.title = span.textContent.trim();
  });

  const DEFAULT_TAB_BY_PAGE = { settings: 'tab-reassort', 'ai-quality': 'tab-improvements' };
  function refreshHashActive() {
    const defaultTab = DEFAULT_TAB_BY_PAGE[currentPage];
    const hash = window.location.hash.replace('#', '');
    document.querySelectorAll('[data-nav-href]').forEach(function (li) {
      const match = defaultTab && (hash ? li.dataset.navHref === hash : li.dataset.navHref === defaultTab);
      li.classList.toggle('active', !!match);
    });
  }
  refreshHashActive();
  window.addEventListener('hashchange', refreshHashActive);

  const pageTitleEl = document.getElementById('page-title');
  if (pageTitleEl) pageTitleEl.textContent = document.body.dataset.pageTitle || '';

  window.reassortSetShopContext = function (posLabel, shopName, shopReference) {
    // querySelectorAll, pas getElementById : #page-shop-context existe en double (topbar classique +
    // barre notch, toutes deux dans le DOM en même temps, cf. global-shop-selector.js) — même bug de
    // synchronisation que le sélecteur de magasin sinon.
    const els = document.querySelectorAll('#page-shop-context');
    if (!els.length) return;
    const user = window.reassortGetUser && window.reassortGetUser();
    const hide = !shopName || (user && !window.reassortIsSingleShopRole(user.role));
    els.forEach(function (el) {
      if (hide) { el.style.display = 'none'; el.textContent = ''; return; }
      el.textContent = (posLabel ? posLabel + ' : ' : '') + shopName + (shopReference ? ' (' + shopReference + ')' : '');
      el.style.display = '';
    });
  };

  // --- Bascule ÉTAT 1 <-> ÉTAT 2 ------------------------------------------------------------
  // Une seule classe (body.nav-collapsed) pilote tout à la fois : masquage sidebar/topbar (CSS,
  // cf. theme-override.css), affichage de la barre notch (#notch-nav-slot), et suppression de la
  // marge de contenu réservée à la sidebar — jamais deux mécanismes indépendants qui pourraient
  // diverger et laisser les deux navigations visibles ensemble (règle absolue de la demande).
  const NAV_COLLAPSED_KEY = 'nav-collapsed';
  const notchSlot = document.getElementById('notch-nav-slot');

  function applyNavState(collapsed) {
    document.body.classList.toggle('nav-collapsed', collapsed);
    if (notchSlot) notchSlot.style.display = collapsed ? '' : 'none';
  }
  let navCollapsed = false;
  try { navCollapsed = localStorage.getItem(NAV_COLLAPSED_KEY) === '1'; } catch (err) { navCollapsed = false; }
  applyNavState(navCollapsed);

  function setNavCollapsed(collapsed) {
    navCollapsed = collapsed;
    try { localStorage.setItem(NAV_COLLAPSED_KEY, collapsed ? '1' : '0'); } catch (err) {}
    applyNavState(collapsed);
  }

  // Seul chemin de retour à l'ÉTAT 1 depuis la barre notch (bouton "Afficher le menu latéral",
  // ReassortNotch.tsx) — jamais un flyout ne doit pouvoir déclencher ceci.
  window.reassortExpandSidebar = function () { setNavCollapsed(false); };

  document.addEventListener('click', function (e) {
    const btn = e.target && e.target.closest ? e.target.closest('#sidebar-visibility-btn') : null;
    if (!btn) return;
    setNavCollapsed(!navCollapsed);
  });

  // Debug global (Conseiller d'amélioration IA) — identique à layout.js, cf. son commentaire.
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
      } catch (e) {}
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
