// Panneau partagé "Recommandation IA" — utilisé sur ai-predictions.html et purchase-order.html.
// API publique : window.openAiRecommendationPanel({ proposalId, ean, label, predictedQuantity,
// predictedWeeklyDemand, stockAtPrediction, ordersAtPrediction, confidenceScore, reasoning,
// dailyHistory, outcome, shopId, onApply(quantity) }).
//
// Comportement voulu (cf. demande explicite) : l'écran principal du panneau ne montre QUE la
// recommandation de l'IA (lancée automatiquement à l'ouverture) et un champ de quantité modifiable
// — jamais les calculs internes (score de confiance, quantité du calcul classique, signaux...) en
// premier plan. Ces données restent disponibles, mais uniquement derrière le bouton "Pourquoi ?".
(function () {
  const CSS = `
    .aip-panel-backdrop { position: fixed; inset: 0; background-color: rgba(0,0,0,.4); z-index: 1040; }
    .aip-detail-panel {
      position: fixed; top: 0; right: 0; bottom: 0; width: 480px; max-width: 92vw;
      background-color: #ffffff; z-index: 1045; box-shadow: -4px 0 16px rgba(0,0,0,.15);
      transform: translateX(100%); transition: transform .25s ease;
      display: flex; flex-direction: column;
    }
    .aip-detail-panel.show { transform: translateX(0); }
    .aip-detail-panel-header { display: flex; align-items: center; justify-content: space-between; padding: 1rem 1.25rem; flex-shrink: 0; }
    .aip-detail-panel-body { padding: 1.25rem; overflow-y: auto; flex-grow: 1; }
    .aip-period-btn.active { background-color: #000000 !important; color: #ffffff !important; border-color: #000000 !important; }

    .aip-simple-view { display: flex; flex-direction: column; gap: 1.25rem; }
    .aip-reco-card { background-color: #000000; color: #ffffff; padding: 1.75rem 1.5rem; text-align: center; }
    .aip-reco-card .aip-reco-eyebrow { font-size: .7rem; letter-spacing: .1em; text-transform: uppercase; color: #999999; margin-bottom: .75rem; }
    .aip-reco-card .aip-reco-eyebrow iconify-icon { vertical-align: -2px; margin-right: .35rem; }
    .aip-reco-card .aip-reco-headline { font-size: 1.05rem; line-height: 1.5; margin-bottom: 1.25rem; }
    .aip-reco-card .aip-reco-headline strong { font-size: 1.3rem; }
    .aip-reco-card .aip-reco-quantity { font-size: 3.5rem; font-weight: 700; line-height: 1; }
    .aip-reco-card .aip-reco-quantity-unit { font-size: .8rem; color: #999999; letter-spacing: .04em; text-transform: uppercase; margin-top: .35rem; }

    .aip-why-btn { display: block; width: 100%; background: none; border: 1px solid #000000; color: #000000; padding: .65rem; font-size: .85rem; font-weight: 600; letter-spacing: .02em; }
    .aip-why-btn:hover { background-color: #000000; color: #ffffff; }

    .aip-order-qty-card { border: 1px solid #e5e5e5; padding: 1.25rem; }
    .aip-order-qty-card label { font-size: .75rem; letter-spacing: .04em; text-transform: uppercase; color: #666; display: block; margin-bottom: .5rem; }
    .aip-order-qty-card .input-group input { font-size: 1.4rem; font-weight: 600; text-align: center; }
    .aip-order-qty-hint { font-size: .75rem; color: #999; margin-top: .5rem; }
    .aip-order-qty-hint.aip-qty-changed { color: #000; font-weight: 600; }

    .aip-ai-loading { border: 1px solid #000000; padding: 2rem 1.5rem; text-align: center; }
    .aip-ai-loading .aip-scan-bar { height: 3px; background: linear-gradient(90deg, transparent, #000000, transparent); background-size: 200% 100%; animation: aip-scan 1.4s linear infinite; margin-bottom: 1.25rem; }
    @keyframes aip-scan { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    .aip-ai-loading .aip-loading-label { font-size: .85rem; letter-spacing: .04em; text-transform: uppercase; color: #333; font-weight: 600; }
    .aip-ai-loading .aip-loading-detail { font-size: .8rem; color: #999; margin-top: .5rem; }
    @media (prefers-reduced-motion: reduce) { .aip-scan-bar { animation: none; background: #000000; } }

    .aip-ai-error-card { border: 1px solid #666666; padding: 1.5rem; text-align: center; }
    .aip-ai-error-card .aip-ai-retry { margin-top: .75rem; }

    .aip-detail-view { display: none; }
    .aip-detail-view.show { display: block; }
    .aip-simple-view.hide { display: none; }
    .aip-back-btn { display: flex; align-items: center; gap: .4rem; background: none; border: none; padding: 0; font-size: .85rem; font-weight: 600; color: #000000; margin-bottom: 1.25rem; }
    .aip-detail-section { margin-bottom: 1.5rem; }
    .aip-detail-section h6 { font-size: .75rem; letter-spacing: .06em; text-transform: uppercase; color: #666; margin-bottom: .65rem; }
    .aip-reasoning-block { border-left: 3px solid #000000; padding: .1rem 1rem; font-size: .9rem; line-height: 1.6; }

    .aip-classic-card { background-color: #f5f5f5; border: 1px solid #e5e5e5; padding: 1rem 1.25rem; }
    .aip-classic-card .aip-classic-eyebrow { font-size: .7rem; letter-spacing: .08em; text-transform: uppercase; color: #999; margin-bottom: .5rem; }

    .aip-signal-row { display: flex; align-items: center; gap: .5rem; margin-bottom: .5rem; }
    .aip-signal-label { width: 150px; flex-shrink: 0; font-size: .8rem; color: #666; }
    .aip-signal-bar { height: 8px; border-radius: 0; background-color: #e5e5e5; flex-grow: 1; overflow: hidden; }
    .aip-signal-bar-fill { height: 100%; background-color: #000000; }
    .aip-signal-value { width: 40px; text-align: right; font-size: .8rem; font-weight: 600; }
  `;

  function ensureStylesAndDom() {
    if (!document.getElementById('aip-shared-styles')) {
      const style = document.createElement('style');
      style.id = 'aip-shared-styles';
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    if (!document.getElementById('aip-detail-panel')) {
      const backdrop = document.createElement('div');
      backdrop.id = 'aip-detail-backdrop';
      backdrop.className = 'aip-panel-backdrop';
      backdrop.hidden = true;

      const panel = document.createElement('div');
      panel.id = 'aip-detail-panel';
      panel.className = 'aip-detail-panel';
      panel.setAttribute('aria-hidden', 'true');
      panel.innerHTML =
        '<div class="aip-detail-panel-header border-bottom">' +
          '<h5 class="mb-0" id="aip-detail-title">Détail</h5>' +
          '<button type="button" class="btn-close" id="aip-detail-close" aria-label="Fermer"></button>' +
        '</div>' +
        '<div class="aip-detail-panel-body" id="aip-detail-body"></div>';

      document.body.appendChild(backdrop);
      document.body.appendChild(panel);

      function hide() {
        panel.classList.remove('show');
        panel.setAttribute('aria-hidden', 'true');
        setTimeout(function () { backdrop.hidden = true; }, 250);
      }
      document.getElementById('aip-detail-close').addEventListener('click', hide);
      backdrop.addEventListener('click', hide);
    }
  }

  let aiAnalysisToken = 0;
  let currentItem = null;
  let currentAiResult = null;

  function aiLoadingHtml() {
    return '<div class="aip-ai-loading">' +
      '<div class="aip-scan-bar"></div>' +
      '<div class="aip-loading-label">L\'IA analyse cet article</div>' +
      '<div class="aip-loading-detail">Historique de ventes, stock actuel, commandes en cours&hellip;</div>' +
      '</div>';
  }

  function aiErrorHtml(message) {
    return '<div class="aip-ai-error-card">' +
      '<p class="small mb-0"><strong>L\'analyse IA a échoué :</strong> ' + message + '</p>' +
      '<button type="button" class="btn btn-outline-dark btn-sm aip-ai-retry" id="aip-ai-retry-btn">Réessayer</button>' +
      '</div>';
  }

  function aiReadyHtml(d) {
    return '<div class="aip-reco-card">' +
        '<div class="aip-reco-eyebrow"><iconify-icon icon="solar:magic-stick-3-bold"></iconify-icon>Recommandation IA</div>' +
        '<div class="aip-reco-headline">Pour cet article, l\'IA recommande de commander <strong>' + d.quantity + ' unité(s)</strong> pour la semaine à venir.</div>' +
        '<div class="aip-reco-quantity">' + d.quantity + '</div>' +
        '<div class="aip-reco-quantity-unit">unités recommandées</div>' +
      '</div>' +
      '<button type="button" class="aip-why-btn" id="aip-why-btn">Pourquoi ?</button>' +
      '<div class="aip-order-qty-card">' +
        '<label for="aip-order-qty-input">Quantité à commander</label>' +
        '<div class="input-group">' +
          '<input type="number" min="0" step="1" class="form-control" id="aip-order-qty-input" value="' + d.quantity + '">' +
          '<button type="button" class="btn btn-dark" id="aip-order-qty-save">Appliquer</button>' +
        '</div>' +
        '<div class="aip-order-qty-hint" id="aip-order-qty-hint">L\'IA recommande ' + d.quantity + ' — vous pouvez commander moins ou plus selon votre jugement.</div>' +
      '</div>';
  }

  function wireSimpleViewEvents(item) {
    const whyBtn = document.getElementById('aip-why-btn');
    if (whyBtn) whyBtn.addEventListener('click', function () { showDetailView(item); });

    const qtyInput = document.getElementById('aip-order-qty-input');
    const qtyHint = document.getElementById('aip-order-qty-hint');
    const qtySaveBtn = document.getElementById('aip-order-qty-save');
    if (qtyInput && currentAiResult) {
      qtyInput.addEventListener('input', function () {
        const val = parseInt(qtyInput.value, 10);
        if (Number.isFinite(val) && val !== currentAiResult.quantity) {
          qtyHint.textContent = 'Écart de ' + (val > currentAiResult.quantity ? '+' : '') + (val - currentAiResult.quantity) + ' par rapport à la recommandation IA (' + currentAiResult.quantity + ').';
          qtyHint.classList.add('aip-qty-changed');
        } else {
          qtyHint.textContent = 'L\'IA recommande ' + currentAiResult.quantity + ' — vous pouvez commander moins ou plus selon votre jugement.';
          qtyHint.classList.remove('aip-qty-changed');
        }
      });
    }
    if (qtySaveBtn) {
      qtySaveBtn.addEventListener('click', function () { saveOrderQuantity(item, qtySaveBtn, qtyHint); });
    }
  }

  async function saveOrderQuantity(item, btn, hint) {
    const qtyInput = document.getElementById('aip-order-qty-input');
    const value = parseInt(qtyInput.value, 10);
    if (!Number.isFinite(value) || value < 0) return;
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = 'Enregistrement...';
    try {
      const res = await window.reassortFetch('/reassort/proposal/' + item.proposalId + '/line-quantity', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ean: item.ean, quantity: value }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.message);
      hint.textContent = 'Quantité enregistrée : ' + value + ' unité(s) sur cette proposition.';
      hint.classList.remove('aip-qty-changed');
      if (typeof item.onApply === 'function') item.onApply(value);
    } catch (err) {
      hint.textContent = 'Erreur: ' + err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }

  async function runAiAnalysis(item) {
    const myToken = ++aiAnalysisToken;
    currentAiResult = null;
    const resultBox = document.getElementById('aip-simple-view');
    if (!resultBox) return;
    resultBox.innerHTML = aiLoadingHtml();
    try {
      const res = await window.reassortFetch('/reassort/proposal/' + item.proposalId + '/ai-analyze-article', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ean: item.ean }),
      });
      const json = await res.json();
      if (myToken !== aiAnalysisToken) return;
      if (!json.success) throw new Error(json.message);
      currentAiResult = json.data;
      const box = document.getElementById('aip-simple-view');
      if (box) {
        box.innerHTML = aiReadyHtml(json.data);
        wireSimpleViewEvents(item);
      }
    } catch (err) {
      if (myToken !== aiAnalysisToken) return;
      const box = document.getElementById('aip-simple-view');
      if (box) {
        box.innerHTML = aiErrorHtml(err.message);
        const retryBtn = document.getElementById('aip-ai-retry-btn');
        if (retryBtn) retryBtn.addEventListener('click', function () { runAiAnalysis(item); });
      }
    }
  }

  // Sparkline SVG inline : léger, pas de dépendance, suffisant pour 7-90 points journaliers.
  function buildSparkline(dailyHistory) {
    if (!dailyHistory || dailyHistory.length < 2) return '<p class="text-muted small">Pas assez d\'historique pour un graphique.</p>';
    const values = dailyHistory.map(function (d) { return d.quantity || 0; });
    const max = Math.max.apply(null, values.concat([1]));
    const width = 400;
    const height = 100;
    const step = width / (values.length - 1);
    const points = values.map(function (v, i) {
      const x = i * step;
      const y = height - (v / max) * (height - 10) - 5;
      return x + ',' + y;
    }).join(' ');
    const dots = values.map(function (v, i) {
      const x = i * step;
      const y = height - (v / max) * (height - 10) - 5;
      return '<circle cx="' + x + '" cy="' + y + '" r="2.5" fill="#000000"></circle>';
    }).join('');
    const labels = '<div class="d-flex justify-content-between small text-muted mt-1">' +
      '<span>' + dailyHistory[0].date + '</span><span>' + dailyHistory[dailyHistory.length - 1].date + '</span></div>';
    return '<svg viewBox="0 0 ' + width + ' ' + height + '" style="width:100%;height:100px;">' +
      '<polyline points="' + points + '" fill="none" stroke="#000000" stroke-width="2"></polyline>' + dots +
      '</svg>' + labels;
  }

  function signalRow(label, value, extra) {
    return '<div class="aip-signal-row">' +
      '<div class="aip-signal-label">' + label + (extra ? ' <span class="text-muted">(' + extra + ')</span>' : '') + '</div>' +
      '<div class="aip-signal-bar"><div class="aip-signal-bar-fill" style="width:' + value + '%;"></div></div>' +
      '<div class="aip-signal-value">' + value + '%</div>' +
      '</div>';
  }

  function extractConfidenceSignals(reasoning) {
    function extract(regex) {
      const m = reasoning && reasoning.match(regex);
      return m ? parseInt(m[1], 10) : null;
    }
    return {
      history: extract(/historique (\d+)%/),
      volatility: extract(/stabilité (\d+)%/),
      accuracy: extract(/précision passée (\d+)%/),
      quality: extract(/qualité données (\d+)%/),
      accuracyNotYetEvaluated: /pas encore évaluée/.test(reasoning || ''),
    };
  }

  function periodButtonsHtml(activeDays) {
    return [7, 30, 90].map(function (d) {
      return '<button type="button" class="btn btn-sm btn-outline-secondary aip-period-btn' + (d === activeDays ? ' active' : '') + '" data-days="' + d + '">' + d + ' j</button>';
    }).join(' ');
  }

  async function loadHistoryForPeriod(item, days) {
    const container = document.getElementById('aip-sparkline-container');
    container.innerHTML = '<p class="text-muted small">Chargement...</p>';
    try {
      const res = await window.reassortFetch('/reassort/predictions/history?shop=' + encodeURIComponent(item.shopId) + '&ean=' + encodeURIComponent(item.ean) + '&days=' + days);
      const json = await res.json();
      if (!json.success) throw new Error(json.message);
      container.innerHTML = buildSparkline(json.data.dailyHistory);
    } catch (err) {
      container.innerHTML = '<p class="text-danger small">Erreur: ' + err.message + '</p>';
    }
  }

  function buildDetailViewHtml(item) {
    const outcome = item.outcome;
    const outcomeHtml = outcome
      ? '<div class="alert alert-light border small">' +
          '<strong>Résultat réel :</strong> ' + outcome.actualSales.toLocaleString('fr-FR') + ' vendus contre ' +
          Math.round(item.predictedQuantity) + ' prévus (écart ' + (outcome.forecastError > 0 ? '+' : '') + Math.round(outcome.forecastError) +
          (outcome.percentageError !== null ? ', ' + Math.round(outcome.percentageError * 100) + '% d\'erreur' : '') + ').' +
        '</div>'
      : '<div class="alert alert-light border small text-muted">Semaine cible pas encore terminée : résultat réel non disponible.</div>';

    const sig = extractConfidenceSignals(item.reasoning);
    const signalsHtml = (sig.history !== null)
      ? '<div class="mt-2">' +
          signalRow('Historique de données', sig.history) +
          signalRow('Stabilité des ventes', sig.volatility) +
          signalRow('Précision passée', sig.accuracy, sig.accuracyNotYetEvaluated ? 'pas encore évaluée' : null) +
          signalRow('Qualité des données', sig.quality) +
        '</div>'
      : '<p class="text-muted small">Détail des signaux non disponible pour cette prédiction.</p>';

    // Commande RPOS récente (≤7j) qui a fait tomber le calcul classique à 0 par construction : à
    // afficher AVANT l'explication de l'IA, pour que l'utilisateur ait le contexte complet (référence,
    // date, nombre de commandes) avant de lire comment l'IA a jugé si elle suffit ou non — cf. demande
    // explicite de ne jamais laisser croire à un blocage automatique sans analyse.
    const recentOrderSection = item.hasRecentOrder
      ? '<div class="aip-detail-section">' +
          '<h6>Commande récente détectée</h6>' +
          '<div class="aip-classic-card">' +
            '<div class="aip-classic-eyebrow">Commande fournisseur des 7 derniers jours (hors de cette analyse)</div>' +
            '<p class="small mb-0">' +
              'Référence <strong>' + (item.recentOrderReference || '—') + '</strong>, passée le ' +
              (item.recentOrderDate ? new Date(item.recentOrderDate).toLocaleDateString('fr-FR') : '—') +
              (item.recentOrderCount && item.recentOrderCount > 1 ? ' (+ ' + (item.recentOrderCount - 1) + ' autre(s) commande(s) récente(s))' : '') +
              '. L\'IA a analysé si cette commande couvre déjà le besoin ou si une quantité supplémentaire est nécessaire — voir son explication ci-dessous.' +
            '</p>' +
          '</div>' +
        '</div>'
      : '';

    const aiSection = currentAiResult
      ? '<div class="aip-detail-section">' +
          '<h6>Pourquoi l\'IA recommande ' + currentAiResult.quantity + ' unité(s) ?</h6>' +
          '<div class="aip-reasoning-block">' + (currentAiResult.reasoning || '—') + '</div>' +
          '<p class="small text-muted mt-2 mb-0">Modèle utilisé : ' + (currentAiResult.providerUsed || '—') + '. L\'IA a analysé l\'historique de ventes ci-dessous, le stock actuellement disponible, les quantités déjà en commande' + (item.hasRecentOrder ? ' (y compris la commande récente ci-dessus)' : '') + ', et la tendance récente pour estimer la couverture nécessaire à la semaine à venir.</p>' +
        '</div>'
      : '<div class="aip-detail-section"><p class="text-muted small">Analyse IA pas encore disponible.</p></div>';

    const hasClassicData = item.predictedWeeklyDemand !== undefined && item.predictedWeeklyDemand !== null;

    // Ajustement fait au moment de la GÉNÉRATION de la proposition (si AI_QUANTITY_ADJUSTMENT_ENABLED
    // était actif) : distinct de l'analyse "à la demande" ci-dessus (aiSection/currentAiResult), qui
    // se fait au clic sur ce panneau. Les deux peuvent coexister et donner des résultats différents
    // (l'historique de ventes a pu évoluer entre les deux moments).
    const hasClassicComparison = item.classicQuantitySuggested !== undefined && item.classicQuantitySuggested !== null
      && Math.round(item.classicQuantitySuggested) !== Math.round(item.predictedQuantity);
    const generationAdjustmentSection = item.generationAiAdjusted
      ? '<div class="aip-detail-section">' +
          '<h6>Ajustement IA à la génération</h6>' +
          '<div class="aip-classic-card">' +
            '<div class="aip-classic-eyebrow">Historique de la décision</div>' +
            '<p class="small mb-2">' +
              'Calcul initial (vente moyenne, stock, commandes en cours) : <strong>' + Math.round(item.classicQuantitySuggested) + '</strong>. ' +
              (hasClassicComparison
                ? 'L\'IA a ajusté cette base à <strong>' + Math.round(item.predictedQuantity) + '</strong> lors de la génération de cette proposition.'
                : 'L\'IA a confirmé ce calcul lors de la génération de cette proposition.') +
            '</p>' +
            (item.generationAiReasoning ? '<p class="small text-muted mb-0">' + item.generationAiReasoning + '</p>' : '') +
          '</div>' +
        '</div>'
      : '';

    const classicSection = hasClassicData
      ? '<div class="aip-detail-section">' +
          '<h6>Niveau de confiance de la prévision de base</h6>' +
          '<div class="aip-classic-card">' +
            '<div class="aip-classic-eyebrow">Calcul système (lissage exponentiel / moyenne simple)</div>' +
            '<div class="row g-2 mb-2">' +
              '<div class="col-6"><div class="text-muted small">Quantité proposée finale</div><div class="fs-20 fw-semibold">' + Math.round(item.predictedQuantity) + '</div></div>' +
              '<div class="col-6"><div class="text-muted small">Vente hebdo. prévue</div><div class="fs-20 fw-semibold">' + Math.round(item.predictedWeeklyDemand) + '</div></div>' +
              '<div class="col-6"><div class="text-muted small">Stock au calcul</div><div class="fs-20 fw-semibold">' + Math.round(item.stockAtPrediction || 0) + '</div></div>' +
              '<div class="col-6"><div class="text-muted small">Déjà en commande</div><div class="fs-20 fw-semibold">' + Math.round(item.ordersAtPrediction || 0) + '</div></div>' +
            '</div>' +
            '<div class="small text-muted mb-2">Score de confiance : <strong>' + (item.confidenceScore ?? '—') + '%</strong></div>' +
            signalsHtml +
          '</div>' +
        '</div>'
      : '';

    return (
      '<button type="button" class="aip-back-btn" id="aip-back-btn"><iconify-icon icon="solar:arrow-left-linear"></iconify-icon>Retour à la recommandation</button>' +

      recentOrderSection +

      aiSection +

      '<div class="aip-detail-section">' +
        '<div class="d-flex align-items-center justify-content-between mb-2">' +
          '<h6 class="mb-0">Évolution des ventes</h6>' +
          '<div class="btn-group" id="aip-period-buttons">' + periodButtonsHtml(30) + '</div>' +
        '</div>' +
        '<div id="aip-sparkline-container">' + buildSparkline(item.dailyHistory) + '</div>' +
      '</div>' +

      generationAdjustmentSection +

      classicSection +

      (hasClassicData
        ? '<div class="aip-detail-section"><h6>Résultat une fois la semaine terminée</h6>' + outcomeHtml + '</div>'
        : '')
    );
  }

  function showDetailView(item) {
    const detailView = document.getElementById('aip-detail-view');
    const simpleView = document.getElementById('aip-simple-view');
    detailView.innerHTML = buildDetailViewHtml(item);
    simpleView.classList.add('hide');
    detailView.classList.add('show');

    document.getElementById('aip-back-btn').addEventListener('click', showSimpleView);
    document.getElementById('aip-period-buttons').querySelectorAll('.aip-period-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('.aip-period-btn').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        loadHistoryForPeriod(item, parseInt(btn.dataset.days, 10));
      });
    });

    // Sans dailyHistory pré-rempli (cas purchase-order.html, qui n'a pas cette donnée sous la
    // main contrairement à ai-predictions.html), le graphique resterait vide tant que l'utilisateur
    // ne clique pas lui-même sur un préréglage de période — on charge donc les 30 derniers jours
    // automatiquement à l'ouverture, à partir des ventes déjà en base locale (aucun appel RPOS).
    if (!item.dailyHistory || !item.dailyHistory.length) {
      loadHistoryForPeriod(item, 30);
    }
  }

  function showSimpleView() {
    document.getElementById('aip-detail-view').classList.remove('show');
    document.getElementById('aip-simple-view').classList.remove('hide');
  }

  function showPanel() {
    const backdrop = document.getElementById('aip-detail-backdrop');
    const panel = document.getElementById('aip-detail-panel');
    backdrop.hidden = false;
    requestAnimationFrame(function () { panel.classList.add('show'); });
    panel.setAttribute('aria-hidden', 'false');
  }

  window.openAiRecommendationPanel = function (item) {
    ensureStylesAndDom();
    currentItem = item;
    currentAiResult = null;
    document.getElementById('aip-detail-title').textContent = item.label || item.ean;
    document.getElementById('aip-detail-body').innerHTML =
      '<div id="aip-simple-view" class="aip-simple-view">' + aiLoadingHtml() + '</div>' +
      '<div id="aip-detail-view" class="aip-detail-view"></div>';
    showPanel();
    runAiAnalysis(item);
  };
})();
