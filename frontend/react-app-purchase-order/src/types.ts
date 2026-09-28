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
  // Commandabilité fournisseur (spec du 28/09/2026, §1-§2) : null = proposition générée avant ce
  // champ (jamais traité comme "non commandable" par défaut, cf. proposalService.js), true/false
  // calculé à la génération depuis le rattachement au fournisseur central RPOS.
  supplierIneligible?: boolean | null;
  currentSuppliers?: string | null;
  // Déjà persistés côté backend depuis longtemps, jamais exposés au frontend avant le 28/09/2026
  // (spec "informations détaillées dans une proposition de commande", §2) :
  // - currentOrderedQuantity : quantité déjà commandée/en transit au moment du calcul (RPOS + cette
  //   plateforme cumulés, cf. proposalService.js orderedQty) — nécessaire pour comprendre pourquoi
  //   une quantité proposée n'est pas simplement "vente moyenne - stock".
  // - cumulativePct : cumul Pareto de cet article sur la PÉRIODE D'ANALYSE (à ne jamais confondre
  //   avec revenueSharePct, calculé sur la fenêtre courte revenueShareStart/End — deux dénominateurs
  //   différents, cf. ProposalTable.tsx et DepartmentListView.tsx).
  currentOrderedQuantity?: number | null;
  cumulativePct?: number | null;
  // CA HT réel de l'article sur TOUTE la période d'analyse (nouveau champ backend, ajouté avec le
  // même correctif) — distinct de revenueSharePct (fenêtre courte), jamais à confondre.
  caHtOnPeriod?: number | null;
  // Statut de couverture à 4 niveaux (spec du 28/09/2026 §3) : SUFFISANT | PARTIELLEMENT_SUFFISANT |
  // INSUFFISANT | NON_DETERMINABLE — distinct de orderSufficient (binaire, ci-dessus), calculé une
  // seule fois par proposalService.computeCoverageStatus et réutilisé à l'identique par le panneau
  // d'analyse statique par article (aiForecastService.buildStaticArticleAnalysis).
  coverageStatus?: string | null;
  coverageStatusReason?: string | null;
}

// Commande RPOS déjà créée pour un rayon précis (demande du 26/09/2026 : validation indépendante
// par rayon) — une proposition peut avoir 0 à N ProposalOrder, un par rayon déjà validé, sans que
// ça change son status global tant que tous les rayons ne sont pas traités.
export interface ProposalOrder {
  id: string;
  department: string;
  rposOrderId: string | null;
  rposOrderReference: string | null;
  rposOrderValidated: boolean | null;
  linesTotal: number;
  linesFailed: number;
  status: string; // PENDING | DONE | FAILED | CANCELLED
  errorMessage: string | null;
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
  analysisPeriodMode?: string | null;
  coverageGapDays?: number | null;
  actualDataStart?: string | null;
  actualDataEnd?: string | null;
  paretoThresholdUsed?: number | null;
  rposShopReference?: string;
  rposShopName?: string;
  lines: ProposalLine[];
  orders?: ProposalOrder[];
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
