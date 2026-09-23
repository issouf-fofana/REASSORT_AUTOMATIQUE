import { useEffect, useRef, useState } from 'react';
import type { GuideFeature, GuideGroup, GuideSection, GuideStatus } from './types';

const STATUS_META: Record<GuideStatus, { label: string; cls: string }> = {
  done: { label: 'Terminé', cls: 'pg-status-done' },
  partial: { label: 'En cours', cls: 'pg-status-partial' },
  planned: { label: 'À venir', cls: 'pg-status-planned' },
};

// Le contenu (why/what/technical) est écrit directement en HTML léger dans project-guide-content.js
// (gras, listes) — pas échappé, comme dans la page HTML d'origine : c'est du contenu de rédaction
// interne, jamais une donnée utilisateur.
function FeatureCard({ feature }: { feature: GuideFeature }) {
  return (
    <div className="pg-card">
      <div className="pg-card-label">Pourquoi ça existe</div>
      <p dangerouslySetInnerHTML={{ __html: feature.why }} />
      <div className="pg-card-label mt-3">Ce que ça fait concrètement</div>
      <p dangerouslySetInnerHTML={{ __html: feature.what }} />
      {feature.technical && <div className="pg-tech-note" dangerouslySetInnerHTML={{ __html: feature.technical }} />}
      {!!feature.pages?.length && (
        <div className="pg-page-links mt-3">
          {feature.pages.map((p, i) => (
            <a href={p.href} key={i}>
              <iconify-icon icon="solar:arrow-right-up-linear"></iconify-icon> {p.label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function Section({ section }: { section: GuideSection }) {
  const ref = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const status = section.status ? STATUS_META[section.status] : null;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!('IntersectionObserver' in window)) {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setVisible(true);
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.08, rootMargin: '0px 0px -40px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <section className={`pg-section${visible ? ' pg-visible' : ''}`} id={section.id} ref={ref}>
      <div className="pg-section-header">
        <iconify-icon icon={section.icon || 'solar:info-circle-bold-duotone'}></iconify-icon>
        <h3 className="pg-section-title">{section.title}</h3>
        {status && <span className={`pg-status-badge ${status.cls}`}>{status.label}</span>}
      </div>
      {section.intro && <p className="text-muted mb-3" dangerouslySetInnerHTML={{ __html: section.intro }} />}
      {section.features?.map((f, i) => (
        <FeatureCard feature={f} key={i} />
      ))}
    </section>
  );
}

export function ProjectGuide() {
  const [groups, setGroups] = useState<GuideGroup[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const tocRef = useRef<HTMLElement>(null);
  const tocColRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setGroups(window.PROJECT_GUIDE_CONTENT || null);
  }, []);

  const allSections = groups ? groups.flatMap((g) => g.sections) : [];

  // Scroll-spy : reproduit exactement onScroll de project-guide.js (dernière section dont le haut
  // est déjà passé sous le seuil de 120px devient l'entrée active du sommaire).
  useEffect(() => {
    if (!allSections.length) return;
    function onScroll() {
      let currentId = allSections[0].id;
      for (const s of allSections) {
        const el = document.getElementById(s.id);
        if (el && el.getBoundingClientRect().top <= 120) currentId = s.id;
      }
      setActiveId(currentId);
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups]);

  // Barre de progression de lecture (filet fin en haut de page, injecté dans le HTML statique de
  // index.html — #pg-progress-bar existe déjà en dehors de l'arbre React, comme #layout-sidebar-slot).
  useEffect(() => {
    const bar = document.getElementById('pg-progress-bar');
    if (!bar) return;
    function onScroll() {
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      const pct = scrollable > 0 ? (window.scrollY / scrollable) * 100 : 0;
      bar!.style.width = Math.min(100, Math.max(0, pct)) + '%';
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    onScroll();
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [groups]);

  // `position: sticky` ne fonctionne pas ici (Volt pose overflow:hidden sur <main class="content">) :
  // `position: fixed` avec sa position horizontale recalculée en JS à partir de la colonne
  // Bootstrap réelle, même contournement que project-guide.js.
  useEffect(() => {
    function positionToc() {
      const toc = tocRef.current;
      const col = tocColRef.current;
      if (!toc || !col || window.innerWidth < 992) return;
      const rect = col.getBoundingClientRect();
      toc.style.left = rect.left + 'px';
      toc.style.width = rect.width + 'px';
    }
    positionToc();
    window.addEventListener('resize', positionToc);
    const t = setTimeout(positionToc, 300);
    return () => {
      window.removeEventListener('resize', positionToc);
      clearTimeout(t);
    };
  }, [groups]);

  return (
    <div>
      <style>{`
        .pg-toc { position: fixed; top: 1.25rem; width: 260px; max-height: calc(100vh - 2.5rem); overflow-y: auto; }
        .pg-toc-group-title { font-size: .7rem; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: #6c757d; margin: 1.1rem 0 .4rem; }
        .pg-toc-group-title:first-child { margin-top: 0; }
        .pg-toc a { display: block; padding: .35rem .7rem; font-size: .85rem; color: #374151; text-decoration: none; border-left: 2px solid transparent; border-radius: 0 4px 4px 0; transition: background-color .15s ease, color .15s ease, border-color .15s ease, padding-left .15s ease; }
        .pg-toc a:hover { background-color: #f5f5f5; color: #111111; padding-left: .9rem; }
        .pg-toc a.active { border-left-color: #111111; color: #111111; font-weight: 600; background-color: #f5f5f5; }
        .pg-section { scroll-margin-top: 1rem; padding-top: .5rem; margin-bottom: 2.5rem; opacity: 0; transform: translateY(14px); transition: opacity .5s ease, transform .5s ease; }
        .pg-section.pg-visible { opacity: 1; transform: translateY(0); }
        @media (prefers-reduced-motion: reduce) { .pg-section { opacity: 1; transform: none; transition: none; } }
        .pg-section-header { display: flex; align-items: center; gap: .6rem; margin-bottom: .5rem; }
        .pg-section-header iconify-icon { font-size: 1.4rem; color: #111111; }
        .pg-section-title { font-size: 1.35rem; font-weight: 700; margin: 0; }
        .pg-status-badge { font-size: .68rem; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; padding: .2rem .55rem; border: 1px solid transparent; }
        .pg-status-done { background-color: #ECFDF5; color: #047857; border-color: #A7F3D0; }
        .pg-status-partial { background-color: #FFFBEB; color: #B45309; border-color: #FDE68A; }
        .pg-status-planned { background-color: #F3F4F6; color: #6B7280; border-color: #E5E7EB; }
        .pg-card { background-color: #ffffff; border: 1px solid #e5e5e5; box-shadow: 0 1px 3px rgba(0,0,0,.06), 0 1px 2px rgba(0,0,0,.08); padding: 1.25rem 1.5rem; margin-bottom: 1rem; transition: box-shadow .2s ease, border-color .2s ease; }
        .pg-card:hover { border-color: #d1d5db; box-shadow: 0 2px 8px rgba(0,0,0,.08), 0 1px 3px rgba(0,0,0,.08); }
        .pg-card-label { font-size: .75rem; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; color: #6c757d; margin-bottom: .5rem; }
        .pg-card p:last-child { margin-bottom: 0; }
        .pg-tech-note { font-size: .8rem; color: #6c757d; background-color: #fafafa; border-left: 3px solid #d1d5db; padding: .6rem .9rem; margin-top: .75rem; }
        .pg-page-links a { display: inline-flex; align-items: center; gap: .3rem; font-size: .85rem; border: 1px solid #d1d5db; padding: .3rem .75rem; margin: .15rem .35rem .15rem 0; text-decoration: none; color: #111111; transition: background-color .15s ease, border-color .15s ease, transform .15s ease; }
        .pg-page-links a:hover { background-color: #111111; color: #ffffff; border-color: #111111; transform: translateY(-1px); }
        @media (max-width: 991px) {
          .pg-toc { position: static; width: auto; max-height: none; margin-bottom: 2rem; }
        }
      `}</style>

      <div className="mb-4">
        <h2 className="mb-1">Guide du projet</h2>
        <p className="text-muted mb-0">
          Ce que fait chaque fonctionnalité, pourquoi elle existe, et où la trouver — pensé pour quelqu'un qui
          découvre le projet ou veut mieux comprendre une fonctionnalité précise.
        </p>
      </div>

      {!groups && <p className="text-danger">Contenu du guide introuvable.</p>}

      {groups && (
        <div className="row">
          <div className="col-lg-3 d-none d-lg-block" ref={tocColRef}>
            <nav className="pg-toc" ref={tocRef}>
              {groups.map((group, gi) => (
                <div key={gi}>
                  <div className="pg-toc-group-title">{group.label}</div>
                  {group.sections.map((s) => (
                    <a
                      href={`#${s.id}`}
                      key={s.id}
                      className={activeId === s.id ? 'active' : ''}
                      onClick={(e) => {
                        e.preventDefault();
                        document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth' });
                      }}
                    >
                      {s.title}
                    </a>
                  ))}
                </div>
              ))}
            </nav>
          </div>
          <div className="col-lg-9">
            {allSections.map((s) => (
              <Section section={s} key={s.id} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
