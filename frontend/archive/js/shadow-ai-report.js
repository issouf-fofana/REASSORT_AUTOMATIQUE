// Section "Mode Simulation — Humain vs IA" de la page ai-autonomy.html (phase 3 — 22/09/2026).
// Affiche, sur les lignes de commande où l'utilisateur a corrigé la quantité proposée par l'IA, qui
// avait raison au vu des ventes réellement constatées ensuite (backend: getShadowAiReport côté
// proposalService.js, endpoint GET /reassort/shadow-ai-report). Réagit au sélecteur de magasin
// global (window.reassortOnActiveShopChange), comme le reste de la page.
(function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function fmtDate(iso) {
    return iso ? new Date(iso).toLocaleDateString('fr-FR') : '—';
  }
  function fmtNum(n) {
    return (Math.round(n * 10) / 10).toLocaleString('fr-FR');
  }

  const VERDICT_LABELS = {
    AI_RIGHT: '<span class="badge bg-success-subtle text-success">IA avait raison</span>',
    HUMAN_RIGHT: '<span class="badge bg-primary-subtle text-primary">Correction justifiée</span>',
    TIED: '<span class="badge bg-secondary-subtle text-secondary">Égalité</span>',
  };

  function summaryHtml(data) {
    if (!data || data.correctedLines === 0) {
      return '<p class="text-muted mb-0">Aucune correction humaine mesurable pour le moment ' +
        '(il faut des commandes validées, dont la quantité a été modifiée avant validation, et dont ' +
        'les ventes réelles ont déjà été mesurées après coup).</p>';
    }
    const ratePct = data.aiConfidenceRate === null ? '—' : Math.round(data.aiConfidenceRate * 100) + '%';
    return (
      '<div class="d-flex flex-wrap gap-4 align-items-center">' +
      '<div><div class="h3 mb-0">' + ratePct + '</div><div class="small text-muted">l\'IA avait raison sur les corrections humaines</div></div>' +
      '<div><div class="h5 mb-0">' + data.correctedLines + '</div><div class="small text-muted">lignes corrigées mesurées</div></div>' +
      '<div><div class="h5 mb-0 text-success">' + data.aiWasRight + '</div><div class="small text-muted">IA avait raison</div></div>' +
      '<div><div class="h5 mb-0 text-primary">' + data.humanWasRight + '</div><div class="small text-muted">correction justifiée</div></div>' +
      '<div><div class="h5 mb-0 text-secondary">' + data.tied + '</div><div class="small text-muted">égalité</div></div>' +
      '</div>'
    );
  }

  function tableHtml(details) {
    if (!details.length) return '';
    return (
      '<table class="table table-sm table-hover mt-3">' +
      '<thead><tr><th>Date</th><th>Article</th><th class="text-end">Proposé (IA)</th><th class="text-end">Commandé</th>' +
      '<th class="text-end">Vendu réellement</th><th>Verdict</th></tr></thead>' +
      '<tbody>' + details.map(function (d) {
        return '<tr>' +
          '<td>' + fmtDate(d.validatedAt) + '</td>' +
          '<td>' + esc(d.label || d.ean) + '</td>' +
          '<td class="text-end">' + fmtNum(d.quantityAiOriginal) + '</td>' +
          '<td class="text-end">' + fmtNum(d.quantityValidated) + '</td>' +
          '<td class="text-end">' + fmtNum(d.actualSalesQuantity) + '</td>' +
          '<td>' + (VERDICT_LABELS[d.verdict] || esc(d.verdict)) + '</td>' +
          '</tr>';
      }).join('') + '</tbody></table>'
    );
  }

  async function load() {
    const summaryEl = document.getElementById('shadow-ai-summary');
    const tableEl = document.getElementById('shadow-ai-table');
    if (!summaryEl || !tableEl) return;

    // Un compte STORE n'a rien dans reassortGetActiveShop (pas de sélecteur affiché pour lui) : le
    // backend retombe alors sur son propre rposShopId (resolveShopId, middleware/auth.js) et ignore
    // ?shop= de toute façon — ne bloque donc l'appel que pour ADMIN/SUPERVISOR sans choix fait.
    const shop = window.reassortGetActiveShop ? window.reassortGetActiveShop() : null;
    const user = window.reassortGetUser ? window.reassortGetUser() : null;
    const isSingleShopRole = user && window.reassortIsSingleShopRole && window.reassortIsSingleShopRole(user.role);
    if (!shop && !isSingleShopRole) {
      summaryEl.innerHTML = '<p class="text-muted mb-0">Sélectionnez un magasin pour voir ce rapport.</p>';
      tableEl.innerHTML = '';
      return;
    }

    summaryEl.innerHTML = '<p class="text-muted mb-0">Chargement…</p>';
    tableEl.innerHTML = '';
    try {
      const res = await window.reassortFetch('/reassort/shadow-ai-report' + (shop ? '?shop=' + encodeURIComponent(shop.id) : ''));
      const json = await res.json();
      if (!json.success) throw new Error(json.message);
      summaryEl.innerHTML = summaryHtml(json.data);
      tableEl.innerHTML = tableHtml(json.data.details || []);
    } catch (err) {
      summaryEl.innerHTML = '<p class="text-danger mb-0">Erreur : ' + esc(err.message) + '</p>';
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    load();
    if (window.reassortOnActiveShopChange) window.reassortOnActiveShopChange(load);
  });
})();
