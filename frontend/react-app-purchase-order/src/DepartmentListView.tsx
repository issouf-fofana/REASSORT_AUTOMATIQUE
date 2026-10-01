import type { Proposal, ProposalLine, ProposalOrder } from './types';

interface GroupData {
  count: number;
  revenuePct: number;
  value: number;
}

function groupLines(lines: ProposalLine[], keyFn: (l: ProposalLine) => string): [string, GroupData][] {
  const byKey = new Map<string, GroupData>();
  lines.forEach((l) => {
    const key = keyFn(l);
    if (!byKey.has(key)) byKey.set(key, { count: 0, revenuePct: 0, value: 0 });
    const d = byKey.get(key)!;
    d.count += 1;
    d.revenuePct += l.revenueSharePct || 0;
    d.value += (l.sellingPrice || 0) * (l.quantitySuggested || 0);
  });
  return Array.from(byKey.entries()).sort((a, b) => b[1].revenuePct - a[1].revenuePct);
}

// Icône décorative par secteur/rayon : purement esthétique (aucune logique métier), une
// correspondance mot-clé raisonnable suffit — un rayon non reconnu retombe sur une icône neutre.
const SECTOR_ICON_BY_KEYWORD: [string, string][] = [
  ['sec', 'solar:box-bold-duotone'],
  ['frais', 'solar:leaf-bold-duotone'],
  ['bazar', 'solar:bag-smile-bold-duotone'],
  ['textile', 'solar:t-shirt-bold-duotone'],
  ['liquide', 'solar:bottle-bold-duotone'],
  ['boisson', 'solar:cup-hot-bold-duotone'],
  ['hygiène', 'solar:health-bold-duotone'],
  ['hygiene', 'solar:health-bold-duotone'],
  ['entretien', 'solar:spray-can-bold-duotone'],
  ['surgel', 'solar:snowflake-bold-duotone'],
];

function sectorIcon(name: string): string {
  const key = name.toLowerCase();
  const match = SECTOR_ICON_BY_KEYWORD.find(([kw]) => key.includes(kw));
  return match ? match[1] : 'solar:widget-2-bold-duotone';
}

function DeptTile({
  name,
  d,
  href,
  onNavigate,
  order,
}: {
  name: string;
  d: GroupData;
  href: string;
  onNavigate: (href: string) => void;
  // ProposalOrder déjà créée pour ce rayon (demande du 26/09/2026, validation indépendante par
  // rayon) — undefined au niveau secteur (n'a pas de sens), null si ce rayon n'est pas encore validé.
  order?: ProposalOrder | null;
}) {
  const pctClamped = Math.max(0, Math.min(100, d.revenuePct));
  const statusMeta = !order
    ? null
    : order.status === 'DONE'
      ? { cls: 'status-done', icon: 'solar:check-circle-bold', label: 'Validé' }
      : order.status === 'FAILED'
        ? { cls: 'status-failed', icon: 'solar:close-circle-bold', label: 'Échec' }
        : { cls: 'status-pending', icon: 'solar:clock-circle-bold', label: 'En attente' };
  return (
    <a
      href={href}
      className="reassort-dept-row text-decoration-none d-block"
      onClick={(e) => {
        // Empêche un vrai rechargement de page (perdrait tout l'état React déjà chargé — proposal,
        // shops, etc.) au profit d'une navigation SPA via history.pushState, exactement comme les
        // flèches "retour" du composant parent — oublié ici lors de la première écriture de ce
        // composant, ce qui faisait sembler les tuiles totalement inertes (24/09/2026).
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // laisse ouvrir dans un nouvel onglet si demandé
        e.preventDefault();
        onNavigate(href);
      }}
    >
      <div className="card-body">
        <div className="row-top">
          <div className="row-identity">
            <div className="tile-icon">
              <iconify-icon icon={sectorIcon(name)}></iconify-icon>
            </div>
            <div>
              <h5 className="card-title">{name}</h5>
              <div className="tile-count">{d.count} article(s)</div>
            </div>
          </div>
          {statusMeta && (
            <span className={`row-status-badge ${statusMeta.cls}`} title={order?.rposOrderReference ? `Commande ${order.rposOrderReference}` : undefined}>
              <iconify-icon icon={statusMeta.icon}></iconify-icon> {statusMeta.label}
            </span>
          )}
        </div>
        <div className="row-metrics">
          <div className="row-metric">
            <div className="row-metric-label">
              <iconify-icon icon="solar:box-bold-duotone"></iconify-icon> Articles
            </div>
            <div className="row-metric-value">{d.count}</div>
          </div>
          <div className="row-metric">
            <div className="row-metric-label">
              <iconify-icon icon="solar:pie-chart-bold-duotone"></iconify-icon> % CA
            </div>
            <div className="row-metric-value">{d.revenuePct.toFixed(1)}%</div>
          </div>
          <div className="row-metric">
            <div className="row-metric-label">
              <iconify-icon icon="solar:wallet-money-bold-duotone"></iconify-icon> Proposé
            </div>
            <div className="row-metric-value">{d.value.toLocaleString('fr-FR')} CFA</div>
          </div>
          <div className="row-progress-wrap">
            <div className="row-metric-label">Part du CA secteur</div>
            <div className="tile-progress">
              <div className="tile-progress-fill" style={{ width: `${pctClamped}%` }}></div>
            </div>
          </div>
        </div>
      </div>
    </a>
  );
}

