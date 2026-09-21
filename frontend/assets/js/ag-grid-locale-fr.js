// Traduction française des libellés AG Grid (menus de filtre, tri, pagination...), demande du
// 21/09/2026. AG Grid Community ne fournit pas de fichier de locale FR utilisable directement
// depuis le CDN pour la version épinglée de ce projet (ag-grid-community@33) : liste maintenue ici
// à la main plutôt que de dépendre d'un chemin CDN incertain d'un paquet séparé versionné à part
// (@ag-grid-community/locale, dont les chemins diffèrent déjà entre versions). Couvre les clés
// effectivement rencontrées dans l'UI (filtres texte/nombre, menu colonne, pagination) — complété
// au fil de l'eau si de nouvelles clés apparaissent sur d'autres pages.
window.AG_GRID_LOCALE_FR = {
  // Filtres génériques
  filterOoo: 'Filtrer...',
  equals: 'Égal à',
  notEqual: 'Différent de',
  blank: 'Vide',
  notBlank: 'Non vide',
  empty: 'Choisir une option',
  // Filtres texte
  contains: 'Contient',
  notContains: 'Ne contient pas',
  startsWith: 'Commence par',
  endsWith: 'Se termine par',
  // Filtres nombre
  lessThan: 'Inférieur à',
  greaterThan: 'Supérieur à',
  lessThanOrEqual: 'Inférieur ou égal à',
  greaterThanOrEqual: 'Supérieur ou égal à',
  inRange: 'Entre',
  inRangeStart: 'De',
  inRangeEnd: 'À',
  // Filtres date
  dateFormatOoo: 'jj/mm/aaaa',
  // Boutons de filtre
  applyFilter: 'Appliquer',
  resetFilter: 'Réinitialiser',
  clearFilter: 'Effacer',
  cancelFilter: 'Annuler',
  // Filtres combinés (ET/OU)
  andCondition: 'ET',
  orCondition: 'OU',
  // Menu colonne
  pinColumn: 'Épingler la colonne',
  pinLeft: 'Épingler à gauche',
  pinRight: 'Épingler à droite',
  noPin: 'Ne pas épingler',
  autosizeThiscolumn: 'Ajuster cette colonne',
  autosizeAllColumns: 'Ajuster toutes les colonnes',
  groupBy: 'Grouper par',
  ungroupBy: 'Dégrouper',
  resetColumns: 'Réinitialiser les colonnes',
  sortAscending: 'Tri croissant',
  sortDescending: 'Tri décroissant',
  sortUnSort: 'Annuler le tri',
  // Pagination
  page: 'Page',
  more: 'Plus',
  to: 'à',
  of: 'sur',
  next: 'Suivant',
  last: 'Dernier',
  first: 'Premier',
  previous: 'Précédent',
  pageSize: 'Taille de page',
  // Autres
  noRowsToShow: 'Aucune donnée à afficher',
  loadingOoo: 'Chargement...',
  searchOoo: 'Rechercher...',
  selectAll: 'Tout sélectionner',
  selectAllSearchResults: 'Sélectionner tous les résultats',
};
