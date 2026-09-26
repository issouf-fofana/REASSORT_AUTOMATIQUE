// Garde d'authentification pour les pages internes de la plateforme de réassort.
// À inclure sur toute page qui n'est pas auth-signin.html.
(function () {
  // En production (Dockploy), le backend est servi sur son propre domaine/sous-domaine, pas sur
  // le port :3001 du même hôte que le frontend (chaque service a son propre reverse proxy) : la
  // vraie URL est injectée à l'exécution du conteneur nginx dans window.REASSORT_BACKEND_URL (voir
  // frontend/assets/config.js, généré par docker-entrypoint.sh à partir de la variable BACKEND_URL).
  // Fallback sur l'ancien comportement (port :3001 du même hostname) pour le développement local
  // sans cette configuration.
  window.REASSORT_API_BASE = (window.REASSORT_BACKEND_URL || (window.location.protocol + '//' + window.location.hostname + ':3001')) + '/api';

  window.reassortGetToken = function () {
    return localStorage.getItem('reassort_token');
  };

  window.reassortGetUser = function () {
    try {
      return JSON.parse(localStorage.getItem('reassort_user') || 'null');
    } catch (e) {
      return null;
    }
  };

  window.reassortLogout = function () {
    localStorage.removeItem('reassort_token');
    localStorage.removeItem('reassort_user');
    window.location.href = '/login';
  };

  // Rôles bornés à un seul magasin fixe (User.rposShopId) — remplace l'ancien test unique
  // "role === 'STORE'" désormais éclaté en 3 niveaux (DIRECTOR/DEPARTMENT_HEAD/SHELF_STOCKER, plan
  // de rôles validé le 15/09/2026). Utilisé partout où le frontend distinguait auparavant un compte
  // STORE (masquer le sélecteur global, ne jamais appeler /reassort/shops réservé à SUPERVISOR/ADMIN,
  // etc.) — un test resté sur l'ancien nom "STORE" ne matche plus aucun compte réel après la
  // migration des rôles, d'où ce point unique à corriger partout plutôt que de renommer chaque
  // occurrence séparément (bug trouvé le 15/09/2026 lors de l'audit de robustesse : le sélecteur de
  // magasin tentait d'appeler une route 403 pour tout compte à magasin unique).
  window.REASSORT_SINGLE_SHOP_ROLES = ['STORE', 'DIRECTOR', 'DEPARTMENT_HEAD', 'SHELF_STOCKER'];
  window.reassortIsSingleShopRole = function (role) {
    return window.REASSORT_SINGLE_SHOP_ROLES.indexOf(role) !== -1;
  };

  // Wrapper fetch qui ajoute automatiquement le token, et déconnecte sur 401.
  window.reassortFetch = async function (path, options) {
    options = options || {};
    options.headers = Object.assign({}, options.headers, {
      Authorization: 'Bearer ' + window.reassortGetToken(),
    });
    const res = await fetch(window.REASSORT_API_BASE + path, options);
    if (res.status === 401) {
      window.reassortLogout();
      throw new Error('Session expirée, veuillez vous reconnecter.');
    }
    return res;
  };

  if (!window.reassortGetToken()) {
    window.location.href = '/login';
  }

  document.addEventListener('DOMContentLoaded', function () {
    const user = window.reassortGetUser();
    const nameEl = document.getElementById('user-menu-name');
    if (user && nameEl) {
      nameEl.textContent = user.name + (user.rposShopName ? ' — ' + user.rposShopName : ' — Admin');
    }
    const usersMenuItem = document.getElementById('menu-item-users');
    if (user && user.role === 'ADMIN' && usersMenuItem) {
      usersMenuItem.style.display = '';
    }
    const adminDashboardMenuItem = document.getElementById('menu-item-admin-dashboard');
    if (user && user.role === 'ADMIN' && adminDashboardMenuItem) {
      adminDashboardMenuItem.style.display = '';
    }
    // Sous-liens Paramètres réservés ADMIN (mêmes onglets que settings.html masque pour un compte
    // STORE/SUPERVISOR — cf. initShopPicker) : révélés ici pour rester coordonné, jamais en dur.
    // Idem pour les pages admin du debug global (Améliorations IA, Journal d'audit : API 403
    // pour les autres rôles) : masquées par défaut dans la sidebar, révélées ici.
    if (user && user.role === 'ADMIN') {
      // settings-menu-reassort ajouté le 15/09/2026 : "Paramètres · Réassort" était jusqu'ici
      // visible pour tout rôle (seul sous-lien Paramètres sans réserve), incohérent avec la
      // décision "personne ne doit voir les paramètres à part le superadmin" — désormais masqué
      // par défaut dans sidebar.html et révélé ici comme les autres sous-liens Paramètres.
      ['settings-menu-heading', 'settings-menu-reassort', 'settings-menu-files', 'settings-menu-rpos', 'settings-menu-cron', 'settings-menu-sync', 'settings-menu-ai', 'menu-item-ai-quality', 'menu-item-ai-mastery', 'menu-item-order-anomalies', 'menu-item-feature-requests', 'menu-item-mail-recipients'].forEach(function (id) {
        const el = document.getElementById(id);
        if (el) el.style.display = '';
      });
    }
  });
})();
