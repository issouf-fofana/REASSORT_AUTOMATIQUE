/**
 * Sélecteur de magasin global (demande du 14/09/2026) : un compte ADMIN/SUPERVISOR choisit son
 * magasin UNE FOIS dans la topbar, et ce choix s'applique automatiquement à toutes les pages —
 * plus besoin de le resélectionner à chaque page visitée. Persisté en localStorage (par utilisateur,
 * pas de fuite entre deux comptes qui partageraient le même navigateur).
 *
 * Pour un compte STORE (un seul magasin assigné, rien à choisir), ce script n'affiche qu'un texte
 * en lecture seule — le vrai magasin actif reste toujours req.user.rposShopId côté backend, jamais
 * ce choix côté client (cf. resolveShopId, middleware/auth.js).
 *
 * API exposée aux pages : window.reassortGetActiveShop() -> { id, reference, name, posId } | null,
 * window.reassortOnActiveShopChange(callback) pour réagir à un changement (ex: recharger les
 * données de la page courante sans navigation complète).
 */
(function () {
  function storageKey() {
    const user = window.reassortGetUser && window.reassortGetUser();
    // Clé par utilisateur : deux comptes ADMIN sur le même navigateur ne se marchent jamais dessus.
    return user ? 'reassort_active_shop_' + user.id : null;
  }

  function getActiveShop() {
    const key = storageKey();
    if (!key) return null;
    try {
      return JSON.parse(localStorage.getItem(key) || 'null');
    } catch (err) {
      return null;
    }
  }

  const changeListeners = [];

  function setActiveShop(shop) {
    const key = storageKey();
    if (!key) return;
    try {
      if (shop) localStorage.setItem(key, JSON.stringify(shop));
      else localStorage.removeItem(key);
    } catch (err) { /* stockage indisponible : le choix ne persiste pas, mais ne casse rien */ }
    renderButton();
    changeListeners.forEach(function (cb) { try { cb(shop); } catch (e) { /* callback défaillant ignoré */ } });
  }

  window.reassortGetActiveShop = getActiveShop;
  window.reassortSetActiveShop = setActiveShop;
  window.reassortOnActiveShopChange = function (cb) { changeListeners.push(cb); };

  function renderButton() {
    const btn = document.getElementById('global-shop-selector-btn');
    const readOnlyEl = document.getElementById('page-shop-context');
    if (!btn) return;
    const user = window.reassortGetUser && window.reassortGetUser();
    if (!user) return;

    if (user.role === 'STORE') {
      // Un seul magasin possible : pas de sélecteur, juste l'affichage déjà géré par
      // shop-picker.js/purchase-order.html via #page-shop-context (lecture seule).
      btn.style.display = 'none';
      return;
    }

    if (readOnlyEl) readOnlyEl.style.display = 'none';
    const shop = getActiveShop();
    btn.textContent = shop ? shop.posLabel + ' : ' + shop.name + ' (' + shop.reference + ') ▾' : 'Choisir un magasin ▾';
    btn.style.display = '';
  }

  // Construit un <select> masqué compatible avec window.reassortMakeShopPickerSearchable
  // (shop-picker.js) : réutilise la même modale de sélection déjà en place, sans dupliquer sa
  // logique de recherche/rendu. La liste de magasins vient de /reassort/shops, comme les pages.
  let hiddenSelect = null;

  async function loadShopOptions() {
    if (!window.reassortFetch) return [];
    try {
      const res = await window.reassortFetch('/reassort/shops');
      const json = await res.json();
      return json.success ? json.data : [];
    } catch (err) {
      return [];
    }
  }

  async function openSelector() {
    if (!hiddenSelect) {
      hiddenSelect = document.createElement('select');
      hiddenSelect.id = 'global-shop-selector-hidden-select';
      hiddenSelect.style.display = 'none';
      document.body.appendChild(hiddenSelect);
    }

    const shops = await loadShopOptions();
    const byPos = {};
    shops.forEach(function (s) {
      if (!byPos[s.posId]) byPos[s.posId] = [];
      byPos[s.posId].push(s);
    });
    hiddenSelect.innerHTML = Object.keys(byPos).sort().map(function (posId) {
      const list = byPos[posId].slice().sort(function (a, b) { return (a.reference || '').localeCompare(b.reference || ''); });
      const options = list.map(function (s) {
        return '<option value="' + s.id + '" data-reference="' + s.reference + '" data-name="' + s.name + '">' + s.reference + ' - ' + s.name + '</option>';
      }).join('');
      return '<optgroup label="' + (list[0].posLabel || posId) + '">' + options + '</optgroup>';
    }).join('');

    const current = getActiveShop();
    if (current && hiddenSelect.querySelector('option[value="' + current.id + '"]')) hiddenSelect.value = current.id;

    if (!hiddenSelect.dataset.wired) {
      hiddenSelect.dataset.wired = '1';
      hiddenSelect.addEventListener('change', function () {
        const opt = hiddenSelect.selectedOptions[0];
        if (!opt) return;
        const posLabel = opt.parentElement && opt.parentElement.tagName === 'OPTGROUP' ? opt.parentElement.label : '';
        setActiveShop({ id: opt.value, reference: opt.dataset.reference, name: opt.dataset.name, posLabel: posLabel });
      });
      window.reassortMakeShopPickerSearchable(hiddenSelect);
    } else {
      // Reconstruit le picker (options à jour) sans re-brancher le listener une 2e fois.
      window.reassortMakeShopPickerSearchable(hiddenSelect);
    }

    // Ouvre directement la modale du picker (déjà injectée par reassortMakeShopPickerSearchable).
    const modalId = hiddenSelect.dataset.shopPickerModalId;
    const modalEl = modalId ? document.getElementById(modalId) : null;
    if (modalEl && window.bootstrap) new bootstrap.Modal(modalEl).show();
  }

  document.addEventListener('click', function (e) {
    const btn = e.target && e.target.closest ? e.target.closest('#global-shop-selector-btn') : null;
    if (btn) openSelector();
  });

  renderButton();
})();
