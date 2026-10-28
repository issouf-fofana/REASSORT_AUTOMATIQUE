import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiFetch } from '../../shared/api/client';
import { JobDetailContent } from './JobDetailContent';

/** Page dédiée /jobs-admin/:jobName (28/10/2026 : contenu extrait dans JobDetailContent.tsx,
 * réutilisé aussi par JobDetailModal.tsx, ouverte depuis le tableau de bord sans navigation). Gardée
 * pour un lien direct partageable ou rechargeable vers le détail d'un job précis. */
export function JobDetailPage() {
  const { jobName } = useParams<{ jobName: string }>();
  // Le libellé lisible n'est connu qu'après le premier chargement côté JobDetailContent — un
  // léger appel séparé ici évite d'attendre ce chargement pour afficher un titre, et reste cohérent
  // si l'utilisateur arrive directement sur cette URL (lien partagé) sans être passé par le tableau.
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    if (!jobName) return;
    apiFetch<{ label: string }>(`/reassort/jobs-admin/${jobName}?page=1&pageSize=1`)
      .then((d) => setLabel(d.label))
      .catch(() => {});
  }, [jobName]);

  if (!jobName) return null;

  return (
    <div>
      <Link to="/jobs-admin" className="small text-decoration-none d-inline-flex align-items-center gap-1 mb-2">
        <iconify-icon icon="solar:arrow-left-bold-duotone"></iconify-icon> Retour à la supervision
      </Link>
      <h1 className="h3 mb-3">{label || jobName}</h1>
      <JobDetailContent jobName={jobName} />
    </div>
  );
}
