import {
  LayoutDashboard,
  MessageSquare,
  Info,
  BookOpen,
  BookMarked,
  ShoppingCart,
  History,
  BarChart3,
  LineChart,
  Sparkles,
  Zap,
  BrainCircuit,
  AlertTriangle,
  Lightbulb,
  Users,
  Mail,
  Coins,
  Sliders,
  Folder,
  ServerCog,
  Clock,
  RefreshCw,
  Wand2,
  PackageX,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface NavEntry {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
  // ADMIN uniquement — même portée que assets/js/reassort-auth.js (liste des id révélés sur
  // DOMContentLoaded) : menu-item-users, menu-item-mail-recipients, menu-item-token-usage,
  // menu-item-ai-quality, menu-item-ai-mastery, menu-item-order-anomalies,
  // menu-item-feature-requests, settings-menu-*.
  adminOnly?: boolean;
}

export interface NavGroup {
  label: string;
  entries: NavEntry[];
}

// Reproduit fidèlement assets/partials/sidebar.html (source de vérité la plus à jour — l'ancien
// react-app-notch-nav/src/navConfig.ts datait d'avant plusieurs ajouts récents : token-usage,
// sales-analysis — jamais une nouvelle route inventée, cf. consigne "ne crée pas de fausses
// routes"). Utilisé en commun par <Sidebar/> ET <NotchNav/> (cf. plan de migration, section
// "Deux modes de navigation à maintenir") pour ne jamais faire diverger la liste des pages entre
// les deux composants.
export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Pilotage',
    entries: [
      { id: 'dashboard', label: 'Tableau de bord', href: '/', icon: LayoutDashboard },
      { id: 'stockouts', label: 'Ruptures de stock', href: '/stockouts', icon: PackageX },
      { id: 'ai-assistant', label: 'Assistant IA', href: '/ai-assistant', icon: MessageSquare },
      { id: 'ai-guide', label: 'Mon accès', href: '/ai-guide', icon: Info },
      { id: 'project-guide', label: 'Guide du projet', href: '/project-guide', icon: BookOpen },
      { id: 'user-guide', label: "Guide d'utilisation", href: '/user-guide', icon: BookMarked },
    ],
  },
  {
    label: 'Réassort',
    entries: [
      { id: 'purchase-order', label: 'Proposition de commande', href: '/purchase-order', icon: ShoppingCart },
      { id: 'purchase-list', label: 'Historique', href: '/purchase-list', icon: History },
      { id: 'sales-analysis', label: "Résultat de l'analyse", href: '/sales-analysis', icon: LineChart },
      { id: 'sales-history', label: 'Ventes synchronisées', href: '/sales-history', icon: BarChart3 },
      { id: 'ai-predictions', label: 'IA & Prédictions', href: '/ai-predictions', icon: Sparkles },
      { id: 'ai-quality', label: 'Qualité & IA', href: '/ai-quality', icon: Zap, adminOnly: true },
      { id: 'ai-mastery', label: 'Mémoire du modèle', href: '/ai-mastery', icon: BrainCircuit, adminOnly: true },
      { id: 'order-anomalies', label: 'Anomalies de commande', href: '/order-anomalies', icon: AlertTriangle, adminOnly: true },
      { id: 'feature-requests', label: "Demandes d'évolution", href: '/feature-requests', icon: Lightbulb, adminOnly: true },
    ],
  },
  {
    label: 'Administration',
    entries: [
      { id: 'users-list', label: 'Utilisateurs', href: '/users-list', icon: Users, adminOnly: true },
      { id: 'mail-recipients', label: 'Destinataires email', href: '/mail-recipients', icon: Mail, adminOnly: true },
      { id: 'token-usage', label: 'Consommation de tokens', href: '/token-usage', icon: Coins, adminOnly: true },
    ],
  },
  {
    label: 'Paramètres',
    entries: [
      { id: 'settings-reassort', label: 'Réassort', href: '/settings#tab-reassort', icon: Sliders, adminOnly: true },
      { id: 'settings-files', label: 'Fichiers de ventes', href: '/settings#tab-files', icon: Folder, adminOnly: true },
      { id: 'settings-rpos', label: 'RPOS & Sécurité', href: '/settings#tab-rpos', icon: ServerCog, adminOnly: true },
      { id: 'settings-cron', label: 'Planification', href: '/settings#tab-cron', icon: Clock, adminOnly: true },
      { id: 'settings-sync', label: 'Synchronisation', href: '/settings#tab-sync', icon: RefreshCw, adminOnly: true },
      { id: 'settings-ai', label: 'Config IA', href: '/settings#tab-ai', icon: Wand2, adminOnly: true },
    ],
  },
];

export function flattenEntries(groups: NavGroup[]): NavEntry[] {
  return groups.flatMap((g) => g.entries);
}

// Détermine l'entrée active à partir du chemin React Router courant (+ hash pour /settings),
// même principe que activeEntryId de l'ancien react-app-notch-nav/src/navConfig.ts.
export function activeEntryId(groups: NavGroup[], pathname: string, hash: string): string {
  const path = pathname.replace(/\/$/, '') || '/';
  const cleanHash = hash.replace('#', '');
  const entries = flattenEntries(groups);

  if (path === '/settings' && cleanHash) {
    const byHash = entries.find((e) => e.href === `/settings#${cleanHash}`);
    if (byHash) return byHash.id;
  }
  const byPath = entries.find((e) => {
    const entryPath = e.href.split('#')[0].replace(/\/$/, '') || '/';
    return entryPath === path;
  });
  return byPath?.id ?? '';
}
