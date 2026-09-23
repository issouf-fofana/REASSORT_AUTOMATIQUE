import { apiFetch } from './api/client';

export interface Shop {
  id: string;
  posId: string;
  reference: string;
  name: string;
  posLabel?: string;
}

export interface SupervisedShop {
  rposShopId: string;
  rposShopReference: string;
  rposShopName: string;
  rposPosId: string;
}

export interface ReassortUserRecord {
  id: string;
  name: string;
  email: string;
  role: string;
  isActive: boolean;
  rposShopId?: string | null;
  rposShopReference?: string | null;
  rposShopName?: string | null;
  rposPosId?: string | null;
  assignedDepartment?: string | null;
  aiPermissionsJson?: string | null;
  supervisedShops?: SupervisedShop[];
  ldapManaged?: boolean;
}

export const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Administrateur',
  SUPERVISOR: 'Superviseur',
  DIRECTOR: 'Directeur',
  DEPARTMENT_HEAD: 'Chef de département',
  SHELF_STOCKER: 'Rayonniste',
  STORE: 'Magasin (ancien rôle)',
};

export const SINGLE_SHOP_ROLES = new Set(['DIRECTOR', 'DEPARTMENT_HEAD', 'SHELF_STOCKER']);
export const DEPARTMENT_SCOPED_ROLES = new Set(['DEPARTMENT_HEAD', 'SHELF_STOCKER']);

export const AI_CAPABILITIES: { key: string; label: string }[] = [
  { key: 'revenueShop', label: "Chiffre d'affaires du magasin (global)" },
  { key: 'revenueArticle', label: "Chiffre d'affaires d'un article / département" },
  { key: 'articleDetails', label: 'Fiche article (prix, emplacement, promotions)' },
  { key: 'stock', label: 'Stock, ruptures et surstock' },
  { key: 'sales', label: 'Ventes et tendances' },
  { key: 'orders', label: 'Commandes et propositions' },
  { key: 'accuracy', label: "Fiabilité de l'IA" },
];

export const AI_ROLE_DEFAULTS: Record<string, Record<string, boolean>> = {
  SHELF_STOCKER: { revenueShop: false, revenueArticle: false, articleDetails: true, stock: true, sales: true, orders: true, accuracy: true },
  DEPARTMENT_HEAD: { revenueShop: false, revenueArticle: true, articleDetails: true, stock: true, sales: true, orders: true, accuracy: true },
  DIRECTOR: { revenueShop: true, revenueArticle: true, articleDetails: true, stock: true, sales: true, orders: true, accuracy: true },
  SUPERVISOR: { revenueShop: true, revenueArticle: true, articleDetails: true, stock: true, sales: true, orders: true, accuracy: true },
};

export function shopLabelFor(u: ReassortUserRecord): string {
  if (u.role === 'ADMIN') return 'Tous magasins';
  if (u.role === 'SUPERVISOR') {
    const shops = u.supervisedShops || [];
    return shops.length ? shops.map((s) => s.rposShopReference).join(', ') : 'Aucun magasin';
  }
  let label = u.rposShopReference ? `${u.rposShopReference} - ${u.rposShopName}` : 'Non assigné';
  if (u.assignedDepartment) label += ` (${u.assignedDepartment})`;
  return label;
}

export async function loadRayonsFor(shopId: string): Promise<string[]> {
  if (!shopId) return [];
  return apiFetch<string[]>(`/reassort/shops/${encodeURIComponent(shopId)}/rayons`);
}

export function groupShopsByPos(shops: Shop[]): Record<string, Shop[]> {
  const byPos: Record<string, Shop[]> = {};
  shops.forEach((s) => {
    (byPos[s.posId] ||= []).push(s);
  });
  return byPos;
}

export function sortedPosIds(byPos: Record<string, Shop[]>): string[] {
  return Object.keys(byPos).sort((a, b) => parseInt(a.replace(/\D/g, ''), 10) - parseInt(b.replace(/\D/g, ''), 10));
}
