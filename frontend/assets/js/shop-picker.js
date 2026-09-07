/**
 * Rend un <select> de magasins (rempli avec des <optgroup>/<option data-reference data-name
 * data-pos-id>) cherchable, sans changer son API : le reste du code continue de lire
 * shopSelect.value / shopSelect.selectedOptions[0].dataset.* comme avant. On construit un
 * dropdown Bootstrap par-dessus qui pilote ce select caché comme source de vérité unique.
 *
 * Utilisation : après avoir rempli selectEl.innerHTML avec les <optgroup>/<option>, appeler
 * window.reassortMakeShopPickerSearchable(selectEl) une fois — un ré-appel après un nouveau
 * remplissage reconstruit le dropdown à partir du select à jour.
 */
(function () {
  function buildPicker(selectEl) {
    // Évite de dupliquer le picker si la fonction est rappelée après un rechargement de la liste.
    const existingWrapper = selectEl.parentElement.querySelector('.shop-picker-wrapper');
    if (existingWrapper) existingWrapper.remove();

    const options = Array.from(selectEl.querySelectorAll('option')).filter(function (o) { return o.value; });

    const wrapper = document.createElement('div');
    wrapper.className = 'shop-picker-wrapper dropdown';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'form-select text-start shop-picker-button';
    button.setAttribute('data-bs-toggle', 'dropdown');
    button.setAttribute('aria-expanded', 'false');
    button.textContent = selectEl.selectedOptions.length ? selectEl.selectedOptions[0].textContent : 'Sélectionner un magasin';

    const menu = document.createElement('div');
    menu.className = 'dropdown-menu p-2 shop-picker-menu';
    menu.style.width = '100%';
    menu.style.maxHeight = '360px';
    menu.style.overflowY = 'auto';

    const searchWrap = document.createElement('div');
    searchWrap.className = 'mb-2';
    searchWrap.innerHTML =
      '<input type="text" class="form-control form-control-sm shop-picker-search" placeholder="Rechercher par POS, code ou nom de magasin...">';
    menu.appendChild(searchWrap);

    const listWrap = document.createElement('div');
    listWrap.className = 'shop-picker-list';
    menu.appendChild(listWrap);

    function renderList(filterText) {
      const q = (filterText || '').trim().toLowerCase();
      listWrap.innerHTML = '';

      // Regroupe par optgroup pour garder la structure "Serveur -> magasins" déjà en place.
      const groups = new Map(); // label -> [option]
      options.forEach(function (opt) {
        const groupLabel = opt.parentElement && opt.parentElement.tagName === 'OPTGROUP'
          ? opt.parentElement.label : '';
        if (!groups.has(groupLabel)) groups.set(groupLabel, []);
        groups.get(groupLabel).push(opt);
      });

      let anyVisible = false;
      groups.forEach(function (opts, groupLabel) {
        const matching = opts.filter(function (opt) {
          if (!q) return true;
          const haystack = (
            (opt.dataset.posId || '') + ' ' +
            (opt.dataset.reference || '') + ' ' +
            (opt.dataset.name || '') + ' ' +
            opt.textContent
          ).toLowerCase();
          return haystack.indexOf(q) !== -1;
        });
        if (!matching.length) return;
        anyVisible = true;

        if (groupLabel) {
          const groupHeader = document.createElement('div');
          groupHeader.className = 'dropdown-header px-1';
          groupHeader.textContent = groupLabel;
          listWrap.appendChild(groupHeader);
        }
        matching.forEach(function (opt) {
          const item = document.createElement('button');
          item.type = 'button';
          item.className = 'dropdown-item shop-picker-item' + (opt.value === selectEl.value ? ' active' : '');
          item.textContent = opt.textContent;
          item.addEventListener('click', function () {
            selectEl.value = opt.value;
            selectEl.dispatchEvent(new Event('change'));
            button.textContent = opt.textContent;
          });
          listWrap.appendChild(item);
        });
      });

      if (!anyVisible) {
        const empty = document.createElement('div');
        empty.className = 'text-muted small px-2 py-1';
        empty.textContent = 'Aucun magasin trouvé.';
        listWrap.appendChild(empty);
      }
    }

    wrapper.appendChild(button);
    wrapper.appendChild(menu);
    selectEl.insertAdjacentElement('afterend', wrapper);

    const searchInput = searchWrap.querySelector('.shop-picker-search');
    searchInput.addEventListener('input', function () { renderList(searchInput.value); });
    // Focus la recherche à l'ouverture, et repart d'une liste non filtrée à chaque ouverture.
    wrapper.addEventListener('shown.bs.dropdown', function () {
      searchInput.value = '';
      renderList('');
      searchInput.focus();
    });

    renderList('');

    // Si le code de la page change lui-même selectEl.value (ex: sélection initiale), garder le
    // bouton synchronisé.
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
