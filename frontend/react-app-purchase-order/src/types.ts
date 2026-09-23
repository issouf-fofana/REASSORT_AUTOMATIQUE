export interface Shop {
  id: string;
  posId: string;
  reference: string;
  name: string;
  posLabel?: string;
}

export interface OrderAnomaly {
  direction: 'HIGH' | 'LOW';
  historicalMin: number;
  historicalMax: number;
  historicalMean: number;
  sampleSize: number;
}

export interface ProposalLine {
  id: string;
  ean: string;
  label: string;
  productId: string;
  sellingPrice: number | null;
  quantitySuggested: number;
  orderingUnit: number | null;
  department: string | null;
  sector: string | null;
  revenueSharePct: number | null;
  avgWeeklySales: number | null;
  seasonalityAdjusted?: boolean;
  seasonalityDeviationPct?: number | null;
  forecastMethod?: string;
  weekdayAdjusted?: boolean;
  stockAtGeneration: number | null;
  hadNegativeStock?: boolean;
  actualStock?: number | null;
  dlvStock?: number | null;
  daysUntilStockout: number | null;
  excludedAsAlreadyOrdered?: boolean;
  quantityInTransit?: number;
  platformOrderReference?: string | null;
  platformOrderDate?: string | null;
  excludedAsAlreadyOrderedRpos?: boolean;
  rposOrderDate?: string | null;
  rposOrderReference?: string | null;
  rposOrderCount?: number;
  rposOrderStatus?: number;
  quantityIfUnblocked?: number;
  orderAnomaly?: OrderAnomaly | null;
  orderSufficiencyReasoning?: string | null;
  orderSufficient?: boolean | null;
  aiAdjusted?: boolean;
  aiReasoning?: string | null;
  classicQuantitySuggested?: number | null;
  wasExcluded?: boolean;
}

export interface Proposal {
  id: string;
  status: string;
  generatedAt: string;
  weeklyPlanId?: string | null;
  shopTotalRevenue?: number | null;
  shopTotalRevenueInclTax?: number | null;
  revenueShareStart?: string | null;
  revenueShareEnd?: string | null;
  analysisPeriodStart?: string | null;
  analysisPeriodEnd?: string | null;
  coverageGapDays?: number | null;
  actualDataStart?: string | null;
  actualDataEnd?: string | null;
  lines: ProposalLine[];
  skippedGenericArticle?: number;
  skippedNegativeStock?: number;
  skippedAlreadyOrdered?: number;
  skippedNotOrderable?: number;
  skippedNotFound?: number;
}

export interface ProposalHistoryItem {
  id: string;
  generatedAt: string;
  status: string;
}

export interface LineState {
  quantity: number;
  excluded: boolean;
}
