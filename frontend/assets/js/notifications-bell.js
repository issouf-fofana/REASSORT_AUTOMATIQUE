// Rend fonctionnelle la cloche de notification de la topbar (jusqu'ici purement décorative,
// "Aucune notification" en dur dans topbar.html) — demande du 22/09/2026 : "quand il y a un
// souci non résolu il doit me faire des relances pour que je réglé au plus vite". Affiche les
// constats d'Améliorations IA ouverts depuis plus longtemps que leur seuil de relance (cf.
// improvementService.getStaleImprovements, backend). Réservé ADMIN (même portée que la page
// Améliorations IA elle-même, requireAdmin côté backend) : un compte STORE n'a de toute façon rien
// à faire de ces constats globaux multi-magasins.
(function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  const PRIORITY_LABEL = { CRITICAL: 'Critique', HIGH: 'Élevée', MEDIUM: 'Moyenne', LOW: 'Faible' };

  function renderDropdown(items) {
    const menu = document.getElementById('page-header-notifications-dropdown');
    if (!menu) return;
    const dropdown = menu.parentElement.querySelector('.dropdown-menu');
    if (!dropdown) return;

    const badge = document.getElementById('notif-bell-badge') || (function () {
      const b = document.createElement('span');
      b.id = 'notif-bell-badge';
      b.className = 'badge bg-danger rounded-pill position-absolute';
      b.style.cssText = 'top: 2px; right: 2px; font-size: .6rem; padding: .25em .4em;';
      menu.style.position = 'relative';
      menu.appendChild(b);
      return b;
    })();
    badge.style.display = items.length ? '' : 'none';
    badge.textContent = items.length > 9 ? '9+' : String(items.length);

    if (!items.length) {
      dropdown.innerHTML = '<a href="#" class="text-center text-primary fw-bold border-bottom border-light py-3 d-block">Notifications</a>' +
        '<div class="text-center text-muted small p-3">Aucune relance en attente</div>';
      return;
    }

    dropdown.innerHTML = '<a href="/ai-quality#tab-corrections" class="text-center text-primary fw-bold border-bottom border-light py-3 d-block">' +
      items.length + ' constat(s) à relancer</a>' +
      '<div style="max-height: 320px; overflow-y: auto;">' +
      items.slice(0, 8).map(function (it) {
        return '<a href="/ai-quality#tab-corrections" class="dropdown-item border-bottom border-light py-2 small">' +
          '<div class="d-flex justify-content-between gap-2">' +
          '<span class="fw-semibold">' + esc(it.title) + '</span>' +
          '<span class="badge bg-warning-subtle text-warning flex-shrink-0">' + (PRIORITY_LABEL[it.priority] || it.priority) + '</span>' +
          '</div>' +
          '<div class="text-muted">Ouvert depuis ' + it.ageDays + ' jour(s), sans action</div>' +
          '</a>';
      }).join('') +
      '</div>' +
      (items.length > 8 ? '<a href="/ai-quality#tab-corrections" class="text-center small py-2 d-block border-top">Voir tout (' + items.length + ')</a>' : '');
  }

  async function loadStaleImprovements() {
    try {
      const res = await window.reassortFetch('/reassort/improvements/stale');
      const json = await res.json();
      if (!json.success) return;
      renderDropdown(json.data || []);
    } catch (err) {
      // Silencieux : une cloche de notification qui échoue à charger ne doit jamais bloquer
      // ou polluer visuellement une page dont ce n'est pas le sujet principal.
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    const user = window.reassortGetUser && window.reassortGetUser();
    if (!user || user.role !== 'ADMIN') return;
    // layout.js injecte la topbar de façon synchrone avant DOMContentLoaded (cf. son propre
    // commentaire), donc #page-header-notifications-dropdown existe déjà à ce stade.
    loadStaleImprovements();
  });
})();
