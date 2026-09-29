// Rend fonctionnelle la cloche de notification de la topbar (jusqu'ici purement décorative,
// "Aucune notification" en dur dans topbar.html) — demande du 22/09/2026 : "quand il y a un
// souci non résolu il doit me faire des relances pour que je réglé au plus vite". Affiche les
// constats d'Améliorations IA ouverts depuis plus longtemps que leur seuil de relance (cf.
// improvementService.getStaleImprovements, backend). Réservé ADMIN (même portée que la page
// Améliorations IA elle-même, requireAdmin côté backend) : un compte STORE n'a de toute façon rien
// à faire de ces constats globaux multi-magasins.
(function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  const PRIORITY_LABEL = { CRITICAL: 'Critique', HIGH: 'Élevée', MEDIUM: 'Moyenne', LOW: 'Faible' };

  function renderDropdown(items) {
    const menu = document.getElementById('page-header-notifications-dropdown');
    if (!menu) return;
    const dropdown = menu.parentElement.querySelector('.dropdown-menu');
    if (!dropdown) return;

    const badge = document.getElementById('notif-bell-badge') || (function () {
      const b = document.createElement('span');
      b.id = 'notif-bell-badge';
      b.className = 'badge bg-danger rounded-pill position-absolute';
      b.style.cssText = 'top: 2px; right: 2px; font-size: .6rem; padding: .25em .4em;';
      menu.style.position = 'relative';
      menu.appendChild(b);
      return b;
    })();
    badge.style.display = items.length ? '' : 'none';
    badge.textContent = items.length > 9 ? '9+' : String(items.length);

    if (!items.length) {
      dropdown.innerHTML = '<a href="#" class="text-center text-primary fw-bold border-bottom border-light py-3 d-block">Notifications</a>' +
        '<div class="text-center text-muted small p-3">Aucune relance en attente</div>';
      return;
    }

    dropdown.innerHTML = '<a href="/ai-improvements" class="text-center text-primary fw-bold border-bottom border-light py-3 d-block">' +
      items.length + ' constat(s) à relancer</a>' +
      '<div style="max-height: 320px; overflow-y: auto;">' +
      items.slice(0, 8).map(function (it) {
        return '<a href="/ai-improvements" class="dropdown-item border-bottom border-light py-2 small">' +
          '<div class="d-flex justify-content-between gap-2">' +
          '<span class="fw-semibold">' + esc(it.title) + '</span>' +
          '<span class="badge bg-warning-subtle text-warning flex-shrink-0">' + (PRIORITY_LABEL[it.priority] || it.priority) + '</span>' +
          '</div>' +
          '<div class="text-muted">Ouvert depuis ' + it.ageDays + ' jour(s), sans action</div>' +
          '</a>';
      }).join('') +
      '</div>' +
      (items.length > 8 ? '<a href="/ai-improvements" class="text-center small py-2 d-block border-top">Voir tout (' + items.length + ')</a>' : '');
  }

  async function loadStaleImprovements() {
    try {
      const res = await window.reassortFetch('/reassort/improvements/stale');
      const json = await res.json();
      if (!json.success) return;
      renderDropdown(json.data || []);
    } catch (err) {
      // Silencieux : une cloche de notification qui échoue à charger ne doit jamais bloquer
      // ou polluer visuellement une page dont ce n'est pas le sujet principal.
    }
  }

  // Alerte active pour les nouveaux constats CRITIQUES (demande du 29/09/2026 : "si erreur vient,
  // que ça soit une alerte qui s'affiche avec un son, pas juste enregistré silencieusement") —
  // distinct de loadStaleImprovements ci-dessus (qui ne relance QUE les constats déjà anciens,
  // jamais au moment de leur création). Un son + toast dès qu'un NOUVEAU constat CRITICAL/PROPOSED
  // apparaît, jamais répété pour un constat déjà vu par ce navigateur (localStorage, par ID).
  const SEEN_KEY = 'reassort_seen_critical_improvement_ids';
  const POLL_INTERVAL_MS = 120000; // 2 minutes : assez réactif sans spammer le backend

  function getSeenIds() {
    try {
      return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]'));
    } catch {
      return new Set();
    }
  }

  function saveSeenIds(ids) {
    try {
      // Borné à 500 IDs les plus récents : évite une croissance illimitée de localStorage sur un
      // compte resté ouvert des mois, jamais un vrai risque de perdre une alerte encore active
      // (un constat déjà résolu/ignoré ne redeviendra jamais "nouveau").
      localStorage.setItem(SEEN_KEY, JSON.stringify(Array.from(ids).slice(-500)));
    } catch {
      // Quota localStorage dépassé ou navigation privée : tant pis, un même constat pourra
      // re-sonner à la prochaine visite plutôt que de faire planter toute la page pour ça.
    }
  }

  function playAlertSound() {
    // Bip généré via Web Audio API (pas de fichier audio à héberger/charger) — deux notes brèves,
    // suffisant pour attirer l'attention sans être une sonnerie agressive.
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      [880, 660].forEach(function (freq, i) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.15, ctx.currentTime + i * 0.18);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.18 + 0.15);
        osc.connect(gain).connect(ctx.destination);
        osc.start(ctx.currentTime + i * 0.18);
        osc.stop(ctx.currentTime + i * 0.18 + 0.16);
      });
    } catch {
      // Web Audio bloqué (politique navigateur avant toute interaction utilisateur, ou
      // navigateur trop ancien) : le toast visuel reste affiché même sans le son.
    }
  }

  async function checkNewCriticalImprovements() {
    try {
      const res = await window.reassortFetch('/reassort/improvements?status=PROPOSED&priority=CRITICAL');
      const json = await res.json();
      if (!json.success) return;
      const items = json.data || [];
      const seen = getSeenIds();
      const newOnes = items.filter(function (it) { return !seen.has(it.id); });

      if (newOnes.length && window.reassortToast) {
        playAlertSound();
        // Un seul toast récapitulatif même si plusieurs constats arrivent d'un coup (ex: le chien
        // de garde tourne une fois par nuit et peut détecter plusieurs magasins en même temps) —
        // jamais un toast par constat, qui empilerait des popups à la suite au réveil de l'admin.
        const message = newOnes.length === 1
          ? 'Nouveau constat critique : ' + newOnes[0].title
          : newOnes.length + ' nouveaux constats critiques détectés (Qualité & IA).';
        window.reassortToast(message, 'error');
      }

      items.forEach(function (it) { seen.add(it.id); });
      saveSeenIds(seen);
    } catch (err) {
      // Silencieux : une alerte qui échoue à se vérifier ne doit jamais bloquer la page — au pire,
      // elle sera retentée au prochain intervalle de sondage.
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    const user = window.reassortGetUser && window.reassortGetUser();
    if (!user || user.role !== 'ADMIN') return;
    // layout.js injecte la topbar de façon synchrone avant DOMContentLoaded (cf. son propre
    // commentaire), donc #page-header-notifications-dropdown existe déjà à ce stade.
    loadStaleImprovements();
    checkNewCriticalImprovements();
    setInterval(checkNewCriticalImprovements, POLL_INTERVAL_MS);
  });
})();
