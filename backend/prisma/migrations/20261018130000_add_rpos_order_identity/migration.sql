-- Identité RPOS de la commande (créée/validée par qui, quand) — stockée au lieu d'un appel RPOS
-- en direct à chaque lecture de la fiche détail d'un épisode de rupture.
ALTER TABLE "proposal_orders" ADD COLUMN "rpos_created_by" TEXT;
ALTER TABLE "proposal_orders" ADD COLUMN "rpos_validated_by" TEXT;
ALTER TABLE "proposal_orders" ADD COLUMN "rpos_validation_date" TIMESTAMP(3);
