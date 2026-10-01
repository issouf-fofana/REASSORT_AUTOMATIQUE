import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { apiFetch } from './api/client';
import type { LineState, Proposal, ProposalLine } from './types';

export interface ProposalTableHandle {
  getDecisions: () => { lineId: string; quantity: number; excluded: boolean; price: number }[];
  getDecisionsForDepartment: (department: string) => { lineId: string; quantity: number; excluded: boolean; price: number }[];
  selectAllToggle: () => void;
  exportCsv: (shopReference: string) => void;
  unblockLine: (l: ProposalLine, quantity: number) => void;
}

// Ordre/largeur des colonnes choisi par l'utilisateur (demande du 30/09/2026) : préférence
// d'affichage globale, pas liée à un magasin ou une proposition précise, donc une seule clé
// partagée. Les colId explicites ajoutés sur les colonnes sans `field` (voir columnDefs) sont
// nécessaires pour que l'état sauvegardé reste valide d'une session à l'autre (sans colId stable,
// ag-grid génère des identifiants positionnels qui changent si l'ordre des colonnes déclarées change
// dans le code).
// Version incrémentée le 01/10/2026 (v2) : l'ajout de la colonne "actions" et le masquage de
// colonnes secondaires par défaut changent la structure des colonnes — un état sauvegardé par un
// utilisateur AVANT ce changement replaçait "actions" tout au fond du tableau (ag-grid ajoute une
// colonne inconnue de l'état sauvegardé à la fin), invisible à côté d'"Article" comme voulu.
// Invalider l'ancien état une fois suffit à repartir sur l'ordre par défaut du code ci-dessous.
const COLUMN_STATE_STORAGE_KEY = 'reassort_proposal_table_column_state_v2';

// Libellé court "hier" / "29/08-28/09" pour la fenêtre de calcul du % CA (revenueShareStart/End) —
// cohérent avec DeptListContext (DepartmentListView.tsx), même format de date.
function fmtRevenueShareWindow(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const fmt = (d: Date) => d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
  return start.toDateString() === end.toDateString() ? fmt(start) : `${fmt(start)}-${fmt(end)}`;
}

function lineUnit(l: ProposalLine): number {
  return Number(l.orderingUnit) || 1;
}
function nbColisFor(l: ProposalLine, quantity: number): number {
  return Math.round((quantity / lineUnit(l)) * 100) / 100;
}

function checkCellRenderer(getLineState: (l: ProposalLine) => LineState, onChange: () => void) {
  return (params: any) => {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'form-check-input';
    const st = getLineState(params.data);
    input.checked = !st.excluded;
    input.addEventListener('change', () => {
      st.excluded = !input.checked;
      onChange();
    });
    return input;
  };
}

// Détail complet d'une ligne (demande du 30/09/2026 : tableau peu lisible, lignes de hauteur très
// inégale à cause des badges empilés dans Article/Vente moy./Stock) — chaque cellule affiche
// désormais UNE seule ligne de texte + au plus une icône d'alerte discrète ; le détail complet
// (autrefois en badges empilés avec <br>) se retrouve dans ArticleDetailModal, ouvert au clic sur
// la ligne. Les fonctions ci-dessous déterminent QUELLE icône est prioritaire quand plusieurs
// conditions coexistent sur la même ligne (jamais plusieurs pastilles empilées).

function articleAlertIcon(l: ProposalLine): { icon: string; cls: string; title: string } | null {
  if (l.excludedAsAlreadyOrderedRpos) {
    return { icon: 'solar:lock-keyhole-bold-duotone', cls: 'text-primary', title: 'Commande RPOS en cours — cliquez sur la ligne pour débloquer si besoin' };
  }
  if (l.excludedAsAlreadyOrdered) {
    return { icon: 'solar:box-bold-duotone', cls: 'text-primary', title: 'Déjà commandé sur cette plateforme' };
  }
  if (l.orderAnomaly) {
    return { icon: 'solar:danger-triangle-bold-duotone', cls: 'reassort-alert-soft', title: l.orderAnomaly.direction === 'HIGH' ? 'Quantité inhabituellement élevée' : 'Quantité inhabituellement faible' };
  }
  if (l.orderSufficiencyReasoning) {
    return l.orderSufficient === false
      ? { icon: 'solar:danger-triangle-bold-duotone', cls: 'reassort-alert-soft', title: 'Commande insuffisante — cliquez sur la ligne pour le détail' }
      : { icon: 'solar:check-circle-bold-duotone', cls: 'text-success', title: 'Commande suffisante' };
  }
  return null;
}

function labelCellRenderer(params: any) {
  const l = params.data as ProposalLine;
  const span = document.createElement('span');
  span.className = 'text-truncate';
  span.style.fontSize = '.86rem';
  span.textContent = l.label;
  return span;
}

// Colonne "Actions" dédiée (01/10/2026, demande explicite : "crée une colonne pour ça" — ces
// boutons collés après le nom de l'article compressaient le texte et le forçaient à se tronquer
// plus tôt) — regroupe le bouton graphique (toujours présent) et le bouton d'alerte (si applicable).
function actionsCellRenderer(params: any) {
  const l = params.data as ProposalLine;
  const wrap = document.createElement('div');
  wrap.className = 'd-flex align-items-center gap-1';
  let html = `<button type="button" class="btn btn-sm btn-link p-0 pa-open-btn flex-shrink-0" data-ean="${l.ean}" data-product-id="${l.productId}" title="Voir l'évolution de cet article"><iconify-icon icon="solar:chart-2-bold-duotone"></iconify-icon> Graphique</button>`;
  const alert = articleAlertIcon(l);
  if (alert) {
    // Bouton cliquable (pas juste une icône statique, demande du 30/09/2026 : "on ne sait pas si on
    // peut cliquer") — ouvre directement le panneau de détail, sans devoir cliquer ailleurs sur la
    // ligne. .article-detail-btn intercepté par onRowClicked/onCellClicked ci-dessous. Libellé texte
    // ajouté le 01/10/2026 (demande explicite, "avec un texte affiché").
    html += `<button type="button" class="btn btn-sm btn-link p-0 article-detail-btn flex-shrink-0 ${alert.cls}" title="${alert.title} — cliquer pour voir le détail"><iconify-icon icon="${alert.icon}"></iconify-icon> Alerte</button>`;
  }
  wrap.innerHTML = html;
  return wrap;
}

