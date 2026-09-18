// Page "Anomalies de commande" (backend/amelioration.md, 18/09/2026) : liste des écarts détectés
// entre une quantité proposée et l'historique des quantités validées pour le même article — jamais
// une conclusion "erreur", juste un signal "différent de l'habitude" à vérifier avant validation.
(function () {
  const STATUS_LABEL = { PENDING: 'À vérifier', ACKNOWLEDGED: 'Acceptée', DISMISSED: 'Ignorée' };
  const DIRECTION_LABEL = { HIGH: 'Quantité inhabituellement élevée (risque de surstock)', LOW: 'Quantité inhabituellement faible (risque de rupture)' };

  let pendingAction = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function fmtDate(iso) {
    return iso ? new Date(iso).toLocaleString('fr-FR') : '—';
  }
  function fmtNum(n) {
    return Math.round(n * 10) / 10;
  }
  function el(id) {
    const e = document.getElementById(id);
    if (!e) console.warn('[anomalies commande] élément manquant (page en cache ? Ctrl+F5) : #' + id);
    return e;
  }
  function on(id, event, fn) {
    const e = (id instanceof Element) ? id : el(id);
    if (e) e.addEventListener(event, fn);
    return e;
  }

  function actionsFor(a) {
    if (a.status !== 'PENDING') return '';
    return (
      '<button type="button" class="btn btn-sm btn-outline-primary" data-act="ACKNOWLEDGED" data-id="' + a.id + '">Accepter</button> ' +
      '<button type="button" class="btn btn-sm btn-outline-secondary" data-act="DISMISSED" data-id="' + a.id + '">Ignorer</button>'
    );
  }

  function cardFor(a) {
    return (
      '<div class="card mb-2">' +
      '<div class="card-body">' +
      '<div class="d-flex justify-content-between align-items-start flex-wrap gap-2">' +
      '<div>' +
      '<span class="badge oa-badge-' + esc(a.direction) + '">' + esc(DIRECTION_LABEL[a.direction] || a.direction) + '</span> ' +
      '<span class="badge bg-secondary">' + esc(STATUS_LABEL[a.status] || a.status) + '</span>' +
      '</div>' +
      '<span class="small text-muted">' + fmtDate(a.detectedAt) + '</span>' +
      '</div>' +
      '<div class="mt-2 fw-semibold">' + esc(a.label || a.ean) + ' <span class="text-muted small">(' + esc(a.ean) + ')</span></div>' +
      '<div class="small text-muted mt-1">Magasin : ' + (a.shopReference ? esc(a.shopReference + (a.shopName ? ' — ' + a.shopName : '')) : esc(a.rposShopId)) + '</div>' +
      '<div class="mt-2">' +
      'Quantité proposée : <strong>' + fmtNum(a.newQuantity) + '</strong> — ' +
      'habituellement entre <strong>' + fmtNum(a.historicalMin) + '</strong> et <strong>' + fmtNum(a.historicalMax) + '</strong> ' +
      '(moyenne ' + fmtNum(a.historicalMean) + ', sur ' + a.sampleSize + ' commande(s) passée(s))' +
      '</div>' +
      (a.contextNote ? '<div class="small text-muted mt-2"><em>Note : ' + esc(a.contextNote) + '</em></div>' : '') +
      '<div class="mt-3">' + actionsFor(a) + '</div>' +
      '</div></div>'
    );
  }

  async function loadList() {
    const listEl = el('oa-list');
    if (!listEl) return;
    listEl.innerHTML = '<div class="text-center text-muted py-4">Chargement...</div>';
    try {
      const status = el('oa-status') ? el('oa-status').value : '';
      const q = status ? '?status=' + encodeURIComponent(status) : '';
      const res = await window.reassortFetch('/reassort/order-anomalies' + q);
      const json = await res.json();
      if (!json.success) throw new Error(json.message);
      let rows = json.data || [];
      // "Toutes (sauf traitées)" par défaut : sans filtre explicite, on masque les DISMISSED pour
      // ne pas noyer les vraies anomalies à vérifier sous les fausses alertes déjà closes.
      if (!status) rows = rows.filter((a) => a.status !== 'DISMISSED');
      if (el('oa-summary')) el('oa-summary').textContent = rows.length + ' anomalie(s)';
      listEl.innerHTML = rows.length
        ? rows.map(cardFor).join('')
        : '<div class="text-center text-muted py-4">Aucune anomalie pour ce filtre.</div>';
      listEl.querySelectorAll('button[data-act]').forEach((btn) => {
        btn.addEventListener('click', () => openNoteModal(btn.dataset.id, btn.dataset.act));
      });
    } catch (err) {
      listEl.innerHTML = '<div class="alert alert-danger">' + esc(err.message) + '</div>';
    }
  }

  function openNoteModal(id, status) {
    pendingAction = { id, status };
    el('oa-note-title').textContent = status === 'ACKNOWLEDGED' ? 'Accepter cette anomalie' : 'Ignorer cette anomalie';
    el('oa-note-label').textContent = status === 'ACKNOWLEDGED' ? 'Pourquoi cet écart est-il justifié ? (optionnel)' : 'Motif (optionnel)';
    el('oa-note-text').value = '';
    el('oa-note-error').style.display = 'none';
    new bootstrap.Modal(el('oa-note-modal')).show();
  }

  async function confirmNote() {
    if (!pendingAction) return;
    const errBox = el('oa-note-error');
    errBox.style.display = 'none';
    try {
      const res = await window.reassortFetch('/reassort/order-anomalies/' + pendingAction.id + '/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: pendingAction.status, contextNote: el('oa-note-text').value.trim() || null }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.message);
      bootstrap.Modal.getInstance(el('oa-note-modal')).hide();
      pendingAction = null;
      await loadList();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.style.display = '';
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    on('oa-status', 'change', loadList);
    on('oa-note-confirm', 'click', confirmNote);
    loadList();
  });
})();
