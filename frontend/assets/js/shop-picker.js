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

    // Le sélecteur global de la topbar (ADMIN/SUPERVISOR, cf. global-shop-selector.js) est l'UNIQUE
    // point de choix du magasin de travail sur la plupart des pages (demande du 15/09/2026 : "le
    // seul filtre qui doit exister sur ces pages") — ce bouton local est donc masqué par défaut
    // pour ne pas dupliquer ce choix.
    // Exception explicite : certaines actions ADMIN ponctuelles (Paramètres > Synchronisation,
    // "Récupération initiale"/"Purger les ventes") doivent pouvoir cibler un magasin DIFFÉRENT du
    // magasin de travail actif, sans devoir changer ce dernier — la page pose data-independent-shop
    // sur son <select> pour signaler ce besoin et garder son propre sélecteur visible.
    const user = window.reassortGetUser && window.reassortGetUser();
    const isIndependentSelector = selectEl.dataset.independentShop === '1';
    const hideForGlobalSelector = user && user.role !== 'STORE' && window.reassortGetActiveShop && !isIndependentSelector;
    if (hideForGlobalSelector) wrapper.style.display = 'none';

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
          // Un sélecteur "indépendant" (Récupération initiale/Purger) ne doit jamais changer le
          // magasin de travail global : choisir un magasin ici sert UNIQUEMENT cette action
          // ponctuelle, pas la navigation sur le reste de l'application.
          if (!isIndependentSelector) syncToGlobalShop(opt);
          const bsModal = bootstrap.Modal.getInstance(modal);
          if (bsModal) bsModal.hide();
        });
      });
    }

    // N'écrase JAMAIS une valeur déjà EXPLICITEMENT choisie par la page appelante (ex: magasin
    // restauré depuis l'URL ?shop=..., positionné via selectEl.value AVANT d'appeler
    // reassortMakeShopPickerSearchable) : ce cas se signale avec l'attribut data-preselected="1"
    // sur le <select>, posé par la page elle-même. Sans ce marqueur explicite, on ne peut pas se
    // fier à selectEl.value seul pour savoir si un choix réel a déjà été fait — un <select> HTML
    // natif fraîchement rempli d'<option> a TOUJOURS une valeur non vide par défaut (la première
    // option, un pur artefact du DOM, jamais un vrai choix utilisateur), ce qui empêchait presque
    // toujours la présélection automatique du magasin global (bug observé le 14/09/2026 : le
    // magasin actif de la topbar n'était jamais répercuté sur Paramètres > Synchronisation).
    function applyGlobalShopIfAny() {
      // Un sélecteur "indépendant" (Récupération initiale/Purger, cf. plus haut) ne suit jamais le
      // magasin global : il doit rester sur le dernier choix explicite de l'utilisateur sur CETTE
      // page précise, pas se faire écraser par le magasin de travail actif ailleurs.
      if (selectEl.dataset.preselected || isIndependentSelector || !window.reassortGetActiveShop) return;
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
    if (window.reassortOnActiveShopChange && !selectEl.dataset.activeShopListenerWired && !isIndependentSelector) {
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
        // Même garde qu'au clic dans la modale (ligne ~155) : un select "indépendant" ne doit
        // jamais répercuter son choix sur le magasin de travail global (bug trouvé le 15/09/2026 —
        // ce listener-ci n'avait pas le garde-fou, contrairement au clic dans la modale).
        if (!isIndependentSelector) syncToGlobalShop(selectEl.selectedOptions[0]);
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
