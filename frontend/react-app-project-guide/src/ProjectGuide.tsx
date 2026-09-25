import { useEffect, useRef, useState } from 'react';
import type { GuideFeature, GuideGroup, GuideSection, GuideStatus } from './types';
import { NotchTabBar } from './components/ui/NotchTabBar';
import './index.css';

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

function groupTabId(index: number): string {
  return `tab-group-${index}`;
}

function tabFromHash(groups: GuideGroup[]): string {
  const hash = window.location.hash.replace('#', '');
  // Un lien direct vers une section précise (ex: partagé depuis une autre page, cf. GuidePage.href)
  // doit ouvrir le GROUPE qui la contient, pas rester sur le premier onglet — on cherche donc aussi
  // par id de section, pas seulement par id d'onglet.
  const byTabId = groups.findIndex((_, i) => groupTabId(i) === hash);
  if (byTabId >= 0) return groupTabId(byTabId);
  const bySectionId = groups.findIndex((g) => g.sections.some((s) => s.id === hash));
  if (bySectionId >= 0) return groupTabId(bySectionId);
  return groupTabId(0);
}

export function ProjectGuide() {
  const [groups, setGroups] = useState<GuideGroup[] | null>(null);
  const [activeTab, setActiveTab] = useState<string>('tab-group-0');
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const content = window.PROJECT_GUIDE_CONTENT || null;
    setGroups(content);
    if (content) setActiveTab(tabFromHash(content));
  }, []);

  useEffect(() => {
    if (!groups) return;
    const currentGroups = groups;
    function onHashChange() {
      setActiveTab(tabFromHash(currentGroups));
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [groups]);

  function selectTab(id: string) {
    window.location.hash = '#' + id;
    setActiveTab(id);
  }

  const activeGroupIndex = groups?.findIndex((_, i) => groupTabId(i) === activeTab) ?? -1;
  const activeGroup = activeGroupIndex >= 0 ? groups![activeGroupIndex] : null;
  const allSections = activeGroup ? activeGroup.sections : [];

  // Scroll-spy : reproduit exactement onScroll de project-guide.js (dernière section dont le haut
  // est déjà passé sous le seuil de 120px devient l'entrée active du sommaire) — recalculé sur les
  // sections du GROUPE ACTIF seulement, les autres groupes n'étant plus montés dans le DOM.
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
  }, [activeGroup]);

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
  }, [activeGroup]);

  return (
    <div>
      <style>{`
        /* Le sommaire (.pg-toc) et la barre d'onglets (.pg-tabs) utilisent position:sticky — rendu
           possible par le passage global de html/body/.content à overflow:visible/clip plutôt que
           hidden (cf. theme-override.css, demande du 24/09/2026 "la topbar doit rester figée aussi"
           généralisée à tout le site), donc plus besoin d'un contournement propre à cette page. */
        .pg-toc { position: sticky; top: calc(64px + 1.25rem); width: 100%; max-height: calc(100vh - 64px - 2.5rem); overflow-y: auto; border-left: 1px solid #e5e5e5; padding-left: 1rem; }
        .pg-toc-group-title { font-size: .68rem; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: #9a9a9a; margin: 1.1rem 0 .5rem; }
        .pg-toc-group-title:first-child { margin-top: 0; }
        .pg-toc a { display: block; padding: .4rem .7rem; font-size: .85rem; color: #444444; text-decoration: none; border-left: 2px solid transparent; margin-left: -1px; border-radius: 0 6px 6px 0; transition: background-color .15s ease, color .15s ease, border-color .15s ease, padding-left .15s ease; }
        .pg-toc a:hover { background-color: #f5f5f5; color: #000000; padding-left: .9rem; }
        .pg-toc a.active { border-left-color: #000000; color: #000000; font-weight: 600; background-color: #f5f5f5; }
        .pg-section { scroll-margin-top: 1rem; padding-top: .5rem; margin-bottom: 2.5rem; opacity: 0; transform: translateY(14px); transition: opacity .5s ease, transform .5s ease; }
        .pg-section.pg-visible { opacity: 1; transform: translateY(0); }
        @media (prefers-reduced-motion: reduce) { .pg-section { opacity: 1; transform: none; transition: none; } }
        .pg-section-header { display: flex; align-items: center; gap: .6rem; margin-bottom: .6rem; padding-bottom: .6rem; border-bottom: 1px solid #f0f0f0; }
        .pg-section-header iconify-icon { font-size: 1.3rem; color: #000000; }
        .pg-section-title { font-size: 1.2rem; font-weight: 700; margin: 0; letter-spacing: -.01em; }
        .pg-status-badge { font-size: .65rem; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; padding: .25rem .6rem; border-radius: 999px; border: 1px solid transparent; margin-left: auto; }
        .pg-status-done { background-color: #ECFDF5; color: #047857; border-color: #A7F3D0; }
        .pg-status-partial { background-color: #FFFBEB; color: #B45309; border-color: #FDE68A; }
        .pg-status-planned { background-color: #F3F4F6; color: #6B7280; border-color: #E5E7EB; }
        .pg-card { background-color: #ffffff; border: 1px solid #e5e5e5; border-radius: .6rem; box-shadow: 0 1px 3px rgba(0,0,0,.05); padding: 1.25rem 1.5rem; margin-bottom: 1rem; transition: box-shadow .2s ease, border-color .2s ease; }
        .pg-card:hover { border-color: #d1d5db; box-shadow: 0 3px 10px rgba(0,0,0,.07); }
        .pg-card-label { font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: #9a9a9a; margin-bottom: .5rem; }
        .pg-card p:last-child { margin-bottom: 0; }
        .pg-tech-note { font-size: .8rem; color: #6c757d; background-color: #fafafa; border-radius: .5rem; border-left: 3px solid #d1d5db; padding: .65rem .9rem; margin-top: .75rem; }
        .pg-page-links a { display: inline-flex; align-items: center; gap: .3rem; font-size: .83rem; font-weight: 500; border: 1px solid #d1d5db; border-radius: 999px; padding: .35rem .85rem; margin: .15rem .35rem .15rem 0; text-decoration: none; color: #111111; transition: background-color .15s ease, border-color .15s ease, transform .15s ease; }
        .pg-page-links a:hover { background-color: #000000; color: #ffffff; border-color: #000000; transform: translateY(-1px); }
        .pg-header { margin-bottom: 1.75rem; }
        .pg-header-eyebrow { font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .1em; color: #9a9a9a; margin-bottom: .4rem; }
        .pg-header-title { font-size: 1.7rem; font-weight: 700; margin: 0 0 .4rem; letter-spacing: -.01em; }
        .pg-header-sub { color: #6c757d; font-size: .9rem; margin: 0; max-width: 720px; }
        /* NotchTabBar (Tailwind, cf. components/ui/NotchTabBar.tsx) gère son propre style de pilule
           animée — .pg-tabs ne fait plus que le positionnement sticky au défilement. */
        .pg-tabs { padding: .75rem 0; margin-bottom: 1.25rem; position: sticky; top: 0; z-index: 10; background-color: #f5f5f5; }
        @media (max-width: 991px) {
          .pg-toc { position: static; width: auto; max-height: none; margin-bottom: 2rem; border-left: none; padding-left: 0; }
        }
      `}</style>

      <div className="pg-header">
        <p className="pg-header-eyebrow">Réassort Automatique — Documentation</p>
        <h2 className="pg-header-title">Guide du projet</h2>
        <p className="pg-header-sub">
          Ce que fait chaque fonctionnalité, pourquoi elle existe, et où la trouver — pensé pour quelqu'un qui
          découvre le projet ou veut mieux comprendre une fonctionnalité précise.
        </p>
      </div>

      {!groups && <p className="text-danger">Contenu du guide introuvable.</p>}

      {groups && (
        <div>
          <div className="pg-tabs">
            <NotchTabBar
              tabs={groups.map((group, gi) => ({ id: groupTabId(gi), label: group.label }))}
              activeId={activeTab}
              onActiveChange={(id) => selectTab(id)}
            />
          </div>

          {activeGroup && (
            <div className="row">
              <div className="col-lg-3 d-none d-lg-block">
                <nav className="pg-toc">
                  <div className="pg-toc-group-title">{activeGroup.label}</div>
                  {activeGroup.sections.map((s) => (
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
      )}
    </div>
  );
}
