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

function CapabilityCard({ entry, allowed }: { entry: CapabilityEntry; allowed: boolean }) {
  const meta = CAPABILITY_META[entry.capability] || CAPABILITY_META.unclassified;
  return (
    <div className="col-md-6 col-lg-4">
      <div className={`aig-capability-card ${allowed ? 'allowed' : 'denied'}`}>
        <div className="aig-capability-title">
          <iconify-icon icon={meta.icon} style={{ fontSize: '1.3rem' }}></iconify-icon>
          <span>{entry.label}</span>
        </div>
        {allowed &&
          (entry.examples.length ? (
            <ul className="aig-example-list">
              {entry.examples.map((ex, i) => (
                <li key={i}>{ex}</li>
              ))}
            </ul>
          ) : (
            <p className="text-muted small mb-0">Aucun exemple disponible.</p>
          ))}
        {!allowed && <p className="aig-denied-reason">{meta.deniedReason}</p>}
      </div>
    </div>
  );
}

function PageCard({ page }: { page: PlatformPage }) {
  return (
    <div className="col-md-6 col-lg-4">
      <div className="aig-page-card">
        <div className="aig-page-name">{page.name}</div>
        <p className="aig-page-desc">{page.description}</p>
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
    <div>
      <style>{`
        .aig-section-title { font-size: 1rem; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; color: #666666; margin-bottom: 1rem; }
        .aig-page-card { border: 1px solid #e5e5e5; border-radius: .5rem; padding: 1rem 1.25rem; height: 100%; }
        .aig-page-name { font-weight: 600; margin-bottom: .3rem; }
        .aig-page-desc { font-size: .85rem; color: #6c757d; margin-bottom: 0; }
        .aig-action-list { margin: 0; padding-left: 1.2rem; }
        .aig-action-list li { margin-bottom: .5rem; }
        .aig-action-list li:last-child { margin-bottom: 0; }
        .aig-capability-card { border: 1px solid #e5e5e5; border-radius: .5rem; padding: 1rem 1.25rem; height: 100%; }
        .aig-capability-card.allowed { border-left: 4px solid #198754; }
        .aig-capability-card.denied { border-left: 4px solid #dc3545; opacity: .85; }
        .aig-capability-title { font-weight: 600; display: flex; align-items: center; gap: .5rem; margin-bottom: .5rem; }
        .aig-example-list { margin: 0; padding-left: 1.1rem; }
        .aig-example-list li { margin-bottom: .35rem; font-size: .88rem; }
        .aig-example-list li:last-child { margin-bottom: 0; }
        .aig-denied-reason { font-size: .85rem; color: #6c757d; margin-top: .5rem; margin-bottom: 0; }
      `}</style>

      <div className="d-flex justify-content-between align-items-start flex-wrap gap-2 mb-4">
        <div>
          <h2 className="mb-1">Mon accès</h2>
          <p className="text-muted mb-0">
            <span className="fw-semibold">{platformGuide?.roleLabel || 'Ce compte'}</span> peuvent faire ceci sur la
            plateforme, et demander cela à l'Assistant IA.
          </p>
        </div>
      </div>

      {!platformGuide && !capabilityGuide && !error && <div className="text-center text-muted py-5">Chargement...</div>}
      {error && <div className="alert alert-danger">Erreur : {error}</div>}

      {platformGuide && capabilityGuide && (
        <div>
          <div className="mb-5">
            <h3 className="aig-section-title">Sur la plateforme</h3>

            <p className="fw-semibold mb-2">Pages accessibles</p>
            <div className="row g-3 mb-4">
              {platformGuide.pages.map((page, i) => (
                <PageCard page={page} key={i} />
              ))}
            </div>

            <p className="fw-semibold mb-2">Actions possibles</p>
            <ul className="aig-action-list">
              {platformGuide.actions.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          </div>

          <div>
            <div className="d-flex justify-content-between align-items-center flex-wrap gap-2 mb-3">
              <h3 className="aig-section-title mb-0">Assistant IA</h3>
              <a href="/ai-assistant" className="btn btn-outline-dark btn-sm">
                Ouvrir l'Assistant IA →
              </a>
            </div>

            <div className="alert alert-light border small mb-4">
              <strong>Comment ça marche :</strong> l'Assistant IA ne répond jamais avec un chiffre inventé. Pour
              chaque question, il identifie d'abord la donnée réelle demandée (ventes, stock, chiffre d'affaires,
              commandes...), va la chercher dans les données du magasin, puis reformule la réponse en langage
              naturel. Si votre compte n'a pas le droit de consulter une donnée précise, l'IA le dit explicitement
              plutôt que de deviner.
            </div>

            <p className="fw-semibold mb-2">Vous pouvez demander</p>
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
                <p className="fw-semibold mb-2">Hors de votre périmètre</p>
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
