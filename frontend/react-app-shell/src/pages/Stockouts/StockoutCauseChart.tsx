import { useEffect, useRef } from 'react';

// Répartition des ruptures par cause probable (demande du 16/10/2026) — reçoit causeCounts déjà
// calculé côté backend (cf. stockoutEpisodeService.js), pas de second appel API, juste la
// visualisation en camembert de données déjà chargées par le parent.
const CAUSE_LABELS: Record<string, string> = {
  MAGASIN_REASSORT: 'Magasin / réassort',
  MAGASIN_COMMANDE_NON_VALIDEE: 'Commande non validée',
  AMONT_A_PRECISER: 'Amont — à préciser',
  ECART_STOCK_RAYON: 'Écart stock / rayon',
  INDETERMINEE: 'Indéterminée',
};

const CAUSE_COLORS: Record<string, string> = {
  MAGASIN_REASSORT: '#F5A623',
  MAGASIN_COMMANDE_NON_VALIDEE: '#E0574C',
  AMONT_A_PRECISER: '#5B6B85',
  ECART_STOCK_RAYON: '#4A90D9',
  INDETERMINEE: '#A0A8B8',
};

// Légende explicative ajoutée le 19/10/2026 (demande explicite : "il faut affiche plus explicatif
// si on doit affiché quelque chose de pertinant") — "Répartition par cause probable" affiche parfois
// 100% sur une seule cause (ex: beaucoup de ruptures très récentes, aucune n'a encore de commande
// passée dessus) sans que le libellé seul explique pourquoi c'est normal ni ce que chaque cause
// signifie concrètement.
const CAUSE_EXPLANATIONS: Record<string, string> = {
  MAGASIN_REASSORT: "Aucune commande n'a encore été passée sur l'article depuis le début de la rupture — cause la plus fréquente sur des ruptures récentes, avant que le magasin ait eu le temps de réagir.",
  MAGASIN_COMMANDE_NON_VALIDEE: 'Une commande existe mais ne porte pas encore cette référence — proposition générée mais pas encore validée.',
  AMONT_A_PRECISER: "Une commande a été passée et transmise à l'entrepôt, mais sa réception n'est pas encore confirmée — le blocage se situe en amont du magasin (entrepôt/fournisseur), pas une absence de réaction locale.",
  ECART_STOCK_RAYON: 'Une commande est déclarée reçue par le système, mais le stock reste en rupture — signe probable de désynchronisation entre le stock informatique et la réalité du rayon.',
  INDETERMINEE: "Impossible de déterminer la cause avec les informations disponibles — aucune commande récente trouvée pour cet article.",
};

// Groupe "avec commande" vs "sans commande" (demande explicite du 19/10/2026 : "ou c'est rupture
// des article commmander et non commadé ?") — le donut affiche désormais ce ratio à 2 parts, plus
// lisible d'un coup d'œil que 5 causes détaillées dans un même camembert ; le détail des 5 causes
// reste disponible dans la légende textuelle en dessous.
const NO_ORDER_CAUSES = new Set(['MAGASIN_REASSORT', 'INDETERMINEE']);

export function StockoutCauseChart({ causeCounts }: { causeCounts: Record<string, number> }) {
  const chartRef = useRef<HTMLDivElement>(null);

  const entries = Object.entries(causeCounts || {}).filter(([, count]) => count > 0);
  const withoutOrder = entries.filter(([cause]) => NO_ORDER_CAUSES.has(cause)).reduce((s, [, c]) => s + c, 0);
  const withOrder = entries.filter(([cause]) => !NO_ORDER_CAUSES.has(cause)).reduce((s, [, c]) => s + c, 0);

  useEffect(() => {
    if (!entries.length || !chartRef.current || !window.ApexCharts) return;
    const labels = ['Sans commande', 'Avec commande'];
    const values = [withoutOrder, withOrder];
    const colors = ['#E0574C', '#4A90D9'];

    const chart = new window.ApexCharts(chartRef.current, {
      chart: { type: 'donut', height: 280 },
      series: values,
      labels,
      colors,
      legend: { position: 'bottom', fontSize: '12px' },
      dataLabels: { enabled: true, formatter: (v: number) => `${Math.round(v)}%` },
      tooltip: { y: { formatter: (v: number) => `${v} rupture(s)` } },
    });

    chart.render();
    return () => { chart.destroy(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [withoutOrder, withOrder]);

  return (
    <div className="card h-100">
      <div className="card-body">
        <h5 className="mb-3" style={{ color: '#1B2A4A', fontWeight: 600, fontSize: '.95rem' }}>
          Ruptures avec ou sans commande en cours
        </h5>
        {entries.length === 0 ? (
          <div className="text-muted small">Aucune rupture en cours.</div>
        ) : (
          <>
            <div ref={chartRef}></div>
            <div className="text-muted" style={{ fontSize: '.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.03em', marginTop: 4 }}>Détail par cause</div>
            <div className="mt-2" style={{ fontSize: '.74rem', color: '#5B6B85', lineHeight: 1.55 }}>
              {entries
                .sort(([, a], [, b]) => b - a)
                .map(([cause, count]) => (
                  <div key={cause} className="d-flex gap-2 mb-1">
                    <span style={{ width: 9, height: 9, borderRadius: '50%', background: CAUSE_COLORS[cause] || '#A0A8B8', flexShrink: 0, marginTop: 4 }}></span>
                    <span><strong style={{ color: '#1B2A4A' }}>{CAUSE_LABELS[cause] || cause}</strong> ({count}) — {CAUSE_EXPLANATIONS[cause] || 'Cause non documentée.'}</span>
                  </div>
                ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
