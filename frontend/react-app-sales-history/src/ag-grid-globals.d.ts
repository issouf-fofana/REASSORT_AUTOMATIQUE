// Déclarations pour les globaux AG Grid chargés en <script> classique dans index.html (bundle CDN +
// assets/js/ag-grid-setup.js/ag-grid-locale-fr.js/ag-grid-toolbar.js) — délibérément typés `any`,
// comme le code vanilla de sales-history.old.html qu'ils reproduisent : AG Grid n'est jamais
// importé comme dépendance npm ici (pas de package ag-grid-react), donc pas de vrais types
// disponibles sans ajouter une dépendance uniquement pour le typage.
export {};

declare global {
  interface Window {
    agGrid: {
      createGrid: (el: HTMLElement, options: any) => any;
    };
    REASSORT_AG_GRID_THEME_SOFT: unknown;
    AG_GRID_LOCALE_FR: Record<string, string>;
    reassortAgGridToolbar: (gridApi: any, containerEl: HTMLElement) => void;
    reassortMakeShopPickerSearchable?: (select: HTMLSelectElement) => void;
  }
}
