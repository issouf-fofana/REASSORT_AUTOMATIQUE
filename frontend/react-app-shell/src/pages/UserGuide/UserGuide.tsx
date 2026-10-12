// Version MINIMALE de la page Guide d'utilisation pour la première étape du socle (cf. plan de
// migration, 12/10/2026) — l'objectif de cette étape est de valider l'ARCHITECTURE (auth, routeur,
// layout, coexistence nginx), pas de porter fidèlement le contenu complet des 343 lignes de
// react-app-user-guide/src/UserGuide.tsx. Le vrai portage du contenu aura lieu au point 8 du plan
// (bascule réelle de /user-guide vers la SPA), une fois cette première validation confirmée.
export function UserGuide() {
  return (
    <div className="card">
      <div className="card-body">
        <h2 className="h4 mb-3">Guide d'utilisation</h2>
        <p className="text-muted">
          Page de test du socle de la nouvelle application unique (SPA) — confirme que
          l'authentification, la navigation et le routage interne fonctionnent, avant de porter le
          contenu réel de cette page et de migrer les suivantes.
        </p>
      </div>
    </div>
  );
}
