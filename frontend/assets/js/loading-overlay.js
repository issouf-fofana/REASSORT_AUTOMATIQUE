/**
 * Écran de chargement plein écran (logo Réassort Automatique) : masque le flash de contenu brut
 * pendant que layout.js injecte sidebar/topbar de façon synchrone (XHR bloquant, cf. layout.js) et
 * que chaque page charge ses propres données initiales. Doit être le tout premier script du
 * <body> (avant layout.js et tout script de page) pour s'afficher sans délai perceptible.
 *
 * Se retire automatiquement :
 * - dès que layout.js a fini d'injecter les partiels (juste après son exécution synchrone) ;
 * - au plus tard après LOADING_OVERLAY_MAX_MS, filet de sécurité si une page ne déclenche jamais
 *   window.hideLoadingOverlay() explicitement (ex: erreur JS avant ce point) — jamais bloquer
 *   l'utilisateur indéfiniment derrière l'écran de chargement.
 */
(function () {
  const LOADING_OVERLAY_MAX_MS = 4000;

  const style = document.createElement('style');
  style.textContent = `
    /* left: 300px sur desktop (demande du 08/10/2026 : "la sidebar ne doit pas bouger" en
       changeant de page) : cet écran plein écran masquait AUSSI la sidebar pendant sa
       réinjection par layout.js (XHR synchrone), donc elle semblait disparaître puis
       réapparaître à chaque navigation — alors que chaque page a déjà le même fond marine
       (#1B2A4A, cf. .sidebar dans theme-override.css) à cet endroit précis, laissé visible
       en dessous. Seule la zone de contenu (à droite de la sidebar) est couverte : la sidebar
       elle-même reste visuellement immobile pendant le chargement, même si c'est toujours
       techniquement un rechargement complet de page (pas une vraie navigation SPA, cf.
       discussion du 08/10/2026 — solution légère retenue plutôt qu'un chantier de fusion des
       ~19 apps en une seule SPA). left:0 en dessous de 768px : la sidebar est masquée sur
       mobile (cf. theme-override.css), donc rien à préserver, l'écran reprend toute la largeur. */
    #reassort-loading-overlay {
      position: fixed; inset: 0; background-color: #1B2A4A; z-index: 9999;
      display: flex; align-items: center; justify-content: center;
      transition: opacity .25s ease;
    }
    @media (min-width: 768px) {
      #reassort-loading-overlay { left: 300px; }
    }
    #reassort-loading-overlay.hide { opacity: 0; pointer-events: none; }
    #reassort-loading-overlay img {
      width: 96px; height: 96px; animation: reassort-loading-pulse 1.4s ease-in-out infinite;
    }
    @keyframes reassort-loading-pulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(0.88); opacity: .65; }
    }
  `;
  document.head.appendChild(style);

  const overlay = document.createElement('div');
  overlay.id = 'reassort-loading-overlay';
  overlay.innerHTML = '<img src="assets/images/logo-reassort.png" alt="Chargement...">';
  document.body.insertBefore(overlay, document.body.firstChild);

  let hidden = false;
  window.hideLoadingOverlay = function () {
    if (hidden) return;
    hidden = true;
    overlay.classList.add('hide');
    setTimeout(function () { overlay.remove(); }, 300);
  };

  setTimeout(window.hideLoadingOverlay, LOADING_OVERLAY_MAX_MS);
})();
