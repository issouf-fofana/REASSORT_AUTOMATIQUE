import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from './api/client';
import type { Proposal } from './types';

interface DataAvailability {
  found: boolean;
  oldestDate?: string;
  newestDate?: string;
  spanDays?: number;
  coversAtLeastOneYear?: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  GENERATED: 'Générée, en attente de validation',
  VALIDATING: 'Validation en cours',
  VALIDATED: 'Validée',
  VALIDATION_FAILED: 'Échec de validation',
  REJECTED: 'Remplacée par une génération plus récente',
};

const PERIOD_MODE_LABEL: Record<string, string> = {
  YESTERDAY: 'Hier',
  LAST_7_DAYS: '7 derniers jours',
  LAST_30_DAYS: '30 derniers jours',
  LAST_60_DAYS: '60 derniers jours',
  LAST_90_DAYS: '90 derniers jours',
  LAST_120_DAYS: '120 derniers jours',
  LAST_180_DAYS: '180 derniers jours',
  LAST_365_DAYS: '365 derniers jours',
  ALL_TIME: 'Toutes les données disponibles',
  CUSTOM: 'Période personnalisée',
};

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/**
 * En-tête complet d'une proposition (spec du 28/09/2026, §2 : "numéro / date / heure / magasin /
 * période d'analyse / statut / nombre total d'articles / commandables / non commandables") —
 * jusqu'ici ces informations étaient éparpillées (certaines seulement dans le <select> Génération,
 * d'autres seulement dans la vue Secteurs via DeptListContext, le nombre commandable/non
 * commandable seulement PAR RAYON) ou carrément absentes (aucun numéro lisible, aucune heure
 * visible en dehors du sélecteur). Calculé sur proposal.lines EN ENTIER (tous rayons confondus),
 * contrairement à eligibilitySummary dans PurchaseOrder.tsx qui ne porte que sur le rayon affiché.
 */
