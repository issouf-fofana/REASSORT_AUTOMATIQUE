// Enregistrement des modules AG Grid Community (bug corrigé le 21/09/2026 : sans cet appel, les
// fonctionnalités "avancées" de la version Community — dont le regroupement de lignes rowGroup/
// groupDisplayType utilisé par "Grouper par rayon" sur Ventes synchronisées — sont silencieusement
// ignorées, sans erreur console, ce qui donnait l'impression que la case à cocher ne faisait rien.
// Depuis AG Grid v31+, TOUTES les fonctionnalités (même Community) sont modulaires et doivent être
// enregistrées explicitement avant le premier appel à agGrid.createGrid(). AllCommunityModule
// regroupe tous les modules Community en un seul repère simple, sans avoir à lister chaque module
// (tri, filtre, pagination, regroupement de lignes...) un par un.
agGrid.ModuleRegistry.registerModules([agGrid.AllCommunityModule]);
