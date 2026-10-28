import { JobDetailContent } from './JobDetailContent';

/** Détail d'un job affiché en fenêtre modale (demande explicite du 28/10/2026 : "pour les detail
 * fait une vue quand je clique je dois voir les detail sur une fenette") — même pattern que les
 * autres modales du projet (ex: WeeklyPlanHistoryModal.tsx) : overlay + backdrop séparé, pas de vraie
 * navigation, on reste sur le tableau de supervision en arrière-plan. Le contenu réel vit dans
 * JobDetailContent.tsx, partagé avec la page dédiée /jobs-admin/:jobName (JobDetailPage.tsx) qui
 * reste utile pour un lien direct partageable ou rechargeable. */
export function JobDetailModal({ jobName, label, onClose }: { jobName: string; label: string; onClose: () => void }) {
  return (
    <>
      <div className="modal fade show" style={{ display: 'block' }} tabIndex={-1} role="dialog">
        <div className="modal-dialog modal-dialog-centered modal-xl modal-dialog-scrollable" role="document">
          <div className="modal-content">
            <div className="modal-header">
              <h5 className="modal-title d-flex align-items-center gap-2">
                <iconify-icon icon="solar:checklist-minimalistic-bold-duotone" className="text-primary fs-24"></iconify-icon>
                <span>{label}</span>
              </h5>
              <button type="button" className="btn-close" onClick={onClose}></button>
            </div>
            <div className="modal-body">
              <JobDetailContent jobName={jobName} />
            </div>
          </div>
        </div>
      </div>
      <div className="modal-backdrop fade show"></div>
    </>
  );
}
