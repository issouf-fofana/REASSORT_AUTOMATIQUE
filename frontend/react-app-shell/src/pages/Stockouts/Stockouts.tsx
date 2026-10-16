import { useEffect, useState } from 'react';
import { StockoutsAllShopsView } from './StockoutsAllShopsView';
import { StockoutShopDetail } from './StockoutShopDetail';

// Module Ruptures (cf. rupture.md, 16/10/2026) — page séparée dans la sidebar (demande du
// 16/10/2026 : d'abord intégrée en bas du Tableau de bord, puis déplacée ici sur demande explicite
// "il doit etre une page separé"). Diagnostic SIMPLIFIÉ, sans les données Cyrus (entrepôt) : on ne
// distingue pas "stock central indisponible" / "non préparé" / "retard transport", ces 3 cas
// retombent tous sur AMONT_A_PRECISER (cf. stockoutEpisodeService.js côté backend).
//
// Restructuré le 16/10/2026 (demande explicite : "je dois faire comme pour les commande, les
// article son classer par rayon et quand je clique je peux voir les article et quand je clique sur
// un article je peux voir les detail") — l'ancien onglet "Par rayon" séparé et le tableau plat de
// "Ce magasin" ont fusionné dans StockoutShopDetail.tsx, qui porte la navigation hiérarchique
// Secteur → Rayon → Articles → détail, réutilisée identiquement pour "Ce magasin" ET le drill-down
// depuis "Tous les magasins" (plus de duplication de comportement entre ces deux entrées).
//
// "Analyse par rayon" avait d'abord été ajoutée comme onglet séparé, puis déplacée DANS
// StockoutShopDetail.tsx (demande explicite : "doit etre dans les detail quand je clique sur pour
// mag") — elle fait partie du détail d'un magasin (comme les KPI/graphes), pas une vue indépendante
// au même niveau que "Ce magasin" / "Tous les magasins".
export function Stockouts() {
  const [user] = useState(() => window.reassortGetUser());
  const isSingleShop = user ? window.reassortIsSingleShopRole(user.role) : true;
  const [selectedShop, setSelectedShop] = useState<{ id: string; posId?: string } | null>(null);

  // Onglets "Ce magasin" / "Tous les magasins" (spec rupture.md §2, demande explicite du 16/10/2026
  // : "tout doit etre dans le dashbord des rupture pas l'autre" — même pattern que
  // TableauDeBord.tsx, pas de page séparée pour la vue réseau).
  const [activeTab, setActiveTab] = useState<'shop' | 'all'>('shop');

  function shopQueryParam(): string {
    const id = isSingleShop ? user?.rposShopId || '' : selectedShop?.id || '';
    const pos = isSingleShop ? user?.rposPosId || '' : selectedShop?.posId || '';
    if (!id) return '';
    return `shop=${encodeURIComponent(id)}${pos ? '&pos=' + encodeURIComponent(pos) : ''}`;
  }

  // Compte ADMIN/SUPERVISOR : suit le sélecteur GLOBAL de la topbar, même pattern que
  // TableauDeBord.tsx (window.reassortGetActiveShop/reassortOnActiveShopChange).
  useEffect(() => {
    if (isSingleShop) return;
    const active = window.reassortGetActiveShop ? window.reassortGetActiveShop() : null;
    if (active) setSelectedShop(active);
    if (window.reassortOnActiveShopChange) {
      window.reassortOnActiveShopChange((shop) => setSelectedShop(shop ?? null));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSingleShop]);

  function handleSelectShopFromNetwork(shop: { id: string; reference: string; name: string }) {
    setSelectedShop({ id: shop.id });
    setActiveTab('shop');
  }

  return (
    <div className="container-fluid py-4">
      {/* Même style que TableauDeBord.tsx (reassort-tabs) — dupliqué ici car chaque page garde son
          propre scope de style, pas de feuille partagée entre pages de la SPA. */}
      <style>{`
        .reassort-tabs .nav-link { color: #5B6B85; font-weight: 600; border: none; border-bottom: 2px solid transparent; }
        .reassort-tabs .nav-link.active { color: #1B2A4A; border-bottom-color: #F5A623; background: transparent; }
      `}</style>

      <div className="d-flex align-items-center justify-content-between mb-3">
        <h2 className="mb-0">Ruptures de stock</h2>
        <span className="text-muted small">Sans données entrepôt (Cyrus) — diagnostic simplifié</span>
      </div>

      {!isSingleShop && (
        <ul className="nav reassort-tabs mb-3">
          <li className="nav-item">
            <button type="button" className={`nav-link${activeTab === 'shop' ? ' active' : ''}`} onClick={() => setActiveTab('shop')}>
              Ce magasin
            </button>
          </li>
          <li className="nav-item">
            <button type="button" className={`nav-link${activeTab === 'all' ? ' active' : ''}`} onClick={() => setActiveTab('all')}>
              Tous les magasins
            </button>
          </li>
        </ul>
      )}

      {activeTab === 'all' && !isSingleShop ? (
        <StockoutsAllShopsView onSelectShop={handleSelectShopFromNetwork} />
      ) : (
        <StockoutShopDetail shopQueryParam={shopQueryParam()} />
      )}
    </div>
  );
}
