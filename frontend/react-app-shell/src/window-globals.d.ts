// Déclarations pour les globaux chargés en <script> classique dans index.html du shell (AG Grid
// CDN + assets/js/ag-grid-setup.js/ag-grid-toolbar.js/global-shop-selector.js/
// ai-recommendation-panel.js), réunies ici car plusieurs pages migrées (sales-analysis,
// ai-predictions, users-list) en dépendent toutes — reprend tel quel le contenu des
// ag-grid-globals.d.ts dispersés dans les anciens projets react-app-*.
export {};

declare global {
  interface Window {
    agGrid: {
      createGrid: (el: HTMLElement, options: any) => any;
    };
    REASSORT_AG_GRID_THEME_SOFT: { withParams: (params: Record<string, unknown>) => unknown };
    REASSORT_AG_GRID_THEME: { withParams: (params: Record<string, unknown>) => unknown };
    AG_GRID_LOCALE_FR: Record<string, string>;
    reassortAgGridToolbar: (gridApi: any, containerEl: HTMLElement) => void;
    reassortMakeShopPickerSearchable?: (select: HTMLSelectElement) => void;
    reassortGetActiveShop: () => { id: string; reference: string; name: string; posId?: string; posLabel?: string } | null;
    reassortOnActiveShopChange: (cb: (shop: { id: string; reference: string; name: string; posId?: string; posLabel?: string } | null) => void) => void;
    reassortSetActiveShop: (shop: { id: string; reference: string; name: string; posId?: string; posLabel?: string } | null) => void;
    reassortRenderShopSelector?: () => void;
    reassortReportError?: (message: string, stack?: string) => void;
    openAiRecommendationPanel?: (item: Record<string, unknown>) => void;
    hideLoadingOverlay?: () => void;
    // ApexCharts (CDN, /purchase-order uniquement) : typé `any` comme AG Grid ci-dessus — jamais
    // importé comme dépendance npm, pas de vrais types sans ajouter une dépendance uniquement pour
    // le typage.
    ApexCharts: new (el: HTMLElement, options: any) => { render: () => void; destroy: () => void; updateOptions: (options: any) => void };
  }
}
