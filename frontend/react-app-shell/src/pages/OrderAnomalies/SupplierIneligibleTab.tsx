import { useEffect, useState } from 'react';
import { apiFetch } from '../../shared/api/client';

// Articles non rattachés au fournisseur central RPOS, tous magasins confondus (demande du
// 28/09/2026 : "faire en sorte qu'après la génération on ait ça sur une vue" — jusqu'ici il fallait
// ouvrir chaque rayon de chaque magasin un par un dans Proposition de commande pour le découvrir).
// Calculé gratuitement à la génération (ProposalLine.supplierIneligible, depuis product.suppliers
// déjà récupéré en lot par proposalService.js) : cette page ne fait qu'une lecture DB, jamais
// d'appel RPOS, donc instantanée quel que soit le volume.
interface SupplierIneligibleItem {
  lineId: string;
  ean: string;
  label: string;
  currentSuppliers: string;
  department: string | null;
  sector: string | null;
  // Résolution intelligente du fournisseur (mission "Logique de gestion des fournisseurs et des
  // commandes", 08/10/2026) : un article de cette liste N'EST PAS forcément bloqué — isCommandable
  // distingue "résolu via historique/fallback, commandable en LD" de "vraiment aucun fournisseur
  // valide, bloqué" (origin NONE). Ne pas confondre avec "non rattaché au central" (le critère
  // d'inclusion dans cette liste), une simple classification.
  resolvedSupplierName: string | null;
  supplierResolutionOrigin: 'CENTRAL' | 'HISTORY' | 'FALLBACK' | 'NONE' | 'MANUAL_OVERRIDE' | null;
  deliveryType: 'LC' | 'LD' | null;
  isCommandable: boolean;
  proposalId: string;
  rposShopId: string;
  shopReference: string;
  shopName: string;
}

export function SupplierIneligibleTab() {
  const [rows, setRows] = useState<SupplierIneligibleItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shopFilter, setShopFilter] = useState('');

  async function load() {
    setError(null);
    try {
      const data = await apiFetch<SupplierIneligibleItem[]>('/reassort/supplier-ineligible-articles');
      setRows(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    load();
  }, []);

  const shops = rows ? Array.from(new Set(rows.map((r) => `${r.shopReference} — ${r.shopName}`))).sort() : [];
  const filteredRows = rows ? rows.filter((r) => !shopFilter || `${r.shopReference} — ${r.shopName}` === shopFilter) : [];

  // Tri croissant/décroissant ajouté le 25/10/2026 (audit complet des tableaux du site, demande
  // explicite : "les ajouté fait un audit de tout tab") — ce tableau n'avait aucun tri.
  type SortKey = 'shopName' | 'label' | 'ean' | 'department' | 'currentSuppliers' | 'isCommandable';
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setSortKey(k); setSortDir('desc'); }
  }
  function SortTh({ k, children }: { k: SortKey; children: React.ReactNode }) {
    const active = sortKey === k;
    return (
      <th role="button" style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort(k)}>
        {children} {active ? (sortDir === 'desc' ? '▼' : '▲') : ''}
      </th>
    );
  }
  const sortedRows = !sortKey ? filteredRows : [...filteredRows].sort((a, b) => {
    const dir = sortDir === 'desc' ? 1 : -1;
    const getValue = (r: SupplierIneligibleItem): number | string => {
      if (sortKey === 'shopName') return `${r.shopReference} — ${r.shopName}`.toLowerCase();
      if (sortKey === 'label') return (r.label || r.ean).toLowerCase();
      if (sortKey === 'ean') return r.ean;
      if (sortKey === 'department') return (r.department || '').toLowerCase();
      if (sortKey === 'currentSuppliers') return (r.currentSuppliers || '').toLowerCase();
      return r.isCommandable ? 1 : 0;
    };
    const av = getValue(a);
    const bv = getValue(b);
    if (typeof av === 'string' || typeof bv === 'string') return dir * String(bv).localeCompare(String(av), 'fr-FR');
    return dir * ((bv as number) - (av as number));
  });

  return (
    <div>
      <div className="oa-intro">
        <strong>À quoi ça sert :</strong> liste, pour toutes les propositions en attente (tous magasins), les articles qui ne sont pas
        rattachés au fournisseur central côté RPOS. Ça ne veut pas dire qu'ils sont bloqués : le système cherche d'abord un fournisseur
        de repli (historique du magasin, puis délai de livraison le plus court) — la colonne « Commandable » indique le vrai statut.
        Seuls les articles marqués « Non » n'ont réellement aucun fournisseur RPOS et ne seront pas envoyés à la commande.
      </div>

      <div className="oa-toolbar">
        <select className="form-select" value={shopFilter} onChange={(e) => setShopFilter(e.target.value)}>
          <option value="">Tous les magasins</option>
          {shops.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <span className="oa-toolbar-count">{rows ? `${filteredRows.length} article(s)` : ''}</span>
        <button type="button" className="btn btn-sm oa-btn-outline" onClick={load}>
          Actualiser
        </button>
      </div>

      {error ? (
        <div className="alert alert-danger">{error}</div>
      ) : rows === null ? (
        <div className="text-center text-muted py-4">Chargement...</div>
      ) : filteredRows.length === 0 ? (
        <div className="text-center text-muted py-5">
          <iconify-icon icon="solar:check-circle-bold-duotone" style={{ fontSize: '2rem', color: '#C7D0E0' }}></iconify-icon>
          <div className="mt-2">Aucun article non rattaché pour ce filtre.</div>
        </div>
      ) : (
        <div className="table-responsive">
          <table className="table table-sm table-hover align-middle">
            <thead>
              <tr>
                <SortTh k="shopName">Magasin</SortTh>
                <SortTh k="label">Article</SortTh>
                <SortTh k="ean">EAN</SortTh>
                <SortTh k="department">Rayon</SortTh>
                <SortTh k="currentSuppliers">Fournisseur actuel</SortTh>
                <SortTh k="isCommandable">Commandable</SortTh>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((r) => (
                <tr key={r.lineId}>
                  <td>{r.shopReference} — {r.shopName}</td>
                  <td>{r.label || '—'}</td>
                  <td>{r.ean}</td>
                  <td>{r.department || '—'}</td>
                  <td>{r.currentSuppliers}</td>
                  <td>
                    {r.isCommandable ? (
                      <span
                        className="badge bg-success-subtle text-success"
                        title={`Résolu via ${r.supplierResolutionOrigin === 'HISTORY' ? "l'historique du magasin" : 'le délai de livraison le plus court'} : ${r.resolvedSupplierName || ''}`}
                      >
                        Oui ({r.deliveryType || 'LD'})
                      </span>
                    ) : (
                      <span className="badge bg-danger-subtle text-danger" title="Aucun fournisseur valide trouvé — cet article ne sera pas envoyé à la commande.">
                        Non
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
