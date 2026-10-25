// Enregistre localement le jeu d'icônes "solar" utilisé dans toute l'application, AVANT tout
// rendu de <iconify-icon icon="solar:...">. Corrige le bug signalé le 25/10/2026 : "sur les pc
// sur le réseau qui n'ont pas accès à internet il y a des logiciels qui ne chargent pas chez eux
// comme les icônes" — iconify-icon.min.js (vendorisé localement depuis le 15/10/2026) est bien un
// fichier JS local, mais SANS collection pré-enregistrée, il appelle quand même l'API publique
// Iconify (api.iconify.design/api.simplesvg.com/api.unisvg.com) pour récupérer le SVG de CHAQUE
// icône au moment de son affichage — invisible avec une connexion internet normale, mais aucune
// icône ne s'affiche jamais sur un poste sans sortie internet (réseau Prosuma local uniquement).
//
// solar-icons-subset.json est un extrait de @iconify-json/solar (node_modules côté build, jamais
// expédié tel quel : le jeu complet fait 12 Mo pour ~8900 icônes) filtré aux ~150 icônes "solar:*"
// réellement utilisées dans le projet (grep -roh "solar:[a-z0-9-]*" sur tout le code), régénéré
// par ce même filtrage si de nouvelles icônes sont ajoutées plus tard. Une fois enregistrée via
// Iconify.addCollection, PLUS AUCUN appel réseau n'est fait pour ces icônes, quel que soit l'état
// de la connexion internet.
(function () {
  function register() {
    if (!window.Iconify || typeof window.Iconify.addCollection !== 'function') return false;
    fetch('/assets/vendor/iconify-icon/solar-icons-subset.json')
      .then(function (res) { return res.json(); })
      .then(function (data) { window.Iconify.addCollection(data); })
      .catch(function (err) {
        console.error('[solar-icons-register] Échec du chargement du jeu d\'icônes local :', err.message);
      });
    return true;
  }
  // iconify-icon.min.js est chargé juste avant ce script (même ordre dans index.html) et expose
  // window.Iconify de façon synchrone à son exécution — pas de retry nécessaire en pratique, mais
  // un filet de sécurité évite un silence total si l'ordre venait à changer un jour.
  if (!register()) {
    var attempts = 0;
    var interval = setInterval(function () {
      attempts += 1;
      if (register() || attempts > 20) clearInterval(interval);
    }, 50);
  }
})();
