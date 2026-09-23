// Remplace le panneau latéral "Columns/Filters" d'AG Grid (23/09/2026) : cette fonctionnalité fait
// partie d'AG Grid Enterprise (licence payante non configurée sur ce projet) — l'activer via
// `sideBar: true` casse complètement le rendu de la grille en Community (testé : page blanche, sans
// erreur console, aucun message expliquant pourquoi). window.reassortAgGridToolbar reproduit
// l'équivalent fonctionnel en Community : un bouton "Colonnes" (afficher/masquer, cases à cocher) et
// un indicateur "Filtres actifs" (liste + effacement), tous deux basés sur des API 100% Community
// (getColumnState/applyColumnState, getFilterModel/setFilterModel).
//
// Usage : window.reassortAgGridToolbar(gridApi, containerEl) — containerEl est un élément où les
// deux boutons sont insérés (ex: la barre d'en-tête d'une carte, à côté du bouton "Export CSV").
(function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function closeAllDropdowns() {
    document.querySelectorAll('.rag-toolbar-dropdown.show').forEach(function (d) { d.classList.remove('show'); });
  }
  document.addEventListener('click', function (e) {
    if (!e.target.closest('.rag-toolbar-btn') && !e.target.closest('.rag-toolbar-dropdown')) closeAllDropdowns();
  });

  function buildColumnsButton(gridApi) {
    const wrap = document.createElement('div');
    wrap.className = 'rag-toolbar-wrap';
    wrap.innerHTML =
      '<button type="button" class="btn btn-sm btn-outline-secondary rag-toolbar-btn">' +
      '<iconify-icon icon="solar:widget-4-bold-duotone" class="align-middle"></iconify-icon> Colonnes' +
      '</button>' +
      '<div class="rag-toolbar-dropdown"></div>';
    const btn = wrap.querySelector('.rag-toolbar-btn');
    const dropdown = wrap.querySelector('.rag-toolbar-dropdown');

    function renderList() {
      const colDefs = gridApi.getColumnDefs() || [];
      const state = gridApi.getColumnState();
      const stateByColId = new Map(state.map(function (s) { return [s.colId, s]; }));
      dropdown.innerHTML = colDefs
        .filter(function (c) { return c.colId !== undefined || c.field; })
        .map(function (c) {
          const colId = c.colId || c.field;
          const s = stateByColId.get(colId);
          const hidden = s ? !!s.hide : !!c.hide;
          const label = c.headerName || c.field || colId;
          return '<label class="rag-toolbar-col-item"><input type="checkbox" data-col-id="' + esc(colId) + '"' + (hidden ? '' : ' checked') + '> ' + esc(label) + '</label>';
        }).join('');
    }

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      const willShow = !dropdown.classList.contains('show');
      closeAllDropdowns();
      if (willShow) { renderList(); dropdown.classList.add('show'); }
    });
    dropdown.addEventListener('change', function (e) {
      const checkbox = e.target.closest('input[data-col-id]');
      if (!checkbox) return;
      gridApi.applyColumnState({ state: [{ colId: checkbox.dataset.colId, hide: !checkbox.checked }] });
    });
    return wrap;
  }

  function buildFiltersButton(gridApi) {
    const wrap = document.createElement('div');
    wrap.className = 'rag-toolbar-wrap';
    wrap.innerHTML =
      '<button type="button" class="btn btn-sm btn-outline-secondary rag-toolbar-btn">' +
      '<iconify-icon icon="solar:filter-bold-duotone" class="align-middle"></iconify-icon> Filtres <span class="rag-toolbar-badge" style="display:none;"></span>' +
      '</button>' +
      '<div class="rag-toolbar-dropdown"></div>';
    const btn = wrap.querySelector('.rag-toolbar-btn');
    const badge = wrap.querySelector('.rag-toolbar-badge');
    const dropdown = wrap.querySelector('.rag-toolbar-dropdown');

    function activeFilterEntries() {
      const model = gridApi.getFilterModel() || {};
      return Object.keys(model);
    }

    function updateBadge() {
      const count = activeFilterEntries().length;
      badge.style.display = count > 0 ? '' : 'none';
      badge.textContent = count;
    }

    function colLabel(colId) {
      const colDefs = gridApi.getColumnDefs() || [];
      const match = colDefs.find(function (c) { return (c.colId || c.field) === colId; });
      return match ? (match.headerName || match.field || colId) : colId;
    }

    function renderList() {
      const keys = activeFilterEntries();
      if (!keys.length) {
        dropdown.innerHTML = '<div class="rag-toolbar-empty">Aucun filtre actif.</div>';
        return;
      }
      dropdown.innerHTML =
        keys.map(function (colId) {
          return '<div class="rag-toolbar-filter-item"><span>' + esc(colLabel(colId)) + '</span>' +
            '<button type="button" class="btn-close btn-close-sm" data-clear-col="' + esc(colId) + '" aria-label="Retirer"></button></div>';
        }).join('') +
        '<button type="button" class="btn btn-sm btn-outline-dark w-100 mt-2" data-clear-all>Tout effacer</button>';
    }

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      const willShow = !dropdown.classList.contains('show');
      closeAllDropdowns();
      if (willShow) { renderList(); dropdown.classList.add('show'); }
    });
    dropdown.addEventListener('click', function (e) {
      const clearOne = e.target.closest('[data-clear-col]');
      const clearAll = e.target.closest('[data-clear-all]');
      if (clearOne) {
        const model = gridApi.getFilterModel() || {};
        delete model[clearOne.dataset.clearCol];
        gridApi.setFilterModel(model);
      } else if (clearAll) {
        gridApi.setFilterModel(null);
      }
      renderList();
    });
    gridApi.addEventListener('filterChanged', updateBadge);
    updateBadge();
    return wrap;
  }

  let stylesInjected = false;
  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const style = document.createElement('style');
    style.textContent =
      '.rag-toolbar-wrap { position: relative; display: inline-block; }' +
      '.rag-toolbar-dropdown { display: none; position: absolute; right: 0; top: calc(100% + 4px); z-index: 1000; ' +
      'background: #fff; border: 1px solid #d1d5db; box-shadow: 0 4px 12px rgba(0,0,0,.12); padding: .6rem; min-width: 220px; max-height: 320px; overflow-y: auto; }' +
      '.rag-toolbar-dropdown.show { display: block; }' +
      '.rag-toolbar-col-item { display: flex; align-items: center; gap: .5rem; font-size: .85rem; padding: .25rem 0; margin: 0; cursor: pointer; }' +
      '.rag-toolbar-filter-item { display: flex; align-items: center; justify-content: space-between; gap: .5rem; font-size: .85rem; padding: .3rem 0; border-bottom: 1px solid #f0f0f0; }' +
      '.rag-toolbar-filter-item:last-of-type { border-bottom: none; }' +
      '.rag-toolbar-empty { font-size: .85rem; color: #6c757d; padding: .3rem 0; }' +
      '.rag-toolbar-badge { display: inline-block; background: #111111; color: #fff; border-radius: 0; font-size: .7rem; padding: 0 .4rem; margin-left: .25rem; }';
    document.head.appendChild(style);
  }

  window.reassortAgGridToolbar = function (gridApi, containerEl) {
    injectStyles();
    containerEl.appendChild(buildColumnsButton(gridApi));
    containerEl.appendChild(buildFiltersButton(gridApi));
  };
})();
