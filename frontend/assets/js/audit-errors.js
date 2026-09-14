// Page "Journal d'audit" (base du debug global) : les erreurs brutes sauvées — toutes les
// pages frontend + toutes les API 5xx — avec leur contexte (qui, où, quand, IP, navigateur).
// Lecture seule : le regroupement en recommandations se fait page Améliorations IA.
(function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('fr-FR');
  }

  async function loadErrors() {
    const tbody = document.getElementById('err-tbody');
    if (!tbody) return;
    const source = document.getElementById('err-source').value;
    tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted py-3">Chargement...</td></tr>';
    try {
      const res = await window.reassortFetch('/reassort/error-reports/recent');
      const json = await res.json();
      if (!json.success) throw new Error(json.message);
      let rows = json.data.rows;
      if (source) rows = rows.filter(function (r) { return r.source === source; });
      document.getElementById('err-summary').textContent =
        json.data.total + ' erreur(s) journalisée(s) (30 derniers jours max, 100 affichées)' +
        (source ? ' — filtrées : ' + rows.length : '');
      tbody.innerHTML = rows.length ? rows.map(function (r) {
        return '<tr><td class="small text-nowrap">' + fmtDate(r.createdAt) + '</td>' +
          '<td><span class="badge ' + (r.source === 'frontend' ? 'bg-info' : 'bg-warning text-dark') + '">' + esc(r.source) + '</span></td>' +
          '<td class="small"><code>' + esc(r.page || (r.method ? r.method + ' ' : '') + (r.url || '')) + '</code></td>' +
          '<td class="small">' + esc(String(r.message).slice(0, 200)) + '</td>' +
          '<td class="small">' + esc(r.userEmail || '—') + '</td>' +
          '<td class="small"><code>' + esc(r.ip || '—') + '</code></td></tr>';
      }).join('') : '<tr><td colspan="6" class="text-center text-muted py-3">Aucune erreur journalisée.</td></tr>';
    } catch (err) {
      tbody.innerHTML = '<tr><td colspan="6" class="alert alert-danger">Erreur: ' + esc(err.message) + '</td></tr>';
    }
  }

  document.getElementById('err-source').addEventListener('change', loadErrors);
  document.getElementById('err-refresh').addEventListener('click', loadErrors);
  document.addEventListener('DOMContentLoaded', loadErrors);
})();
