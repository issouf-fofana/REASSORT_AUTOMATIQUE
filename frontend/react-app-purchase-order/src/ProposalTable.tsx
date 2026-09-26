import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { apiFetch } from './api/client';
import type { LineState, Proposal, ProposalLine } from './types';

export interface ProposalTableHandle {
  getDecisions: () => { lineId: string; quantity: number; excluded: boolean; price: number }[];
  getDecisionsForDepartment: (department: string) => { lineId: string; quantity: number; excluded: boolean; price: number }[];
  selectAllToggle: () => void;
  exportCsv: (shopReference: string) => void;
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

function labelCellRenderer(params: any) {
  const l = params.data as ProposalLine;
  const wrap = document.createElement('div');
  wrap.style.lineHeight = '1.35';
  wrap.style.padding = '.35rem 0';
  let html = `<span style="font-size:.86rem;">${l.label}</span>`;
  html += ` <button type="button" class="btn btn-sm btn-link p-0 ms-1 pa-open-btn" data-ean="${l.ean}" data-product-id="${l.productId}" title="Voir l'évolution de cet article"><iconify-icon icon="solar:chart-2-bold-duotone"></iconify-icon></button>`;

  if (l.excludedAsAlreadyOrdered) {
    html += `<br><span class="badge bg-info-subtle text-info mt-1 reassort-mini-badge" title="Déjà en commande sur cette plateforme, pas encore reçue"><iconify-icon icon="solar:box-bold-duotone"></iconify-icon> Déjà commandé (qté ${l.quantityInTransit || 0})${l.platformOrderReference ? ` — cmd ${l.platformOrderReference}` : ''}${l.platformOrderDate ? ` du ${new Date(l.platformOrderDate).toLocaleDateString('fr-FR')}` : ''}</span>`;
  } else if (l.excludedAsAlreadyOrderedRpos) {
    const statusLabel = l.rposOrderStatus === 2 ? ' — validée' : l.rposOrderStatus === 1 ? ' — en préparation (pas encore validée)' : l.rposOrderStatus === 6 ? ' — annulée' : '';
    html += `<br><span class="badge bg-secondary-subtle text-secondary mt-1 reassort-mini-badge" title="Commande(s) RPOS des 7 derniers jours, hors de cette plateforme."><iconify-icon icon="solar:box-bold-duotone"></iconify-icon> Commandé le ${l.rposOrderDate ? new Date(l.rposOrderDate).toLocaleDateString('fr-FR') : '?'}${l.rposOrderReference ? ` (réf. ${l.rposOrderReference})` : ''}${l.rposOrderCount && l.rposOrderCount > 1 ? ` + ${l.rposOrderCount - 1} autre(s)` : ''}${statusLabel}</span><br><button type="button" class="btn btn-sm btn-warning mt-1 reassort-unblock-btn" data-line-id="${l.id}" data-quantity="${l.quantityIfUnblocked || l.quantitySuggested || 0}"><iconify-icon icon="solar:lock-keyhole-unlocked-bold-duotone"></iconify-icon> Débloquer et commander quand même</button>`;
  }

  if (l.orderAnomaly) {
    html += `<br><span class="badge ${l.orderAnomaly.direction === 'HIGH' ? 'bg-warning-subtle text-warning' : 'bg-danger-subtle text-danger'} mt-1 reassort-mini-badge" title="Habituellement entre ${l.orderAnomaly.historicalMin.toFixed(0)} et ${l.orderAnomaly.historicalMax.toFixed(0)} (moyenne ${l.orderAnomaly.historicalMean.toFixed(0)}, sur ${l.orderAnomaly.sampleSize} commande(s) passée(s))"><iconify-icon icon="solar:danger-triangle-bold-duotone"></iconify-icon> ${l.orderAnomaly.direction === 'HIGH' ? 'Quantité inhabituellement élevée' : 'Quantité inhabituellement faible'}</span>`;
  }

  if (l.orderSufficiencyReasoning) {
    html += `<br><span class="badge ${l.orderSufficient === false ? 'bg-warning-subtle text-warning' : 'bg-success-subtle text-success'} mt-1 os-badge reassort-mini-badge" style="cursor:pointer;" data-reasoning="${l.orderSufficiencyReasoning.replace(/"/g, '&quot;')}">${l.orderSufficient === false ? '<iconify-icon icon="solar:danger-triangle-bold-duotone"></iconify-icon> Commande insuffisante' : '<iconify-icon icon="solar:check-circle-bold-duotone"></iconify-icon> Commande suffisante'}</span>`;
  }

  wrap.innerHTML = html;
  return wrap;
}

function stockCellRenderer(params: any) {
  const l = params.data as ProposalLine;
  const unreliableStock = !!l.hadNegativeStock;
  const stockValue = unreliableStock && l.actualStock !== null && l.actualStock !== undefined ? l.actualStock : l.stockAtGeneration;
  const wrap = document.createElement('div');
  let html = stockValue !== null && stockValue !== undefined ? (stockValue < 0 ? `<span class="text-danger fw-semibold">${stockValue.toFixed(1)}</span>` : stockValue.toFixed(1)) : '—';
  if (unreliableStock) {
    html += `<br><span class="badge reassort-mini-badge bg-warning-subtle text-warning mt-1" title="Ne se corrige que par une intégration de facture ou un inventaire physique côté RPOS"><iconify-icon icon="solar:danger-triangle-bold-duotone"></iconify-icon> Stock non fiable</span>`;
  }
  if (l.dlvStock) {
    html += `<br><span class="badge reassort-mini-badge bg-info-subtle text-info mt-1" title="Stock retiré du calcul car basculé en DLV (vente à prix réduit sur un EAN séparé)"><iconify-icon icon="solar:tag-price-bold-duotone"></iconify-icon> ${l.dlvStock.toFixed(1)} en DLV</span>`;
  }
  wrap.innerHTML = html;
  return wrap;
}

function avgSalesCellRenderer(params: any) {
  const l = params.data as ProposalLine;
  const wrap = document.createElement('div');
  if (l.avgWeeklySales === null || l.avgWeeklySales === undefined) {
    wrap.textContent = '—';
    return wrap;
  }
  let html = l.avgWeeklySales.toFixed(1);
  if (l.seasonalityAdjusted) {
    html += `<br><span class="badge reassort-mini-badge bg-info-subtle text-info mt-1" title="Ajustée par rapport à la même période l'année dernière (écart ${l.seasonalityDeviationPct !== null && l.seasonalityDeviationPct !== undefined ? l.seasonalityDeviationPct.toFixed(0) + '%' : '?'})"><iconify-icon icon="solar:calendar-bold-duotone"></iconify-icon> Saisonnalité</span>`;
  }
  if (l.forecastMethod === 'smoothed') {
    html += `<br><span class="badge reassort-mini-badge bg-success-subtle text-success mt-1" title="Prévision par lissage exponentiel : donne plus de poids aux ventes récentes qu'à une moyenne plate"><iconify-icon icon="solar:chart-2-bold-duotone"></iconify-icon> Prévision lissée</span>`;
  }
  if (l.weekdayAdjusted) {
    html += `<br><span class="badge reassort-mini-badge bg-primary-subtle text-primary mt-1" title="La quantité tient compte du profil de vente par jour de semaine de cet article (ex: samedi plus fort), pas d'une répartition uniforme sur la semaine"><iconify-icon icon="solar:calendar-mark-bold-duotone"></iconify-icon> Jour de semaine</span>`;
  }
  wrap.innerHTML = html;
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
  const badgeClass = days <= 3 ? 'bg-danger-subtle text-danger' : days <= 7 ? 'bg-warning-subtle text-warning' : 'bg-success-subtle text-success';
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
  onOpenSufficiency: (reasoning: string) => void;
}>(function ProposalTable({
  proposal,
  lines,
  shopId,
  shopQueryParam,
  readOnly,
  onOpenAnalytics,
  onTotalChange,
  onOpenSufficiency,
}, ref) {
  const gridDivRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const gridApiRef = useRef<any>(null);
  const lineStateRef = useRef<Map<string, LineState>>(new Map());
  const pendingFilterModelRef = useRef<Record<string, unknown> | null>(null);

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
    btn.className = 'btn btn-sm btn-outline-dark';
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
      rowHeight: 44,
      headerHeight: 34,
      headerFontSize: 11,
      dataFontSize: 13,
      cellHorizontalPadding: 10,
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
        { headerName: '#', valueGetter: (p: any) => p.node.rowIndex + 1, width: 60, sortable: false, filter: false },
        { headerName: 'EAN', field: 'ean', width: 130, filter: 'agTextColumnFilter' },
        { headerName: 'Article', field: 'label', flex: 2, minWidth: 260, filter: 'agTextColumnFilter', autoHeight: true, wrapText: true, cellRenderer: labelCellRenderer },
        {
          headerName: 'Prix vente',
          field: 'sellingPrice',
          type: 'numericColumn',
          filter: 'agNumberColumnFilter',
          width: 120,
          valueFormatter: (p: any) => (p.value ? p.value.toLocaleString('fr-FR') + ' CFA' : '—'),
        },
        { headerName: 'Vente moy./sem.', field: 'avgWeeklySales', type: 'numericColumn', filter: 'agNumberColumnFilter', width: 150, autoHeight: true, cellRenderer: avgSalesCellRenderer },
        { headerName: 'Stock actuel', field: 'stockAtGeneration', type: 'numericColumn', filter: 'agNumberColumnFilter', width: 140, autoHeight: true, cellRenderer: stockCellRenderer },
        { headerName: 'Rupture dans', field: 'daysUntilStockout', type: 'numericColumn', filter: 'agNumberColumnFilter', width: 130, cellRenderer: stockoutCellRenderer },
        {
          headerName: 'Dernier achat',
          width: 170,
          sortable: false,
          filter: false,
          cellRenderer: lastPurchaseCellRenderer,
          valueGetter: (p: any) => {
            const el = document.querySelector(`.last-purchase-result[data-product-id="${p.data.productId}"]`);
            return el ? el.textContent : '';
          },
        },
        {
          headerName: 'Dernière vente',
          width: 170,
          sortable: false,
          filter: false,
          cellRenderer: lastSaleCellRenderer,
          valueGetter: (p: any) => {
            const el = document.querySelector(`.last-sale-result[data-product-id="${p.data.productId}"]`);
            return el ? el.textContent : '';
          },
        },
        {
          headerName: '% CA magasin',
          field: 'revenueSharePct',
          type: 'numericColumn',
          filter: 'agNumberColumnFilter',
          width: 130,
          valueFormatter: (p: any) => (p.value !== null && p.value !== undefined ? p.value.toFixed(2) + ' %' : '—'),
        },
        { headerName: 'IA', width: 130, sortable: false, filter: false, cellRenderer: aiCellRenderer, valueGetter: () => '' },
        {
          headerName: 'Qté proposée',
          type: 'numericColumn',
          width: 170,
          sortable: false,
          filter: false,
          cellRenderer: qtyCellRenderer,
          valueGetter: (p: any) => getLineState(p.data).quantity,
        },
        {
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
        const target = e.event.target as HTMLElement;
        const unblockBtn = target.closest?.('.reassort-unblock-btn') as HTMLButtonElement | null;
        if (unblockBtn && !readOnly) {
          const quantity = parseFloat(unblockBtn.dataset.quantity || '0') || 0;
          const st = getLineState(e.data);
          st.quantity = quantity;
          st.excluded = false;
          unblockBtn.disabled = true;
          unblockBtn.innerHTML = '<iconify-icon icon="solar:check-circle-bold-duotone"></iconify-icon> Débloqué — inclus dans la commande';
          unblockBtn.classList.remove('btn-warning');
          unblockBtn.classList.add('btn-success');
          gridApiRef.current?.refreshCells({ rowNodes: [e.node], force: true });
          updateOrderTotal();
          return;
        }
        const paBtn = target.closest?.('.pa-open-btn') as HTMLButtonElement | null;
        if (paBtn) {
          onOpenAnalytics({ ean: paBtn.dataset.ean || '', productId: paBtn.dataset.productId || '', label: e.data.label });
          return;
        }
        const osBadge = target.closest?.('.os-badge') as HTMLElement | null;
        if (osBadge) {
          onOpenSufficiency(osBadge.dataset.reasoning || '');
        }
      },
      // Force AG Grid à re-mesurer la largeur réelle de son conteneur juste après le montage : en
      // navigation SPA (history.pushState, sans rechargement complet de la page), le calcul initial
      // des colonnes peut avoir lieu avant que la sidebar/topbar aient fini de se stabiliser après le
      // changement de vue, produisant des colonnes EAN/Article visuellement chevauchées — jamais
      // reproduit sur l'ancienne page HTML, qui recharge entièrement le DOM à chaque navigation et
      // ne mesure donc jamais un conteneur encore en transition (bug constaté le 24/09/2026).
      onGridReady: () => {
        // AG Grid mesure son propre conteneur via un ResizeObserver interne, mais si la sidebar ou
        // la topbar continuent d'animer/se stabiliser juste après ce montage (navigation SPA), sa
        // première mesure peut être prise sur une largeur transitoire sans qu'un nouveau resize ne
        // soit jamais détecté ensuite. Un `resize` explicite, après laisser le DOM se stabiliser,
        // force AG Grid à re-mesurer une dernière fois sur la largeur réellement finale.
        requestAnimationFrame(() => {
          setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
        });
      },
    });
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
      <div ref={gridDivRef} id="reassort-grid"></div>
    </div>
  );
});
