import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../api/client';
import { useAuth } from './useAuth';

export interface Shop {
  id: string;
  reference: string;
  name: string;
  posId: string;
}

/**
 * Reproduit la logique de sélection de magasin de settings.old.html (const currentUser =
 * window.reassortGetUser(); function selectedShopIds() {...}) : un compte à rôle "single-shop"
 * (STORE/DIRECTOR/DEPARTMENT_HEAD/SHELF_STOCKER) est TOUJOURS cantonné à son propre magasin
 * (currentUser.rposShopId), jamais de sélecteur affiché — seul ADMIN/SUPERVISOR voit la liste
 * complète et peut cocher plusieurs magasins à la fois pour un réglage en masse.
 *
 * Réutilisable par toutes les futures sections migrées (pas seulement Réassort), pour ne jamais
 * dupliquer cette règle de cloisonnement magasin par magasin.
 */
export function useShopSelector() {
  const { user } = useAuth();
  const isSingleShop = user ? window.reassortIsSingleShopRole(user.role) : true;

  const [shops, setShops] = useState<Shop[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isSingleShop || !user) return;
    setLoading(true);
    apiFetch<Shop[]>('/reassort/shops')
      .then((data) => {
        const sorted = [...data].sort((a, b) => {
          const posA = parseInt((a.posId || '').replace(/\D/g, ''), 10) || 0;
          const posB = parseInt((b.posId || '').replace(/\D/g, ''), 10) || 0;
          if (posA !== posB) return posA - posB;
          return (a.reference || '').localeCompare(b.reference || '');
        });
        setShops(sorted);
        if (sorted.length > 0) setSelectedIds([sorted[0].id]);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [isSingleShop, user]);

  const effectiveShopIds = useMemo(() => {
    if (isSingleShop) return user?.rposShopId ? [user.rposShopId] : [];
    return selectedIds;
  }, [isSingleShop, user, selectedIds]);

  const toggleShop = useCallback((shopId: string) => {
    setSelectedIds((prev) =>
      prev.includes(shopId) ? prev.filter((id) => id !== shopId) : [...prev, shopId]
    );
  }, []);

  return {
    isSingleShop,
    shops,
    selectedShopIds: effectiveShopIds,
    toggleShop,
    loading,
    error,
    isBulk: effectiveShopIds.length > 1,
  };
}
