// Onglet "Journal des décisions IA" de ai-quality.html (22/09/2026) : historique consultable et
// filtrable des décisions déjà prises par l'IA (ProposalLine.aiReasoning/aiAction, persistés à la
// génération, cf. proposalService.js getAiDecisionLog). Ne recalcule rien côté client ; lit
// uniquement l'historique déjà en base pour le magasin actif (sélecteur global de la topbar).
(function () {
  const ACTION_LABELS = {
    ORDER_NOW: 'Commander maintenant',
    ORDER_MORE: 'Commander plus',
    ORDER_LESS: 'Commander moins',
    WAIT: 'Attendre',
    STOCK_RISK: 'Risque de rupture',
    OVERSTOCK: 'Surstock',
    DEMAND_INCREASE: 'Hausse de demande',
    DEMAND_DECREASE: 'Baisse de demande',
    ANOMALY: 'Anomalie',
    VERIFY_STOCK: 'Vérifier le stock',
    NO_ACTION: 'Aucune action',
  };
  const ACTION_BADGE_CLASS = {
    STOCK_RISK: 'bg-danger-subtle text-danger',
    ANOMALY: 'bg-danger-subtle text-danger',
    OVERSTOCK: 'bg-warning-subtle text-warning',
    ORDER_LESS: 'bg-warning-subtle text-warning',
    DEMAND_DECREASE: 'bg-warning-subtle text-warning',
    ORDER_NOW: 'bg-success-subtle text-success',
    ORDER_MORE: 'bg-success-subtle text-success',
    DEMAND_INCREASE: 'bg-info-subtle text-info',
  };

  function fmtDate(iso) {
    return iso ? new Date(iso).toLocaleString('fr-FR') : '—';
  }
  function fmtNum(n) {
    return (n === null || n === undefined) ? '—' : (Math.round(n * 10) / 10).toLocaleString('fr-FR');
  }

  function actionCellRenderer(params) {
    const action = params.value;
    if (!action) return '<span class="text-muted">—</span>';
    const cls = ACTION_BADGE_CLASS[action] || 'bg-secondary-subtle text-secondary';
    return '<span class="badge ' + cls + '">' + (ACTION_LABELS[action] || action) + '</span>';
  }

  function correctedCellRenderer(params) {
    return params.value
      ? '<span class="badge bg-primary-subtle text-primary">Corrigée par l\'humain</span>'
      : '<span class="text-muted small">Suivie telle quelle</span>';
  }

  const gridColumnDefs = [
    { headerName: 'Générée le', field: 'generatedAt', width: 160, filter: 'agDateColumnFilter',
      valueFormatter: function (p) { return fmtDate(p.value); } },
    { headerName: 'Article', field: 'label', flex: 1, minWidth: 200, filter: 'agTextColumnFilter',
      valueFormatter: function (p) { return p.value || p.data.ean; } },
    { headerName: 'Action IA', field: 'aiAction', width: 170, filter: 'agTextColumnFilter', cellRenderer: actionCellRenderer },
    { headerName: 'Raisonnement de l\'IA', field: 'aiReasoning', flex: 2, minWidth: 320, filter: 'agTextColumnFilter',
      autoHeight: true, wrapText: true, valueFormatter: function (p) { return p.value || '—'; } },
    { headerName: 'Calcul classique', field: 'classicQuantitySuggested', width: 130, filter: 'agNumberColumnFilter',
      valueFormatter: function (p) { return fmtNum(p.value); } },
    { headerName: 'Proposé (IA)', field: 'quantityAiOriginal', width: 120, filter: 'agNumberColumnFilter',
      valueFormatter: function (p) { return fmtNum(p.value); } },
    { headerName: 'Commandé', field: 'quantityValidated', width: 110, filter: 'agNumberColumnFilter',
      valueFormatter: function (p) { return fmtNum(p.value); } },
    { headerName: 'Décision', field: 'wasCorrectedByHuman', width: 170, cellRenderer: correctedCellRenderer },
    { headerName: 'Statut commande', field: 'proposalStatus', width: 130, filter: 'agTextColumnFilter' },
  ];

  let gridApi = null;
  function ensureGrid() {
    if (gridApi) return gridApi;
    gridApi = agGrid.createGrid(document.getElementById('adl-grid'), {
      theme: window.REASSORT_AG_GRID_THEME,
      columnDefs: gridColumnDefs,
      rowData: [],
      localeText: window.AG_GRID_LOCALE_FR,
      domLayout: 'autoHeight',
      pagination: true,
      paginationPageSize: 50,
      paginationPageSizeSelector: [25, 50, 100, 200],
      animateRows: false,
    });
    return gridApi;
  }

  async function load() {
    ensureGrid();
    const summaryEl = document.getElementById('adl-summary');
    const shop = window.reassortGetActiveShop ? window.reassortGetActiveShop() : null;
    const user = window.reassortGetUser ? window.reassortGetUser() : null;
    const isSingleShopRole = user && window.reassortIsSingleShopRole && window.reassortIsSingleShopRole(user.role);
    if (!shop && !isSingleShopRole) {
      summaryEl.textContent = 'Sélectionnez un magasin pour voir ce journal.';
      gridApi.setGridOption('rowData', []);
      return;
    }

    summaryEl.textContent = 'Chargement…';
    try {
      const params = new URLSearchParams();
      if (shop) params.set('shop', shop.id);
      const ean = document.getElementById('adl-ean').value.trim();
      const action = document.getElementById('adl-action').value;
      const from = document.getElementById('adl-from').value;
      const to = document.getElementById('adl-to').value;
      if (ean) params.set('ean', ean);
      if (action) params.set('action', action);
      if (from) params.set('from', from + 'T00:00:00');
      if (to) params.set('to', to + 'T23:59:59');

      const res = await window.reassortFetch('/reassort/ai-decision-log?' + params.toString());
      const json = await res.json();
      if (!json.success) throw new Error(json.message);
      const rows = json.data || [];
      summaryEl.textContent = rows.length + ' décision(s) IA (200 max affichées)';
      gridApi.setGridOption('rowData', rows);
    } catch (err) {
      summaryEl.textContent = 'Erreur : ' + err.message;
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('adl-filter').addEventListener('click', load);
    document.getElementById('adl-export-csv').addEventListener('click', function () {
      if (!gridApi) return;
      gridApi.exportDataAsCsv({ fileName: 'journal-decisions-ia-' + new Date().toISOString().slice(0, 10) + '.csv' });
    });
    // Chargé seulement quand l'onglet devient visible (évite un appel réseau inutile si l'utilisateur
    // ne consulte jamais ce journal) — déclenché par Bootstrap au clic sur l'onglet, et par le
    // routage par hash existant (openTabFromHash) pour un lien direct /ai-quality#tab-decision-log.
    let loaded = false;
    const tabLink = document.querySelector('a[href="#tab-decision-log"]');
    if (tabLink) {
      tabLink.addEventListener('shown.bs.tab', function () {
        if (!loaded) { loaded = true; load(); }
      });
    }
    if (window.location.hash === '#tab-decision-log') { loaded = true; load(); }
    if (window.reassortOnActiveShopChange) window.reassortOnActiveShopChange(function () { if (loaded) load(); });
  });
})();
