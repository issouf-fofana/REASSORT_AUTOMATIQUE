// Page "Journal des corrections" (mémoire de correction, demande du 17/09/2026) : liste et détail
// des entrées CorrectionRecord — auto-corrections IA confirmées (AI_AUTO) et corrections de code
// (DEV_FIX), avec le détail complet (erreur/contexte/cause/fix/fichiers/tests avant-après) et les
// liens vers l'historique des corrections similaires sur le même domaine.
(function () {
  const DOMAIN_LABEL = {
    revenueShop: 'CA magasin', revenueArticle: 'CA article/rayon', articleDetails: 'Fiche article',
    stock: 'Stock', sales: 'Ventes', orders: 'Commandes', accuracy: 'Précision IA', code: 'Code / technique',
  };
  const SOURCE_LABEL = { AI_AUTO: 'Auto-correction IA', DEV_FIX: 'Correction de code' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('fr-FR');
  }

  function el(id) {
    const e = document.getElementById(id);
    if (!e) console.warn('[corrections] élément manquant (page en cache ? Ctrl+F5) : #' + id);
    return e;
  }
  function on(id, event, fn) {
    const e = (id instanceof Element) ? id : el(id);
    if (e) e.addEventListener(event, fn);
    return e;
  }

  function fileList(arr) {
    if (!arr || !arr.length) return '<span class="text-muted">aucun</span>';
    return arr.map((f) => '<code>' + esc(f) + '</code>').join(', ');
  }

  function cardFor(rec) {
    const srcBadge = '<span class="badge ' + (rec.source === 'AI_AUTO' ? 'src-AI_AUTO' : 'src-DEV_FIX') + '">' + (SOURCE_LABEL[rec.source] || rec.source) + '</span>';
    const domainBadge = '<span class="badge bg-light text-dark border">' + esc(DOMAIN_LABEL[rec.domain] || rec.domain) + '</span>';
    return (
      '<div class="card mb-2 corr-card" data-id="' + rec.id + '" style="cursor:pointer;">' +
      '<div class="card-body">' +
      '<div class="d-flex justify-content-between align-items-start flex-wrap gap-2">' +
      '<div>' + srcBadge + ' ' + domainBadge + ' <span class="small text-muted ms-2">' + fmtDate(rec.createdAt) + ' — ' + esc(rec.createdBy) + '</span></div>' +
      (rec.similarPastCorrectionIds && rec.similarPastCorrectionIds.length ? '<span class="badge bg-secondary">' + rec.similarPastCorrectionIds.length + ' similaire(s)</span>' : '') +
      '</div>' +
      '<div class="mt-2 fw-semibold">' + esc(rec.errorObserved) + '</div>' +
      '<div class="small text-muted mt-1">' + esc(rec.rootCause).slice(0, 220) + (rec.rootCause.length > 220 ? '…' : '') + '</div>' +
      '</div></div>'
    );
  }

  function detailHtml(rec) {
    const similar = (rec.similarPastCorrections || []).map((s) => (
      '<div class="border rounded p-2 mb-2">' +
      '<div class="small text-muted">' + fmtDate(s.createdAt) + ' — ' + esc(SOURCE_LABEL[s.source] || s.source) + '</div>' +
      '<div class="fw-semibold">' + esc(s.errorObserved) + '</div>' +
      '<div class="small corr-pre">' + esc(s.fixApplied) + '</div>' +
      '</div>'
    )).join('') || '<span class="text-muted">Aucune correction similaire antérieure sur ce domaine.</span>';

    return (
      '<div class="mb-3"><span class="badge ' + (rec.source === 'AI_AUTO' ? 'src-AI_AUTO' : 'src-DEV_FIX') + '">' + (SOURCE_LABEL[rec.source] || rec.source) + '</span> ' +
      '<span class="badge bg-secondary">' + esc(DOMAIN_LABEL[rec.domain] || rec.domain) + '</span> ' +
      '<span class="small text-muted">' + fmtDate(rec.createdAt) + ' — ' + esc(rec.createdBy) + '</span></div>' +

      '<h6>Erreur constatée</h6><p class="corr-pre">' + esc(rec.errorObserved) + '</p>' +
      '<h6>Contexte</h6><p class="corr-pre">' + esc(rec.context) + '</p>' +
      '<h6>Cause identifiée</h6><p class="corr-pre">' + esc(rec.rootCause) + '</p>' +
      '<h6>Correction apportée</h6><p class="corr-pre">' + esc(rec.fixApplied) + '</p>' +
      '<h6>Fichiers concernés</h6><p>' + fileList(rec.filesChanged) + '</p>' +
      '<h6>Fonctions concernées</h6><p>' + fileList(rec.functionsChanged) + '</p>' +
      '<div class="row">' +
      '<div class="col-md-6"><h6>Avant correction</h6><pre class="corr-pre small bg-light p-2 rounded">' + esc(rec.testsBefore) + '</pre></div>' +
      '<div class="col-md-6"><h6>Après correction</h6><pre class="corr-pre small bg-light p-2 rounded">' + esc(rec.testsAfter) + '</pre></div>' +
      '</div>' +
      '<h6 class="mt-3">Historique des corrections similaires (même domaine)</h6>' + similar
    );
  }

  async function openDetail(id) {
    try {
      const res = await window.reassortFetch('/reassort/corrections/' + id);
      const json = await res.json();
      if (!json.success) throw new Error(json.message);
      el('corr-detail-body').innerHTML = detailHtml(json.data);
      new bootstrap.Modal(el('corr-detail-modal')).show();
    } catch (err) {
      window.reassortToast ? window.reassortToast('Erreur : ' + err.message, 'error') : alert(err.message);
    }
  }

  async function loadList() {
    const listEl = el('corr-list');
    if (!listEl) return;
    listEl.innerHTML = '<div class="text-center text-muted py-4">Chargement...</div>';
    try {
      const domain = el('corr-domain') ? el('corr-domain').value : '';
      const source = el('corr-source') ? el('corr-source').value : '';
      const q = [];
      if (domain) q.push('domain=' + encodeURIComponent(domain));
      if (source) q.push('source=' + encodeURIComponent(source));
      const res = await window.reassortFetch('/reassort/corrections' + (q.length ? '?' + q.join('&') : ''));
      const json = await res.json();
      if (!json.success) throw new Error(json.message);
      const rows = json.data || [];
      if (el('corr-summary')) el('corr-summary').textContent = rows.length + ' correction(s)';
      listEl.innerHTML = rows.length
        ? rows.map(cardFor).join('')
        : '<div class="text-center text-muted py-4">Aucune correction journalisée pour ce filtre.</div>';
      listEl.querySelectorAll('.corr-card').forEach((card) => {
        card.addEventListener('click', () => openDetail(card.dataset.id));
      });
    } catch (err) {
      listEl.innerHTML = '<div class="alert alert-danger">' + esc(err.message) + '</div>';
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    on('corr-domain', 'change', loadList);
    on('corr-source', 'change', loadList);
    loadList();
  });
})();
