(function () {
  const shopSelect = document.getElementById('aip-shop');
  const proposalSelect = document.getElementById('aip-proposal');
  const tbody = document.getElementById('aip-tbody');
  const infoBox = document.getElementById('aip-proposal-info');
  const pageLabel = document.getElementById('aip-page-label');
  const prevBtn = document.getElementById('aip-prev-page');
  const nextBtn = document.getElementById('aip-next-page');

  const PAGE_SIZE = 25;
  let allPredictions = [];
  let currentPage = 1;

  async function loadShopList() {
    try {
      const res = await window.reassortFetch('/reassort/shops');
      const json = await res.json();
      if (!json.success) throw new Error(json.message);
      const byPos = {};
      json.data.forEach(function (s) {
        if (!byPos[s.posId]) byPos[s.posId] = [];
        byPos[s.posId].push(s);
      });
      shopSelect.innerHTML = Object.keys(byPos).sort().map(function (posId) {
        const shops = byPos[posId].slice().sort(function (a, b) { return (a.reference || '').localeCompare(b.reference || ''); });
        const options = shops.map(function (s) {
          return '<option value="' + s.id + '">' + s.reference + ' - ' + s.name + '</option>';
        }).join('');
        return '<optgroup label="' + (shops[0].posLabel || posId) + '">' + options + '</optgroup>';
      }).join('');
      if (window.reassortMakeShopPickerSearchable) window.reassortMakeShopPickerSearchable(shopSelect);
      // Le navigateur peut restaurer une sélection précédente sans déclencher "change" : on charge
      // explicitement si un magasin se retrouve déjà sélectionné après le remplissage.
      if (shopSelect.value) loadProposalList();
    } catch (err) {
      shopSelect.innerHTML = '<option value="">Erreur: ' + err.message + '</option>';
    }
  }

  async function loadProposalList() {
    const shopId = shopSelect.value;
    proposalSelect.innerHTML = '<option value="">—</option>';
    proposalSelect.disabled = true;
    if (!shopId) return;
    try {
      const res = await window.reassortFetch('/reassort/predictions/proposals?shop=' + encodeURIComponent(shopId));
      const json = await res.json();
      if (!json.success) throw new Error(json.message);
      if (!json.data.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted py-4">Aucune prédiction enregistrée pour ce magasin. Générez une proposition pour en créer.</td></tr>';
        infoBox.textContent = '';
        return;
      }
      proposalSelect.innerHTML = json.data.map(function (p, i) {
        const dateLabel = new Date(p.generatedAt).toLocaleString('fr-FR');
        return '<option value="' + p.id + '">' + dateLabel + ' (' + p.status + ')' + (i === 0 ? ' — dernière' : '') + '</option>';
      }).join('');
      proposalSelect.disabled = false;
      loadPredictions();
    } catch (err) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center text-danger py-4">Erreur: ' + err.message + '</td></tr>';
    }
  }

  function confidenceColor(score) {
    if (score >= 70) return '#000000';
    if (score >= 40) return '#666666';
    return '#999999';
  }

  async function loadPredictions() {
    const shopId = shopSelect.value;
    if (!shopId) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted py-4">Sélectionnez un magasin pour afficher ses prédictions.</td></tr>';
      infoBox.textContent = '';
      return;
    }
    tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted py-4">Chargement...</td></tr>';
    try {
      const proposalId = proposalSelect.value;
      const url = '/reassort/predictions?shop=' + encodeURIComponent(shopId) + (proposalId ? '&proposalId=' + encodeURIComponent(proposalId) : '');
      const res = await window.reassortFetch(url);
      const json = await res.json();
      if (!json.success) throw new Error(json.message);
      const d = json.data;

      if (!d.proposalId || !d.predictions.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted py-4">Aucune prédiction enregistrée pour ce magasin. Générez une proposition pour en créer.</td></tr>';
        infoBox.textContent = '';
        return;
      }

      // Reflète dans le sélecteur la proposition réellement chargée (utile au premier chargement,
      // quand proposalId n'était pas encore renseigné dans l'URL).
      if (proposalSelect.value !== d.proposalId) proposalSelect.value = d.proposalId;

      infoBox.textContent = d.predictions.length + ' article(s) — génération du ' + new Date(d.generatedAt).toLocaleString('fr-FR') + '.';

      allPredictions = d.predictions;
      currentPage = 1;
      renderPage();
    } catch (err) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center text-danger py-4">Erreur: ' + err.message + '</td></tr>';
    }
  }

  function renderPage() {
    const totalPages = Math.max(1, Math.ceil(allPredictions.length / PAGE_SIZE));
    currentPage = Math.min(currentPage, totalPages);
    const start = (currentPage - 1) * PAGE_SIZE;
    const pageItems = allPredictions.slice(start, start + PAGE_SIZE);

    tbody.innerHTML = pageItems.map(function (p, i) {
      const score = p.confidenceScore !== null && p.confidenceScore !== undefined ? p.confidenceScore : 0;
      const outcome = p.outcome;
      const actual = outcome ? outcome.actualSales.toLocaleString('fr-FR') : '—';
      const gap = outcome
        ? '<span class="' + (outcome.forecastError > 0 ? 'text-success' : outcome.forecastError < 0 ? 'text-danger' : '') + '">' + (outcome.forecastError > 0 ? '+' : '') + Math.round(outcome.forecastError) + '</span>'
        : '<span class="text-muted">en attente</span>';
      return '<tr data-index="' + (start + i) + '">' +
        '<td>' + (p.label || '—') + '<div class="text-muted small">' + p.ean + '</div></td>' +
        '<td class="text-end">' + Math.round(p.predictedWeeklyDemand) + '</td>' +
        '<td class="text-end">' + actual + '</td>' +
        '<td class="text-end">' + gap + '</td>' +
        '<td style="min-width:140px;">' +
          '<div class="d-flex align-items-center gap-2">' +
            '<div class="confidence-bar flex-grow-1"><div class="confidence-bar-fill" style="width:' + score + '%; background-color:' + confidenceColor(score) + ';"></div></div>' +
            '<span class="small fw-semibold">' + score + '%</span>' +
          '</div>' +
        '</td>' +
        '<td class="small text-muted">' + (p.model === 'flat' ? 'Moyenne simple' : 'Lissage exponentiel') + '</td>' +
        '</tr>';
    }).join('');

    pageLabel.textContent = 'Page ' + currentPage + ' / ' + totalPages + ' (' + allPredictions.length + ' article(s))';
    prevBtn.disabled = currentPage <= 1;
    nextBtn.disabled = currentPage >= totalPages;

    tbody.querySelectorAll('tr[data-index]').forEach(function (row) {
      row.addEventListener('click', function () {
        openDetail(allPredictions[parseInt(row.dataset.index, 10)]);
      });
    });
  }

  // Sparkline SVG inline : léger, pas de dépendance, suffisant pour 7-14 points journaliers.
  function buildSparkline(dailyHistory) {
    if (!dailyHistory || dailyHistory.length < 2) return '<p class="text-muted small">Pas assez d\'historique pour un graphique.</p>';
    const values = dailyHistory.map(function (d) { return d.quantity || 0; });
    const max = Math.max.apply(null, values.concat([1]));
    const width = 400;
    const height = 100;
    const step = width / (values.length - 1);
    const points = values.map(function (v, i) {
      const x = i * step;
      const y = height - (v / max) * (height - 10) - 5;
      return x + ',' + y;
    }).join(' ');
    const dots = values.map(function (v, i) {
      const x = i * step;
      const y = height - (v / max) * (height - 10) - 5;
      return '<circle cx="' + x + '" cy="' + y + '" r="2.5" fill="#000000"></circle>';
    }).join('');
    const labels = '<div class="d-flex justify-content-between small text-muted mt-1">' +
      '<span>' + dailyHistory[0].date + '</span><span>' + dailyHistory[dailyHistory.length - 1].date + '</span></div>';
    return '<svg viewBox="0 0 ' + width + ' ' + height + '" style="width:100%;height:100px;">' +
      '<polyline points="' + points + '" fill="none" stroke="#000000" stroke-width="2"></polyline>' + dots +
      '</svg>' + labels;
  }

  function signalRow(label, value, extra) {
    return '<div class="aip-signal-row">' +
      '<div class="aip-signal-label">' + label + (extra ? ' <span class="text-muted">(' + extra + ')</span>' : '') + '</div>' +
      '<div class="aip-signal-bar"><div class="aip-signal-bar-fill" style="width:' + value + '%;"></div></div>' +
      '<div class="aip-signal-value">' + value + '%</div>' +
      '</div>';
  }

  function openDetail(p) {
    document.getElementById('aip-detail-title').textContent = p.label || p.ean;

    const outcome = p.outcome;
    const outcomeHtml = outcome
      ? '<div class="alert alert-light border small">' +
          '<strong>Résultat réel :</strong> ' + outcome.actualSales.toLocaleString('fr-FR') + ' vendus contre ' +
          Math.round(p.predictedQuantity) + ' prévus (écart ' + (outcome.forecastError > 0 ? '+' : '') + Math.round(outcome.forecastError) +
          (outcome.percentageError !== null ? ', ' + Math.round(outcome.percentageError * 100) + '% d\'erreur' : '') + ').' +
        '</div>'
      : '<div class="alert alert-light border small text-muted">Semaine cible pas encore terminée : résultat réel non disponible.</div>';

    // Le detail des 4 signaux du score de confiance n'est pas renvoyé en champs séparés par l'API
    // (seulement condensé dans "reasoning" en texte) : on l'extrait ici plutôt que de dupliquer le
    // calcul côté frontend, pour rester fidèle à ce que confidenceService.js a réellement produit.
    function extractSignal(regex) {
      const m = p.reasoning && p.reasoning.match(regex);
      return m ? parseInt(m[1], 10) : null;
    }
    const sigHistory = extractSignal(/historique (\d+)%/);
    const sigVolatility = extractSignal(/stabilité (\d+)%/);
    const sigAccuracy = extractSignal(/précision passée (\d+)%/);
    const sigQuality = extractSignal(/qualité données (\d+)%/);
    const accuracyNotYetEvaluated = /pas encore évaluée/.test(p.reasoning || '');

    const signalsHtml = (sigHistory !== null)
      ? '<div class="mt-2">' +
          signalRow('Historique de données', sigHistory) +
          signalRow('Stabilité des ventes', sigVolatility) +
          signalRow('Précision passée', sigAccuracy, accuracyNotYetEvaluated ? 'pas encore évaluée' : null) +
          signalRow('Qualité des données', sigQuality) +
        '</div>'
      : '<p class="text-muted small">Détail des signaux non disponible pour cette prédiction.</p>';

    document.getElementById('aip-detail-body').innerHTML =
      '<h6 class="text-muted small text-uppercase mb-2">Recommandation</h6>' +
      '<div class="row g-2 mb-3">' +
        '<div class="col-6"><div class="border p-2"><div class="text-muted small">Quantité prévue</div><div class="fs-20 fw-semibold">' + Math.round(p.predictedQuantity) + '</div></div></div>' +
        '<div class="col-6"><div class="border p-2"><div class="text-muted small">Vente hebdo. prévue</div><div class="fs-20 fw-semibold">' + Math.round(p.predictedWeeklyDemand) + '</div></div></div>' +
        '<div class="col-6"><div class="border p-2"><div class="text-muted small">Stock au calcul</div><div class="fs-20 fw-semibold">' + Math.round(p.stockAtPrediction) + '</div></div></div>' +
        '<div class="col-6"><div class="border p-2"><div class="text-muted small">Déjà en commande</div><div class="fs-20 fw-semibold">' + Math.round(p.ordersAtPrediction) + '</div></div></div>' +
      '</div>' +

      '<h6 class="text-muted small text-uppercase mb-2">Historique de ventes utilisé</h6>' +
      buildSparkline(p.dailyHistory) +

      '<h6 class="text-muted small text-uppercase mb-2 mt-3">Score de confiance : ' + (p.confidenceScore ?? '—') + '%</h6>' +
      signalsHtml +

      '<h6 class="text-muted small text-uppercase mb-2 mt-3">Explication</h6>' +
      '<p class="small">' + (p.reasoning || '—') + '</p>' +

      '<h6 class="text-muted small text-uppercase mb-2 mt-3">Résultat</h6>' +
      outcomeHtml;

    const panel = new bootstrap.Offcanvas(document.getElementById('aip-detail-panel'));
    panel.show();
  }

  shopSelect.addEventListener('change', loadProposalList);
  proposalSelect.addEventListener('change', loadPredictions);
  document.getElementById('aip-refresh').addEventListener('click', loadPredictions);
  prevBtn.addEventListener('click', function () { if (currentPage > 1) { currentPage--; renderPage(); } });
  nextBtn.addEventListener('click', function () { currentPage++; renderPage(); });

  loadShopList();
})();
