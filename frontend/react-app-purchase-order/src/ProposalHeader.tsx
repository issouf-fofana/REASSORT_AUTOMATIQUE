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
    const commandable = active.filter((l) => l.supplierIneligible !== true);
    const nonCommandable = active.filter((l) => l.supplierIneligible === true);
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
        .ph-card { background: #ffffff; border: 1px solid #e9ecf2; border-radius: 14px; box-shadow: 0 1px 3px rgba(27,42,74,.05); overflow: hidden; }
        .ph-top { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; padding: 1rem 1.3rem; background: #1B2A4A; color: #ffffff; }
        .ph-identity { display: flex; align-items: center; gap: .9rem; min-width: 0; }
        .ph-icon { width: 38px; height: 38px; border-radius: 10px; background: rgba(255,255,255,.12); color: #F5A623; display: flex; align-items: center; justify-content: center; font-size: 1.1rem; flex-shrink: 0; }
        .ph-number { font-weight: 700; font-size: .98rem; }
        .ph-shop { color: #C7D0E0; font-size: .8rem; }
        .ph-status { font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; padding: .35rem .8rem; border-radius: 999px; white-space: nowrap; background: rgba(245,166,35,.18); color: #F5A623; }
        .ph-status.validated { background: rgba(34,197,94,.18); color: #86efac; }
        .ph-metrics { display: flex; flex-wrap: wrap; gap: 1.5rem; padding: .9rem 1.3rem; }
        .ph-metric { min-width: 100px; }
        .ph-metric-label { display: flex; align-items: center; gap: .35rem; color: #8a93a8; font-size: .68rem; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; margin-bottom: .25rem; }
        .ph-metric-label iconify-icon { font-size: .85rem; }
        .ph-metric-value { font-size: .95rem; font-weight: 700; color: #1B2A4A; }
        .ph-metric-value.success { color: #047857; }
        .ph-metric-value.danger { color: #b91c1c; }
      `}</style>
      <div className="ph-top">
        <div className="ph-identity">
          <div className="ph-icon">
            <iconify-icon icon="solar:document-text-bold-duotone"></iconify-icon>
          </div>
          <div className="min-width-0">
            <div className="ph-number">Proposition {proposalNumber}</div>
            <div className="ph-shop" title={fmtDateTime(proposal.generatedAt)}>
              {proposal.rposShopReference || '—'}
              {proposal.rposShopName ? ` — ${proposal.rposShopName}` : ''}
            </div>
          </div>
        </div>
        <span className={`ph-status${proposal.status === 'VALIDATED' ? ' validated' : ''}`}>
          {STATUS_LABEL[proposal.status] || proposal.status}
        </span>
      </div>
      <div className="ph-metrics">
        <div className="ph-metric">
          <div className="ph-metric-label">
            <iconify-icon icon="solar:calendar-bold-duotone"></iconify-icon> Analyse
          </div>
          <div className="ph-metric-value" title={periodModeLabel || undefined}>
            {periodLabel || '—'}
          </div>
        </div>
        {dataAvailability?.found && dataAvailability.oldestDate && dataAvailability.newestDate && (
          <div className="ph-metric">
            <div className="ph-metric-label">
              <iconify-icon icon="solar:database-bold-duotone"></iconify-icon> Données dispo.
            </div>
            <div
              className="ph-metric-value"
              title="Étendue complète de l'historique de ventes synchronisé pour ce magasin, indépendamment de la période d'analyse."
            >
              {fmtDate(dataAvailability.oldestDate)} → {fmtDate(dataAvailability.newestDate)}
            </div>
          </div>
        )}
        <div className="ph-metric">
          <div className="ph-metric-label">
            <iconify-icon icon="solar:box-bold-duotone"></iconify-icon> Articles
          </div>
          <div className="ph-metric-value">{summary.total}</div>
        </div>
        {summary.hasEligibilityData && (
          <>
            <div className="ph-metric">
              <div className="ph-metric-label">
                <iconify-icon icon="solar:check-circle-bold-duotone"></iconify-icon> Commandables
              </div>
              <div className="ph-metric-value success">{summary.commandableCount}</div>
            </div>
            <div className="ph-metric">
              <div className="ph-metric-label">
                <iconify-icon icon="solar:close-circle-bold-duotone"></iconify-icon> Non commandables
              </div>
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
