export interface Shop {
  id: string;
  posId: string;
  reference: string;
  name: string;
  posLabel?: string;
}

export interface PendingProposal {
  lines: unknown[];
  generatedAt: string;
}

export interface ConformityRate {
  rate: number | null;
  unchangedLines: number;
  totalLines: number;
}

export interface StockoutRate {
  rate: number | null;
  stockoutLines: number;
  totalLines: number;
}

export interface OverstockRate {
  rate: number | null;
  overstockLines: number;
  totalLines: number;
}

export interface ForecastAccuracy {
  rate: number | null;
  accurateLines: number;
  evaluatedLines: number;
  windowDays: number;
  thresholdPct: number;
}

export interface SupplierOrder {
  reference: string;
  external_reference: string | null;
  date: string;
  status_display: string;
}

export interface WeeklyConformityPoint {
  weekStart: string;
  rate: number | null;
  totalLines: number;
}

// Top articles par CA réel (30/09/2026, Tableau de bord) — GET /reassort/top-articles.
export interface TopArticle {
  ean: string;
  label: string;
  revenue: number;
  revenueSharePct: number;
}

// Vue "Tous les magasins" (fusion de l'ancienne page Vue globale, 30/09/2026).
export interface PerShopRow {
  rposShopReference?: string;
  rposShopName?: string;
  rposPosId?: string;
  pendingProposals: number;
  validatedProposals: number;
  conformityRate: number | null;
  rejectionRate: number | null;
  stockoutRate: number | null;
  overstockRate: number | null;
  forecastMAE: number | null;
  lastValidatedAt: string | null;
}

export interface Improvement {
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
  title: string;
  scope: string;
  status: string;
}

export interface AdminDashboardData {
  totalShops: number;
  totalPendingProposals: number;
  shopsWithPendingProposal: number;
  totalValidatedProposals: number;
  stockoutAlertThreshold: number;
  globalStockoutRate: number | null;
  globalOverstockRate: number | null;
  globalConformityRate: number | null;
  globalAcceptanceRate: number | null;
  globalModificationRate: number | null;
  globalRejectionRate: number | null;
  globalForecastMAE: number | null;
  globalForecastEvaluatedCount: number;
  globalForecastBias: number | null;
  globalForecastWAPE: number | null;
  aiShadowConfidenceRate: number | null;
  aiShadowCorrectedLines: number;
  aiShadowAiRightLines: number;
  perShop: PerShopRow[];
  openImprovements: Improvement[];
}
