// ApexCharts chargé en <script> classique dans index.html (bundle CDN, jamais importé comme
// dépendance npm ici — même pattern que react-app-purchase-order/ProductAnalyticsModal.tsx).
export {};

declare global {
  interface Window {
    ApexCharts: new (el: HTMLElement, options: Record<string, unknown>) => {
      render: () => void;
      destroy: () => void;
    };
  }
}
