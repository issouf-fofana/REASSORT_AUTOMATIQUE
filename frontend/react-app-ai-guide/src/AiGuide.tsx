import { useEffect, useState } from 'react';
import { apiFetch } from './api/client';

interface PlatformPage {
  name: string;
  description: string;
}

interface PlatformGuide {
  roleLabel: string;
  pages: PlatformPage[];
  actions: string[];
}

interface CapabilityEntry {
  capability: string;
  label: string;
  examples: string[];
}

interface CapabilityGuide {
  allowed: CapabilityEntry[];
  denied: CapabilityEntry[];
}

const CAPABILITY_META: Record<string, { icon: string; deniedReason: string }> = {
  revenueShop: {
    icon: 'solar:wallet-money-bold-duotone',
    deniedReason:
      'Réservé aux comptes ayant une vision globale du magasin (Directeur, Superviseur, Administrateur) ou aux Chefs de département pour leur seul rayon.',
  },
  revenueArticle: {
    icon: 'solar:tag-price-bold-duotone',
    deniedReason: "Réservé aux comptes autorisés à voir le chiffre d'affaires d'un article ou d'un rayon précis.",
  },
  articleDetails: {
    icon: 'solar:box-bold-duotone',
    deniedReason: 'Réservé aux comptes autorisés à consulter la fiche complète d\'un article.',
  },
  stock: {
    icon: 'solar:archive-bold-duotone',
    deniedReason: 'Réservé aux comptes autorisés à consulter le stock et les ruptures.',
  },
  sales: {
    icon: 'solar:chart-bold-duotone',
    deniedReason: 'Réservé aux comptes autorisés à consulter les ventes et tendances.',
  },
  orders: {
    icon: 'solar:cart-check-bold-duotone',
    deniedReason: 'Réservé aux comptes autorisés à consulter les commandes et propositions.',
  },
  accuracy: {
    icon: 'solar:target-bold-duotone',
    deniedReason: "Réservé aux comptes autorisés à consulter la fiabilité de l'IA.",
  },
  unclassified: {
    icon: 'solar:question-circle-bold-duotone',
    deniedReason: 'Fonctionnalité non couverte par votre compte.',
  },
};

const EXAMPLES_COLLAPSED_COUNT = 3;

function CapabilityCard({ entry, allowed }: { entry: CapabilityEntry; allowed: boolean }) {
  const meta = CAPABILITY_META[entry.capability] || CAPABILITY_META.unclassified;
  const [expanded, setExpanded] = useState(false);
  const visibleExamples = expanded ? entry.examples : entry.examples.slice(0, EXAMPLES_COLLAPSED_COUNT);
  const hiddenCount = entry.examples.length - visibleExamples.length;

  return (
    <div className="col-md-6 col-lg-4">
      <div className={`aig-capability-card ${allowed ? 'allowed' : 'denied'}`}>
        <div className="aig-capability-icon">
          <iconify-icon icon={meta.icon}></iconify-icon>
        </div>
        <div className="aig-capability-title">{entry.label}</div>
        {allowed &&
          (entry.examples.length ? (
            <>
              <div className="aig-example-chips">
                {visibleExamples.map((ex, i) => (
                  <span className="aig-example-chip" key={i}>
                    {ex}
                  </span>
                ))}
              </div>
              {hiddenCount > 0 && (
                <button type="button" className="aig-example-more" onClick={() => setExpanded(true)}>
                  +{hiddenCount} autre{hiddenCount > 1 ? 's' : ''} exemple{hiddenCount > 1 ? 's' : ''}
                </button>
              )}
              {expanded && entry.examples.length > EXAMPLES_COLLAPSED_COUNT && (
                <button type="button" className="aig-example-more" onClick={() => setExpanded(false)}>
                  Réduire
                </button>
              )}
            </>
          ) : (
            <p className="text-muted small mb-0">Aucun exemple disponible.</p>
          ))}
        {!allowed && <p className="aig-denied-reason">{meta.deniedReason}</p>}
      </div>
    </div>
  );
}

const PAGE_ICON_BY_KEYWORD: [string, string][] = [
  ['tableau de bord', 'solar:widget-4-bold-duotone'],
  ['vue globale', 'solar:global-bold-duotone'],
  ['assistant ia', 'solar:chat-round-dots-bold-duotone'],
  ['proposition', 'solar:cart-check-bold-duotone'],
  ['historique', 'solar:history-bold-duotone'],
  ['vente', 'solar:chart-2-bold-duotone'],
  ['prédiction', 'solar:graph-up-bold-duotone'],
  ['amélioration', 'solar:lightbulb-bolt-bold-duotone'],
  ['journal', 'solar:document-text-bold-duotone'],
  ['utilisateur', 'solar:users-group-rounded-bold-duotone'],
  ['paramètre', 'solar:settings-bold-duotone'],
];

function pageIcon(name: string): string {
  const key = name.toLowerCase();
  const match = PAGE_ICON_BY_KEYWORD.find(([kw]) => key.includes(kw));
  return match ? match[1] : 'solar:widget-2-bold-duotone';
}

