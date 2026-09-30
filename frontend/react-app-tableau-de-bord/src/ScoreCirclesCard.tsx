// Cercles de score empilés (30/09/2026, maquette "GoodFood") — même esprit visuel que les 3
// cercles chevauchants de la maquette, appliqué à 3 taux déjà calculés sur cette page (Conformité,
// Rupture, Surstock) : pas de nouvel appel réseau, ces valeurs sont déjà chargées par
// TableauDeBord.tsx pour les cartes KPI existantes.
function ScoreCircle({
  label,
  value,
  color,
  style,
}: {
  label: string;
  value: string;
  color: string;
  style: React.CSSProperties;
}) {
  return (
    <div
      className="d-flex flex-column align-items-center justify-content-center text-center"
      style={{
        position: 'absolute',
        width: 108,
        height: 108,
        borderRadius: '50%',
        background: color,
        color: '#fff',
        ...style,
      }}
    >
      <span style={{ fontSize: '1.15rem', fontWeight: 700 }}>{value}</span>
      <span style={{ fontSize: '.68rem', opacity: 0.9 }}>{label}</span>
    </div>
  );
}

export function ScoreCirclesCard({
  conformity,
  stockout,
  overstock,
}: {
  conformity: string;
  stockout: string;
  overstock: string;
}) {
  return (
    <div className="card kpi-card kpi-card-chart h-100 mb-0">
      <div className="card-body">
        <h5 className="mb-3" style={{ color: '#1B2A4A', fontWeight: 600, fontSize: '.95rem' }}>
          Vue d'ensemble des taux
        </h5>
        <div className="text-muted small mb-3">Conformité, rupture et surstock sur les propositions validées</div>
        <div style={{ position: 'relative', height: 200 }}>
          <ScoreCircle label="Conformité" value={conformity} color="#1B2A4A" style={{ top: 10, left: '50%', transform: 'translateX(-50%)' }} />
          <ScoreCircle label="Rupture" value={stockout} color="#F5A623" style={{ bottom: 0, left: 30 }} />
          <ScoreCircle label="Surstock" value={overstock} color="#5B6B85" style={{ bottom: 0, right: 30 }} />
        </div>
      </div>
    </div>
  );
}