export function ProposalHeader({ proposal }: { proposal: Proposal }) {
  // Étendue réelle de l'historique de ventes disponible pour ce magasin (spec du 28/09/2026, §7 :
  // "Données disponibles : du DD/MM/AAAA au DD/MM/AAAA") — distinct de la période d'analyse
  // ci-dessous (la fenêtre RÉSOLUE pour CETTE proposition précise), ceci montre jusqu'où on pourrait
  // remonter si on voulait comparer sur une plus longue période. Chargé une fois par proposition
  // (pas par changement de département/vue), jamais bloquant : un échec de chargement laisse
  // simplement cette ligne absente plutôt que de gêner l'affichage du reste de l'en-tête.
  const [dataAvailability, setDataAvailability] = useState<DataAvailability | null>(null);
  useEffect(() => {
    let cancelled = false;
    setDataAvailability(null);
    apiFetch<DataAvailability>(`/reassort/proposal/${proposal.id}/data-availability`)
      .then((data) => { if (!cancelled) setDataAvailability(data); })
      .catch(() => { /* non bloquant : l'en-tête reste utilisable sans cette info */ });
    return () => { cancelled = true; };
  }, [proposal.id]);

  const summary = useMemo(() => {
    const active = proposal.lines.filter((l) => !l.wasExcluded);
    // Corrigé le 08/10/2026 (mission "Logique de gestion des fournisseurs et des commandes") :
    // non commandable = aucun fournisseur RPOS réel (currentSuppliers === 'aucun'), pas simplement
    // "pas le central" (supplierIneligible seul) — un article avec un fournisseur actif non-central
    // EST commandable, juste pas en livraison centrale (LC).
    const nonCommandable = active.filter((l) => !l.currentSuppliers || l.currentSuppliers === 'aucun');
    const commandable = active.filter((l) => !!l.currentSuppliers && l.currentSuppliers !== 'aucun');
    const hasEligibilityData = active.some((l) => l.supplierIneligible !== null && l.supplierIneligible !== undefined);
    return {
      total: proposal.lines.length,
      commandableCount: commandable.length,
      nonCommandableCount: nonCommandable.length,
      hasEligibilityData,
    };
  }, [proposal.lines]);

  // Numéro lisible (spec §2) : juste la date de génération — la référence magasin est déjà affichée
  // séparément dans la carte "Magasin" ci-dessous, inutile de la répéter ici (retiré le 30/09/2026).
  const proposalNumber = new Date(proposal.generatedAt).toISOString().slice(0, 10);

  const periodLabel = proposal.analysisPeriodStart && proposal.analysisPeriodEnd
    ? `${fmtDate(proposal.analysisPeriodStart)} → ${fmtDate(proposal.analysisPeriodEnd)}`
    : null;
  const periodModeLabel = proposal.analysisPeriodMode ? PERIOD_MODE_LABEL[proposal.analysisPeriodMode] || proposal.analysisPeriodMode : null;

  return (
    <div className="ph-card mb-3">
      <style>{`
        /* Refonte du 05/10/2026 ("afficher les contours pour chaque partie") : chaque compartiment —
           bandeau identité/statut, puis chaque métrique individuellement — a son propre contour net
           et visible, pas un séparateur à peine perceptible comme la tentative précédente
           (#EDF1F7 sur blanc). Bordures à #D6DEEA (même teinte que .reassort-info-badge ailleurs
           sur le site), clairement lisibles sans être agressives. */
        /* Bandeau passé en blanc (demande du 05/10/2026, "trop de bleu à l'écran, le marine doit
           rester la sidebar seule") — fini le fond dégradé marine ici, l'identité reste lisible en
           texte foncé simple et le seul accent de couleur est le badge de statut. */
        .ph-card { background: #ffffff; border: 1px solid #D6DEEA; border-radius: 14px; overflow: hidden; box-shadow: 0 1px 3px rgba(27,42,74,.08); }
        .ph-top {
          display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; flex-wrap: wrap;
          padding: 1.1rem 1.4rem;
          background: #ffffff;
          border-bottom: 1px solid #D6DEEA;
        }
        .ph-number { font-weight: 600; font-size: 1.1rem; letter-spacing: -.01em; color: #1B2A4A; }
        .ph-shop { color: #5B6B85; font-size: .82rem; margin-top: .15rem; }
        /* Pilule pleine (demande du 05/10/2026 : remise après une tentative "texte seul" jugée trop
           discrète) — mêmes couleurs que la version d'origine, juste un contour en plus pour rester
           cohérent avec le reste de la refonte "contours visibles". */
        .ph-status {
          font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
          padding: .35rem .8rem; border-radius: 999px; white-space: nowrap;
          background: #F5A623; color: #1B2A4A; border: 1px solid rgba(255,255,255,.25);
        }
        .ph-status.validated { background: #22c55e; color: #0b3b1f; }
        /* Grille façon tableau (demande du 05/10/2026, "séparé par les bordures comme dans un
           tableau") : chaque métrique est une vraie cellule avec un contour complet sur ses 4 côtés
           (via un gap négatif + bordure pleine + chevauchement des bordures adjacentes, pattern CSS
           classique pour un tableau sans bordures doublées), pas juste un filet entre deux blocs. */
        .ph-metrics {
          display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
          background: #D6DEEA; gap: 1px;
        }
        .ph-metric { background: #ffffff; padding: .9rem 1.4rem; }
        .ph-metric-label { color: #8a93a8; font-size: .72rem; margin-bottom: .2rem; }
        .ph-metric-value { font-size: 1.1rem; font-weight: 600; line-height: 1.15; color: #1B2A4A; }
        .ph-metric-value.success { color: #047857; }
        .ph-metric-value.danger { color: #b91c1c; }
        @media (max-width: 767px) { .ph-metric { border-right: none; } }
      `}</style>
      <div className="ph-top">
        <div className="min-width-0">
          <div className="ph-number">Proposition {proposalNumber}</div>
          <div className="ph-shop" title={fmtDateTime(proposal.generatedAt)}>
            {proposal.rposShopReference || '—'}
            {proposal.rposShopName ? ` — ${proposal.rposShopName}` : ''}
          </div>
        </div>
        <span className={`ph-status${proposal.status === 'VALIDATED' ? ' validated' : ''}`}>
          {STATUS_LABEL[proposal.status] || proposal.status}
        </span>
      </div>
      <div className="ph-metrics">
        <div className="ph-metric">
          <div className="ph-metric-label">Analyse</div>
          <div className="ph-metric-value" title={periodModeLabel || undefined}>
            {periodLabel || '—'}
          </div>
        </div>
        {dataAvailability?.found && dataAvailability.oldestDate && dataAvailability.newestDate && (
          <div className="ph-metric">
            <div className="ph-metric-label">Données dispo.</div>
            <div
              className="ph-metric-value"
              title="Étendue complète de l'historique de ventes synchronisé pour ce magasin, indépendamment de la période d'analyse."
            >
              {fmtDate(dataAvailability.oldestDate)} → {fmtDate(dataAvailability.newestDate)}
            </div>
          </div>
        )}
        <div className="ph-metric">
          <div className="ph-metric-label">Articles</div>
          <div className="ph-metric-value">{summary.total}</div>
        </div>
        {summary.hasEligibilityData && (
          <>
            <div className="ph-metric">
              <div className="ph-metric-label">Commandables</div>
              <div className="ph-metric-value success">{summary.commandableCount}</div>
            </div>
            <div className="ph-metric">
              <div className="ph-metric-label">Non commandables</div>
              <div className={`ph-metric-value${summary.nonCommandableCount > 0 ? ' danger' : ''}`}>
                {summary.nonCommandableCount}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
