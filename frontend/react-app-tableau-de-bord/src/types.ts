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