function RemainderTile({
  proposal,
  rawGroups,
  onOpenExcluded,
}: {
  proposal: Proposal;
  rawGroups: [string, GroupData][];
  onOpenExcluded: (reason: string, label: string) => void;
}) {
  const coveredPct = rawGroups.reduce((sum, [, d]) => sum + d.revenuePct, 0);
  const remainderPct = Math.max(0, 100 - coveredPct);
  const remainderValue = proposal.shopTotalRevenue ? Math.round(proposal.shopTotalRevenue * (remainderPct / 100)) : null;
  const remainderPctClamped = Math.max(0, Math.min(100, remainderPct));

  const items: [string, string, number | undefined][] = (
    [
      ['genericArticle', 'Génériques exclus', proposal.skippedGenericArticle],
      ['negativeStock', 'Stock négatif', proposal.skippedNegativeStock],
      ['alreadyOrdered', 'Déjà commandés', proposal.skippedAlreadyOrdered],
      ['notOrderable', 'Non commandables', proposal.skippedNotOrderable],
      ['notFound', 'Introuvables côté RPOS', proposal.skippedNotFound],
    ] as [string, string, number | undefined][]
  ).filter(([, , count]) => !!count);

  return (
    <div className="reassort-dept-row reassort-dept-row-neutral">
      <div className="card-body">
        <div className="row-top">
          <div className="row-identity">
            <div className="tile-icon">
              <iconify-icon icon="solar:pie-chart-2-bold-duotone"></iconify-icon>
            </div>
            <div>
              <h5 className="card-title">Reste du CA magasin</h5>
              <div className="tile-count">Non proposé ici (hors Pareto, stock négatif, déjà commandé, générique, etc.)</div>
            </div>
          </div>
        </div>
        <div className="row-metrics">
          <div className="row-metric">
            <div className="row-metric-label">
              <iconify-icon icon="solar:pie-chart-bold-duotone"></iconify-icon> % CA
            </div>
            <div className="row-metric-value">{remainderPct.toFixed(1)}%</div>
          </div>
          {remainderValue !== null && (
            <div className="row-metric">
              <div className="row-metric-label">
                <iconify-icon icon="solar:wallet-money-bold-duotone"></iconify-icon> Montant
              </div>
              <div className="row-metric-value">{remainderValue.toLocaleString('fr-FR')} CFA</div>
            </div>
          )}
          <div className="row-progress-wrap">
            <div className="row-metric-label">Part du CA secteur</div>
            <div className="tile-progress">
              <div className="tile-progress-fill" style={{ width: `${remainderPctClamped}%` }}></div>
            </div>
          </div>
        </div>
        {items.length > 0 && (
          <ul className="text-muted small mb-0 ps-3 mt-3">
            {items.map(([reason, label, count]) => (
              <li key={reason}>
                <a
                  href="#"
                  style={{ cursor: 'pointer', textDecoration: 'underline' }}
                  onClick={(e) => {
                    e.preventDefault();
                    onOpenExcluded(reason, label);
                  }}
                >
                  {label} : {count}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('fr-FR');
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function DeptListContext({ proposal }: { proposal: Proposal }) {
  if (!proposal.analysisPeriodStart || !proposal.analysisPeriodEnd) return null;
  const start = new Date(proposal.analysisPeriodStart);
  const end = new Date(proposal.analysisPeriodEnd);
  const periodLabel = start.toDateString() === end.toDateString() ? fmtDate(proposal.analysisPeriodStart) : `du ${fmtDate(proposal.analysisPeriodStart)} au ${fmtDate(proposal.analysisPeriodEnd)}`;
  const revenueLabel = proposal.shopTotalRevenue
    ? `${proposal.shopTotalRevenue.toLocaleString('fr-FR')} CFA HT${proposal.shopTotalRevenueInclTax ? ` (${proposal.shopTotalRevenueInclTax.toLocaleString('fr-FR')} CFA TTC)` : ''}`
    : '—';

  let revenuePeriodLabel = '';
  if (proposal.revenueShareStart && proposal.revenueShareEnd) {
    const revStart = new Date(proposal.revenueShareStart);
    const revEnd = new Date(proposal.revenueShareEnd);
    revenuePeriodLabel = revStart.toDateString() === revEnd.toDateString() ? ` (${fmtDate(proposal.revenueShareStart)})` : ` (du ${fmtDate(proposal.revenueShareStart)} au ${fmtDate(proposal.revenueShareEnd)})`;
  }

  const showCoverageWarning = !!(proposal.coverageGapDays && proposal.coverageGapDays > 1 && proposal.actualDataStart);
  const actualStart = proposal.actualDataStart ? fmtDate(proposal.actualDataStart) : null;
  const actualEnd = proposal.actualDataEnd || proposal.analysisPeriodEnd ? fmtDate(proposal.actualDataEnd || proposal.analysisPeriodEnd!) : null;

  return (
    <div className="d-flex flex-wrap align-items-center gap-2 mb-3">
      <span
        className="badge border reassort-mini-badge reassort-info-badge"
        title={`Période sur laquelle le classement Pareto et les quantités proposées ont été calculés.`}
      >
        <iconify-icon icon="solar:calendar-bold-duotone"></iconify-icon> Analyse : {periodLabel}
      </span>
      <span
        className="badge border reassort-mini-badge reassort-info-badge"
        title={`Chiffre figé au moment de la génération (${fmtDateTime(proposal.generatedAt)}), sur une fenêtre de référence indépendante de la période d'analyse — sert uniquement à calculer le % CA de chaque article.`}
      >
        <iconify-icon icon="solar:wallet-money-bold-duotone"></iconify-icon> CA magasin{revenuePeriodLabel} : {revenueLabel}
      </span>
      {showCoverageWarning && actualStart && actualEnd && (
        <span
          className="badge border reassort-mini-badge reassort-warning-badge"
          title={`Cette génération demandait des ventes depuis le ${fmtDate(proposal.analysisPeriodStart!)}, mais les données réellement disponibles ne remontent qu'au ${actualStart} — soit ${proposal.coverageGapDays} jour(s) manquant(s). Lancez un backfill (Paramètres > Fichiers de ventes) pour combler ce manque.`}
        >
          <iconify-icon icon="solar:danger-triangle-bold-duotone"></iconify-icon> Données dispo. : {actualStart} → {actualEnd}
        </span>
      )}
    </div>
  );
}

export function DepartmentListView({
  proposal,
  selectedSector,
  buildNavUrl,
  onNavigate,
  onOpenExcluded,
}: {
  proposal: Proposal | null;
  selectedSector: string | null;
  buildNavUrl: (sector: string | null, dept: string | null) => string;
  onNavigate: (href: string) => void;
  onOpenExcluded: (proposalId: string, reason: string, label: string) => void;
}) {
  const lines = proposal ? proposal.lines : [];

  if (!lines.length) {
    return (
      <div>
        <div className="alert alert-light border">Aucune proposition en attente. Elle sera générée automatiquement cette nuit.</div>
      </div>
    );
  }

  const isSectorLevel = !selectedSector;
  const groups = isSectorLevel
    ? groupLines(lines, (l) => l.sector || l.department || 'Sans secteur')
    : groupLines(
        lines.filter((l) => (l.sector || l.department || 'Sans secteur') === selectedSector),
        (l) => l.department || 'Sans rayon',
      );

  const tiles = groups.map(([name, d]): [string, GroupData, string] => [
    name,
    d,
    isSectorLevel ? buildNavUrl(name, null) : buildNavUrl(selectedSector, name),
  ]);

  // ProposalOrder par nom de rayon (demande du 26/09/2026) : uniquement pertinent au niveau rayon,
  // jamais au niveau secteur (un secteur n'a pas de commande RPOS propre, seuls ses rayons en ont).
  const orderByDepartment = new Map((proposal?.orders || []).map((o) => [o.department, o]));

  return (
    <div>
      <DeptListContext proposal={proposal!} />
      <div className="reassort-dept-grid">
        {tiles.map(([name, d, href]) => (
          <DeptTile
            name={name}
            d={d}
            href={href}
            onNavigate={onNavigate}
            order={isSectorLevel ? undefined : orderByDepartment.get(name) || null}
            key={name}
          />
        ))}
        {proposal && (
          <RemainderTile proposal={proposal} rawGroups={groups} onOpenExcluded={(reason, label) => onOpenExcluded(proposal.id, reason, label)} />
        )}
      </div>
    </div>
  );
}

export { groupLines };
