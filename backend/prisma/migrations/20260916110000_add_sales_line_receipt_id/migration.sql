-- Ajoute receipt_id (UUID du ticket de caisse RPOS) à sales_lines, pour compter le vrai nombre de
-- ventes (tickets distincts) plutôt que le nombre de lignes d'articles — demande du 16/09/2026.
-- Nullable : les lignes déjà synchronisées avant ce changement n'ont pas cette info.
ALTER TABLE "sales_lines" ADD COLUMN "receipt_id" TEXT;
