import { QualityTabs } from './QualityTabs';

// Page Qualité & IA (5 onglets : Améliorations IA, Journal des corrections, Journal des erreurs,
// Préparation à l'autonomie, Journal des décisions) — portée verbatim depuis react-app-ai-quality/
// (fusion du 22/09/2026 de 4 pages en une seule). Routage par onglets conservé en hash (#tab-xxx),
// même raisonnement que /settings (vague 3) : déjà fonctionnel tel quel dans une SPA React Router
// (BrowserRouter ne gère pas le hash), aucun refactor useSearchParams nécessaire ici. AdminGuard
// posé au niveau de la route dans router/routes.tsx, comme les autres pages ADMIN du shell.
export function AiQuality() {
  return <QualityTabs />;
}
