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
//
// Regroupement demandé le 26/09/2026 ("classe aussi : section réassort, paramètre, AI, commande,
// mail, utilisateur") : plus fin que les 3 groupes Pilotage/Réassort/Administration de la sidebar
// d'origine — chaque page est reclassée par SUJET plutôt que par section de menu, et les 6
// sous-onglets Paramètres forment leur propre colonne avec libellé complet (jamais tronqué, cf.
// bug visuel signalé le 26/09/2026 : "Paramètres · Fichiers ..." illisible dans une colonne étroite).
export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Pilotage',
    entries: [
      { id: 'dashboard', label: 'Tableau de bord', href: '/', icon: LayoutDashboard },
      { id: 'admin-dashboard', label: 'Vue globale', href: '/admin-dashboard', icon: Globe, adminOnly: true },
      { id: 'ai-guide', label: 'Mon accès', href: '/ai-guide', icon: Info },
      { id: 'project-guide', label: 'Guide du projet', href: '/project-guide', icon: BookOpen },
    ],
  },
  {
    // "Commande" fusionné ici le 26/09/2026 ("met commande anomalie dans le lot de réassort c'est
    // même famille") : Anomalies de commande n'avait pas assez de contenu pour justifier sa propre
    // colonne, et relève du même sujet que le réassort.
    label: 'Réassort',
    entries: [
      { id: 'purchase-order', label: 'Proposition de commande', href: '/purchase-order', icon: ShoppingCart },
      { id: 'purchase-list', label: 'Historique', href: '/purchase-list', icon: History },
      { id: 'sales-history', label: 'Ventes synchronisées', href: '/sales-history', icon: BarChart3 },
      { id: 'order-anomalies', label: 'Anomalies de commande', href: '/order-anomalies', icon: AlertTriangle, adminOnly: true },
    ],
  },
  {
    label: 'IA',
    entries: [
      { id: 'ai-assistant', label: 'Assistant IA', href: '/ai-assistant', icon: MessageSquare },
      { id: 'ai-predictions', label: 'IA & Prédictions', href: '/ai-predictions', icon: Sparkles },
      { id: 'ai-quality', label: 'Qualité & IA', href: '/ai-quality', icon: Zap, adminOnly: true },
      { id: 'ai-mastery', label: 'Mémoire du modèle', href: '/ai-mastery', icon: BrainCircuit, adminOnly: true },
    ],
  },
  {
    label: 'Mail',
    entries: [
      { id: 'mail-recipients', label: 'Destinataires email', href: '/mail-recipients', icon: Mail, adminOnly: true },
      { id: 'feature-requests', label: 'Demandes d\'évolution', href: '/feature-requests', icon: Lightbulb, adminOnly: true },
    ],
  },
  {
    label: 'Utilisateur',
    entries: [{ id: 'users-list', label: 'Utilisateurs', href: '/users-list', icon: Users, adminOnly: true }],
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
