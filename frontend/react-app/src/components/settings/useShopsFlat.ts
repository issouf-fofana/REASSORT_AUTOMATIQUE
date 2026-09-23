import { useEffect, useState } from 'react';
import { apiFetch } from '../../api/client';
import type { ShopOption } from './ShopMultiPicker';

interface RawShop {
  id: string;
  posId: string;
  reference: string;
  name: string;
}

/**
 * Reproduit loadShopSelect(selectId, skipSearchable=true) de settings.old.html : charge TOUS les
 * magasins (pas de cloisonnement par rôle, section réservée ADMIN), triés par posId puis référence,
 * à plat (le regroupement par <optgroup> posId n'a de sens que pour un <select> natif, jamais
 * reproduit ici — la recherche texte de ShopMultiPicker couvre le même besoin de filtrage).
 */
export function useShopsFlat() {
  const [shops, setShops] = useState<ShopOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<RawShop[]>('/reassort/shops')
      .then((data) => {
        const sorted = [...data].sort((a, b) => {
          if (a.posId !== b.posId) return a.posId.localeCompare(b.posId);
          return (a.reference || '').localeCompare(b.reference || '');
        });
        setShops(
          sorted.map((s) => ({ id: s.id, posId: s.posId, reference: s.reference, label: s.name })),
        );
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  return { shops, loading, error };
}
