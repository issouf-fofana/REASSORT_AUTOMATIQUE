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
  PackageSearch,
  Trash2,
  Activity,
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
// Réorganisée par thème le 21/10/2026 (demande explicite : "il faut organise la sidebare tout ce
// qui est qui dans onglé IA, tout ce qui est stock dans l'onglet stok... tu vois il fait bien
// organisé") — l'ancien découpage Pilotage/Réassort mélangeait pages de navigation générale, pages
// de stock et pages IA dans les deux mêmes groupes (ex: "Assistant IA" dans Pilotage, "IA &
// Prédictions" dans Réassort). Désormais : Pilotage = tableau de bord + guides uniquement, Stock =
// toutes les pages dont le sujet est le stock/les commandes (même si l'IA intervient dans leur
// calcul, ex: Anomalies de commande, Résultat de l'analyse — confirmé explicitement), IA = pages
// dont le cœur est l'assistant/les modèles eux-mêmes, Administration et Paramètres inchangés.
export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Pilotage',
    entries: [
      { id: 'dashboard', label: 'Tableau de bord', href: '/', icon: LayoutDashboard },
      // Ramené ici le 25/10/2026 (demande explicite : "le bouton Assistant IA sur la sidebare tu
      // peux metre juste en bas de Tableau de bord") — était dans le groupe "IA" depuis la
      // réorganisation par thème du 21/10/2026 (cf. commentaire plus haut), mais l'usage le plus
      // fréquent de cette page justifie un accès direct depuis le tout premier groupe.
      { id: 'ai-assistant', label: 'Assistant IA', href: '/ai-assistant', icon: MessageSquare },
      { id: 'ai-guide', label: 'Mon accès', href: '/ai-guide', icon: Info },
      { id: 'project-guide', label: 'Guide du projet', href: '/project-guide', icon: BookOpen },
      { id: 'user-guide', label: "Guide d'utilisation", href: '/user-guide', icon: BookMarked },
    ],
  },
  {
    label: 'Stock',
    entries: [
      { id: 'stockouts', label: 'Ruptures de stock', href: '/stockouts', icon: PackageX },
      // Pas adminOnly : le backend autorise ADMIN ET SUPERVISOR (requireAdminOrSupervisor,
      // overstockReportService.js) — adminOnly masquerait la page aux SUPERVISOR alors qu'ils y ont
      // accès, même raisonnement que la vue "Tous les magasins" de 'stockouts' ci-dessus.
      { id: 'overstock-report', label: 'Surstock', href: '/overstock-report', icon: PackageSearch },
      // Même raisonnement que 'overstock-report' ci-dessus (accessible ADMIN/SUPERVISOR/mono-magasin,
      // jamais adminOnly).
      { id: 'scrap-report', label: 'Casse', href: '/scrap-report', icon: Trash2 },
      { id: 'purchase-order', label: 'Proposition de commande', href: '/purchase-order', icon: ShoppingCart },
      { id: 'purchase-list', label: 'Historique', href: '/purchase-list', icon: History },
      { id: 'sales-analysis', label: "Résultat de l'analyse", href: '/sales-analysis', icon: LineChart },
      { id: 'sales-history', label: 'Ventes synchronisées', href: '/sales-history', icon: BarChart3 },
      { id: 'order-anomalies', label: 'Anomalies de commande', href: '/order-anomalies', icon: AlertTriangle, adminOnly: true },
    ],
  },
  {
    label: 'IA',
    entries: [
      { id: 'ai-predictions', label: 'IA & Prédictions', href: '/ai-predictions', icon: Sparkles },
      { id: 'ai-quality', label: 'Qualité & IA', href: '/ai-quality', icon: Zap, adminOnly: true },
      { id: 'ai-mastery', label: 'Mémoire du modèle', href: '/ai-mastery', icon: BrainCircuit, adminOnly: true },
      { id: 'feature-requests', label: "Demandes d'évolution", href: '/feature-requests', icon: Lightbulb, adminOnly: true },
    ],
  },
  {
    label: 'Administration',
    entries: [
      { id: 'users-list', label: 'Utilisateurs', href: '/users-list', icon: Users, adminOnly: true },
      { id: 'mail-recipients', label: 'Destinataires email', href: '/mail-recipients', icon: Mail, adminOnly: true },
      { id: 'token-usage', label: 'Consommation de tokens', href: '/token-usage', icon: Coins, adminOnly: true },
      // Interface d'administration centralisée des 26 jobs planifiés (26/10/2026, demande
      // explicite : "une interface d'administration centralisée... statut, logs, suivi temps réel,
      // historique, diagnostic, prochaine exécution"). Remplace la supervision qu'offrait seulement
      // JobsHealthPanel dans Paramètres > Planification (12 jobs sur 26, un seul statut sans
      // historique ni logs) — SchedulingSection.tsx garde la configuration (cron/activation), cette
      // page ajoute la supervision complète.
      { id: 'jobs-admin', label: 'Supervision des tâches', href: '/jobs-admin', icon: Activity, adminOnly: true },
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