function stockCellRenderer(params: any) {
  const l = params.data as ProposalLine;
  const unreliableStock = !!l.hadNegativeStock;
  const stockValue = unreliableStock && l.actualStock !== null && l.actualStock !== undefined ? l.actualStock : l.stockAtGeneration;
  const wrap = document.createElement('div');
  wrap.className = 'd-flex align-items-center gap-1';
  let html = stockValue !== null && stockValue !== undefined ? (stockValue < 0 ? `<span class="text-danger fw-semibold">${stockValue.toFixed(1)}</span>` : `<span>${stockValue.toFixed(1)}</span>`) : '<span>—</span>';
  if (unreliableStock) {
    html += `<iconify-icon icon="solar:danger-triangle-bold-duotone" class="reassort-alert-soft" title="Stock non fiable — ne se corrige que par une intégration de facture ou un inventaire physique côté RPOS"></iconify-icon>`;
  } else if (l.dlvStock) {
    html += `<iconify-icon icon="solar:tag-price-bold-duotone" class="text-info" title="${l.dlvStock.toFixed(1)} en DLV — stock retiré du calcul car basculé sur un EAN séparé"></iconify-icon>`;
  }
  wrap.innerHTML = html;
  return wrap;
}

function avgSalesCellRenderer(params: any) {
  const l = params.data as ProposalLine;
  const wrap = document.createElement('div');
  wrap.className = 'd-flex align-items-center gap-1';
  if (l.avgWeeklySales === null || l.avgWeeklySales === undefined) {
    wrap.textContent = '—';
    return wrap;
  }
  // Moyenne par jour ajoutée à côté de celle par semaine (demande du 30/09/2026).
  let html = `<span>${l.avgWeeklySales.toFixed(1)} /sem. · ${(l.avgWeeklySales / 7).toFixed(1)} /j</span>`;
  if (l.seasonalityAdjusted) {
    html += `<iconify-icon icon="solar:calendar-bold-duotone" class="text-info" title="Saisonnalité : ajustée par rapport à la même période l'année dernière (écart ${l.seasonalityDeviationPct !== null && l.seasonalityDeviationPct !== undefined ? l.seasonalityDeviationPct.toFixed(0) + '%' : '?'})"></iconify-icon>`;
  } else if (l.forecastMethod === 'smoothed') {
    html += `<iconify-icon icon="solar:chart-2-bold-duotone" class="text-success" title="Prévision lissée : donne plus de poids aux ventes récentes qu'à une moyenne plate"></iconify-icon>`;
  } else if (l.weekdayAdjusted) {
    html += `<iconify-icon icon="solar:calendar-mark-bold-duotone" class="text-primary" title="Jour de semaine : la quantité tient compte du profil de vente par jour (ex: samedi plus fort)"></iconify-icon>`;
  }
  wrap.innerHTML = html;
  return wrap;
}

// Commandabilité fournisseur (spec du 28/09/2026, §2) : badge clair par article, avec raison
// affichée au survol pour les non-commandables — supplierIneligible null (proposition générée
// avant ce champ) n'affiche rien, jamais un badge "non commandable" trompeur faute de donnée.
function supplierEligibilityCellRenderer(params: any) {
  const l = params.data as ProposalLine;
  const wrap = document.createElement('div');
  if (l.supplierIneligible === null || l.supplierIneligible === undefined) {
    wrap.innerHTML = '<span class="text-muted">—</span>';
    return wrap;
  }
  wrap.innerHTML = l.supplierIneligible
    ? `<span class="badge reassort-mini-badge reassort-badge-soft-danger" title="Fournisseur central non renseigné — cet article ne sera pas intégré à la commande. Fournisseur(s) actuel(s) : ${l.currentSuppliers || 'aucun'}"><iconify-icon icon="solar:close-circle-bold"></iconify-icon> Non commandable</span>`
    : '<span class="badge reassort-mini-badge bg-success-subtle text-success"><iconify-icon icon="solar:check-circle-bold"></iconify-icon> Commandable</span>';
  return wrap;
}

function stockoutCellRenderer(params: any) {
  const l = params.data as ProposalLine;
  const wrap = document.createElement('div');
  if (l.daysUntilStockout === null || l.daysUntilStockout === undefined) {
    wrap.innerHTML = '<span class="text-muted">—</span>';
    return wrap;
  }
  const days = Math.round(l.daysUntilStockout);
  const badgeClass = days <= 3 ? 'reassort-badge-soft-danger' : days <= 7 ? 'reassort-badge-soft-warning' : 'bg-success-subtle text-success';
  wrap.innerHTML = `<span class="badge reassort-mini-badge ${badgeClass} py-1 px-2">${days <= 0 ? 'en rupture' : days + ' j'}</span>`;
  return wrap;
}

