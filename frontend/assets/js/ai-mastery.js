// Page "Mémoire du modèle" (maîtrise par domaine métier, demande du 17/09/2026) : affiche le
// niveau de maîtrise/confiance de chaque domaine (capacités RBAC IA), avec la méthode de calcul
// explicite (vérité-terrain réelle pour "accuracy", volume de corrections pour les autres) et les
// erreurs récurrentes connues.
(function () {
  const DOMAIN_LABEL = {
    revenueShop: 'CA magasin', revenueArticle: 'CA article/rayon', articleDetails: 'Fiche article',
    stock: 'Stock', sales: 'Ventes', orders: 'Commandes', accuracy: 'Précision des prévisions', code: 'Code / technique',
  };
  const METHOD_LABEL = { ACCURACY_OUTCOME: 'Précision réelle (vérité terrain)', CORRECTION_VOLUME: 'Volume de corrections' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function fmtDate(iso) {
    return iso ? new Date(iso).toLocaleString('fr-FR') : 'jamais calculé';
  }
  function el(id) {
    const e = document.getElementById(id);
    if (!e) console.warn('[mastery] élément manquant (page en cache ? Ctrl+F5) : #' + id);
    return e;
  }
  function on(id, event, fn) {
    const e = (id instanceof Element) ? id : el(id);
    if (e) e.addEventListener(event, fn);
    return e;
  }

  function barClass(score) {
    if (score >= 80) return 'mastery-high';
    if (score >= 50) return 'mastery-mid';
    return 'mastery-low';
  }

  function cardFor(m) {
    const issues = (m.knownIssues || []).map((i) => (
      '<li>' + esc(i.label) + ' <span class="text-muted">(x' + i.count + ')</span></li>'
    )).join('');
    return (
      '<div class="card mb-2">' +
      '<div class="card-body">' +
      '<div class="d-flex justify-content-between align-items-center flex-wrap gap-2">' +
      '<h6 class="mb-0">' + esc(DOMAIN_LABEL[m.domain] || m.domain) + '</h6>' +
      '<span class="badge bg-secondary">' + esc(METHOD_LABEL[m.method] || m.method) + '</span>' +
      '</div>' +
      '<div class="row mt-2 align-items-center">' +
      '<div class="col-md-6">' +
      '<div class="d-flex justify-content-between small mb-1"><span>Maîtrise</span><span>' + Math.round(m.masteryScore) + ' / 100</span></div>' +
      '<div class="mastery-bar"><div class="mastery-bar-fill ' + barClass(m.masteryScore) + '" style="width:' + Math.round(m.masteryScore) + '%;"></div></div>' +
      '</div>' +
      '<div class="col-md-6">' +
      '<div class="d-flex justify-content-between small mb-1"><span>Confiance (taille échantillon)</span><span>' + Math.round(m.confidenceScore) + ' / 100</span></div>' +
      '<div class="mastery-bar"><div class="mastery-bar-fill bg-secondary" style="width:' + Math.round(m.confidenceScore) + '%;"></div></div>' +
      '</div>' +
      '</div>' +
      '<div class="small text-muted mt-2">' +
      m.totalObservations + ' observation(s) — ' + m.correctionCount + ' correction(s) journalisée(s) — dernier calcul : ' + fmtDate(m.lastEvaluatedAt) +
      '</div>' +
      (issues ? '<div class="small mt-2"><strong>Erreurs récurrentes :</strong><ul class="mb-0">' + issues + '</ul></div>' : '') +
      '</div></div>'
    );
  }

  async function load() {
    const listEl = el('mastery-list');
    if (!listEl) return;
    listEl.innerHTML = '<div class="text-center text-muted py-4">Chargement...</div>';
    try {
      const res = await window.reassortFetch('/reassort/mastery');
      const json = await res.json();
      if (!json.success) throw new Error(json.message);
      const rows = json.data || [];
      if (el('mastery-summary')) el('mastery-summary').textContent = rows.length + ' domaine(s)';
      listEl.innerHTML = rows.map(cardFor).join('') || '<div class="text-center text-muted py-4">Aucune donnée.</div>';
    } catch (err) {
      listEl.innerHTML = '<div class="alert alert-danger">' + esc(err.message) + '</div>';
    }
  }

  async function recompute() {
    const btn = el('mastery-recompute');
    if (btn) { btn.disabled = true; btn.textContent = 'Calcul en cours...'; }
    try {
      const res = await window.reassortFetch('/reassort/mastery/recompute', { method: 'POST' });
      const json = await res.json();
      if (!json.success) throw new Error(json.message);
      const rows = json.data || [];
      if (el('mastery-summary')) el('mastery-summary').textContent = rows.length + ' domaine(s)';
      el('mastery-list').innerHTML = rows.map(cardFor).join('');
    } catch (err) {
      window.reassortToast ? window.reassortToast('Erreur : ' + err.message, 'error') : alert(err.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Recalculer maintenant'; }
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    on('mastery-recompute', 'click', recompute);
    load();
  });
})();
