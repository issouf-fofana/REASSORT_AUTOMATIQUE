import { Route, Routes } from 'react-router-dom';
import { AppLayout } from '../shared/components/AppLayout';
import { AdminGuard } from '../shared/auth/AdminGuard';
import { UserGuide } from '../pages/UserGuide/UserGuide';
import { ProjectGuide } from '../pages/ProjectGuide/ProjectGuide';
import { AiGuide } from '../pages/AiGuide/AiGuide';
import { FeatureRequests } from '../pages/FeatureRequests/FeatureRequests';
import { MailRecipients } from '../pages/MailRecipients/MailRecipients';
import { SalesAnalysis } from '../pages/SalesAnalysis/SalesAnalysis';
import { AiMastery } from '../pages/AiMastery/AiMastery';
import { AiPredictions } from '../pages/AiPredictions/AiPredictions';
import { TokenUsagePage } from '../pages/TokenUsage/TokenUsagePage';
import { UsersPage } from '../pages/UsersList/UsersPage';
import { SalesHistory } from '../pages/SalesHistory/SalesHistory';
import { PurchaseList } from '../pages/PurchaseList/PurchaseList';
import { OrderAnomalies } from '../pages/OrderAnomalies/OrderAnomalies';
import { SignIn } from '../pages/Login/SignIn';
import { Settings } from '../pages/Settings/Settings';
import { AiQuality } from '../pages/AiQuality/AiQuality';
import { AiAssistantPage } from '../pages/AiAssistant/AiAssistantPage';
import { PurchaseOrderPage } from '../pages/PurchaseOrder/PurchaseOrderPage';
import { Dashboard } from '../pages/Dashboard/Dashboard';
import { Stockouts } from '../pages/Stockouts/Stockouts';
import { StockoutEpisodePage } from '../pages/Stockouts/StockoutEpisodePage';
import { OverstockReport } from '../pages/OverstockReport/OverstockReport';

// Vague 1 du plan de migration (/home/youssef/.claude/plans/pure-singing-willow.md) : pages
// simples, faible trafic. /feature-requests et /mail-recipients réservées ADMIN (AdminGuard, même
// garde-fou cosmétique que les pages non-SPA — la vraie sécurité reste le backend).
//
// Vague 2 : /sales-analysis et /ai-predictions accessibles à tout utilisateur authentifié (pas
// d'AdminGuard, comme dans leurs App.tsx d'origine) ; /ai-mastery, /token-usage et /users-list
// réservées ADMIN.
//
// Vague 3 : /sales-history et /purchase-list accessibles à tout utilisateur authentifié (cloisonné
// par magasin/rayon côté backend, pas d'AdminGuard, comme leurs App.tsx d'origine) ;
// /order-anomalies réservée ADMIN. /login est un cas à part : rendue SANS <AppLayout/> (pas de
// sidebar/topbar sur l'écran de connexion) et c'est la seule route de la SPA où la garde d'auth
// inline de index.html n'exige pas de token (cf. plan, section "garde d'auth"). /settings garde son
// routage par onglets en window.location.hash (#tab-xxx), déjà fonctionnel tel quel dans la SPA.
//
// Vague 4 : /ai-quality (AdminGuard, même routage par hash que /settings) et /ai-assistant (pas
// d'AdminGuard) migrées sans refactor useSearchParams — leur état d'URL manuel
// (window.history.pushState/URLSearchParams pour #tab-xxx et ?conversation=<id>) fonctionne déjà
// tel quel à l'intérieur d'un <BrowserRouter>, tant que la page ne déclenche jamais de navigation
// interne concurrente via <Link>/navigate() pendant qu'elle gère son propre état. /purchase-order
// (le plus complexe de la vague, ?shop=&sector=&dept=) migrée selon le même principe — pas
// d'AdminGuard, aucun window.location.href vers une autre route dans son code.
//
// Vague 5 (dernière) : / (Tableau de bord), pas d'AdminGuard. Seule page qui n'a pu être portée
// strictement verbatim : ses 3 navigations internes vers d'autres routes de la SPA
// (TodayProposalsCard → /purchase-order, 2 liens → /purchase-list et /ai-quality#tab-corrections)
// utilisaient window.location.href/<a href>, converties en navigate()/<Link> — sinon elles
// auraient provoqué un rechargement complet de page malgré la fusion, l'exact problème que ce
// chantier corrige.
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<SignIn />} />
      <Route element={<AppLayout />}>
        <Route path="/user-guide" element={<UserGuide />} />
        <Route path="/project-guide" element={<ProjectGuide />} />
        <Route path="/ai-guide" element={<AiGuide />} />
        <Route path="/feature-requests" element={<AdminGuard><FeatureRequests /></AdminGuard>} />
        <Route path="/mail-recipients" element={<AdminGuard><MailRecipients /></AdminGuard>} />
        <Route path="/sales-analysis" element={<SalesAnalysis />} />
        <Route path="/ai-mastery" element={<AdminGuard><AiMastery /></AdminGuard>} />
        <Route path="/ai-predictions" element={<AiPredictions />} />
        <Route path="/token-usage" element={<AdminGuard><TokenUsagePage /></AdminGuard>} />
        <Route path="/users-list" element={<AdminGuard><UsersPage /></AdminGuard>} />
        <Route path="/sales-history" element={<SalesHistory />} />
        <Route path="/purchase-list" element={<PurchaseList />} />
        <Route path="/order-anomalies" element={<AdminGuard><OrderAnomalies /></AdminGuard>} />
        <Route path="/stockouts" element={<Stockouts />} />
        <Route path="/stockouts/episode/:episodeId" element={<StockoutEpisodePage />} />
        {/* Pas d'AdminGuard (contrairement à /feature-requests) : le backend autorise ADMIN ET
            SUPERVISOR (requireAdminOrSupervisor, overstockReportService.js), même raisonnement que
            /stockouts qui n'est pas non plus guardée alors que sa vue "Tous les magasins" a la même
            restriction — le vrai contrôle reste le 403 backend pour un compte RAYONNISTE/CHEF. */}
        <Route path="/overstock-report" element={<OverstockReport />} />
        <Route path="/settings" element={<AdminGuard><Settings /></AdminGuard>} />
        <Route path="/ai-quality" element={<AdminGuard><AiQuality /></AdminGuard>} />
        <Route path="/ai-assistant" element={<AiAssistantPage />} />
        <Route path="/purchase-order" element={<PurchaseOrderPage />} />
        <Route path="/" element={<Dashboard />} />
      </Route>
    </Routes>
  );
}
