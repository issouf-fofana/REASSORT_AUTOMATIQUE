-- Jour de livraison des commandes de week-end (LUNDI ou MARDI), propre à chaque magasin.
ALTER TABLE "reassort_configs" ADD COLUMN "weekend_delivery_day" TEXT NOT NULL DEFAULT 'LUNDI';