function PageCard({ page }: { page: PlatformPage }) {
  const restricted = /réservé administrateur/i.test(page.description);
  const description = page.description.replace(/\s*\(réservé Administrateur\)\.?/i, '.');
  return (
    <div className="col-md-6 col-lg-4">
      <div className="aig-page-card">
        <div className="aig-page-icon">
          <iconify-icon icon={pageIcon(page.name)}></iconify-icon>
        </div>
        <div className="aig-page-body">
          <div className="aig-page-name-row">
            <span className="aig-page-name">{page.name}</span>
            {restricted && <span className="aig-badge-admin">Admin</span>}
          </div>
          <p className="aig-page-desc">{description}</p>
        </div>
      </div>
    </div>
  );
}

export function AiGuide() {
  const [platformGuide, setPlatformGuide] = useState<PlatformGuide | null>(null);
  const [capabilityGuide, setCapabilityGuide] = useState<CapabilityGuide | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [platform, capability] = await Promise.all([
          apiFetch<PlatformGuide>('/reassort/platform-guide'),
          apiFetch<CapabilityGuide>('/reassort/chatbot/capability-guide'),
        ]);
        setPlatformGuide(platform);
        setCapabilityGuide(capability);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  return (
    <div className="aig-page">
      <style>{`
        .aig-hero {
          position: relative;
          overflow: hidden;
          background: linear-gradient(135deg, #14213D 0%, #1B2A4A 55%, #3E5A8C 100%);
          color: #ffffff;
          border-radius: 1rem;
          padding: 2.5rem 2.5rem 2.25rem;
          margin-bottom: 2.25rem;
          display: flex;
          justify-content: space-between;
          align-items: flex-end;
          flex-wrap: wrap;
          gap: 1rem;
        }
        .aig-hero::before {
          content: '';
          position: absolute;
          top: -60px;
          right: -60px;
          width: 260px;
          height: 260px;
          border-radius: 50%;
          background: radial-gradient(circle, rgba(245, 166, 35, .35) 0%, rgba(245, 166, 35, 0) 70%);
        }
        .aig-hero-icon { display: inline-flex; align-items: center; justify-content: center; width: 42px; height: 42px; border-radius: .9rem; background: rgba(255, 255, 255, .12); color: #F5A623; font-size: 1.3rem; margin-bottom: 1rem; }
        .aig-hero-eyebrow { font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .12em; color: #C9D3E6; margin-bottom: .6rem; position: relative; }
        .aig-hero-title { font-size: 2.1rem; font-weight: 700; margin: 0 0 .6rem; letter-spacing: -.01em; color: #ffffff !important; position: relative; }
        .aig-hero-sub { color: #CBD5E8; font-size: .93rem; margin: 0; max-width: 640px; line-height: 1.55; position: relative; }
        .aig-hero-role { background: #F5A623; color: #1B2A4A; font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; padding: .45rem .95rem; border-radius: 999px; white-space: nowrap; position: relative; }

        .aig-section { margin-bottom: 2.75rem; }
        .aig-section-header { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: .75rem; margin-bottom: 1.1rem; padding-bottom: .75rem; border-bottom: 1px solid #e9ecf2; }
        .aig-section-title { font-size: .78rem; font-weight: 700; text-transform: uppercase; letter-spacing: .1em; color: #1B2A4A; margin: 0; }
        .aig-subheading { font-size: .82rem; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: #8a93a8; margin-bottom: .85rem; }

        .aig-page-card { border: 1px solid #e9ecf2; border-radius: .9rem; padding: 1.1rem 1.25rem; height: 100%; display: flex; gap: .85rem; background: #ffffff; box-shadow: 0 1px 2px rgba(27, 42, 74, .04); transition: border-color .15s ease, box-shadow .15s ease, transform .15s ease; }
        .aig-page-card:hover { border-color: #c7d2e8; box-shadow: 0 8px 20px rgba(27, 42, 74, .08); transform: translateY(-1px); }
        .aig-page-icon { width: 42px; height: 42px; border-radius: .7rem; background: #EDF1F7; color: #1B2A4A; display: flex; align-items: center; justify-content: center; font-size: 1.2rem; flex-shrink: 0; }
        .aig-page-body { min-width: 0; }
        .aig-page-name-row { display: flex; align-items: center; gap: .5rem; margin-bottom: .3rem; }
        .aig-page-name { font-weight: 600; font-size: .95rem; color: #1B2A4A; }
        .aig-page-desc { font-size: .83rem; color: #5B6B85; margin-bottom: 0; line-height: 1.45; }
        .aig-badge-admin { font-size: .62rem; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: #8A5A00; background: #FDF1DD; padding: .15rem .5rem; border-radius: 999px; flex-shrink: 0; }

        .aig-action-list { margin: 0; padding-left: 0; list-style: none; }
        .aig-action-list li { position: relative; padding-left: 1.6rem; margin-bottom: .65rem; font-size: .9rem; color: #33415C; }
        .aig-action-list li:last-child { margin-bottom: 0; }
        .aig-action-list li::before { content: ''; position: absolute; left: 0; top: .45rem; width: 7px; height: 7px; border-radius: 50%; background: #F5A623; }

        .aig-assistant-callout { border: 1px solid #e9ecf2; border-radius: .9rem; padding: 1.15rem 1.4rem; margin-bottom: 1.5rem; background: #F7F9FC; font-size: .87rem; color: #44516B; line-height: 1.55; }
        .aig-assistant-callout strong { color: #1B2A4A; }

        .aig-capability-card { border: 1px solid #e9ecf2; border-radius: .9rem; padding: 1.15rem 1.25rem; height: 100%; background: #ffffff; box-shadow: 0 1px 2px rgba(27, 42, 74, .04); }
        .aig-capability-card.allowed .aig-capability-icon { background: #1B2A4A; color: #F5A623; }
        .aig-capability-card.denied { background: #F7F9FC; }
        .aig-capability-card.denied .aig-capability-icon { background: #e9ecf2; color: #8a93a8; }
        .aig-capability-icon { width: 38px; height: 38px; border-radius: .65rem; display: flex; align-items: center; justify-content: center; font-size: 1.15rem; margin-bottom: .7rem; }
        .aig-capability-title { font-weight: 600; font-size: .92rem; margin-bottom: .5rem; color: #1B2A4A; }
        .aig-capability-card.denied .aig-capability-title { color: #6c7a94; }
        .aig-example-chips { display: flex; flex-wrap: wrap; gap: .4rem; }
        .aig-example-chip {
          font-size: .78rem;
          color: #33415C;
          background: #EDF1F7;
          border-radius: 999px;
          padding: .32rem .7rem;
          line-height: 1.3;
        }
        .aig-example-more {
          border: none;
          background: transparent;
          color: #1B2A4A;
          font-weight: 600;
          font-size: .78rem;
          padding: .5rem 0 0;
          cursor: pointer;
        }
        .aig-example-more:hover { color: #F5A623; }
        .aig-denied-reason { font-size: .82rem; color: #8a93a8; margin-top: 0; margin-bottom: 0; line-height: 1.45; }
      `}</style>

      <div className="aig-hero">
        <div>
          <div className="aig-hero-icon">
            <iconify-icon icon="solar:shield-star-bold-duotone"></iconify-icon>
          </div>
          <p className="aig-hero-eyebrow">Réassort Automatique — Accès &amp; capacités IA</p>
          <h2 className="aig-hero-title">Mon accès</h2>
          <p className="aig-hero-sub">
            Ce que votre compte peut consulter et faire sur la plateforme, et ce que vous pouvez demander en langage
            naturel à l'Assistant IA.
          </p>
        </div>
        {platformGuide?.roleLabel && <span className="aig-hero-role">{platformGuide.roleLabel}</span>}
      </div>

      {!platformGuide && !capabilityGuide && !error && <div className="text-center text-muted py-5">Chargement...</div>}
      {error && <div className="alert alert-danger">Erreur : {error}</div>}

      {platformGuide && capabilityGuide && (
        <div>
          <div className="aig-section">
            <div className="aig-section-header">
              <h3 className="aig-section-title">Sur la plateforme</h3>
            </div>

            <p className="aig-subheading">Pages accessibles</p>
            <div className="row g-3 mb-4">
              {platformGuide.pages.map((page, i) => (
                <PageCard page={page} key={i} />
              ))}
            </div>

            <p className="aig-subheading">Actions possibles</p>
            <ul className="aig-action-list">
              {platformGuide.actions.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          </div>

          <div className="aig-section mb-0">
            <div className="aig-section-header">
              <h3 className="aig-section-title">Assistant IA</h3>
              <a href="/ai-assistant" className="btn btn-sm" style={{ background: '#1B2A4A', color: '#ffffff', fontWeight: 600 }}>
                Ouvrir l'Assistant IA →
              </a>
            </div>

            <div className="aig-assistant-callout">
              <strong>Comment ça marche :</strong> l'Assistant IA ne répond jamais avec un chiffre inventé. Pour
              chaque question, il identifie d'abord la donnée réelle demandée (ventes, stock, chiffre d'affaires,
              commandes...), va la chercher dans les données du magasin, puis reformule la réponse en langage
              naturel. Si votre compte n'a pas le droit de consulter une donnée précise, l'IA le dit explicitement
              plutôt que de deviner.
            </div>

            <p className="aig-subheading">Vous pouvez demander</p>
            <div className="row g-3 mb-4">
              {capabilityGuide.allowed.length ? (
                capabilityGuide.allowed.map((c, i) => <CapabilityCard entry={c} allowed key={i} />)
              ) : (
                <div className="col-12">
                  <p className="text-muted">Aucune capacité disponible pour ce compte.</p>
                </div>
              )}
            </div>

            {capabilityGuide.denied.length > 0 && (
              <div>
                <p className="aig-subheading">Hors de votre périmètre</p>
                <div className="row g-3">
                  {capabilityGuide.denied.map((c, i) => (
                    <CapabilityCard entry={c} allowed={false} key={i} />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
