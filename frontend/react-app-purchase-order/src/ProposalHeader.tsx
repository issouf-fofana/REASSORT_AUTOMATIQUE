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

  // Numéro lisible (spec §2) : composé de la date de génération + référence magasin, jamais stocké
  // séparément — aucune migration nécessaire, calculé à l'affichage à partir de champs déjà
  // persistés. Séparateur " / " plutôt que "-" (30/09/2026, signalé peu lisible) : AAAA-MM-JJ a déjà
  // des tirets, "...-414" se lisait comme un 4e segment de date au lieu d'une référence magasin.
  const proposalNumber = proposal.rposShopReference
    ? `${new Date(proposal.generatedAt).toISOString().slice(0, 10)} / ${proposal.rposShopReference}`
    : proposal.id.slice(0, 8);

  const periodLabel = proposal.analysisPeriodStart && proposal.analysisPeriodEnd
    ? `${fmtDate(proposal.analysisPeriodStart)} → ${fmtDate(proposal.analysisPeriodEnd)}`
    : null;
  const periodModeLabel = proposal.analysisPeriodMode ? PERIOD_MODE_LABEL[proposal.analysisPeriodMode] || proposal.analysisPeriodMode : null;

  return (
    <div className="card mb-3">
      <div className="card-body py-3">
        <div className="row g-3 small">
          <div className="col-6 col-md-3">
            <div className="text-muted">Numéro de proposition</div>
            <div className="fw-semibold font-monospace">{proposalNumber}</div>
          </div>
          <div className="col-6 col-md-3">
            <div className="text-muted">Créée le</div>
            <div className="fw-semibold">{fmtDateTime(proposal.generatedAt)}</div>
          </div>
          <div className="col-6 col-md-3">
            <div className="text-muted">Magasin</div>
            <div className="fw-semibold">
              {proposal.rposShopReference || '—'}
              {proposal.rposShopName ? ` — ${proposal.rposShopName}` : ''}
            </div>
          </div>
          <div className="col-6 col-md-3">
            <div className="text-muted">Statut</div>
            <div className="fw-semibold">{STATUS_LABEL[proposal.status] || proposal.status}</div>
          </div>
          <div className="col-6 col-md-3">
            <div className="text-muted">Période d'analyse</div>
            <div className="fw-semibold" title={periodModeLabel || undefined}>
              {periodLabel || '—'}
            </div>
          </div>
          {dataAvailability?.found && dataAvailability.oldestDate && dataAvailability.newestDate && (
            <div className="col-6 col-md-3">
              <div className="text-muted">Données disponibles</div>
              <div className="fw-semibold" title="Étendue complète de l'historique de ventes synchronisé pour ce magasin, indépendamment de la période d'analyse ci-dessus.">
                {fmtDate(dataAvailability.oldestDate)} → {fmtDate(dataAvailability.newestDate)}
              </div>
            </div>
          )}
          <div className="col-6 col-md-3">
            <div className="text-muted">Nombre total d'articles</div>
            <div className="fw-semibold">{summary.total}</div>
          </div>
          {summary.hasEligibilityData && (
            <>
              <div className="col-6 col-md-3">
                <div className="text-muted">Articles commandables</div>
                <div className="fw-semibold text-success">
                  <iconify-icon icon="solar:check-circle-bold" className="align-middle me-1"></iconify-icon>
                  {summary.commandableCount}
                </div>
              </div>
              <div className="col-6 col-md-3">
                <div className="text-muted">Articles non commandables</div>
                <div className={`fw-semibold ${summary.nonCommandableCount > 0 ? 'text-danger' : 'text-muted'}`}>
                  <iconify-icon icon="solar:close-circle-bold" className="align-middle me-1"></iconify-icon>
                  {summary.nonCommandableCount}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
