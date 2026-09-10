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
  if (sidebarSlot) sidebarSlot.outerHTML = loadPartialSync('assets/partials/sidebar.html');
  if (topbarSlot) topbarSlot.outerHTML = loadPartialSync('assets/partials/topbar.html');

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
  document.querySelectorAll('[data-nav-group]').forEach(function (li) {
    const pages = li.dataset.navGroup.split(',').map(stripHtmlExt);
    if (pages.indexOf(currentPage) === -1) return;
    li.classList.add('active');
    const toggle = li.querySelector('[data-bs-toggle="collapse"]');
    const submenu = li.querySelector('.multi-level');
    if (toggle) toggle.setAttribute('aria-expanded', 'true');
    if (submenu) {
      submenu.classList.add('show');
      submenu.setAttribute('aria-expanded', 'true');
    }
  });

  // Titre de page (topbar) : fourni par chaque page via <body data-page-title="...">.
  const pageTitleEl = document.getElementById('page-title');
  if (pageTitleEl) pageTitleEl.textContent = document.body.dataset.pageTitle || '';
})();
