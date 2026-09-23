// Enregistrement des modules AG Grid Community (bug corrigé le 21/09/2026 : sans cet appel, les
// fonctionnalités "avancées" de la version Community — dont le regroupement de lignes rowGroup/
// groupDisplayType utilisé par "Grouper par rayon" sur Ventes synchronisées — sont silencieusement
// ignorées, sans erreur console, ce qui donnait l'impression que la case à cocher ne faisait rien.
// Depuis AG Grid v31+, TOUTES les fonctionnalités (même Community) sont modulaires et doivent être
// enregistrées explicitement avant le premier appel à agGrid.createGrid(). AllCommunityModule
// regroupe tous les modules Community en un seul repère simple, sans avoir à lister chaque module
// (tri, filtre, pagination, regroupement de lignes...) un par un.
agGrid.ModuleRegistry.registerModules([agGrid.AllCommunityModule]);

// Thème AG Grid centralisé (migration vers la Theming API v33, demande du 23/09/2026 — remplace le
// thème CSS classique ag-theme-quartz.css + variables --ag-* utilisé jusqu'ici sur chaque page).
// Reprend EXACTEMENT les mêmes valeurs que l'ancien thème CSS de purchase-order.html (page pilote
// déjà validée visuellement), pour ne rien changer à l'apparence — seul le mécanisme change.
// Un thème CSS classique et la Theming API ne doivent JAMAIS coexister sur la même grille (conflit
// silencieux) : les pages migrées ici ne doivent plus charger ag-theme-quartz.css ni poser la classe
// ag-theme-quartz sur leur conteneur — le thème est fourni par grille via `theme: window.REASSORT_AG_GRID_THEME`
// dans les options passées à agGrid.createGrid().
window.REASSORT_AG_GRID_THEME = agGrid.themeQuartz.withParams({
  fontFamily: { googleFont: 'Inter' },
  fontSize: 14,
  accentColor: '#1F2937',
  rowHoverColor: 'rgba(17, 24, 39, 0.075)',
  selectedRowBackgroundColor: 'rgba(17, 24, 39, 0.1)',
  headerBackgroundColor: '#f8f9fa',
  headerTextColor: '#1a1a1a',
  headerColumnResizeHandleColor: '#E5E7EB',
  borderColor: '#E5E7EB',
  rowBorder: { color: '#E5E7EB' },
  wrapperBorderRadius: 0,
  borderRadius: 0,
  // équivalent de l'ancien --ag-cell-horizontal-border: transparent (masque le séparateur vertical
  // entre colonnes, gardé uniquement entre lignes via rowBorder ci-dessus).
  columnBorder: false,
  inputFocusBorder: { color: '#1F2937' },
  checkboxCheckedBackgroundColor: '#1F2937',
  rangeSelectionBorderColor: '#1F2937',
  foregroundColor: '#374151',
  cellTextColor: '#374151',
  rowHeight: 68,
  headerHeight: 40,
  // Reproduit .table thead th de volt.css (0.75rem, weight 600) : AG Grid utilise fontSize/14px pour
  // tout par défaut, y compris l'en-tête — distingué ici. text-transform/letter-spacing n'ont pas
  // d'équivalent Theming API, restent en CSS ciblé sur .ag-header-cell-text (cf. purchase-order.html).
  headerFontSize: 12,
  headerFontWeight: 600,
  dataFontSize: 14,
});

// Variante utilisée par ai-predictions.html (palette légèrement plus douce que l'autre grille : gris
// clairs #f3f4f6/#dee2e6/#eef0f2 au lieu de #E5E7EB) — reprend EXACTEMENT les anciennes valeurs
// --ag-* de cette page, jamais unifiée avec REASSORT_AG_GRID_THEME pour ne pas changer son apparence
// sans qu'on l'ait demandé.
window.REASSORT_AG_GRID_THEME_SOFT = agGrid.themeQuartz.withParams({
  fontFamily: { googleFont: 'Inter' },
  fontSize: 13.5,
  accentColor: '#1F2937',
  selectedRowBackgroundColor: '#f3f4f6',
  rowHoverColor: '#f8f9fa',
  headerBackgroundColor: '#f8f9fa',
  headerTextColor: '#1a1a1a',
  headerColumnResizeHandleColor: '#dee2e6',
  borderColor: '#dee2e6',
  rowBorder: { color: '#eef0f2' },
  columnBorder: { color: '#eef0f2' },
  inputFocusBorder: { color: '#1F2937' },
  checkboxCheckedBackgroundColor: '#1F2937',
  rangeSelectionBorderColor: '#1F2937',
  wrapperBorderRadius: 0,
  borderRadius: 0,
});
