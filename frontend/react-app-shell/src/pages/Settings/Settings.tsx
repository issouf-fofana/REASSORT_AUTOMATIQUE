import { SettingsTabs } from './components/SettingsTabs';

// Page Paramètres (6 sections : Réassort, Fichiers de ventes, RPOS & Sécurité, Planification,
// Synchronisation, Config IA, Comptes mail) — portée verbatim depuis react-app/ (ex settings-app),
// routage par onglets conservé en hash (#tab-xxx), compatible avec les liens existants de
// navConfig.ts (/settings#tab-reassort...). AdminGuard posé au niveau de la route dans
// router/routes.tsx, comme les autres pages réservées ADMIN du shell (pas de garde locale
// dupliquée).
export function Settings() {
  return <SettingsTabs />;
}
