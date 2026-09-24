// Page "Journal des erreurs" (demande du 21/09/2026) : consulte les erreurs API 5xx déjà capturées
// automatiquement en base (ErrorReport, hook global server.js) — jusqu'ici uniquement consultable
// via une requête SQL directe, jamais depuis l'UI.
(function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function fmtDate(iso) {
    return iso ? new Date(iso).toLocaleString('fr-FR') : '—';
  }

  function badgeClassFor(statusCode) {
    if (statusCode >= 500 && statusCode < 502) return 'bg-danger-subtle text-danger';
    return 'bg-warning-subtle text-warning'; // 502/503/504 : souvent transitoire (RPOS injoignable), moins critique qu'un vrai bug 500
  }

  function cardFor(e) {
    return (
      '<div class="card mb-2">' +
      '<div class="card-body">' +
      '<div class="d-flex justify-content-between align-items-start flex-wrap gap-2">' +
      '<div>' +
      '<span class="badge ' + badgeClassFor(e.statusCode) + '">' + e.statusCode + '</span> ' +
      '<span class="fw-semibold">' + esc(e.method) + ' ' + esc(e.url.replace(/^(GET|POST|PUT|DELETE|PATCH)\s+/, '')) + '</span>' +
      '</div>' +
      '<span class="small text-muted">' + fmtDate(e.createdAt) + '</span>' +
      '</div>' +
      '<div class="mt-2">' + esc(e.message) + '</div>' +
      '<div class="small text-muted mt-2">' +
      (e.userEmail ? 'Utilisateur : ' + esc(e.userEmail) + ' — ' : '') +
      (e.ip ? 'IP : ' + esc(e.ip) : '') +
      '</div>' +
      (e.stack ? '<details class="mt-2"><summary class="small text-muted" style="cursor:pointer;">Détail technique (stack trace)</summary><pre class="small mt-1 mb-0" style="white-space:pre-wrap;">' + esc(e.stack) + '</pre></details>' : '') +
      '</div></div>'
    );
  }

  async function loadList() {
    const listEl = document.getElementById('el-list');
    if (!listEl) return;
    listEl.innerHTML = '<div class="text-center text-muted py-4">Chargement...</div>';
    try {
      const params = new URLSearchParams();
      const search = document.getElementById('el-search').value.trim();
      const status = document.getElementById('el-status').value;
      if (search) params.set('search', search);
      if (status) params.set('statusCode', status);
      const res = await window.reassortFetch('/reassort/error-reports?' + params.toString());
      const json = await res.json();
      if (!json.success) throw new Error(json.message);
      const rows = json.data || [];
      document.getElementById('el-summary').textContent = rows.length + ' erreur(s)';
      listEl.innerHTML = rows.length
        ? rows.map(cardFor).join('')
        : '<div class="text-center text-muted py-4">Aucune erreur pour ce filtre.</div>';
    } catch (err) {
      listEl.innerHTML = '<div class="alert alert-danger">' + esc(err.message) + '</div>';
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('el-refresh').addEventListener('click', loadList);
    document.getElementById('el-status').addEventListener('change', loadList);
    let searchTimer = null;
    document.getElementById('el-search').addEventListener('input', function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(loadList, 400);
    });
    loadList();
  });
})();
