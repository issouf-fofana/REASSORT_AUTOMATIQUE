export interface OrderAnomaly {
  id: string;
  direction: 'HIGH' | 'LOW';
  status: 'PENDING' | 'ACKNOWLEDGED' | 'DISMISSED';
  detectedAt: string;
  label: string | null;
  ean: string;
  shopReference: string | null;
  shopName: string | null;
  rposShopId: string;
  newQuantity: number;
  historicalMin: number;
  historicalMax: number;
  historicalMean: number;
  sampleSize: number;
  contextNote: string | null;
}
