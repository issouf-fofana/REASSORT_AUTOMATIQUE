-- AlterTable
ALTER TABLE "users" ADD COLUMN     "assigned_department" TEXT;
ALTER TABLE "users" ADD COLUMN     "ai_permissions_json" TEXT;

-- Le défaut du champ "role" change de "STORE" à "DIRECTOR" (nouvelle hiérarchie) : les comptes
-- STORE déjà existants sont migrés explicitement ici plutôt que de rester sur une valeur qui ne
-- fait plus partie du système de rôles supporté par le code (plan validé le 15/09/2026 : "les STORE
-- actuels basculent en DIRECTOR par défaut, le plus proche de leur usage actuel").
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'DIRECTOR';
UPDATE "users" SET "role" = 'DIRECTOR' WHERE "role" = 'STORE';
