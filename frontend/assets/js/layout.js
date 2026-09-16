// Injecte la sidebar et la topbar Volt (partagées entre toutes les pages, cf.
// assets/partials/sidebar.html et topbar.html) dans les emplacements réservés
// #layout-sidebar-slot et #layout-topbar-slot, marque le lien actif d'après l'URL
// courante, et pose le titre de page depuis <body data-page-title="...">.
//
// reassort-auth.js et les scripts propres à chaque page dépendent d'éléments injectés
// ici (#menu-item-users, #menu-item-admin-dashboard, #user-menu-name, #page-title) et
// s'exécutent sur DOMContentLoaded : ce fichier doit donc avoir fini d'injecter AVANT
// que DOMContentLoaded ne se déclenche pour eux. On charge donc les partiels de façon
// bloquante via une requête synchrone (XMLHttpRequest), seule option sans étape de build
// ni changement du chargement des scripts existants.
(function () {
  function loadPartialSync(path) {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', path, false); // synchrone : volontaire, cf. commentaire ci-dessus
    xhr.send(null);
    if (xhr.status !== 200 && xhr.status !== 0) {
      console.error('[layout] Échec du chargement de ' + path + ' (HTTP ' + xhr.status + ')');
      return '';
    }
    return xhr.responseText;
  }

  const sidebarSlot = document.getElementById('layout-sidebar-slot');
  const topbarSlot = document.getElementById('layout-topbar-slot');
  // Les partiels sont chargés en XHR donc mis en cache par le navigateur : sans version, un
  // nouveau lien sidebar (ex: Améliorations IA) reste invisible tant que l'utilisateur ne vide
  // pas son cache manuellement. Incrémenter PARTIALS_VERSION à chaque modification de
  // sidebar.html/topbar.html (règle : toute fonctionnalité = lien sidebar + page dédiée).
  const PARTIALS_VERSION = '2026-09-16-9';
  if (sidebarSlot) sidebarSlot.outerHTML = loadPartialSync('assets/partials/sidebar.html?v=' + PARTIALS_VERSION);
  if (topbarSlot) topbarSlot.outerHTML = loadPartialSync('assets/partials/topbar.html?v=' + PARTIALS_VERSION);

  // Sections repliables de la sidebar (Réassort, Administration — demande du 16/09/2026). État
  // mémorisé en localStorage (pas de dépendance à Bootstrap collapse : son état vit dans le DOM,
  // détruit à chaque ré-injection de ce partiel sur chaque page, cf. bug du 14/09/2026 où le menu
  // "se refermait" — ici l'état SURVIT à la navigation). Par défaut (rien en localStorage) : ouvert,
  // comportement identique à l'ancienne sidebar plate tant que l'utilisateur n'a rien replié.
  //
  // Le pliage utilise une classe CSS (.sidebar-group-collapsed sur le <ul> parent), JAMAIS
  // style.display sur les <li> individuels : reassort-auth.js révèle certains de ces mêmes <li>
  // (liens ADMIN) sur DOMContentLoaded, qui se déclenche APRÈS ce script (chargé en <head>, avant le
  // corps de page) — s'il fixait lui-même style.display, il effacerait par erreur un display:none
  // légitime posé pour un rôle non-admin, ou l'inverse. Une règle CSS (`[data-collapse-group="x"]`
  // sous un ancêtre `.sidebar-group-collapsed`) laisse chaque <li> garder son propre style.display
  // inline intact — reassort-auth.js reste l'unique source de vérité sur "ce lien existe-t-il pour
  // ce rôle", le pliage ne fait qu'ajouter une couche par-dessus qui masque tout le groupe.
  (function initCollapsibleSidebarSections() {
    const COLLAPSE_KEY_PREFIX = 'sidebar-collapsed-';
    function isCollapsed(group) {
      try { return localStorage.getItem(COLLAPSE_KEY_PREFIX + group) === '1'; } catch (err) { return false; }
    }
    function setCollapsed(group, collapsed) {
      try { localStorage.setItem(COLLAPSE_KEY_PREFIX + group, collapsed ? '1' : '0'); } catch (err) { /* état non persistant si le stockage est indisponible */ }
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
    // Ne jamais cacher la page où l'utilisateur se trouve déjà : si l'item actif appartient à un
    // groupe replié, on le déplie automatiquement au chargement (une seule fois, avant que
    // data-nav-item/data-nav-href ne marquent l'état actif juste après).
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

  // Le sélecteur de magasin global (global-shop-selector.js) est chargé en <head>, avant que la
  // topbar ci-dessus n'injecte #global-shop-selector-btn dans le DOM : son tout premier rendu
  // échoue donc silencieusement (élément introuvable). On le redéclenche explicitement maintenant
  // que la topbar existe réellement — sans ce rappel, le bouton restait invisible sur toute page
  // où aucune sélection de magasin n'avait encore eu lieu ailleurs (bug observé le 15/09/2026).
  if (window.reassortRenderShopSelector) window.reassortRenderShopSelector();

  // Item de navigation actif : correspondance sur le nom de fichier de la page courante. Les
  // data-nav-item/data-nav-group gardent le suffixe ".html" (valeur historique, encore utilisée
  // par purchase-order.html pour son propre routage interne) — on normalise donc les deux côtés
  // (URL courante ET valeurs comparées) en retirant ".html" avant de comparer, pour fonctionner
  // aussi bien avec l'ancienne forme (/admin-dashboard.html) que l'URL propre servie par nginx
  // (/admin-dashboard, cf. frontend/nginx.conf) sans avoir à réécrire ces attributs partout.
  function stripHtmlExt(name) { return name.replace(/\.html$/, ''); }
  let currentPage = window.location.pathname.split('/').pop() || 'index';
  currentPage = stripHtmlExt(currentPage) || 'index';
  document.querySelectorAll('[data-nav-item]').forEach(function (li) {
    if (stripHtmlExt(li.dataset.navItem) === currentPage) li.classList.add('active');
  });
  // Sous-liens Paramètres (sidebar plate, sans groupe repliable) : actif suivi via le hash
  // (#tab-xxx), en live lors des clics sidebar sans rechargement. Sans hash sur /settings,
  // l'onglet affiché par défaut est tab-reassort (cf. openTabFromHash dans settings.html).
  function refreshHashActive() {
    const onSettings = currentPage === 'settings';
    const hash = window.location.hash.replace('#', '');
    document.querySelectorAll('[data-nav-href]').forEach(function (li) {
      const match = onSettings && (hash ? li.dataset.navHref === hash : li.dataset.navHref === 'tab-reassort');
      li.classList.toggle('active', !!match);
    });
  }
  refreshHashActive();
  window.addEventListener('hashchange', refreshHashActive);

  // Titre de page (topbar) : fourni par chaque page via <body data-page-title="...">.
  const pageTitleEl = document.getElementById('page-title');
  if (pageTitleEl) pageTitleEl.textContent = document.body.dataset.pageTitle || '';

  // Contexte magasin sous le titre de page (style RPOS "Serveur X : NOM MAGASIN (CODE)", demande
  // du 14/09/2026) : appelé par shop-picker.js à chaque sélection, pour ne pas dupliquer cette
  // logique sur chaque page qui a un sélecteur de magasin.
  //
  // Affiché en LECTURE SEULE uniquement pour un compte STORE (un seul magasin possible, rien à
  // choisir). Pour ADMIN/SUPERVISOR, le sélecteur global cliquable (#global-shop-selector-btn, cf.
  // global-shop-selector.js) fait déjà ce travail — les deux affichés en même temps créaient un
  // doublon visuel (bug observé : "CASH CENTER ZONE 4" en lecture seule ET "SUPER U VALLON"
  // cliquable superposés), la décision est donc centralisée ici plutôt que dans chaque appelant.
  window.reassortSetShopContext = function (posLabel, shopName, shopReference) {
    const el = document.getElementById('page-shop-context');
    if (!el) return;
    const user = window.reassortGetUser && window.reassortGetUser();
    if (!shopName || (user && !window.reassortIsSingleShopRole(user.role))) { el.style.display = 'none'; el.textContent = ''; return; }
    el.textContent = (posLabel ? posLabel + ' : ' : '') + shopName + (shopReference ? ' (' + shopReference + ')' : '');
    el.style.display = '';
  };

  // Masquer/afficher la sidebar sur desktop (bouton #sidebar-visibility-btn de la topbar,
  // demande du 14/09/2026) : état mémorisé en localStorage, appliqué avant le premier rendu
  // pour éviter un flash du menu. En délégation (le bouton est injecté avec la topbar).
  const SIDEBAR_HIDDEN_KEY = 'sidebar-hidden';
  try {
    if (localStorage.getItem(SIDEBAR_HIDDEN_KEY) === '1') document.body.classList.add('sidebar-hidden');
  } catch (err) { /* stockage indisponible : menu toujours visible */ }
  document.addEventListener('click', function (e) {
    const btn = e.target && e.target.closest ? e.target.closest('#sidebar-visibility-btn') : null;
    if (!btn) return;
    const hidden = document.body.classList.toggle('sidebar-hidden');
    try { localStorage.setItem(SIDEBAR_HIDDEN_KEY, hidden ? '1' : '0'); } catch (err) {}
  });

  // Debug global (Conseiller d'amélioration IA) : remonte TOUTES les erreurs JS non capturées
  // de CHAQUE page interne (window.onerror + promesses rejetées) vers ErrorReport — le chien de
  // garde les regroupe en constats avec le message exact. Anti-bruit : dédup 60s par
  // (page+message), plafond 20 envois par page chargée, et les échecs du capteur lui-même ne
  // sont jamais remontés (pas de boucle). Requiert le token (pages internes uniquement).
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

    // Exposé pour tout code qui CATCH volontairement une erreur pour l'afficher proprement à
    // l'utilisateur (message "Erreur : ..." dans une bulle de chat, un toast...) — ces erreurs ne
    // remontent JAMAIS via window.onerror/unhandledrejection puisqu'elles sont gérées, donc
    // resteraient invisibles au Conseiller d'amélioration IA sans cet appel explicite (trouvé le
    // 16/09/2026 : le widget Assistant IA affichait "Flux terminé sans réponse exploitable." sans
    // que le Journal d'audit n'en garde jamais trace). Même anti-bruit (dédup, plafond) que les
    // erreurs automatiques.
    window.reassortReportError = send;
  })();

  // Sidebar/topbar injectées, page prête à s'afficher : retire l'écran de chargement (cf.
  // loading-overlay.js, chargé avant ce script dans chaque page). Un léger délai laisse le temps
  // au navigateur de peindre le DOM injecté avant de révéler la page, pour éviter un flash brut.
  if (window.hideLoadingOverlay) setTimeout(window.hideLoadingOverlay, 100);
})();
