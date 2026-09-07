// Garde d'authentification pour les pages internes de la plateforme de réassort.
// À inclure sur toute page qui n'est pas auth-signin.html.
(function () {
  window.REASSORT_API_BASE = window.location.protocol + '//' + window.location.hostname + ':3001/api';

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
    window.location.href = 'auth-signin.html';
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
    window.location.href = 'auth-signin.html';
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
  });
})();
