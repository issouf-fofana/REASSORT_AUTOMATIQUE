// Pagination client simple pour les onglets qui rendent des cartes HTML (pas AG Grid, qui a déjà
// sa propre pagination native) — demande du 29/09/2026 : ImprovementsTab/CorrectionsTab affichaient
// jusqu'à 200 lignes d'un coup, sans découpage, rendant la page très longue à faire défiler.
export function Pagination({
  page,
  pageCount,
  onChange,
}: {
  page: number;
  pageCount: number;
  onChange: (page: number) => void;
}) {
  if (pageCount <= 1) return null;
  return (
    <div className="d-flex justify-content-center align-items-center gap-2 my-3">
      <button type="button" className="btn btn-sm btn-outline-dark" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        Précédent
      </button>
      <span className="small text-muted">
        Page {page} / {pageCount}
      </span>
      <button type="button" className="btn btn-sm btn-outline-dark" disabled={page >= pageCount} onClick={() => onChange(page + 1)}>
        Suivant
      </button>
    </div>
  );
}
