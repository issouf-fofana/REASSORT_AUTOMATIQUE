// Forme exacte renvoyée par GET /reassort/proposal/analyze/detail (backend proposalService.js,
// fonction analyzeSales + computeParetoFromLines) — une analyse volontaire, indépendante de toute
// génération de proposition (demande du 05/10/2026).

export interface AnalysisArticle {
  code: string;
  label: string;
  avg_weekly_quantity: number;
  forecast_method: string;
  cumulative_pct: number;
  daily_history: { date: string; quantity: number }[];
  weekday_factors: number[];
  ca_ht_on_period: number;
}

export interface SalesAnalysisDetail {
  articles: AnalysisArticle[];
  totalArticlesWithSales: number;
  period: { start: string; end: string };
  periodDays: number;
  actualDataStart: string | null;
  actualDataEnd: string | null;
  coverageGapDays: number | null;
  shopTotalRevenue: number;
  shopTotalRevenueInclTax: number | null;
  salesSource: string;
  analyzedAt: string;
}
