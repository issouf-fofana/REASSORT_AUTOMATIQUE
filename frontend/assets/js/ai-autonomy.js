// Page "Préparation à l'autonomie" (demande du 17/09/2026) : échelle de supervision
// (VALIDATION_HUMAINE -> SUPERVISION_HUMAINE -> AUTONOMIE_CONTROLEE -> AUTONOME), critères mesurables
// et historique des évaluations. Indicateur purement consultatif, ne change jamais lui-même le
// comportement du système (cf. autonomyReadinessService.js).
(function () {
  const LEVELS = [
    { key: 'VALIDATION_HUMAINE', label: 'Validation humaine', desc: 'Chaque décision IA est validée par un humain avant application.' },
    { key: 'SUPERVISION_HUMAINE', label: 'Supervision humaine', desc: 'Un humain supervise en continu, intervient sur les cas à risque.' },
    { key: 'AUTONOMIE_CONTROLEE', label: 'Autonomie contrôlée', desc: 'Le système agit avec des garde-fous, contrôle a posteriori.' },
    { key: 'AUTONOME', label: 'Autonome', desc: 'Fonctionnement autonome, supervision minimale.' },
  ];
  const CRITERIA = [
    { key: 'errorRateScore', label: 'Taux d\'erreur (inversé)' },
    { key: 'recommendationAccuracyScore', label: 'Exactitude des recommandations' },
    { key: 'stabilityScore', label: 'Stabilité des résultats' },
    { key: 'anomalyDetectionScore', label: 'Détection d\'anomalies' },
    { key: 'postCorrectionScore', label: 'Résultats après correction' },
    { key: 'ruleComplianceScore', label: 'Respect des règles métier' },
    { key: 'testCaseScore', label: 'Performance sur cas de test' },
  ];

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function fmtDate(iso) {
    return iso ? new Date(iso).toLocaleString('fr-FR') : '—';
  }
  function el(id) {
    const e = document.getElementById(id);
    if (!e) console.warn('[autonomy] élément manquant (page en cache ? Ctrl+F5) : #' + id);
    return e;
  }
  function on(id, event, fn) {
    const e = (id instanceof Element) ? id : el(id);
    if (e) e.addEventListener(event, fn);
    return e;
  }

  function ladderHtml(readiness) {
    const effectiveLevel = readiness ? (readiness.levelConfirmed ? readiness.level : readiness.lastConfirmedLevel) : 'VALIDATION_HUMAINE';
    const effectiveIndex = LEVELS.findIndex((l) => l.key === effectiveLevel);
    const pendingLevel = readiness && !readiness.levelConfirmed ? readiness.level : null;
    return LEVELS.map((l, i) => {
      let cls = '';
      if (i === effectiveIndex) cls = 'active';
      else if (pendingLevel === l.key) cls = 'pending';
      return (
        '<div class="autonomy-step ' + cls + '">' +
        '<div class="fw-bold">' + esc(l.label) + '</div>' +
        '<div class="small text-muted">' + esc(l.desc) + '</div>' +
        (i === effectiveIndex ? '<div class="badge bg-success mt-2">Palier tenu</div>' : '') +
        (pendingLevel === l.key ? '<div class="badge bg-warning text-dark mt-2">En confirmation</div>' : '') +
        '</div>'
      );
    }).join('');
  }

  function criteriaHtml(readiness) {
    if (!readiness) return '<p class="text-muted">Aucune évaluation disponible pour le moment.</p>';
    return (
      '<div class="small text-muted mb-3">' + readiness.measuredCriteriaCount + ' / 7 critères mesurables aujourd\'hui (les autres n\'ont pas encore de source de données fiable).</div>' +
      CRITERIA.map((c) => {
        const value = readiness[c.key];
        const measurable = value !== null && value !== undefined;
        return (
          '<div class="mb-2">' +
          '<div class="d-flex justify-content-between small mb-1"><span>' + esc(c.label) + '</span><span>' +
          (measurable ? Math.round(value) + ' / 100' : '<span class="text-muted">non mesurable</span>') + '</span></div>' +
          '<div class="criteria-bar"><div class="criteria-bar-fill" style="width:' + (measurable ? Math.round(value) : 0) + '%; ' + (measurable ? '' : 'background:#dee2e6;') + '"></div></div>' +
          '</div>'
        );
      }).join('')
    );
  }

  function historyHtml(rows) {
    if (!rows.length) return '<p class="text-muted">Aucun historique.</p>';
    return (
      '<table class="table table-sm">' +
      '<thead><tr><th>Date</th><th>Score global</th><th>Palier</th><th>Continuité</th><th>Critères mesurés</th></tr></thead>' +
      '<tbody>' + rows.map((r) => (
        '<tr><td>' + fmtDate(r.computedAt) + '</td><td>' + Math.round(r.globalScore) + ' / 100</td>' +
        '<td>' + esc((LEVELS.find((l) => l.key === r.level) || {}).label || r.level) + '</td>' +
        '<td>' + r.currentStreakCount + '</td><td>' + r.measuredCriteriaCount + ' / 7</td></tr>'
      )).join('') + '</tbody></table>'
    );
  }

  async function load() {
    try {
      const [readinessRes, historyRes] = await Promise.all([
        window.reassortFetch('/reassort/autonomy-readiness'),
        window.reassortFetch('/reassort/autonomy-readiness/history'),
      ]);
      const readinessJson = await readinessRes.json();
      const historyJson = await historyRes.json();
      if (!readinessJson.success) throw new Error(readinessJson.message);
      if (!historyJson.success) throw new Error(historyJson.message);

      const readiness = readinessJson.data;
      el('autonomy-ladder').innerHTML = ladderHtml(readiness);
      el('autonomy-streak-note').textContent = readiness
        ? (readiness.levelConfirmed
          ? 'Palier "' + (LEVELS.find((l) => l.key === readiness.level) || {}).label + '" confirmé (tenu sur ' + readiness.currentStreakCount + ' évaluations consécutives).'
          : 'En cours de confirmation (' + readiness.currentStreakCount + ' évaluation(s) consécutive(s) sur le seuil requis) — le palier affiché comme "tenu" reste le dernier confirmé.')
        : 'Aucune évaluation calculée pour le moment.';
      el('autonomy-criteria').innerHTML = criteriaHtml(readiness);
      el('autonomy-history').innerHTML = historyHtml(historyJson.data || []);
    } catch (err) {
      window.reassortToast ? window.reassortToast('Erreur : ' + err.message, 'error') : alert(err.message);
    }
  }

  async function recompute() {
    const btn = el('autonomy-recompute');
    if (btn) { btn.disabled = true; btn.textContent = 'Calcul en cours...'; }
    try {
      await window.reassortFetch('/reassort/autonomy-readiness/recompute', { method: 'POST' });
      await load();
    } catch (err) {
      window.reassortToast ? window.reassortToast('Erreur : ' + err.message, 'error') : alert(err.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Recalculer maintenant'; }
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    on('autonomy-recompute', 'click', recompute);
    load();
  });
})();
