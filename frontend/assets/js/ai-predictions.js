(function () {
  const shopSelect = document.getElementById('aip-shop');
  const proposalSelect = document.getElementById('aip-proposal');
  const infoBox = document.getElementById('aip-proposal-info');
  const pageLabel = document.getElementById('aip-page-label');
  const emptyBox = document.getElementById('aip-empty');
  const gridEl = document.getElementById('aip-grid');

  let allPredictions = [];
  let currentProposalId = null;
  // Jeton de requête : un changement rapide de magasin peut faire partir plusieurs chargements en
  // parallèle dont les réponses reviennent dans le désordre — sans ce garde-fou, la réponse d'un
  // magasin déjà quitté pouvait écraser l'affichage après coup (même bug que sales-history.html,
  // corrigé le 15/09/2026).
  let loadToken = 0;

  function showEmpty(message) {
    emptyBox.textContent = message;
    emptyBox.style.display = '';
    gridEl.style.display = 'none';
    pageLabel.textContent = '—';
  }

  function showGrid() {
    emptyBox.style.display = 'none';
    gridEl.style.display = '';
  }

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
          return '<option value="' + s.id + '" data-pos-id="' + s.posId + '">' + s.reference + ' - ' + s.name + '</option>';
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

  // Lance en fond (sans attendre) le calcul du profil d'activité du magasin utilisé par l'analyse
  // IA par article : ce calcul (~15-30s au pire, mis en cache 24h ensuite) est le principal facteur
  // de lenteur du tout premier clic "Analyser" sur un magasin — le déclencher dès sa sélection
  // laisse le temps qu'il soit déjà en cache au moment où l'utilisateur clique réellement un article.
  function warmShopActivity(shopId) {
    const opt = shopSelect.querySelector('option[value="' + shopId + '"]');
    const posId = opt ? opt.dataset.posId : null;
    if (!shopId || !posId) return;
    window.reassortFetch('/reassort/shop-activity/warm?shop=' + encodeURIComponent(shopId) + '&pos=' + encodeURIComponent(posId), { method: 'POST' }).catch(function () {});
  }

  async function loadProposalList() {
    const shopId = shopSelect.value;
    const token = ++loadToken;
    proposalSelect.innerHTML = '<option value="">—</option>';
    proposalSelect.disabled = true;
    if (!shopId) return;
    warmShopActivity(shopId);
    try {
      const res = await window.reassortFetch('/reassort/predictions/proposals?shop=' + encodeURIComponent(shopId));
      const json = await res.json();
      if (token !== loadToken) return; // un changement de magasin plus récent a déjà démarré, réponse ignorée
      if (!json.success) throw new Error(json.message);
      if (!json.data.length) {
        showEmpty('Aucune prédiction enregistrée pour ce magasin. Générez une proposition pour en créer.');
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
      if (token !== loadToken) return;
      showEmpty('Erreur: ' + err.message);
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
      showEmpty('Sélectionnez un magasin pour afficher ses prédictions.');
      infoBox.textContent = '';
      return;
    }
    const token = ++loadToken;
    showEmpty('Chargement...');
    try {
      const proposalId = proposalSelect.value;
      const url = '/reassort/predictions?shop=' + encodeURIComponent(shopId) + (proposalId ? '&proposalId=' + encodeURIComponent(proposalId) : '');
      const res = await window.reassortFetch(url);
      const json = await res.json();
      if (token !== loadToken) return; // un changement de magasin plus récent a déjà démarré, réponse ignorée
      if (!json.success) throw new Error(json.message);
      const d = json.data;

      if (!d.proposalId || !d.predictions.length) {
        showEmpty('Aucune prédiction enregistrée pour ce magasin. Générez une proposition pour en créer.');
        infoBox.textContent = '';
        return;
      }

      // Reflète dans le sélecteur la proposition réellement chargée (utile au premier chargement,
      // quand proposalId n'était pas encore renseigné dans l'URL).
      if (proposalSelect.value !== d.proposalId) proposalSelect.value = d.proposalId;
      currentProposalId = d.proposalId;

      infoBox.textContent = d.predictions.length + ' article(s) — génération du ' + new Date(d.generatedAt).toLocaleString('fr-FR') + '.';

      allPredictions = d.predictions;
      renderGrid();
    } catch (err) {
      if (token !== loadToken) return;
      showEmpty('Erreur: ' + err.message);
    }
  }

  // Type d'action structuré (§18 du cahier des charges) : badge coloré par famille sémantique
  // (urgence/alerte en rouge-orange, réduction/attente en gris, augmentation en vert, neutre en
  // bleu clair) — jamais de bleu comme accent principal de l'appli, ici uniquement une nuance
  // sémantique parmi d'autres, cohérent avec les badges déjà utilisés ailleurs (ruptures, etc.).
  const AI_ACTION_LABELS = {
    ORDER_NOW: 'À commander',
    ORDER_MORE: 'Commande insuffisante',
    ORDER_LESS: 'Réduire la commande',
    WAIT: 'Attendre',
    STOCK_RISK: 'Risque de rupture',
    OVERSTOCK: 'Surstock',
    DEMAND_INCREASE: 'Demande en hausse',
    DEMAND_DECREASE: 'Demande en baisse',
    ANOMALY: 'Anomalie détectée',
    VERIFY_STOCK: 'Vérifier le stock',
    NO_ACTION: 'Rien à signaler',
  };
  const AI_ACTION_BADGE_CLASS = {
    ORDER_NOW: 'bg-dark',
    ORDER_MORE: 'bg-warning text-dark',
    ORDER_LESS: 'bg-secondary',
    WAIT: 'bg-light text-dark border',
    STOCK_RISK: 'bg-danger',
    OVERSTOCK: 'bg-warning text-dark',
    DEMAND_INCREASE: 'bg-success',
    DEMAND_DECREASE: 'bg-secondary',
    ANOMALY: 'bg-danger',
    VERIFY_STOCK: 'bg-danger',
    NO_ACTION: 'bg-light text-dark border',
  };
  function aiActionLabel(action) {
    return (action && AI_ACTION_LABELS[action]) || '—';
  }

  function labelCellRenderer(params) {
    const p = params.data;
    const wrap = document.createElement('div');
    wrap.innerHTML = (p.label || '—') + '<div class="text-muted small">' + p.ean + '</div>';
    return wrap;
  }

  function gapCellRenderer(params) {
    const p = params.data;
    const outcome = p.outcome;
    const span = document.createElement('span');
    if (!outcome) {
      span.className = 'text-muted';
      span.textContent = 'en attente';
      return span;
    }
    span.className = outcome.forecastError > 0 ? 'text-success' : (outcome.forecastError < 0 ? 'text-danger' : '');
    span.textContent = (outcome.forecastError > 0 ? '+' : '') + Math.round(outcome.forecastError);
    return span;
  }

  function confidenceCellRenderer(params) {
    const p = params.data;
    const score = p.confidenceScore !== null && p.confidenceScore !== undefined ? p.confidenceScore : 0;
    const wrap = document.createElement('div');
    wrap.className = 'd-flex align-items-center gap-2';
    wrap.style.minWidth = '140px';
    wrap.innerHTML =
      '<div class="confidence-bar flex-grow-1"><div class="confidence-bar-fill" style="width:' + score + '%; background-color:' + confidenceColor(score) + ';"></div></div>' +
      '<span class="small fw-semibold">' + score + '%</span>';
    return wrap;
  }

  function aiActionCellRenderer(params) {
    const p = params.data;
    const action = p.aiAction;
    if (!action || !AI_ACTION_LABELS[action]) {
      const span = document.createElement('span');
      span.className = 'text-muted small';
      span.textContent = '—';
      return span;
    }
    const badge = document.createElement('span');
    badge.className = 'badge ' + AI_ACTION_BADGE_CLASS[action];
    badge.textContent = AI_ACTION_LABELS[action];
    return badge;
  }

  // Ouvre le panneau partagé "Recommandation IA" (assets/js/ai-recommendation-panel.js, même
  // composant que purchase-order-v2.html) pour la ligne cliquée. Attaché directement sur la
  // cellule via onCellClicked (AG Grid virtualise les lignes, donc pas de délégation sur un
  // tbody parent comme dans l'ancienne version).
  function openPanelForRow(prediction) {
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
      classicQuantitySuggested: prediction.classicQuantitySuggested,
      generationAiAdjusted: prediction.aiAdjusted,
      generationAiReasoning: prediction.aiReasoningAtGeneration,
      generationAiAction: prediction.aiAction,
      hasRecentOrder: prediction.hasRecentOrder,
      recentOrderReference: prediction.recentOrderReference,
      recentOrderDate: prediction.recentOrderDate,
      recentOrderCount: prediction.recentOrderCount,
      orderingUnit: prediction.orderingUnit,
      avgWeeklySales: prediction.avgWeeklySales,
      daysUntilStockout: prediction.daysUntilStockout,
    });
  }

  const gridColumnDefs = [
    { headerName: 'Rayon', field: 'department', width: 160, filter: 'agTextColumnFilter',
      valueGetter: function (p) { return p.data ? (p.data.department || 'Autre') : ''; } },
    { headerName: 'Article', field: 'label', flex: 2, minWidth: 260, filter: 'agTextColumnFilter', cellRenderer: labelCellRenderer },
    { headerName: 'Qté à commander', field: 'predictedQuantity', type: 'numericColumn', filter: 'agNumberColumnFilter', width: 160,
      valueFormatter: function (p) { return p.value !== null && p.value !== undefined ? String(Math.round(p.value)) : '—'; },
      cellClass: 'fw-semibold' },
    { headerName: 'Vente prévue/sem.', field: 'predictedWeeklyDemand', type: 'numericColumn', filter: 'agNumberColumnFilter', width: 160,
      valueFormatter: function (p) { return p.value !== null && p.value !== undefined ? String(Math.round(p.value)) : '—'; } },
    { headerName: 'Réel', width: 110, type: 'numericColumn', sortable: false, filter: false,
      valueGetter: function (p) { return p.data && p.data.outcome ? p.data.outcome.actualSales : null; },
      valueFormatter: function (p) { return p.value !== null && p.value !== undefined ? p.value.toLocaleString('fr-FR') : '—'; } },
    { headerName: 'Écart', width: 110, sortable: false, filter: false, cellRenderer: gapCellRenderer,
      valueGetter: function (p) { return p.data && p.data.outcome ? Math.round(p.data.outcome.forecastError) : null; } },
    { headerName: 'Confiance', field: 'confidenceScore', width: 170, filter: 'agNumberColumnFilter', cellRenderer: confidenceCellRenderer,
      valueFormatter: function (p) { return (p.value !== null && p.value !== undefined ? p.value : 0) + ' %'; } },
    { headerName: 'Méthode', field: 'model', width: 160, filter: 'agTextColumnFilter',
      valueFormatter: function (p) { return p.value === 'flat' ? 'Moyenne simple' : 'Lissage exponentiel'; } },
    { headerName: 'Action IA', field: 'aiAction', width: 170, filter: 'agTextColumnFilter', cellRenderer: aiActionCellRenderer,
      valueFormatter: function (p) { return aiActionLabel(p.value); } },
  ];

  let gridApi = null;
  function ensureGrid() {
    if (gridApi) return gridApi;
    gridApi = agGrid.createGrid(gridEl, {
      theme: window.REASSORT_AG_GRID_THEME_SOFT,
      columnDefs: gridColumnDefs,
      rowData: [],
      localeText: window.AG_GRID_LOCALE_FR,
      // La grille prend la hauteur de son contenu réel plutôt qu'une hauteur fixe avec du vide en
      // dessous, comme les autres tableaux du site migrés vers AG Grid (purchase-order-v2.html).
      domLayout: 'autoHeight',
      pagination: true,
      paginationPageSize: 50,
      paginationPageSizeSelector: [25, 50, 100, 200],
      animateRows: false,
      suppressCellFocus: true,
      getRowId: function (params) { return params.data.ean; },
      // Tri par défaut : rayon (regroupement visuel équivalent à l'ancien groupByDepartment), puis
      // confiance croissante (donnée interne) — les articles les moins fiables d'abord dans chaque
      // rayon, comme l'ancien tri manuel.
      onGridReady: function () {
        gridApi.applyColumnState({ state: [
          { colId: 'department', sort: 'asc', sortIndex: 0 },
          { colId: 'confidenceScore', sort: 'asc', sortIndex: 1 },
        ] });
      },
      // Clic sur une ligne : ouvre le panneau de recommandation IA pour cet article, attaché
      // directement par AG Grid (plus de délégation sur un tbody parent comme dans l'ancienne
      // version, dont les lignes n'existent plus une fois virtualisées hors écran).
      onCellClicked: function (e) {
        openPanelForRow(e.data);
      },
      onPaginationChanged: function () {
        updatePageLabel();
      },
      onModelUpdated: function () {
        updatePageLabel();
      },
    });
    window.reassortAgGridToolbar(gridApi, document.getElementById('aip-grid-toolbar'));
    return gridApi;
  }

  function updatePageLabel() {
    if (!gridApi) return;
    const totalArticles = allPredictions.length;
    const deptCount = new Set(allPredictions.map(function (p) { return p.department || 'Autre'; })).size;
    const totalPages = gridApi.paginationGetTotalPages() || 1;
    const currentPage = gridApi.paginationGetCurrentPage() + 1;
    pageLabel.textContent = 'Page ' + currentPage + ' / ' + totalPages + ' (' + deptCount + ' rayon(s), ' + totalArticles + ' article(s))';
  }

  function renderGrid() {
    showGrid();
    const api = ensureGrid();
    api.setGridOption('rowData', allPredictions);
    updatePageLabel();
  }

  document.getElementById('aip-export-csv').addEventListener('click', function () {
    if (!gridApi) return;
    const shopRef = (shopSelect.selectedOptions.length && shopSelect.selectedOptions[0].textContent) || 'magasin';
    gridApi.exportDataAsCsv({
      fileName: 'predictions-ia-' + shopRef.replace(/[^a-z0-9]+/gi, '-') + '-' + new Date().toISOString().slice(0, 10) + '.csv',
    });
  });

  shopSelect.addEventListener('change', loadProposalList);
  proposalSelect.addEventListener('change', loadPredictions);
  document.getElementById('aip-refresh').addEventListener('click', loadPredictions);

  loadShopList();
})();
