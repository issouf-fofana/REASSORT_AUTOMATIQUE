import { useEffect, useRef } from 'react';
import { FormulaInfoButton } from './StockoutEpisodePage';

// Répartition des ruptures par cause probable (demande du 16/10/2026) — reçoit causeCounts déjà
// calculé côté backend (cf. stockoutEpisodeService.js), pas de second appel API, juste la
// visualisation en camembert de données déjà chargées par le parent.
// AMONT_FOURNISSEUR_CENTRAL / AMONT_FOURNISSEUR_EXTERNE ajoutés le 21/10/2026 (demande explicite :
// "Amont — ca viens de founisseur central ou du fournisseur externe") — cf. StockoutShopDetail.tsx.
const CAUSE_LABELS: Record<string, string> = {
  MAGASIN_REASSORT: 'Magasin / réassort',
  MAGASIN_COMMANDE_NON_VALIDEE: 'Commande non validée',
  AMONT_FOURNISSEUR_CENTRAL: 'Amont — fournisseur central',
  AMONT_FOURNISSEUR_EXTERNE: 'Amont — fournisseur externe',
  AMONT_A_PRECISER: 'Amont — à préciser',
  ECART_STOCK_RAYON: 'Écart stock / rayon',
  INDETERMINEE: 'Indéterminée',
};

const CAUSE_COLORS: Record<string, string> = {
  MAGASIN_REASSORT: '#F5A623',
  MAGASIN_COMMANDE_NON_VALIDEE: '#E0574C',
  AMONT_FOURNISSEUR_CENTRAL: '#5B6B85',
  AMONT_FOURNISSEUR_EXTERNE: '#7C6B9E',
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
  AMONT_FOURNISSEUR_CENTRAL: "Une commande a été passée vers l'entrepôt central (livraison centrale), mais sa réception n'est pas encore confirmée — le blocage se situe en amont du magasin, pas une absence de réaction locale.",
  AMONT_FOURNISSEUR_EXTERNE: "Une commande a été passée vers un fournisseur externe (livraison directe), mais sa réception n'est pas encore confirmée — le blocage se situe en amont du magasin, pas une absence de réaction locale.",
  AMONT_A_PRECISER: "Une commande a été passée et transmise à l'entrepôt, mais sa réception n'est pas encore confirmée — le blocage se situe en amont du magasin (entrepôt/fournisseur, type non précisé), pas une absence de réaction locale.",
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
            {/* RÉÉCRIT le 19/10/2026 (demande explicite : "la legend sous le graphique le texte est
                trop diminu ou fait comme pour les formule la un petit truc pop up pour affiché") —
                remplace le bloc de texte dense (une phrase d'explication par cause, en tout petit)
                par une liste compacte de puces (couleur + libellé + compte, lisible d'un coup
                d'œil), chaque explication détaillée n'étant plus affichée qu'à la demande via le
                même bouton ⓘ que les formules de calcul (FormulaInfoButton, StockoutEpisodePage.tsx). */}
            <div className="d-flex align-items-center gap-1 mt-3 mb-1">
              <div className="text-muted" style={{ fontSize: '.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.03em' }}>
                Détail par cause
              </div>
              <FormulaInfoButton
                title="Détail par cause de rupture"
                steps={entries
                  .sort(([, a], [, b]) => b - a)
                  .map(([cause, count]) => ({
                    label: `${CAUSE_LABELS[cause] || cause} (${count})`,
                    detail: CAUSE_EXPLANATIONS[cause] || 'Cause non documentée.',
                  }))}
              />
            </div>
            <div className="d-flex flex-wrap gap-2">
              {entries
                .sort(([, a], [, b]) => b - a)
                .map(([cause, count]) => (
                  <div key={cause} className="d-flex align-items-center gap-1" style={{ fontSize: '.78rem', color: '#2A2F45' }}>
                    <span style={{ width: 9, height: 9, borderRadius: '50%', background: CAUSE_COLORS[cause] || '#A0A8B8', flexShrink: 0 }}></span>
                    <span>{CAUSE_LABELS[cause] || cause} ({count})</span>
                  </div>
                ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
