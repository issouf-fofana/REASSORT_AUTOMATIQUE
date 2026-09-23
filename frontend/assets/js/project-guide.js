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
  }

  document.addEventListener('DOMContentLoaded', init);
})();
