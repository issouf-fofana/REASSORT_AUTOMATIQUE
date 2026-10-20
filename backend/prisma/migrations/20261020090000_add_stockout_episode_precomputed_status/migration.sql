-- Précalcul du statut dynamique des ruptures (demande explicite du 20/10/2026 : "il ne calcule ps
-- a meme temps et il doit avoir un syste de calcul deja fais en base... le but est d'optimisé") —
-- hasOrder/reactionStatus/deliveryStatus/orderCreatedAt étaient recalculés EN DIRECT à chaque
-- chargement de la page Ruptures (getOpenEpisodes). Stockés désormais, maintenus par un job
-- planifié fréquent + des hooks sur événements connus (commande validée, arrivage détecté).
ALTER TABLE "stockout_episodes" ADD COLUMN "has_order" BOOLEAN;
ALTER TABLE "stockout_episodes" ADD COLUMN "reaction_status" TEXT;
ALTER TABLE "stockout_episodes" ADD COLUMN "delivery_status" TEXT;
ALTER TABLE "stockout_episodes" ADD COLUMN "order_created_at" TIMESTAMP(3);
ALTER TABLE "stockout_episodes" ADD COLUMN "actual_reception_date_status" TIMESTAMP(3);
ALTER TABLE "stockout_episodes" ADD COLUMN "status_computed_at" TIMESTAMP(3);
