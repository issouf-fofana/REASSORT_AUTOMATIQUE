// Pagination client simple (30/09/2026, tableau "Performance par magasin" trop long à faire
// défiler avec 53 magasins) — même pattern que react-app-ai-quality/src/components/ui/Pagination.tsx,
// dupliqué ici car chaque app React a son propre bundle, pas de partage direct entre elles.
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
      <button type="button" className="btn btn-sm reassort-btn-navy-outline" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        Précédent
      </button>
      <span className="small text-muted">
        Page {page} / {pageCount}
      </span>
      <button type="button" className="btn btn-sm reassort-btn-navy-outline" disabled={page >= pageCount} onClick={() => onChange(page + 1)}>
        Suivant
      </button>
    </div>
  );
}
