/**
 * Rend un <select> de magasins (rempli avec des <optgroup>/<option data-reference data-name
 * data-pos-id>) cherchable via une modale plein écran (tableau Serveur / Code / Nom magasin,
 * recherche en haut), sans changer son API : le reste du code continue de lire
 * shopSelect.value / shopSelect.selectedOptions[0].dataset.* comme avant.
 *
 * Style calqué sur le sélecteur de magasin RPOS (demande du 14/09/2026) mais en noir/blanc,
 * cohérent avec le reste de l'application (jamais de bleu comme accent).
 *
 * Utilisation : après avoir rempli selectEl.innerHTML avec les <optgroup>/<option>, appeler
 * window.reassortMakeShopPickerSearchable(selectEl) une fois — un ré-appel après un nouveau
 * remplissage reconstruit le picker à partir du select à jour.
 */
(function () {
  let modalCounter = 0;

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function buildPicker(selectEl) {
    const existingWrapper = selectEl.parentElement.querySelector('.shop-picker-wrapper');
    if (existingWrapper) existingWrapper.remove();
    const existingModal = document.getElementById(selectEl.dataset.shopPickerModalId || '');
    if (existingModal) existingModal.remove();

    modalCounter += 1;
    const modalId = 'shop-picker-modal-' + modalCounter;
    selectEl.dataset.shopPickerModalId = modalId;

    const options = Array.from(selectEl.querySelectorAll('option')).filter(function (o) { return o.value; });

    const wrapper = document.createElement('div');
    wrapper.className = 'shop-picker-wrapper';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'form-select text-start shop-picker-button';
    button.setAttribute('data-bs-toggle', 'modal');
    button.setAttribute('data-bs-target', '#' + modalId);
    button.textContent = selectEl.selectedOptions.length ? selectEl.selectedOptions[0].textContent : 'Sélectionner un magasin';

    wrapper.appendChild(button);
    selectEl.insertAdjacentElement('afterend', wrapper);

    const modal = document.createElement('div');
    modal.className = 'modal fade shop-picker-modal';
    modal.id = modalId;
    modal.tabIndex = -1;
    modal.setAttribute('aria-hidden', 'true');
    modal.innerHTML =
      '<div class="modal-dialog modal-lg modal-dialog-scrollable">' +
        '<div class="modal-content">' +
          '<div class="modal-header">' +
            '<h5 class="modal-title">Sélectionner un magasin</h5>' +
            '<button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Fermer"></button>' +
          '</div>' +
          '<div class="modal-body p-0">' +
            '<div class="p-3 border-bottom">' +
              '<input type="text" class="form-control shop-picker-search" placeholder="Rechercher par serveur, code ou nom de magasin...">' +
            '</div>' +
            '<div class="table-responsive">' +
              '<table class="table table-hover mb-0 shop-picker-table">' +
                '<thead>' +
                  '<tr><th>Serveur</th><th>Code magasin</th><th>Nom magasin</th></tr>' +
                '</thead>' +
                '<tbody class="shop-picker-tbody"></tbody>' +
              '</table>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);

    const tbody = modal.querySelector('.shop-picker-tbody');
    const searchInput = modal.querySelector('.shop-picker-search');

    function renderRows(filterText) {
      const q = (filterText || '').trim().toLowerCase();
      const rows = options
        .filter(function (opt) {
          if (!q) return true;
          const groupLabel = opt.parentElement && opt.parentElement.tagName === 'OPTGROUP' ? opt.parentElement.label : '';
          const haystack = ((opt.dataset.posId || '') + ' ' + (opt.dataset.reference || '') + ' ' + (opt.dataset.name || '') + ' ' + groupLabel + ' ' + opt.textContent).toLowerCase();
          return haystack.indexOf(q) !== -1;
        })
        .map(function (opt) {
          const groupLabel = opt.parentElement && opt.parentElement.tagName === 'OPTGROUP' ? opt.parentElement.label : (opt.dataset.posId || '—');
          const isActive = opt.value === selectEl.value;
          return '<tr class="shop-picker-row' + (isActive ? ' table-active' : '') + '" data-value="' + escapeHtml(opt.value) + '">' +
            '<td>' + escapeHtml(groupLabel) + '</td>' +
            '<td>' + escapeHtml(opt.dataset.reference || '—') + '</td>' +
            '<td>' + escapeHtml(opt.dataset.name || opt.textContent) + '</td>' +
            '</tr>';
        });

      tbody.innerHTML = rows.length
        ? rows.join('')
        : '<tr><td colspan="3" class="text-center text-muted py-4">Aucun magasin trouvé.</td></tr>';

      tbody.querySelectorAll('.shop-picker-row').forEach(function (row) {
        row.addEventListener('click', function () {
          const opt = options.find(function (o) { return o.value === row.dataset.value; });
          if (!opt) return;
          selectEl.value = opt.value;
          selectEl.dispatchEvent(new Event('change'));
          button.textContent = opt.textContent;
          const bsModal = bootstrap.Modal.getInstance(modal);
          if (bsModal) bsModal.hide();
        });
      });
    }

    searchInput.addEventListener('input', function () { renderRows(searchInput.value); });
    modal.addEventListener('shown.bs.modal', function () {
      searchInput.value = '';
      renderRows('');
      searchInput.focus();
    });

    selectEl.addEventListener('change', function () {
      if (selectEl.selectedOptions.length) button.textContent = selectEl.selectedOptions[0].textContent;
    });
  }

  window.reassortMakeShopPickerSearchable = function (selectEl) {
    if (!selectEl) return;
    selectEl.style.display = 'none';
    buildPicker(selectEl);
  };
})();
