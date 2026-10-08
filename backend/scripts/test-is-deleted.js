// Script de test ponctuel (08/10/2026) : vérifie si l'API RPOS /api/supplier_order/ accepte
// is_deleted='true' (ou l'absence du paramètre) pour retourner aussi les commandes supprimées —
// jamais testé jusqu'ici, is_deleted=false est codé en dur partout dans rposClient.js sans qu'on
// ait vérifié que l'autre valeur fonctionne (certains filtres RPOS, comme label_1__icontains, sont
// silencieusement ignorés par l'API). À lancer depuis le dossier backend/ :
//   node scripts/test-is-deleted.js <posId> <shopId>
// Supprimer ce fichier une fois le comportement confirmé et documenté dans rposClient.js.

const rpos = require('../src/services/rposClient');

async function main() {
  const [, , posId, shopId] = process.argv;
  if (!posId || !shopId) {
    console.error('Usage: node scripts/test-is-deleted.js <posId> <shopId>');
    process.exit(1);
  }

  for (const isDeletedValue of ['false', 'true']) {
    const label = `is_deleted=${isDeletedValue}`;
    try {
      const result = await rpos.getSupplierOrders(posId, {
        shopId,
        pageSize: 10,
        page: 1,
        platformOnly: false,
        isDeleted: isDeletedValue,
      });
      console.log(`\n=== ${label} ===`);
      console.log(`count: ${result.count}, results: ${(result.results || []).length}`);
      (result.results || []).slice(0, 5).forEach((o) => {
        console.log(`  - ${o.reference || o.id} | ${o.external_reference || ''} | status: ${o.status}`);
      });
    } catch (err) {
      console.error(`\n=== ${label} : ERREUR ===`);
      console.error(err.message);
    }
  }

  console.log(
    '\nComparez les deux counts ci-dessus : si is_deleted=true retourne PLUS de résultats (ou des ' +
      "résultats différents) que is_deleted=false, l'API respecte bien ce paramètre et on peut l'utiliser " +
      "pour afficher les commandes supprimées dans l'Historique. Si les deux listes sont identiques, RPOS " +
      'ignore silencieusement ce paramètre et il faudra une autre approche.',
  );
}

main().catch((err) => {
  console.error('Échec du script:', err);
  process.exit(1);
});
