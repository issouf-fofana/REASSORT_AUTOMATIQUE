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
  // Explication automatique basée sur la tendance de vente récente (amelioration.md §7) — distincte
  // de contextNote (note humaine) : calculée par le système, jamais un verdict, juste un indice.
  trendContext: string | null;
  // Détail des commandes validées ayant servi au calcul (demande du 05/10/2026), le plus récent
  // en premier — instantané figé au moment de la détection, peut différer de l'historique actuel.
  historyDetail: { quantity: number; generatedAt: string; orderReference: string | null }[] | null;
}
