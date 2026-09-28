import { useEffect, useState } from 'react';
import { apiFetch } from './api/client';

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

  return (
    <div>
      <div className="oa-intro">
        <strong>À quoi ça sert :</strong> liste, pour toutes les propositions en attente (tous magasins), les articles qui ne sont pas
        rattachés au fournisseur central côté RPOS — un article dans cette situation risque d'être refusé silencieusement au moment de
        l'envoi réel de la commande. Calculé automatiquement à chaque génération, sans besoin d'ouvrir chaque rayon un par un.
      </div>

      <div className="oa-toolbar">
        <select className="form-select" value={shopFilter} onChange={(e) => setShopFilter(e.target.value)}>
          <option value="">Tous les magasins</option>
          {shops.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <span className="oa-toolbar-count">{rows ? `${filteredRows.length} article(s)` : ''}</span>
        <button type="button" className="btn btn-sm btn-outline-secondary" onClick={load}>
          Actualiser
        </button>
      </div>

      {error ? (
        <div className="alert alert-danger">{error}</div>
      ) : rows === null ? (
        <div className="text-center text-muted py-4">Chargement...</div>
      ) : filteredRows.length === 0 ? (
        <div className="text-center text-muted py-5">
          <iconify-icon icon="solar:check-circle-bold-duotone" style={{ fontSize: '2rem', color: '#c9ccd1' }}></iconify-icon>
          <div className="mt-2">Aucun article non rattaché pour ce filtre.</div>
        </div>
      ) : (
        <div className="table-responsive">
          <table className="table table-sm table-hover align-middle">
            <thead>
              <tr>
                <th>Magasin</th>
                <th>Article</th>
                <th>EAN</th>
                <th>Rayon</th>
                <th>Fournisseur actuel</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((r) => (
                <tr key={r.lineId}>
                  <td>{r.shopReference} — {r.shopName}</td>
                  <td>{r.label || '—'}</td>
                  <td>{r.ean}</td>
                  <td>{r.department || '—'}</td>
                  <td>{r.currentSuppliers}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