function lastPurchaseCellRenderer(params: any) {
  const l = params.data as ProposalLine;
  const span = document.createElement('span');
  span.className = 'last-purchase-result small text-muted';
  span.dataset.productId = l.productId;
  span.dataset.ean = l.ean;
  span.textContent = 'Chargement...';
  return span;
}

function lastSaleCellRenderer(params: any) {
  const l = params.data as ProposalLine;
  const span = document.createElement('span');
  span.className = 'last-sale-result small text-muted';
  span.dataset.productId = l.productId;
  span.textContent = 'Chargement...';
  return span;
}

export const ProposalTable = forwardRef<ProposalTableHandle, {
  proposal: Proposal | null;
  lines: ProposalLine[];
  shopId: string;
  shopQueryParam: string;
  readOnly: boolean;
  onOpenAnalytics: (article: { ean: string; productId: string; label: string }) => void;
  onTotalChange: (total: number) => void;
  onOpenArticleDetail: (line: ProposalLine) => void;
}>(function ProposalTable({
  proposal,
  lines,
  shopId,
  shopQueryParam,
  readOnly,
  onOpenAnalytics,
  onTotalChange,
  onOpenArticleDetail,
}, ref) {
  const gridDivRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const gridApiRef = useRef<any>(null);
  const lineStateRef = useRef<Map<string, LineState>>(new Map());
  const pendingFilterModelRef = useRef<Record<string, unknown> | null>(null);
  // Scrollbar horizontale dupliquée en haut du tableau (demande du 30/09/2026) : avec beaucoup de
  // colonnes, la scrollbar native ag-grid en bas du tableau est trop fine/difficile à attraper sans
  // faire défiler toute la page pour la voir. syncingScrollRef évite une boucle infinie entre les
  // deux barres (chacune déclenche un scroll sur l'autre).
  const topScrollRef = useRef<HTMLDivElement>(null);
  const topScrollInnerRef = useRef<HTMLDivElement>(null);
  const syncingScrollRef = useRef(false);

  function getLineState(l: ProposalLine): LineState {
    if (!lineStateRef.current.has(l.id)) {
      lineStateRef.current.set(l.id, { quantity: l.quantitySuggested, excluded: !(l.quantitySuggested > 0) });
    }
    return lineStateRef.current.get(l.id)!;
  }

  function updateOrderTotal() {
    let total = 0;
    lines.forEach((l) => {
      const st = getLineState(l);
      if (!st.excluded) total += (l.sellingPrice || 0) * st.quantity;
    });
    onTotalChange(total);
    if (gridApiRef.current) gridApiRef.current.refreshCells({ columns: ['Valeur commande'], force: true });
  }

  // Extrait de l'ancien handler inline .reassort-unblock-btn (onCellClicked) pour être réutilisable
  // depuis ArticleDetailModal (30/09/2026) : inclut la ligne dans la commande avec la quantité
  // "si débloqué" déjà calculée côté backend (quantityIfUnblocked), sans changer le comportement.
  function unblockLine(l: ProposalLine, quantity: number) {
    const st = getLineState(l);
    st.quantity = quantity;
    st.excluded = false;
    const rowNode = gridApiRef.current?.getRowNode(l.id);
    if (rowNode) gridApiRef.current?.refreshCells({ rowNodes: [rowNode], force: true });
    updateOrderTotal();
  }

  function qtyCellRenderer(params: any) {
    const l = params.data as ProposalLine;
    const unit = lineUnit(l);
    const st = getLineState(l);
    const wrap = document.createElement('div');
    wrap.className = 'd-flex align-items-center justify-content-end gap-1';
    wrap.innerHTML =
      `<input type="number" min="0" step="1" class="form-control form-control-sm text-end" style="width: 65px;" title="Nombre de colis" ${readOnly ? 'disabled' : ''}>` +
      `<span class="text-muted small">× ${unit}</span>` +
      `<input type="number" min="0" class="form-control form-control-sm text-end bg-light" style="width: 70px;" title="Quantité totale en unités (calculée à partir du nombre de colis)" ${readOnly ? 'disabled' : ''}>`;
    const colisInput = wrap.children[0] as HTMLInputElement;
    const qtyInput = wrap.children[2] as HTMLInputElement;
    colisInput.value = String(nbColisFor(l, st.quantity));
    qtyInput.value = String(st.quantity);
    colisInput.addEventListener('input', () => {
      const nbColis = parseFloat(colisInput.value) || 0;
      st.quantity = Math.round(nbColis * unit);
      qtyInput.value = String(st.quantity);
      updateOrderTotal();
    });
    qtyInput.addEventListener('input', () => {
      st.quantity = parseFloat(qtyInput.value) || 0;
      colisInput.value = String(nbColisFor(l, st.quantity));
      updateOrderTotal();
    });
    return wrap;
  }

  function valueCellRenderer(params: any) {
    const l = params.data as ProposalLine;
    const st = getLineState(l);
    const span = document.createElement('span');
    span.className = 'reassort-line-value-cell';
    span.textContent = l.sellingPrice ? (l.sellingPrice * st.quantity).toLocaleString('fr-FR') + ' CFA' : '—';
    return span;
  }

  function aiCellRenderer(params: any) {
    const l = params.data as ProposalLine;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-sm btn-outline-dark ai-analyze-btn';
    btn.title = 'Demander une recommandation IA pour cet article';
    btn.innerHTML = '<iconify-icon icon="solar:magic-stick-3-bold" class="align-middle"></iconify-icon> Analyser';
    btn.addEventListener('click', () => {
      if (!proposal || !window.openAiRecommendationPanel) return;
      window.openAiRecommendationPanel({
        proposalId: proposal.id,
        shopId,
        ean: l.ean,
        label: l.label,
        predictedQuantity: l.quantitySuggested,
        generationAiAdjusted: l.aiAdjusted,
        generationAiReasoning: l.aiReasoning,
        classicQuantitySuggested: l.classicQuantitySuggested,
        stockAtPrediction: l.stockAtGeneration,
        avgWeeklySales: l.avgWeeklySales,
        orderingUnit: l.orderingUnit,
        daysUntilStockout: l.daysUntilStockout,
        hasRecentOrder: !!l.excludedAsAlreadyOrderedRpos,
        recentOrderReference: l.rposOrderReference,
        recentOrderDate: l.rposOrderDate,
        recentOrderCount: l.rposOrderCount,
        dlvStock: l.dlvStock || null,
        onApply: readOnly
          ? undefined
          : (quantity: number) => {
              getLineState(l).quantity = quantity;
              getLineState(l).excluded = false;
              gridApiRef.current?.refreshCells({ rowNodes: [params.node], force: true });
              updateOrderTotal();
            },
      });
    });
    return btn;
  }

  function ensureGrid() {
    if (gridApiRef.current) return gridApiRef.current;
    if (!gridDivRef.current) return null;
    // rowHeight/headerHeight resserrés UNIQUEMENT sur cette grille (withParams part du thème partagé
    // window.REASSORT_AG_GRID_THEME sans le modifier) : les badges empilés dans certaines cellules
    // (Article, Stock, Vente moy.) rendaient les lignes du thème par défaut (68px) visuellement
    // massives sur cette page précise, demande du 24/09/2026 "trop gros, style plus pro".
    const tableTheme = window.REASSORT_AG_GRID_THEME.withParams({
      // rowHeight fiable partout depuis que Article/Vente moy./Stock actuel n'empilent plus de badges
      // en autoHeight (30/09/2026) — légèrement remonté (44 → 48) pour un peu plus d'air, sans revenir
      // au 68 par défaut jugé "trop gros" le 24/09/2026. Zébrage + bordures nettes + en-têtes plus
      // marqués (style "plus pro", demande du 30/09/2026), via la Theming API, sans toucher au thème
      // partagé window.REASSORT_AG_GRID_THEME (withParams retourne un thème immutable, local à cette
      // grille uniquement).
      rowHeight: 48,
      headerHeight: 38,
      headerFontSize: 11.5,
      headerFontWeight: 700,
      dataFontSize: 13,
      cellHorizontalPadding: 10,
      oddRowBackgroundColor: '#FAFAFA',
      rowBorder: { color: '#D9DCE1' },
    });
    gridApiRef.current = window.agGrid.createGrid(gridDivRef.current, {
      theme: tableTheme,
      columnDefs: [
        {
          headerName: '',
          field: '_check',
          width: 46,
          pinned: 'left',
          sortable: false,
          filter: false,
          resizable: false,
          cellRenderer: checkCellRenderer(getLineState, updateOrderTotal),
          valueGetter: (p: any) => (getLineState(p.data).excluded ? 'Non' : 'Oui'),
        },
        { colId: 'rowIndex', headerName: '#', valueGetter: (p: any) => p.node.rowIndex + 1, width: 60, sortable: false, filter: false },
        { headerName: 'EAN', field: 'ean', width: 130, filter: 'agTextColumnFilter' },
        { headerName: 'Article', field: 'label', flex: 2, minWidth: 220, filter: 'agTextColumnFilter', cellRenderer: labelCellRenderer },
        {
          colId: 'actions',
          headerName: 'Actions',
          width: 190,
          sortable: false,
          filter: false,
          cellRenderer: actionsCellRenderer,
          valueGetter: () => '',
        },
        {
          headerName: 'Prix vente',
          field: 'sellingPrice',
          type: 'numericColumn',
          filter: 'agNumberColumnFilter',
          width: 120,
          valueFormatter: (p: any) => (p.value ? p.value.toLocaleString('fr-FR') + ' CFA' : '—'),
        },
        { headerName: 'Vente moy.', field: 'avgWeeklySales', type: 'numericColumn', filter: 'agNumberColumnFilter', width: 170, cellRenderer: avgSalesCellRenderer },
        { headerName: 'Stock actuel', field: 'stockAtGeneration', type: 'numericColumn', filter: 'agNumberColumnFilter', width: 140, cellRenderer: stockCellRenderer },
        { headerName: 'Rupture dans', field: 'daysUntilStockout', type: 'numericColumn', filter: 'agNumberColumnFilter', width: 130, cellRenderer: stockoutCellRenderer },
        {
          // Statut de couverture à 4 niveaux (spec du 28/09/2026 §3), calculé une seule fois à la
          // génération (proposalService.computeCoverageStatus) — même champ que celui affiché dans le
          // panneau d'analyse statique par article, jamais une seconde logique.
          headerName: 'Couverture',
          field: 'coverageStatus',
          width: 170,
          filter: 'agTextColumnFilter',
          headerTooltip: 'Suffisant / Partiellement suffisant / Insuffisant / Non déterminable — cf. infobulle sur la valeur pour le détail.',
          cellRenderer: (p: any) => {
            const l = p.data as ProposalLine;
            const labelByStatus: Record<string, { text: string; cls: string }> = {
              SUFFISANT: { text: 'Suffisant', cls: 'text-success' },
              PARTIELLEMENT_SUFFISANT: { text: 'Partiellement suffisant', cls: 'text-warning' },
              INSUFFISANT: { text: 'Insuffisant', cls: 'text-danger' },
              NON_DETERMINABLE: { text: 'Non déterminable', cls: 'text-muted' },
            };
            const info = l.coverageStatus ? labelByStatus[l.coverageStatus] : null;
            if (!info) return '—';
            const span = document.createElement('span');
            span.className = info.cls;
            span.style.fontSize = '.86rem';
            span.textContent = info.text;
            if (l.coverageStatusReason) span.title = l.coverageStatusReason;
            return span;
          },
        },
        {
          headerName: 'Commandable',
          field: 'supplierIneligible',
          width: 150,
          sortable: true,
          filter: false,
          cellRenderer: supplierEligibilityCellRenderer,
          valueGetter: (p: any) => (p.data.supplierIneligible === true ? 'Non' : p.data.supplierIneligible === false ? 'Oui' : ''),
        },
        {
          colId: 'quantityProposed',
          headerName: 'Qté proposée',
          type: 'numericColumn',
          width: 170,
          sortable: false,
          filter: false,
          cellRenderer: qtyCellRenderer,
          valueGetter: (p: any) => getLineState(p.data).quantity,
        },
        {
          colId: 'orderValue',
          headerName: 'Valeur commande',
          type: 'numericColumn',
          width: 150,
          sortable: false,
          filter: false,
          cellRenderer: valueCellRenderer,
          valueGetter: (p: any) => {
            const st = getLineState(p.data);
            return p.data.sellingPrice ? p.data.sellingPrice * st.quantity : 0;
          },
        },
        { colId: 'ai', headerName: 'IA', width: 130, sortable: false, filter: false, cellRenderer: aiCellRenderer, valueGetter: () => '' },
        // Colonnes secondaires (masquées par défaut le 01/10/2026 : trop de scroll horizontal pour
        // des infos déjà résumées ailleurs — badge d'alerte sur la colonne Article, bandeau de
        // contexte au-dessus de la liste des rayons) — restent accessibles via le bouton "Colonnes"
        // (reassortAgGridToolbar) et via la colonne Article qui pointe déjà vers ArticleDetailModal.
        {
          colId: 'lastPurchase',
          headerName: 'Dernier achat',
          width: 170,
          hide: true,
          sortable: false,
          filter: false,
          cellRenderer: lastPurchaseCellRenderer,
          valueGetter: (p: any) => {
            const el = document.querySelector(`.last-purchase-result[data-product-id="${p.data.productId}"]`);
            return el ? el.textContent : '';
          },
        },
        {
          colId: 'lastSale',
          headerName: 'Dernière vente',
          width: 170,
          hide: true,
          sortable: false,
          filter: false,
          cellRenderer: lastSaleCellRenderer,
          valueGetter: (p: any) => {
            const el = document.querySelector(`.last-sale-result[data-product-id="${p.data.productId}"]`);
            return el ? el.textContent : '';
          },
        },
        {
          // CA HT de l'article sur la période d'analyse (spec §2) — ajouté le 28/09/2026, jamais
          // affiché avant (le backend ne le calculait même pas explicitement jusqu'à ce correctif).
          // Distinct de la colonne "% CA" juste après, calculée sur une fenêtre plus courte.
          headerName: proposal?.analysisPeriodStart && proposal?.analysisPeriodEnd
            ? `CA (${fmtRevenueShareWindow(proposal.analysisPeriodStart, proposal.analysisPeriodEnd)})`
            : 'CA (période)',
          headerTooltip: "Chiffre d'affaires HT réel de l'article sur toute la période d'analyse (Pareto) de cette proposition.",
          field: 'caHtOnPeriod',
          type: 'numericColumn',
          filter: 'agNumberColumnFilter',
          width: 150,
          hide: true,
          valueFormatter: (p: any) => (p.value !== null && p.value !== undefined ? Math.round(p.value).toLocaleString('fr-FR') + ' CFA' : '—'),
        },
        {
          // En-tête + tooltip dynamiques (28/09/2026, spec "toujours afficher clairement la période
          // d'analyse") : revenueSharePct est calculé sur une fenêtre COURTE et DISTINCTE de la
          // période d'analyse/Pareto (revenueShareStart/End, souvent 1 seul jour par défaut) — déjà
          // expliqué dans le bandeau au-dessus de la liste des rayons (DeptListContext), mais ce
          // contexte se perd une fois qu'on défile dans le tableau détaillé d'un rayon. Le nom de
          // colonne et l'infobulle rappellent maintenant la vraie fenêtre à cet endroit précis.
          headerName: proposal?.revenueShareStart && proposal?.revenueShareEnd
            ? `% CA (${fmtRevenueShareWindow(proposal.revenueShareStart, proposal.revenueShareEnd)})`
            : '% CA magasin',
          headerTooltip: proposal?.revenueShareStart && proposal?.revenueShareEnd
            ? `Part du CA calculée sur ${fmtRevenueShareWindow(proposal.revenueShareStart, proposal.revenueShareEnd)}, PAS sur la période d'analyse (Pareto) de cette proposition — deux fenêtres distinctes, voir le bandeau au-dessus.`
            : undefined,
          field: 'revenueSharePct',
          type: 'numericColumn',
          filter: 'agNumberColumnFilter',
          width: 160,
          hide: true,
          valueFormatter: (p: any) => (p.value !== null && p.value !== undefined ? p.value.toFixed(2) + ' %' : '—'),
        },
        {
          // Cumul Pareto (spec du 28/09/2026, §2 : "classe Pareto A/B/C ou équivalent") — déjà
          // calculé et persisté (cumulativePct) mais jamais affiché avant ce fix. Pas de classe A/B/C
          // au sens strict dans ce système (cf. audit : seuls les articles DANS le seuil configuré
          // sont proposés, il n'y a jamais de "classe B/C" distincte) — le cumul lui-même, sur la
          // même période d'analyse que le Pareto, est l'équivalent direct demandé.
          headerName: 'Pareto (cumul)',
          field: 'cumulativePct',
          type: 'numericColumn',
          filter: 'agNumberColumnFilter',
          width: 140,
          hide: true,
          headerTooltip: "Cumul du chiffre d'affaires sur la période d'analyse (Pareto), pas la fenêtre courte du % CA à gauche.",
          valueFormatter: (p: any) => (p.value !== null && p.value !== undefined ? p.value.toFixed(1) + ' %' : '—'),
        },
        {
          // En DLV (colonne dédiée, demande du 30/09/2026) — en plus du badge déjà affiché dans la
          // cellule Stock actuel. Groupée ici avec Casse/perte (autre info "stock/mouvements"), avant
          // le bloc "commande" ci-dessous.
          headerName: 'En DLV',
          field: 'dlvStock',
          type: 'numericColumn',
          filter: 'agNumberColumnFilter',
          width: 100,
          hide: true,
          valueFormatter: (p: any) => (p.value ? Number(p.value).toFixed(1) : '—'),
        },
        {
          // Quantité perdue en casse/péremption/vol sur la période d'analyse (demande du
          // 30/09/2026) — calculée pour tous les articles côté backend (stockMoveAnalysisService),
          // pas seulement ceux déjà signalés en anomalie.
          headerName: 'Casse/perte',
          field: 'scrapQuantity',
          type: 'numericColumn',
          filter: 'agNumberColumnFilter',
          width: 110,
          hide: true,
          headerTooltip: 'Quantité perdue en casse, péremption ou vol constatée sur la période analysée (mouvements RPOS isScrap).',
          valueFormatter: (p: any) => (p.value ? Number(p.value).toFixed(1) : '—'),
        },
        {
          // Quantité déjà commandée/en transit (spec §2 : "quantité déjà commandée / en cours de
          // commande") — currentOrderedQuantity est déjà persisté (cumul RPOS + plateforme, cf.
          // proposalService.js orderedQty) mais jamais affiché en colonne avant ce fix ; seul un
          // badge apparaissait quand l'article était totalement exclu de la proposition pour cette
          // raison (labelCellRenderer). Ici visible pour TOUT article, même partiellement couvert.
          headerName: 'Déjà commandé',
          field: 'currentOrderedQuantity',
          type: 'numericColumn',
          filter: 'agNumberColumnFilter',
          width: 140,
          hide: true,
          valueFormatter: (p: any) => (p.value !== null && p.value !== undefined && p.value > 0 ? p.value.toLocaleString('fr-FR') : '—'),
        },
        {
          // Référence + date de la commande RPOS déjà en cours, en colonne dédiée (demande du
          // 30/09/2026) — en plus du badge déjà affiché dans la cellule Article/Déjà commandé, pas à
          // sa place : voir d'un coup d'œil si une commande est déjà passée sans ouvrir de détail.
          colId: 'orderReference',
          headerName: 'Réf. commande',
          width: 170,
          hide: true,
          filter: 'agTextColumnFilter',
          valueGetter: (p: any) => (p.data as ProposalLine).rposOrderReference || '',
          cellRenderer: (p: any) => {
            const l = p.data as ProposalLine;
            if (!l.rposOrderReference) return '<span class="text-muted">—</span>';
            const dateStr = l.rposOrderDate ? new Date(l.rposOrderDate).toLocaleDateString('fr-FR') : '';
            return `${l.rposOrderReference}${dateStr ? ` (${dateStr})` : ''}`;
          },
        },
      ],
      rowData: [],
      localeText: window.AG_GRID_LOCALE_FR,
      domLayout: 'autoHeight',
      // Pagination client-side (AG Grid) : un filtre s'applique TOUJOURS sur l'intégralité des lignes
      // chargées, jamais seulement sur la page affichée — la pagination ne fait que limiter combien
      // de résultats déjà filtrés sont montrés à la fois, jamais quelles lignes sont cherchées.
      pagination: true,
      paginationPageSize: 10,
      paginationPageSizeSelector: [10, 25, 50, 100, 200],
      animateRows: false,
      suppressCellFocus: true,
      getRowId: (params: any) => params.data.id,
      // `resize` explicite (même remède que ai-predictions.html) : évite un espace vide sous le
      // tableau quand un filtre réduit fortement le nombre de lignes visibles, domLayout 'autoHeight'
      // ne re-mesurant pas toujours seul sa hauteur après un changement de modèle/page.
      onPaginationChanged: () => {
        loadLastPurchasesAutomatically();
        requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
      },
      onModelUpdated: () => {
        requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
      },
      onCellClicked: (e: any) => {
        // Seule branche restante depuis la refonte du 30/09/2026 : les badges/bouton "Débloquer" et
        // "Commande suffisante" ne sont plus dans le DOM de la cellule Article (déplacés dans
        // ArticleDetailModal, ouvert par onRowClicked ci-dessous) — .pa-open-btn reste le seul élément
        // interactif propre à cette cellule, avec son propre comportement (ouvre directement le
        // graphique, sans passer par le panneau de détail).
        const target = e.event.target as HTMLElement;
        const paBtn = target.closest?.('.pa-open-btn') as HTMLButtonElement | null;
        if (paBtn) {
          onOpenAnalytics({ ean: paBtn.dataset.ean || '', productId: paBtn.dataset.productId || '', label: e.data.label });
        }
      },
      // Clic sur la ligne entière ouvre le panneau de détail (demande du 30/09/2026), sauf sur les
      // zones déjà interactives : case à cocher (pinned left), bouton graphique (garde son
      // comportement propre via onCellClicked ci-dessus), bouton "Analyser" IA, inputs de quantité.
      onRowClicked: (e: any) => {
        const target = e.event?.target as HTMLElement | null;
        if (target?.closest?.('input[type="checkbox"]')) return;
        if (target?.closest?.('.pa-open-btn')) return;
        if (target?.closest?.('input[type="number"]')) return;
        if (target?.closest?.('.ai-analyze-btn')) return;
        onOpenArticleDetail(e.data as ProposalLine);
      },
      // Force AG Grid à re-mesurer la largeur réelle de son conteneur juste après le montage : en
      // navigation SPA (history.pushState, sans rechargement complet de la page), le calcul initial
      // des colonnes peut avoir lieu avant que la sidebar/topbar aient fini de se stabiliser après le
      // changement de vue, produisant des colonnes EAN/Article visuellement chevauchées — jamais
      // reproduit sur l'ancienne page HTML, qui recharge entièrement le DOM à chaque navigation et
      // ne mesure donc jamais un conteneur encore en transition (bug constaté le 24/09/2026).
      onGridReady: () => {
        // Restaure l'ordre/largeur des colonnes choisi par l'utilisateur lors d'une session
        // précédente (demande du 30/09/2026 : "si j'ai modifié l'ordre une fois, il faut pouvoir la
        // sauvegarder, ne pas réinitialiser quand je sors") — stocké en localStorage, partagé entre
        // tous les magasins/propositions (c'est une préférence d'affichage, pas une donnée métier).
        try {
          const saved = localStorage.getItem(COLUMN_STATE_STORAGE_KEY);
          if (saved) gridApiRef.current?.applyColumnState({ state: JSON.parse(saved), applyOrder: true });
        } catch {
          // localStorage indisponible ou JSON corrompu : la grille garde simplement l'ordre par défaut.
        }
        // AG Grid mesure son propre conteneur via un ResizeObserver interne, mais si la sidebar ou
        // la topbar continuent d'animer/se stabiliser juste après ce montage (navigation SPA), sa
        // première mesure peut être prise sur une largeur transitoire sans qu'un nouveau resize ne
        // soit jamais détecté ensuite. Un `resize` explicite, après laisser le DOM se stabiliser,
        // force AG Grid à re-mesurer une dernière fois sur la largeur réellement finale.
        requestAnimationFrame(() => {
          setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
        });
        // Synchronise la largeur du faux contenu de la barre du haut sur la largeur scrollable
        // réelle du tableau (le viewport horizontal natif ag-grid, .ag-body-horizontal-scroll-*).
        // Recalculée à chaque resize/changement de colonnes visibles, pas seulement au montage.
        const syncTopScrollWidth = () => {
          const nativeContainer = gridDivRef.current?.querySelector('.ag-body-horizontal-scroll-container') as HTMLElement | null;
          if (nativeContainer && topScrollInnerRef.current) {
            topScrollInnerRef.current.style.width = nativeContainer.style.width || `${nativeContainer.scrollWidth}px`;
          }
        };
        requestAnimationFrame(syncTopScrollWidth);
        window.addEventListener('resize', syncTopScrollWidth);
        gridApiRef.current?.addEventListener('columnVisible', syncTopScrollWidth);
        gridApiRef.current?.addEventListener('gridSizeChanged', syncTopScrollWidth);

        // Répercute le scroll de la barre du haut sur le viewport natif ag-grid (pas d'API publique
        // pour positionner le scroll horizontal en pixels — on manipule directement le DOM natif,
        // comme onBodyScroll ci-dessous le fait dans l'autre sens).
        const nativeViewport = gridDivRef.current?.querySelector('.ag-body-horizontal-scroll-viewport') as HTMLElement | null;
        topScrollRef.current?.addEventListener('scroll', () => {
          if (syncingScrollRef.current || !nativeViewport || !topScrollRef.current) return;
          syncingScrollRef.current = true;
          nativeViewport.scrollLeft = topScrollRef.current.scrollLeft;
          syncingScrollRef.current = false;
        });
      },
      onBodyScroll: (e: any) => {
        // Répercute le scroll natif ag-grid (souris/trackpad/scrollbar du bas) sur la barre du haut,
        // sans déclencher en retour son propre handler 'scroll' (cf. syncingScrollRef ci-dessous).
        if (syncingScrollRef.current || !topScrollRef.current) return;
        syncingScrollRef.current = true;
        topScrollRef.current.scrollLeft = e.left;
        syncingScrollRef.current = false;
      },
      // Sauvegarde l'ordre/largeur des colonnes à chaque changement manuel de l'utilisateur (glisser
      // une colonne, redimensionner) — persistant tant qu'il n'a pas été explicitement réinitialisé.
      onColumnMoved: (e: any) => { if (e.finished) saveColumnState(); },
      onColumnResized: (e: any) => { if (e.finished) saveColumnState(); },
    });
    function saveColumnState() {
      try {
        const state = gridApiRef.current?.getColumnState();
        if (state) localStorage.setItem(COLUMN_STATE_STORAGE_KEY, JSON.stringify(state));
      } catch {
        // localStorage indisponible (navigation privée, quota atteint...) : l'ordre choisi ne
        // survivra pas à cette session, mais la grille reste pleinement utilisable.
      }
    }
    if (toolbarRef.current) {
      // reassortAgGridToolbar AJOUTE ses boutons sans jamais vider le conteneur au préalable (voir
      // ag-grid-toolbar.js) — filet de sécurité en plus du useMemo sur `lines` côté PurchaseOrder.tsx
      // qui évite l'essentiel des recréations de grille : si ensureGrid() est malgré tout rappelé
      // sur ce même conteneur, on repart d'un conteneur vide plutôt que d'empiler les boutons
      // Colonnes/Filtres à l'infini (bug constaté le 24/09/2026).
      toolbarRef.current.innerHTML = '';
      window.reassortAgGridToolbar(gridApiRef.current, toolbarRef.current);
    }
    return gridApiRef.current;
  }

  async function loadLastPurchasesAutomatically() {
    const spans = Array.from(document.querySelectorAll<HTMLSpanElement>('.last-purchase-result'));
    const CONCURRENCY = 5;
    let index = 0;

    async function worker() {
      while (index < spans.length) {
        const span = spans[index++];
        const saleSpan = document.querySelector<HTMLSpanElement>(`.last-sale-result[data-product-id="${span.dataset.productId}"]`);
        try {
          const data = await apiFetch<{ lastPurchase: { date: string; quantity: number } | null; lastSale: { date: string; quantity: number } | null }>(
            `/reassort/product/${span.dataset.productId}/last-purchase?${shopQueryParam}&ean=${encodeURIComponent(span.dataset.ean || '')}`,
          );
          span.textContent = data.lastPurchase ? `${new Date(data.lastPurchase.date).toLocaleDateString('fr-FR')} — qté ${data.lastPurchase.quantity}` : 'Aucun achat trouvé';
          if (saleSpan) {
            saleSpan.textContent = data.lastSale ? `${new Date(data.lastSale.date).toLocaleDateString('fr-FR')} — qté ${data.lastSale.quantity}` : 'Aucune vente trouvée';
          }
        } catch {
          span.textContent = 'Erreur';
          if (saleSpan) saleSpan.textContent = 'Erreur';
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  }

  useImperativeHandle(ref, () => ({
    getDecisions() {
      // Toutes les lignes de LA PROPOSITION ENTIÈRE, pas seulement `lines` (filtrées par rayon
      // sélectionné) : reproduit le comportement de l'ancienne page HTML (validateProposal), où une
      // ligne jamais affichée dans cette session garde sa valeur par défaut (quantitySuggested,
      // incluse ssi > 0) au lieu d'être silencieusement absente de la commande envoyée à RPOS — bug
      // constaté le 24/09/2026 : valider depuis la vue d'un seul rayon envoyait une commande sans les
      // articles des autres rayons de la même proposition.
      const allLines = proposal ? proposal.lines : lines;
      return allLines.map((l) => {
        const st = getLineState(l);
        return { lineId: l.id, quantity: st.quantity, excluded: st.excluded, price: l.sellingPrice || 0 };
      });
    },
    // Décisions du RAYON PRÉCIS demandé uniquement (demande du 26/09/2026 : validation indépendante
    // par rayon) — contrairement à getDecisions() ci-dessus, jamais les autres rayons de la
    // proposition : l'API /validate-department attend explicitement les lignes d'UN SEUL rayon.
    getDecisionsForDepartment(department: string) {
      const allLines = proposal ? proposal.lines : lines;
      return allLines
        .filter((l) => (l.department || 'Sans rayon') === department)
        .map((l) => {
          const st = getLineState(l);
          return { lineId: l.id, quantity: st.quantity, excluded: st.excluded, price: l.sellingPrice || 0 };
        });
    },
    selectAllToggle() {
      const allExcluded = lines.every((l) => getLineState(l).excluded);
      lines.forEach((l) => {
        getLineState(l).excluded = !allExcluded;
      });
      gridApiRef.current?.refreshCells({ force: true });
      updateOrderTotal();
    },
    exportCsv(shopReference: string) {
      if (!gridApiRef.current) return;
      gridApiRef.current.exportDataAsCsv({
        fileName: `proposition-commande-${shopReference}-${new Date().toISOString().slice(0, 10)}.csv`,
      });
    },
    unblockLine,
  }));

  useEffect(() => {
    // Le filtre de colonne actif (ex: filtrer "Article" sur "Eau" dans le rayon Liquides) vit dans
    // l'instance AG Grid elle-même — détruite et recréée à chaque rafraîchissement (bouton
    // "Actualiser", qui redonne une nouvelle référence à `lines` via le useMemo de PurchaseOrder.tsx)
    // puisque `ensureGrid()` reconstruit tout de zéro. Sans le sauvegarder avant destruction (dans le
    // cleanup de l'effet PRÉCÉDENT, seul moment où l'ancienne instance existe encore) et le
    // réappliquer ici, actualiser pendant qu'un filtre est actif l'effaçait silencieusement, donnant
    // l'impression à l'utilisateur de "revenir en arrière" vers la liste complète du rayon (bug
    // constaté le 24/09/2026).
    const filterModelToRestore = pendingFilterModelRef.current;
    pendingFilterModelRef.current = null;
    lineStateRef.current.clear();
    const api = ensureGrid();
    if (!api) return;
    api.setGridOption('rowData', lines);
    if (filterModelToRestore && Object.keys(filterModelToRestore).length) {
      api.setFilterModel(filterModelToRestore);
    }
    loadLastPurchasesAutomatically();
    updateOrderTotal();
    return () => {
      if (gridApiRef.current) {
        pendingFilterModelRef.current = gridApiRef.current.getFilterModel();
        gridApiRef.current.destroy();
        gridApiRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines]);

  return (
    <div>
      <div ref={toolbarRef} className="d-flex gap-2 mb-2"></div>
      <div ref={topScrollRef} className="reassort-grid-top-scroll">
        <div ref={topScrollInnerRef}></div>
      </div>
      <div ref={gridDivRef} id="reassort-grid"></div>
    </div>
  );
});
