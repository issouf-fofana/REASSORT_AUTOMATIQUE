import type { Proposal, ProposalLine } from './types';

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

function accentColorFor(pct: number): string {
  if (pct >= 40) return '#3a3f47';
  if (pct >= 15) return '#6b7178';
  if (pct >= 5) return '#9ba1a8';
  return '#c9ccd1';
}

function DeptTile({ name, d, href }: { name: string; d: GroupData; href: string }) {
  const pctClamped = Math.max(0, Math.min(100, d.revenuePct));
  return (
    <div className="col-md-4 col-lg-3">
      <a href={href} className="card text-decoration-none h-100 reassort-dept-tile" style={{ '--tile-accent': accentColorFor(d.revenuePct) } as React.CSSProperties}>
        <div className="card-body">
          <h5 className="card-title mb-1">{name}</h5>
          <div className="text-muted small mb-2">{d.count} article(s)</div>
          <div className="tile-pct">
            {d.revenuePct.toFixed(1)}
            <span className="fs-14 fw-normal text-muted"> % CA</span>
          </div>
          <div className="tile-progress">
            <div className="tile-progress-fill" style={{ width: `${pctClamped}%` }}></div>
          </div>
          <div className="tile-revenue">{d.value.toLocaleString('fr-FR')} CFA proposé</div>
        </div>
      </a>
    </div>
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
    <div className="col-md-4 col-lg-3">
      <div className="card h-100 reassort-dept-tile" style={{ '--tile-accent': '#c9ccd1', borderStyle: 'dashed', opacity: 0.92 } as React.CSSProperties}>
        <div className="card-body">
          <h5 className="card-title mb-1 text-muted">Reste du CA magasin</h5>
          <div className="text-muted small mb-2">Non proposé ici (hors Pareto, stock négatif, déjà commandé, générique, etc.)</div>
          <div className="tile-pct text-secondary">
            {remainderPct.toFixed(1)}
            <span className="fs-14 fw-normal text-muted"> % CA</span>
          </div>
          <div className="tile-progress">
            <div className="tile-progress-fill" style={{ width: `${remainderPctClamped}%` }}></div>
          </div>
          {remainderValue !== null && <div className="tile-revenue">{remainderValue.toLocaleString('fr-FR')} CFA</div>}
          {items.length > 0 && (
            <ul className="text-muted small mb-0 ps-3 mt-1" style={{ position: 'relative', zIndex: 5 }}>
              {items.map(([reason, label, count]) => (
                <li key={reason} style={{ pointerEvents: 'auto' }}>
                  <a
                    href="#"
                    style={{ position: 'relative', zIndex: 10, cursor: 'pointer', pointerEvents: 'auto', textDecoration: 'underline' }}
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
    </div>
  );
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('fr-FR');
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

  const showCoverageWarning = proposal.coverageGapDays && proposal.coverageGapDays > 1 && proposal.actualDataStart;

  return (
    <div className="alert alert-light border small mb-3">
      <strong>Période d'analyse configurée (Pareto) :</strong> {periodLabel} &nbsp;•&nbsp;{' '}
      <strong>CA magasin sur une période DIFFÉRENTE{revenuePeriodLabel} :</strong> {revenueLabel}{' '}
      <span className="text-muted">
        — sert uniquement à calculer le % CA de chaque article, pas à représenter le CA sur la période d'analyse ci-dessus
      </span>
      {showCoverageWarning && (
        <div className="alert alert-warning small mt-2 mb-0">
          <strong>
            <iconify-icon icon="solar:danger-triangle-bold-duotone"></iconify-icon> Données incomplètes :
          </strong>{' '}
          cette génération demandait des ventes depuis le {fmtDate(proposal.analysisPeriodStart!)}, mais les données
          réellement disponibles ne remontent qu'au <strong>{fmtDate(proposal.actualDataStart!)}</strong> (jusqu'au{' '}
          {fmtDate(proposal.actualDataEnd || proposal.analysisPeriodEnd!)}) — soit {proposal.coverageGapDays} jour(s)
          manquant(s). Le calcul (Pareto, quantités proposées) porte donc sur une période plus courte que celle
          affichée ci-dessus. Lancez un backfill (Paramètres &gt; Fichiers de ventes) pour combler ce manque avant de
          vous fier pleinement à cette proposition.
        </div>
      )}
    </div>
  );
}

export function DepartmentListView({
  proposal,
  selectedSector,
  buildNavUrl,
  onOpenExcluded,
}: {
  proposal: Proposal | null;
  selectedSector: string | null;
  buildNavUrl: (sector: string | null, dept: string | null) => string;
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

  return (
    <div>
      <DeptListContext proposal={proposal!} />
      <div className="row g-3">
        {tiles.map(([name, d, href]) => (
          <DeptTile name={name} d={d} href={href} key={name} />
        ))}
        {proposal && (
          <RemainderTile proposal={proposal} rawGroups={groups} onOpenExcluded={(reason, label) => onOpenExcluded(proposal.id, reason, label)} />
        )}
      </div>
    </div>
  );
}

export { groupLines };
