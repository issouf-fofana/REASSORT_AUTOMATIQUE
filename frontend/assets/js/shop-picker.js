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

  // Les <option> ne portent pas toujours data-reference/data-name explicites : le texte affiché
  // est déjà au format "{reference} - {name}" (cf. ai-predictions.js et pages similaires), donc on
  // le déduit de là plutôt que de dépendre d'attributs jamais posés par certaines pages.
  function parseShopOption(opt) {
    const groupLabel = opt.parentElement && opt.parentElement.tagName === 'OPTGROUP' ? opt.parentElement.label : (opt.dataset.posId || '');
    const text = opt.textContent || '';
    const dashIndex = text.indexOf(' - ');
    const reference = opt.dataset.reference || (dashIndex !== -1 ? text.slice(0, dashIndex).trim() : '');
    const name = opt.dataset.name || (dashIndex !== -1 ? text.slice(dashIndex + 3).trim() : text.trim());
    return { posLabel: groupLabel, reference: reference, name: name };
  }

  function updateShopContext(opt) {
    if (!window.reassortSetShopContext) return;
    const parsed = parseShopOption(opt);
    window.reassortSetShopContext(parsed.posLabel, parsed.name, parsed.reference);
  }

  // Ce picker vient de sélectionner explicitement un magasin (clic utilisateur) : répercute ce
  // choix comme nouveau magasin global (cf. global-shop-selector.js), pour qu'un changement fait
  // sur N'IMPORTE QUELLE page se propage aux autres pages visitées ensuite — pas seulement au
  // sélecteur unique de la topbar.
  function syncToGlobalShop(opt) {
    if (!window.reassortSetActiveShop) return;
    const parsed = parseShopOption(opt);
    window.reassortSetActiveShop({ id: opt.value, reference: parsed.reference, name: parsed.name, posLabel: parsed.posLabel });
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
          updateShopContext(opt);
          syncToGlobalShop(opt);
          const bsModal = bootstrap.Modal.getInstance(modal);
          if (bsModal) bsModal.hide();
        });
      });
    }

    // N'écrase JAMAIS une valeur déjà présente (ex: magasin restauré depuis l'URL ?shop=...,
    // priorité assumée à ce qui est explicite dans l'URL courante) — ne s'applique que si le
    // select est encore vide, cas normal d'un premier chargement de page.
    function applyGlobalShopIfAny() {
      if (selectEl.value || !window.reassortGetActiveShop) return;
      const activeShop = window.reassortGetActiveShop();
      if (!activeShop) return;
      applyShop(activeShop);
    }

    function applyShop(shop) {
      if (!shop || selectEl.value === shop.id) return; // déjà à jour, évite un dispatch inutile
      const matchingOption = options.find(function (o) { return o.value === shop.id; });
      if (!matchingOption) return;
      selectEl.value = matchingOption.value;
      selectEl.dispatchEvent(new Event('change'));
      button.textContent = matchingOption.textContent;
      updateShopContext(matchingOption);
    }

    // Un autre picker (ou le bouton global de la topbar) vient de changer le magasin actif : ce
    // picker-ci se resynchronise en direct, sans attendre un rechargement de page (bug observé :
    // deux pickers sur la même page affichaient chacun un magasin différent après un changement
    // fait via l'un d'eux, cf. demande du 14/09/2026 "je dois voir le magasin sur chaque vue").
    // syncToGlobalShop plus bas déclenche aussi ce callback pour le picker qui a émis le
    // changement ; applyShop() est un no-op dans ce cas précis (valeur déjà à jour), donc pas de
    // boucle ni de double dispatch.
    // Un seul abonnement par <select> (pas un de plus à chaque reconstruction du picker, ex:
    // global-shop-selector.js qui rappelle reassortMakeShopPickerSearchable à chaque ouverture) :
    // sans ce garde-fou, les abonnements s'empilaient et resynchronisaient le même select plusieurs
    // fois par changement.
    if (window.reassortOnActiveShopChange && !selectEl.dataset.activeShopListenerWired) {
      selectEl.dataset.activeShopListenerWired = '1';
      window.reassortOnActiveShopChange(applyShop);
    }

    searchInput.addEventListener('input', function () { renderRows(searchInput.value); });
    modal.addEventListener('shown.bs.modal', function () {
      searchInput.value = '';
      renderRows('');
      searchInput.focus();
    });

    selectEl.addEventListener('change', function () {
      if (selectEl.selectedOptions.length) {
        button.textContent = selectEl.selectedOptions[0].textContent;
        updateShopContext(selectEl.selectedOptions[0]);
        syncToGlobalShop(selectEl.selectedOptions[0]);
      }
    });

    // Magasin global déjà choisi (topbar, cf. global-shop-selector.js) : présélectionne ce picker
    // avec ce magasin dès sa construction, pour qu'une page nouvellement chargée démarre déjà sur
    // le bon magasin sans que l'utilisateur ait à le rechoisir à chaque page (demande du
    // 14/09/2026). Ne fait rien si le magasin global n'existe pas parmi les options de CETTE page
    // (ex: un select dédié à un sous-ensemble de magasins).
    applyGlobalShopIfAny();

    // Sélection déjà présente au moment où le picker est construit (ex: magasin restauré depuis
    // l'URL ou le localStorage) : affiche le contexte dès le départ, pas seulement au prochain
    // changement.
    if (selectEl.selectedOptions.length && selectEl.value) updateShopContext(selectEl.selectedOptions[0]);
  }

  window.reassortMakeShopPickerSearchable = function (selectEl) {
    if (!selectEl) return;
    selectEl.style.display = 'none';
    buildPicker(selectEl);
  };
})();
