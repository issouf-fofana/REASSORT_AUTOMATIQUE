// Page "Améliorations IA" (conseiller d'amélioration, première brique AI Center) :
// diagnostic, recommandation, suivi et audit complet — pas une simple liste.
// - Tri par priorité (Critique d'abord), filtres statut/priorité.
// - Message d'erreur EXACT affiché tel quel (jamais reformulé).
// - Actions : En cours / À vérifier / Appliquer (+note de la correction réelle) /
//   Ignorer (+motif) / Rouvrir. IMPROVED/NO_EFFECT posés par le système seul.
// - Détails : timeline complète Détection → Analyse → Recommandation → Validation →
//   Correction → Vérification → Résultat + preuves + prompt IA + contexte.
(function () {
  const PRIORITY = {
    CRITICAL: { label: 'Critique', badge: 'bg-danger' },
    HIGH: { label: 'Élevée', badge: 'bg-warning text-dark' },
    MEDIUM: { label: 'Moyenne', badge: 'bg-info' },
    LOW: { label: 'Faible', badge: 'bg-secondary' },
  };
  const STATUS_LABEL = { PROPOSED: 'Proposée', IN_PROGRESS: 'En cours', TO_VERIFY: 'À vérifier', APPLIED: 'Appliquée', DISMISSED: 'Ignorée', IMPROVED: 'Améliorée <iconify-icon icon="solar:check-circle-bold-duotone"></iconify-icon>', NO_EFFECT: 'Sans effet' };
  const EVENT_LABEL = { DETECTED: 'Détection', ENRICHED: 'Analyse IA', EDITED: 'Modification', STATUS_CHANGED: 'Changement de statut', EVALUATED: 'Vérification' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('fr-FR');
  }

  // Blinde anti cache-mixte (constaté en prod : vieux HTML + JS neuf = getElementById
  // null qui tuait TOUT le script, bouton "Analyser" inclus). Chaque liaison est gardée :
  // un élément manquant désactive juste sa fonction, jamais toute la page.
  function el(id) {
    const e = document.getElementById(id);
    if (!e) console.warn('[améliorations] élément manquant (page en cache ? Ctrl+F5) : #' + id);
    return e;
  }
  function on(id, event, fn) {
    const e = (id instanceof Element) ? id : el(id);
    if (e) e.addEventListener(event, fn);
    return e;
  }

  function prio(imp) {
    return PRIORITY[imp.priority] || PRIORITY.MEDIUM;
  }

  function metricText(imp) {
    if (imp.metricName == null || imp.metricBefore == null) return '';
    const fmt = function (v) { return Math.round(v * 100) / 100; };
    const after = imp.metricAfter == null ? '…' : fmt(imp.metricAfter);
    return '<div class="small text-muted mt-1">Métrique <code>' + esc(imp.metricName) + '</code> : ' +
      fmt(imp.metricBefore) + ' → ' + after + '</div>';
  }

  function actionsFor(imp) {
    const b = [];
    const btn = function (act, label, cls) {
      b.push('<button type="button" class="btn btn-sm ' + cls + '" data-act="' + act + '" data-id="' + imp.id + '">' + label + '</button>');
    };
    if (imp.status === 'PROPOSED') { btn('IN_PROGRESS', 'En cours', 'btn-outline-primary'); btn('APPLIED', 'Marquer appliqué', 'btn-success'); btn('DISMISSED', 'Ignorer', 'btn-outline-secondary'); }
    else if (imp.status === 'IN_PROGRESS') { btn('TO_VERIFY', 'À vérifier', 'btn-outline-primary'); btn('APPLIED', 'Marquer appliqué', 'btn-success'); btn('DISMISSED', 'Ignorer', 'btn-outline-secondary'); }
    else if (imp.status === 'TO_VERIFY') { btn('APPLIED', 'Marquer appliqué', 'btn-success'); btn('DISMISSED', 'Ignorer', 'btn-outline-secondary'); btn('IN_PROGRESS', 'Reprendre', 'btn-outline-primary'); }
    else if (imp.status === 'APPLIED') { btn('IN_PROGRESS', 'Rouvrir', 'btn-outline-primary'); }
    else { btn('IN_PROGRESS', 'Rouvrir', 'btn-outline-primary'); }
    // Proposition IA modifiable (recommandation, reco dev, priorité) tant que non clôturée.
    if (['PROPOSED', 'IN_PROGRESS', 'TO_VERIFY'].includes(imp.status)) {
      b.push('<button type="button" class="btn btn-sm btn-outline-dark" data-edit="' + imp.id + '">Modifier</button>');
    }
    b.push('<button type="button" class="btn btn-sm btn-outline-dark" data-detail="' + imp.id + '">Détails</button>');
    return b.length ? '<div class="mt-2 d-flex flex-wrap gap-2">' + b.join('') + '</div>' : '';
  }

  function card(imp) {
    const p = prio(imp);
    return '<div class="card mb-3"><div class="card-body">' +
      '<div class="d-flex flex-wrap gap-2 align-items-center mb-2">' +
      '<span class="badge ' + p.badge + '">Priorité ' + p.label + '</span>' +
      '<span class="badge bg-light text-dark border">' + esc(imp.severity) + '</span>' +
      '<span class="badge bg-light text-dark border">' + esc(imp.type) + '</span>' +
      '<span class="badge bg-secondary">' + (STATUS_LABEL[imp.status] || imp.status) + '</span>' +
      (imp.aiConfidence != null ? '<span class="badge bg-light text-dark border">Confiance IA ' + imp.aiConfidence + '%</span>' : '') +
      '<span class="small text-muted ms-auto">' + fmtDate(imp.createdAt) + '</span>' +
      '</div>' +
      '<h5 class="card-title mb-1">' + esc(imp.title) + '</h5>' +
      '<div class="small imp-detail">' + esc(imp.detail) + '</div>' +
      (imp.errorMessage ? '<div class="alert alert-danger small mt-2 mb-0"><strong>Erreur exacte constatée :</strong><br><code class="imp-detail">' + esc(imp.errorMessage) + '</code></div>' : '') +
      (imp.devRecommendation ? '<div class="alert alert-light border small mt-2 mb-0"><strong>Recommandation dev :</strong><br><span class="imp-detail">' + esc(imp.devRecommendation) + '</span></div>' : '') +
      metricText(imp) +
      (imp.providerUsed ? '<div class="small text-muted mt-1">Enrichi par IA (' + esc(imp.providerUsed) + ')</div>' : '') +
      (imp.aiError ? '<div class="alert alert-warning small mt-2 mb-0"><strong>Enrichissement IA échoué :</strong> ' + esc(imp.aiError) + ' — recommandation déterministe conservée.</div>' : '') +
      actionsFor(imp) +
      '</div></div>';
  }

  function timelineHtml(events) {
    if (!events || !events.length) return '<p class="text-muted small">Aucun événement.</p>';
    return '<ul class="list-group list-group-flush">' + events.map(function (e) {
      return '<li class="list-group-item px-0">' +
        '<div class="d-flex justify-content-between"><strong>' + esc(EVENT_LABEL[e.action] || e.action) + '</strong>' +
        '<span class="small text-muted">' + fmtDate(e.at) + '</span></div>' +
        '<div class="small">Par ' + esc(e.actor) +
        (e.fromStatus || e.toStatus ? ' · ' + esc(e.fromStatus || '—') + ' → ' + esc(e.toStatus || '—') : '') + '</div>' +
        (e.note ? '<div class="small text-muted imp-detail">' + esc(e.note) + '</div>' : '') +
        '</li>';
    }).join('') + '</ul>';
  }

  async function openDetail(id) {
    const body = el('imp-detail-body');
    const modalEl = el('imp-detail-modal');
    if (!body || !modalEl) { alert('Page en cache : faites Ctrl+F5 pour recharger.'); return; }
    body.innerHTML = '<p class="text-muted">Chargement...</p>';
    new bootstrap.Modal(modalEl).show();
    try {
      const res = await window.reassortFetch('/reassort/improvements/' + id);
      const json = await res.json();
      if (!json.success) throw new Error(json.message);
      const d = json.data;
      const p = prio(d);
      body.innerHTML =
        '<h5>' + esc(d.title) + '</h5>' +
        '<p><span class="badge ' + p.badge + '">Priorité ' + p.label + '</span> ' +
        '<span class="badge bg-secondary">' + (STATUS_LABEL[d.status] || d.status) + '</span></p>' +
        '<h6 class="mt-3">Problème détecté</h6><p class="small imp-detail">' + esc(d.detail) + '</p>' +
        (d.errorMessage ? '<h6>Erreur exacte</h6><p><code class="imp-detail">' + esc(d.errorMessage) + '</code></p>' : '') +
        (d.devRecommendation ? '<h6>Recommandation dev</h6><p class="small imp-detail">' + esc(d.devRecommendation) + '</p>' : '') +
        '<h6>Contexte de détection</h6><ul class="small">' +
        '<li>Détecté le ' + fmtDate(d.createdAt) + ' par ' + esc(d.detectedBy || '—') + (d.detectedIp ? ' (' + esc(d.detectedIp) + ')' : '') + '</li>' +
        '<li>Environnement : ' + esc(d.environment || '—') + ' · version appli : ' + esc(d.appVersion || '—') + '</li>' +
        '<li>Périmètre : ' + esc(d.scope) + '</li></ul>' +
        (d.appliedBy ? '<h6>Correction</h6><p class="small">Par ' + esc(d.appliedBy) + ' le ' + fmtDate(d.appliedAt) + (d.appliedNote ? '<br><span class="imp-detail">' + esc(d.appliedNote) + '</span>' : '') + '</p>' : '') +
        (d.dismissedBy ? '<h6>Ignorée</h6><p class="small">Par ' + esc(d.dismissedBy) + (d.dismissedReason ? ' — motif : <span class="imp-detail">' + esc(d.dismissedReason) + '</span>' : '') + '</p>' : '') +
        '<h6>Preuves</h6><pre class="border rounded p-2 small">' + esc(JSON.stringify(d.evidence || {}, null, 2)) + '</pre>' +
        (d.aiPrompt ? '<details class="small mt-2"><summary class="text-primary" style="cursor:pointer;">Voir le prompt envoyé à l’IA</summary><pre class="border rounded p-2 mt-1" style="white-space:pre-wrap;">' + esc(d.aiPrompt) + '</pre></details>' : '') +
        '<h6 class="mt-3">Timeline</h6>' + timelineHtml(d.events);
    } catch (err) {
      body.innerHTML = '<div class="alert alert-danger">Erreur: ' + esc(err.message) + '</div>';
    }
  }

  let pendingAction = null;

  // Modale "Modifier" : ajuste la proposition de l'IA (recommandation, reco dev, priorité).
  // Tracé dans la timeline (EDITED) — l'humain affine avant d'appliquer.
  async function openEdit(id) {
    try {
      const res = await window.reassortFetch('/reassort/improvements/' + id);
      const json = await res.json();
      if (!json.success) throw new Error(json.message);
      document.getElementById('imp-edit-id').value = json.data.id;
      document.getElementById('imp-edit-detail').value = json.data.detail || '';
      document.getElementById('imp-edit-dev').value = json.data.devRecommendation || '';
      document.getElementById('imp-edit-priority').value = json.data.priority || 'MEDIUM';
      document.getElementById('imp-edit-error').style.display = 'none';
      new bootstrap.Modal(document.getElementById('imp-edit-modal')).show();
    } catch (err) {
      alert('Erreur: ' + err.message);
    }
  }

  on('imp-edit-confirm', 'click', async function () {
    const id = document.getElementById('imp-edit-id').value;
    const btn = this;
    btn.disabled = true;
    try {
      const res = await window.reassortFetch('/reassort/improvements/' + id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          detail: document.getElementById('imp-edit-detail').value,
          devRecommendation: document.getElementById('imp-edit-dev').value || null,
          priority: document.getElementById('imp-edit-priority').value,
        }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.message);
      bootstrap.Modal.getInstance(document.getElementById('imp-edit-modal')).hide();
      loadList();
    } catch (err) {
      const e = document.getElementById('imp-edit-error');
      e.textContent = 'Erreur: ' + err.message;
      e.style.display = 'block';
    } finally {
      btn.disabled = false;
    }
  });

  function askNote(act, id) {
    // APPLIED = décrire la correction réellement effectuée ; DISMISSED = motif obligatoire ;
    // autres transitions : note optionnelle.
    const cfg = {
      APPLIED: { title: 'Marquer appliqué', label: 'Correction réellement effectuée (fichiers, réglages, commandes...)', required: false },
      DISMISSED: { title: 'Ignorer la recommandation', label: 'Motif (obligatoire)', required: true },
      IN_PROGRESS: { title: 'Passer en cours', label: 'Note (optionnel)', required: false },
      TO_VERIFY: { title: 'Passer à vérifier', label: 'Note (optionnel)', required: false },
    }[act] || { title: 'Changer de statut', label: 'Note (optionnel)', required: false };
    pendingAction = { act: act, id: id, required: cfg.required };
    document.getElementById('imp-note-title').textContent = cfg.title;
    document.getElementById('imp-note-label').textContent = cfg.label;
    document.getElementById('imp-note-text').value = '';
    document.getElementById('imp-note-error').style.display = 'none';
    new bootstrap.Modal(document.getElementById('imp-note-modal')).show();
  }

  on('imp-note-confirm', 'click', async function () {
    if (!pendingAction) return;
    const note = document.getElementById('imp-note-text').value.trim();
    if (pendingAction.required && !note) {
      const e = document.getElementById('imp-note-error');
      e.textContent = 'Motif requis pour ignorer une recommandation.';
      e.style.display = 'block';
      return;
    }
    const btn = this;
    btn.disabled = true;
    try {
      const res = await window.reassortFetch('/reassort/improvements/' + pendingAction.id + '/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: pendingAction.act, note: note || null }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.message);
      bootstrap.Modal.getInstance(document.getElementById('imp-note-modal')).hide();
      loadList();
    } catch (err) {
      const e = document.getElementById('imp-note-error');
      e.textContent = 'Erreur: ' + err.message;
      e.style.display = 'block';
    } finally {
      btn.disabled = false;
    }
  });

  async function loadList() {
    const list = document.getElementById('imp-list');
    const status = document.getElementById('imp-filter').value;
    const priority = document.getElementById('imp-priority').value;
    const sort = document.getElementById('imp-sort').value;
    list.innerHTML = '<div class="text-center text-muted py-4">Chargement...</div>';
    try {
      const q = [];
      if (status) q.push('status=' + status);
      if (priority) q.push('priority=' + priority);
      q.push('sort=' + sort);
      const res = await window.reassortFetch('/reassort/improvements' + (q.length ? '?' + q.join('&') : ''));
      const json = await res.json();
      if (!json.success) throw new Error(json.message);
      const rows = json.data;
      document.getElementById('imp-summary').textContent = rows.length + ' recommandation(s)';
      list.innerHTML = rows.length ? rows.map(card).join('') :
        '<div class="alert alert-light border">Aucune recommandation pour ce filtre. Lancez “Analyser maintenant”.</div>';
      list.querySelectorAll('button[data-act]').forEach(function (btn) {
        btn.addEventListener('click', function () { askNote(btn.dataset.act, btn.dataset.id); });
      });
      list.querySelectorAll('button[data-edit]').forEach(function (btn) {
        btn.addEventListener('click', function () { openEdit(btn.dataset.edit); });
      });
      list.querySelectorAll('button[data-detail]').forEach(function (btn) {
        btn.addEventListener('click', function () { openDetail(btn.dataset.detail); });
      });
    } catch (err) {
      list.innerHTML = '<div class="alert alert-danger">Erreur: ' + esc(err.message) + '</div>';
    }
  }

  on('imp-filter', 'change', loadList);
  on('imp-priority', 'change', loadList);
  on('imp-sort', 'change', loadList);

  on('imp-generate', 'click', async function () {
    const btn = this;
    btn.disabled = true;
    btn.textContent = 'Analyse en cours...';
    try {
      const res = await window.reassortFetch('/reassort/improvements/generate', { method: 'POST' });
      const json = await res.json();
      if (!json.success) throw new Error(json.message);
      const d = json.data;
      document.getElementById('imp-summary').textContent =
        d.findings + ' constat(s), ' + d.created + ' nouvelle(s), ' + d.enriched + ' enrichie(s) par IA, ' +
        d.evaluation.improved + ' améliorée(s) constatée(s).';
      loadList();
    } catch (err) {
      alert('Erreur: ' + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Analyser maintenant';
    }
  });

  // Journal d'audit : déplacé sur sa page dédiée (audit-errors.html, lien sidebar
  // "Journal d'audit") — cette page ne garde que les recommandations.

  document.addEventListener('DOMContentLoaded', loadList);
})();
