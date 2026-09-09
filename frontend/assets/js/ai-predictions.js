(function () {
  const shopSelect = document.getElementById('aip-shop');
  const proposalSelect = document.getElementById('aip-proposal');
  const tbody = document.getElementById('aip-tbody');
  const infoBox = document.getElementById('aip-proposal-info');
  const pageLabel = document.getElementById('aip-page-label');
  const prevBtn = document.getElementById('aip-prev-page');
  const nextBtn = document.getElementById('aip-next-page');

  const DEPARTMENTS_PER_PAGE = 5;
  let allPredictions = [];
  let groupedByDepartment = []; // [{ department, predictions: [...] }], trié par nb d'articles décroissant
  let currentPage = 1;
  let currentProposalId = null;

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
        tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-4">Aucune prédiction enregistrée pour ce magasin. Générez une proposition pour en créer.</td></tr>';
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
      tbody.innerHTML = '<tr><td colspan="7" class="text-center text-danger py-4">Erreur: ' + err.message + '</td></tr>';
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
      tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-4">Sélectionnez un magasin pour afficher ses prédictions.</td></tr>';
      infoBox.textContent = '';
      return;
    }
    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-4">Chargement...</td></tr>';
    try {
      const proposalId = proposalSelect.value;
      const url = '/reassort/predictions?shop=' + encodeURIComponent(shopId) + (proposalId ? '&proposalId=' + encodeURIComponent(proposalId) : '');
      const res = await window.reassortFetch(url);
      const json = await res.json();
      if (!json.success) throw new Error(json.message);
      const d = json.data;

      if (!d.proposalId || !d.predictions.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-4">Aucune prédiction enregistrée pour ce magasin. Générez une proposition pour en créer.</td></tr>';
        infoBox.textContent = '';
        return;
      }

      // Reflète dans le sélecteur la proposition réellement chargée (utile au premier chargement,
      // quand proposalId n'était pas encore renseigné dans l'URL).
      if (proposalSelect.value !== d.proposalId) proposalSelect.value = d.proposalId;
      currentProposalId = d.proposalId;

      infoBox.textContent = d.predictions.length + ' article(s) — génération du ' + new Date(d.generatedAt).toLocaleString('fr-FR') + '.';

      allPredictions = d.predictions;
      groupedByDepartment = groupByDepartment(allPredictions);
      currentPage = 1;
      renderPage();
    } catch (err) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-center text-danger py-4">Erreur: ' + err.message + '</td></tr>';
    }
  }

  // Regroupe par rayon (department) plutôt que de mélanger tous les articles du magasin en vrac :
  // sinon un article "PRODUITS FRAIS" à faible confiance apparaît juste au-dessus d'un article
  // "BAZAR" sans aucun rapport, rendant le tableau difficile à parcourir par un responsable de
  // rayon. Chaque groupe garde le tri par confiance croissante (les moins fiables d'abord).
  function groupByDepartment(predictions) {
    const byDept = new Map();
    predictions.forEach(function (p) {
      const dept = p.department || 'Autre';
      if (!byDept.has(dept)) byDept.set(dept, []);
      byDept.get(dept).push(p);
    });
    return Array.from(byDept.entries())
      .map(function ([department, items]) { return { department, predictions: items }; })
      .sort(function (a, b) { return a.department.localeCompare(b.department); });
  }

  function predictionRowHtml(p) {
    const score = p.confidenceScore !== null && p.confidenceScore !== undefined ? p.confidenceScore : 0;
    const outcome = p.outcome;
    const actual = outcome ? outcome.actualSales.toLocaleString('fr-FR') : '—';
    const gap = outcome
      ? '<span class="' + (outcome.forecastError > 0 ? 'text-success' : outcome.forecastError < 0 ? 'text-danger' : '') + '">' + (outcome.forecastError > 0 ? '+' : '') + Math.round(outcome.forecastError) + '</span>'
      : '<span class="text-muted">en attente</span>';
    return '<tr data-ean="' + p.ean + '">' +
      '<td>' + (p.label || '—') + '<div class="text-muted small">' + p.ean + '</div></td>' +
      '<td class="text-end fw-semibold">' + Math.round(p.predictedQuantity) + '</td>' +
      '<td class="text-end text-muted">' + Math.round(p.predictedWeeklyDemand) + '</td>' +
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
  }

  // Pagination par groupe de département (pas par ligne) : un rayon n'est jamais coupé entre deux
  // pages, ce qui rendrait sa lecture incohérente pour un responsable de rayon donné.
  function renderPage() {
    const totalPages = Math.max(1, Math.ceil(groupedByDepartment.length / DEPARTMENTS_PER_PAGE));
    currentPage = Math.min(currentPage, totalPages);
    const start = (currentPage - 1) * DEPARTMENTS_PER_PAGE;
    const pageGroups = groupedByDepartment.slice(start, start + DEPARTMENTS_PER_PAGE);

    tbody.innerHTML = pageGroups.map(function (group) {
      const headerRow = '<tr class="table-light"><td colspan="7" class="fw-semibold py-2">' +
        group.department + ' <span class="text-muted fw-normal">(' + group.predictions.length + ' article(s))</span></td></tr>';
      return headerRow + group.predictions.map(predictionRowHtml).join('');
    }).join('');

    const totalArticles = allPredictions.length;
    pageLabel.textContent = 'Page ' + currentPage + ' / ' + totalPages + ' (' + groupedByDepartment.length + ' rayon(s), ' + totalArticles + ' article(s))';
    prevBtn.disabled = currentPage <= 1;
    nextBtn.disabled = currentPage >= totalPages;

    // L'ouverture du panneau et toute la logique d'analyse IA / détail vivent dans le module
    // partagé ai-recommendation-panel.js (réutilisé aussi sur purchase-order.html) : cette page ne
    // fait que fournir les données de la ligne cliquée.
    tbody.querySelectorAll('tr[data-ean]').forEach(function (row) {
      row.addEventListener('click', function () {
        const prediction = allPredictions.find(function (p) { return p.ean === row.dataset.ean; });
        if (!prediction) return;
        window.openAiRecommendationPanel({
          proposalId: currentProposalId,
          shopId: shopSelect.value,
          ean: prediction.ean,
          label: prediction.label,
          predictedQuantity: prediction.predictedQuantity,
          predictedWeeklyDemand: prediction.predictedWeeklyDemand,
          stockAtPrediction: prediction.stockAtPrediction,
          ordersAtPrediction: prediction.ordersAtPrediction,
          confidenceScore: prediction.confidenceScore,
          reasoning: prediction.reasoning,
          dailyHistory: prediction.dailyHistory,
          outcome: prediction.outcome,
        });
      });
    });
  }

  shopSelect.addEventListener('change', loadProposalList);
  proposalSelect.addEventListener('change', loadPredictions);
  document.getElementById('aip-refresh').addEventListener('click', loadPredictions);
  prevBtn.addEventListener('click', function () { if (currentPage > 1) { currentPage--; renderPage(); } });
  nextBtn.addEventListener('click', function () { currentPage++; renderPage(); });

  loadShopList();
})();
