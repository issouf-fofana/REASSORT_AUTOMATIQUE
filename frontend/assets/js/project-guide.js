// Moteur de la page "Guide du projet" (23/09/2026) : construit le sommaire et les sections à
// partir de window.PROJECT_GUIDE_CONTENT (project-guide-content.js), et gère le suivi visuel de la
// section active au scroll. Séparé du contenu pour que la rédaction (project-guide-content.js)
// reste éditable sans toucher à la logique d'affichage.
(function () {
  const STATUS_META = {
    done: { label: 'Terminé', cls: 'pg-status-done' },
    partial: { label: 'En cours', cls: 'pg-status-partial' },
    planned: { label: 'À venir', cls: 'pg-status-planned' },
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Le contenu (why/what/technical) est écrit directement en HTML léger dans project-guide-content.js
  // (gras, listes) — pas échappé, car c'est du contenu de rédaction interne, jamais une donnée
  // utilisateur.
  function renderFeature(feature) {
    const status = STATUS_META[feature.status] || STATUS_META.planned;
    const pageLinksHtml = (feature.pages || []).length
      ? '<div class="pg-page-links mt-3">' + feature.pages.map(function (p) {
          return '<a href="' + esc(p.href) + '"><iconify-icon icon="solar:arrow-right-up-linear"></iconify-icon> ' + esc(p.label) + '</a>';
        }).join('') + '</div>'
      : '';
    const technicalHtml = feature.technical
      ? '<div class="pg-tech-note">' + feature.technical + '</div>'
      : '';
    return (
      '<div class="pg-card">' +
        '<div class="pg-card-label">Pourquoi ça existe</div>' +
        '<p>' + feature.why + '</p>' +
        '<div class="pg-card-label mt-3">Ce que ça fait concrètement</div>' +
        '<p>' + feature.what + '</p>' +
        technicalHtml +
        pageLinksHtml +
      '</div>'
    );
  }

  function renderSection(section) {
    const status = STATUS_META[section.status] || null;
    const statusBadge = status ? '<span class="pg-status-badge ' + status.cls + '">' + status.label + '</span>' : '';
    const featuresHtml = (section.features || []).map(renderFeature).join('');
    return (
      '<section class="pg-section" id="' + esc(section.id) + '">' +
        '<div class="pg-section-header">' +
          '<iconify-icon icon="' + esc(section.icon || 'solar:info-circle-bold-duotone') + '"></iconify-icon>' +
          '<h3 class="pg-section-title">' + esc(section.title) + '</h3>' +
          statusBadge +
        '</div>' +
        (section.intro ? '<p class="text-muted mb-3">' + section.intro + '</p>' : '') +
        featuresHtml +
      '</section>'
    );
  }

  function renderToc(groups) {
    return groups.map(function (group) {
      const linksHtml = group.sections.map(function (s) {
        return '<a href="#' + esc(s.id) + '" data-toc-link="' + esc(s.id) + '">' + esc(s.title) + '</a>';
      }).join('');
      return '<div class="pg-toc-group-title">' + esc(group.label) + '</div>' + linksHtml;
    }).join('');
  }

  function setupScrollSpy(sectionIds) {
    const links = document.querySelectorAll('[data-toc-link]');
    function onScroll() {
      let currentId = sectionIds[0];
      for (const id of sectionIds) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= 120) currentId = id;
      }
      links.forEach(function (l) {
        l.classList.toggle('active', l.dataset.tocLink === currentId);
      });
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  // `position: sticky` ne fonctionne pas ici (Volt pose overflow:hidden sur <main class="content">,
  // ce qui casse le contexte de défilement nécessaire à sticky — le sommaire disparaissait
  // entièrement au scroll, signalé le 23/09/2026). `position: fixed` s'accroche directement au
  // viewport, mais perd alors l'alignement horizontal automatique de sa colonne Bootstrap : on le
  // recalcule ici à partir de la position réelle de la colonne, et on le tient à jour au
  // redimensionnement (une bascule de largeur de sidebar déplace la colonne).
  function positionToc() {
    const toc = document.getElementById('pg-toc');
    const col = document.getElementById('pg-toc-col');
    if (!toc || !col || window.innerWidth < 992) return;
    const rect = col.getBoundingClientRect();
    toc.style.left = rect.left + 'px';
    toc.style.width = rect.width + 'px';
  }

  // Apparition progressive des sections au défilement (demande explicite du 23/09/2026 : rendre la
  // page "plus visible et réactive") : chaque section glisse légèrement vers le haut en apparaissant
  // la première fois qu'elle entre dans le viewport, jamais rejouée ensuite (unobserve après le
  // premier passage) pour ne pas distraire lors d'un simple aller-retour de scroll.
  function setupRevealAnimation() {
    if (!('IntersectionObserver' in window)) {
      document.querySelectorAll('.pg-section').forEach(function (el) { el.classList.add('pg-visible'); });
      return;
    }
    const observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('pg-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });
    document.querySelectorAll('.pg-section').forEach(function (el) { observer.observe(el); });
  }

  // Barre de progression de lecture (filet fin en haut de page) : retour visuel réactif au scroll,
  // proportionnel à la position dans le contenu total de la page.
  function setupProgressBar() {
    const bar = document.getElementById('pg-progress-bar');
    if (!bar) return;
    function onScroll() {
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      const pct = scrollable > 0 ? (window.scrollY / scrollable) * 100 : 0;
      bar.style.width = Math.min(100, Math.max(0, pct)) + '%';
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    onScroll();
  }

  function init() {
    const groups = window.PROJECT_GUIDE_CONTENT;
    if (!groups) {
      document.getElementById('pg-content').innerHTML = '<p class="text-danger">Contenu du guide introuvable.</p>';
      return;
    }

    document.getElementById('pg-toc').innerHTML = renderToc(groups);

    const allSections = [];
    groups.forEach(function (g) { g.sections.forEach(function (s) { allSections.push(s); }); });
    document.getElementById('pg-content').innerHTML = allSections.map(renderSection).join('');

    setupScrollSpy(allSections.map(function (s) { return s.id; }));
    setupRevealAnimation();
    setupProgressBar();

    positionToc();
    window.addEventListener('resize', positionToc);
    // La sidebar Volt peut se réduire/déplier après le chargement initial (bouton toggle) sans
    // déclencher de resize navigateur — un court re-calcul différé couvre ce cas sans devoir
    // observer chaque interaction possible de la sidebar.
    setTimeout(positionToc, 300);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
