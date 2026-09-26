import {
  LayoutDashboard,
  Globe,
  MessageSquare,
  Info,
  BookOpen,
  ShoppingCart,
  History,
  BarChart3,
  Sparkles,
  Zap,
  BrainCircuit,
  AlertTriangle,
  Users,
  Sliders,
  Folder,
  ServerCog,
  Clock,
  RefreshCw,
  Wand2,
  Mail,
  Lightbulb,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface NavEntry {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
  // ADMIN uniquement (même portée que reassort-auth.js : menu-item-users, menu-item-admin-dashboard,
  // menu-item-ai-quality, menu-item-ai-mastery, menu-item-order-anomalies, settings-menu-*).
  adminOnly?: boolean;
}

export interface NavGroup {
  label: string;
  entries: NavEntry[];
}

// Reproduit exactement assets/partials/sidebar.html (13 pages + 6 sous-onglets Paramètres) — jamais
// une nouvelle route inventée, cf. consigne "ne crée pas de fausses routes". Icônes Lucide en
// remplacement des <svg> inline d'origine (même sens, bibliothèque différente).
export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Pilotage',
    entries: [
      { id: 'dashboard', label: 'Tableau de bord', href: '/', icon: LayoutDashboard },
      { id: 'admin-dashboard', label: 'Vue globale', href: '/admin-dashboard', icon: Globe, adminOnly: true },
      { id: 'ai-assistant', label: 'Assistant IA', href: '/ai-assistant', icon: MessageSquare },
      { id: 'ai-guide', label: 'Mon accès', href: '/ai-guide', icon: Info },
      { id: 'project-guide', label: 'Guide du projet', href: '/project-guide', icon: BookOpen },
    ],
  },
  {
    label: 'Réassort',
    entries: [
      { id: 'purchase-order', label: 'Proposition de commande', href: '/purchase-order', icon: ShoppingCart },
      { id: 'purchase-list', label: 'Historique', href: '/purchase-list', icon: History },
      { id: 'sales-history', label: 'Ventes synchronisées', href: '/sales-history', icon: BarChart3 },
      { id: 'ai-predictions', label: 'IA & Prédictions', href: '/ai-predictions', icon: Sparkles },
      { id: 'ai-quality', label: 'Qualité & IA', href: '/ai-quality', icon: Zap, adminOnly: true },
      { id: 'ai-mastery', label: 'Mémoire du modèle', href: '/ai-mastery', icon: BrainCircuit, adminOnly: true },
      { id: 'order-anomalies', label: 'Anomalies de commande', href: '/order-anomalies', icon: AlertTriangle, adminOnly: true },
    ],
  },
  {
    label: 'Administration',
    entries: [
      { id: 'users-list', label: 'Utilisateurs', href: '/users-list', icon: Users, adminOnly: true },
      { id: 'mail-recipients', label: 'Destinataires email', href: '/mail-recipients', icon: Mail, adminOnly: true },
      { id: 'feature-requests', label: 'Demandes d\'évolution', href: '/feature-requests', icon: Lightbulb, adminOnly: true },
      { id: 'settings-reassort', label: 'Paramètres · Réassort', href: '/settings#tab-reassort', icon: Sliders, adminOnly: true },
      { id: 'settings-files', label: 'Paramètres · Fichiers de ventes', href: '/settings#tab-files', icon: Folder, adminOnly: true },
      { id: 'settings-rpos', label: 'Paramètres · RPOS & Sécurité', href: '/settings#tab-rpos', icon: ServerCog, adminOnly: true },
      { id: 'settings-cron', label: 'Paramètres · Planification', href: '/settings#tab-cron', icon: Clock, adminOnly: true },
      { id: 'settings-sync', label: 'Paramètres · Synchronisation', href: '/settings#tab-sync', icon: RefreshCw, adminOnly: true },
      { id: 'settings-ai', label: 'Paramètres · IA', href: '/settings#tab-ai', icon: Wand2, adminOnly: true },
    ],
  },
];

export function flattenEntries(groups: NavGroup[]): NavEntry[] {
  return groups.flatMap((g) => g.entries);
}

// Détermine l'entrée active à partir de l'URL courante (chemin + hash), même logique que
// stripHtmlExt/data-nav-item/data-nav-href de layout.js.
export function activeEntryId(groups: NavGroup[]): string {
  const path = window.location.pathname.replace(/\/$/, '') || '/';
  const hash = window.location.hash.replace('#', '');
  const entries = flattenEntries(groups);

  if (path === '/settings' && hash) {
    const byHash = entries.find((e) => e.href === `/settings#${hash}`);
    if (byHash) return byHash.id;
  }
  const byPath = entries.find((e) => {
    const entryPath = e.href.split('#')[0].replace(/\/$/, '') || '/';
    return entryPath === path;
  });
  return byPath?.id ?? entries[0].id;
}
