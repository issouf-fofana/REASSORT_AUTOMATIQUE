(function () {
  const shopSelect = document.getElementById('aip-shop');
  const proposalSelect = document.getElementById('aip-proposal');
  const tbody = document.getElementById('aip-tbody');
  const infoBox = document.getElementById('aip-proposal-info');
  const pageLabel = document.getElementById('aip-page-label');
  const prevBtn = document.getElementById('aip-prev-page');
  const nextBtn = document.getElementById('aip-next-page');

  const DEPARTMENTS_PER_PAGE = 5;
  let allPredictions = [];
  let groupedByDepartment = []; // [{ department, predictions: [...] }], trié par nb d'articles décroissant
  let currentPage = 1;

  async function loadShopList() {
    try {
      const res = await window.reassortFetch('/reassort/shops');
      const json = await res.json();
      if (!json.success) throw new Error(json.message);
      const byPos = {};
      json.data.forEach(function (s) {
        if (!byPos[s.posId]) byPos[s.posId] = [];
        byPos[s.posId].push(s);
      });
      shopSelect.innerHTML = Object.keys(byPos).sort().map(function (posId) {
        const shops = byPos[posId].slice().sort(function (a, b) { return (a.reference || '').localeCompare(b.reference || ''); });
        const options = shops.map(function (s) {
          return '<option value="' + s.id + '">' + s.reference + ' - ' + s.name + '</option>';
        }).join('');
        return '<optgroup label="' + (shops[0].posLabel || posId) + '">' + options + '</optgroup>';
      }).join('');
      if (window.reassortMakeShopPickerSearchable) window.reassortMakeShopPickerSearchable(shopSelect);
      // Le navigateur peut restaurer une sélection précédente sans déclencher "change" : on charge
      // explicitement si un magasin se retrouve déjà sélectionné après le remplissage.
      if (shopSelect.value) loadProposalList();
    } catch (err) {
      shopSelect.innerHTML = '<option value="">Erreur: ' + err.message + '</option>';
    }
  }

  async function loadProposalList() {
    const shopId = shopSelect.value;
    proposalSelect.innerHTML = '<option value="">—</option>';
    proposalSelect.disabled = true;
    if (!shopId) return;
    try {
      const res = await window.reassortFetch('/reassort/predictions/proposals?shop=' + encodeURIComponent(shopId));
      const json = await res.json();
      if (!json.success) throw new Error(json.message);
      if (!json.data.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted py-4">Aucune prédiction enregistrée pour ce magasin. Générez une proposition pour en créer.</td></tr>';
        infoBox.textContent = '';
        return;
      }
      proposalSelect.innerHTML = json.data.map(function (p, i) {
        const dateLabel = new Date(p.generatedAt).toLocaleString('fr-FR');
        return '<option value="' + p.id + '">' + dateLabel + ' (' + p.status + ')' + (i === 0 ? ' — dernière' : '') + '</option>';
      }).join('');
      proposalSelect.disabled = false;
      loadPredictions();
    } catch (err) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center text-danger py-4">Erreur: ' + err.message + '</td></tr>';
    }
  }

  function confidenceColor(score) {
    if (score >= 70) return '#000000';
    if (score >= 40) return '#666666';
    return '#999999';
  }

  async function loadPredictions() {
    const shopId = shopSelect.value;
    if (!shopId) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted py-4">Sélectionnez un magasin pour afficher ses prédictions.</td></tr>';
      infoBox.textContent = '';
      return;
    }
    tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted py-4">Chargement...</td></tr>';
    try {
      const proposalId = proposalSelect.value;
      const url = '/reassort/predictions?shop=' + encodeURIComponent(shopId) + (proposalId ? '&proposalId=' + encodeURIComponent(proposalId) : '');
      const res = await window.reassortFetch(url);
      const json = await res.json();
      if (!json.success) throw new Error(json.message);
      const d = json.data;

      if (!d.proposalId || !d.predictions.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted py-4">Aucune prédiction enregistrée pour ce magasin. Générez une proposition pour en créer.</td></tr>';
        infoBox.textContent = '';
        return;
      }

      // Reflète dans le sélecteur la proposition réellement chargée (utile au premier chargement,
      // quand proposalId n'était pas encore renseigné dans l'URL).
      if (proposalSelect.value !== d.proposalId) proposalSelect.value = d.proposalId;
      currentProposalId = d.proposalId;

      infoBox.textContent = d.predictions.length + ' article(s) — génération du ' + new Date(d.generatedAt).toLocaleString('fr-FR') + '.';

      allPredictions = d.predictions;
      groupedByDepartment = groupByDepartment(allPredictions);
      currentPage = 1;
      renderPage();
    } catch (err) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center text-danger py-4">Erreur: ' + err.message + '</td></tr>';
    }
  }

  // Regroupe par rayon (department) plutôt que de mélanger tous les articles du magasin en vrac :
  // sinon un article "PRODUITS FRAIS" à faible confiance apparaît juste au-dessus d'un article
  // "BAZAR" sans aucun rapport, rendant le tableau difficile à parcourir par un responsable de
  // rayon. Chaque groupe garde le tri par confiance croissante (les moins fiables d'abord).
  function groupByDepartment(predictions) {
    const byDept = new Map();
    predictions.forEach(function (p) {
      const dept = p.department || 'Autre';
      if (!byDept.has(dept)) byDept.set(dept, []);
      byDept.get(dept).push(p);
    });
    return Array.from(byDept.entries())
      .map(function ([department, items]) { return { department, predictions: items }; })
      .sort(function (a, b) { return a.department.localeCompare(b.department); });
  }

  function predictionRowHtml(p) {
    const score = p.confidenceScore !== null && p.confidenceScore !== undefined ? p.confidenceScore : 0;
    const outcome = p.outcome;
    const actual = outcome ? outcome.actualSales.toLocaleString('fr-FR') : '—';
    const gap = outcome
      ? '<span class="' + (outcome.forecastError > 0 ? 'text-success' : outcome.forecastError < 0 ? 'text-danger' : '') + '">' + (outcome.forecastError > 0 ? '+' : '') + Math.round(outcome.forecastError) + '</span>'
      : '<span class="text-muted">en attente</span>';
    return '<tr data-ean="' + p.ean + '">' +
      '<td>' + (p.label || '—') + '<div class="text-muted small">' + p.ean + '</div></td>' +
      '<td class="text-end">' + Math.round(p.predictedWeeklyDemand) + '</td>' +
      '<td class="text-end">' + actual + '</td>' +
      '<td class="text-end">' + gap + '</td>' +
      '<td style="min-width:140px;">' +
        '<div class="d-flex align-items-center gap-2">' +
          '<div class="confidence-bar flex-grow-1"><div class="confidence-bar-fill" style="width:' + score + '%; background-color:' + confidenceColor(score) + ';"></div></div>' +
          '<span class="small fw-semibold">' + score + '%</span>' +
        '</div>' +
      '</td>' +
      '<td class="small text-muted">' + (p.model === 'flat' ? 'Moyenne simple' : 'Lissage exponentiel') + '</td>' +
      '</tr>';
  }

  // Pagination par groupe de département (pas par ligne) : un rayon n'est jamais coupé entre deux
  // pages, ce qui rendrait sa lecture incohérente pour un responsable de rayon donné.
  function renderPage() {
    const totalPages = Math.max(1, Math.ceil(groupedByDepartment.length / DEPARTMENTS_PER_PAGE));
    currentPage = Math.min(currentPage, totalPages);
    const start = (currentPage - 1) * DEPARTMENTS_PER_PAGE;
    const pageGroups = groupedByDepartment.slice(start, start + DEPARTMENTS_PER_PAGE);

    tbody.innerHTML = pageGroups.map(function (group) {
      const headerRow = '<tr class="table-light"><td colspan="6" class="fw-semibold py-2">' +
        group.department + ' <span class="text-muted fw-normal">(' + group.predictions.length + ' article(s))</span></td></tr>';
      return headerRow + group.predictions.map(predictionRowHtml).join('');
    }).join('');

    const totalArticles = allPredictions.length;
    pageLabel.textContent = 'Page ' + currentPage + ' / ' + totalPages + ' (' + groupedByDepartment.length + ' rayon(s), ' + totalArticles + ' article(s))';
    prevBtn.disabled = currentPage <= 1;
    nextBtn.disabled = currentPage >= totalPages;

    tbody.querySelectorAll('tr[data-ean]').forEach(function (row) {
      row.addEventListener('click', function () {
        const prediction = allPredictions.find(function (p) { return p.ean === row.dataset.ean; });
        if (prediction) openDetail(prediction);
      });
    });
  }

  // Sparkline SVG inline : léger, pas de dépendance, suffisant pour 7-14 points journaliers.
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

  let currentDetailPrediction = null;
  let currentProposalId = null;

  // Jeton d'appel : si l'utilisateur ouvre un autre article (ou relance une analyse) avant que
  // l'appel LLM précédent ne réponde, la réponse tardive du premier appel ne doit jamais écraser
  // l'affichage d'un article différent déjà à l'écran.
  let aiAnalysisToken = 0;

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

  // Résultat de l'IA en mémoire pour cet article ouvert (utilisé par la vue simple, la vue détail,
  // et le champ de quantité modifiable) : null tant que l'appel n'a pas encore répondu.
  let currentAiResult = null;

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

  function wireSimpleViewEvents(prediction) {
    const whyBtn = document.getElementById('aip-why-btn');
    if (whyBtn) whyBtn.addEventListener('click', function () { showDetailView(prediction); });

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
      qtySaveBtn.addEventListener('click', function () { saveOrderQuantity(prediction, qtySaveBtn, qtyHint); });
    }
  }

  async function saveOrderQuantity(prediction, btn, hint) {
    const qtyInput = document.getElementById('aip-order-qty-input');
    const value = parseInt(qtyInput.value, 10);
    if (!Number.isFinite(value) || value < 0) return;
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = 'Enregistrement...';
    try {
      const res = await window.reassortFetch('/reassort/proposal/' + currentProposalId + '/line-quantity', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ean: prediction.ean, quantity: value }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.message);
      prediction.predictedQuantity = value; // reflète la nouvelle valeur si le panneau est rouvert
      hint.textContent = 'Quantité enregistrée : ' + value + ' unité(s) sur cette proposition.';
      hint.classList.remove('aip-qty-changed');
    } catch (err) {
      hint.textContent = 'Erreur: ' + err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }

  async function runAiAnalysis(prediction) {
    const myToken = ++aiAnalysisToken;
    currentAiResult = null;
    const resultBox = document.getElementById('aip-simple-view');
    if (!resultBox) return; // le panneau a été fermé/changé entre-temps
    resultBox.innerHTML = aiLoadingHtml();
    try {
      const res = await window.reassortFetch('/reassort/proposal/' + currentProposalId + '/ai-analyze-article', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ean: prediction.ean }),
      });
      const json = await res.json();
      if (myToken !== aiAnalysisToken) return; // une autre analyse a été lancée depuis
      if (!json.success) throw new Error(json.message);
      currentAiResult = json.data;
      const box = document.getElementById('aip-simple-view');
      if (box) {
        box.innerHTML = aiReadyHtml(json.data);
        wireSimpleViewEvents(prediction);
      }
    } catch (err) {
      if (myToken !== aiAnalysisToken) return;
      const box = document.getElementById('aip-simple-view');
      if (box) {
        box.innerHTML = aiErrorHtml(err.message);
        const retryBtn = document.getElementById('aip-ai-retry-btn');
        if (retryBtn) retryBtn.addEventListener('click', function () { runAiAnalysis(prediction); });
      }
    }
  }

  async function loadHistoryForPeriod(days) {
    const container = document.getElementById('aip-sparkline-container');
    container.innerHTML = '<p class="text-muted small">Chargement...</p>';
    try {
      const shopId = shopSelect.value;
      const res = await window.reassortFetch('/reassort/predictions/history?shop=' + encodeURIComponent(shopId) + '&ean=' + encodeURIComponent(currentDetailPrediction.ean) + '&days=' + days);
      const json = await res.json();
      if (!json.success) throw new Error(json.message);
      container.innerHTML = buildSparkline(json.data.dailyHistory);
    } catch (err) {
      container.innerHTML = '<p class="text-danger small">Erreur: ' + err.message + '</p>';
    }
  }

  function periodButtonsHtml(activeDays) {
    return [7, 30, 90].map(function (d) {
      return '<button type="button" class="btn btn-sm btn-outline-secondary aip-period-btn' + (d === activeDays ? ' active' : '') + '" data-days="' + d + '">' + d + ' j</button>';
    }).join(' ');
  }

  // Détail des 4 signaux du score de confiance : pas renvoyé en champs séparés par l'API (seulement
  // condensé dans "reasoning" en texte) — extrait ici plutôt que de dupliquer le calcul côté
  // frontend, pour rester fidèle à ce que confidenceService.js a réellement produit.
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

  function buildDetailViewHtml(p) {
    const outcome = p.outcome;
    const outcomeHtml = outcome
      ? '<div class="alert alert-light border small">' +
          '<strong>Résultat réel :</strong> ' + outcome.actualSales.toLocaleString('fr-FR') + ' vendus contre ' +
          Math.round(p.predictedQuantity) + ' prévus (écart ' + (outcome.forecastError > 0 ? '+' : '') + Math.round(outcome.forecastError) +
          (outcome.percentageError !== null ? ', ' + Math.round(outcome.percentageError * 100) + '% d\'erreur' : '') + ').' +
        '</div>'
      : '<div class="alert alert-light border small text-muted">Semaine cible pas encore terminée : résultat réel non disponible.</div>';

    const sig = extractConfidenceSignals(p.reasoning);
    const signalsHtml = (sig.history !== null)
      ? '<div class="mt-2">' +
          signalRow('Historique de données', sig.history) +
          signalRow('Stabilité des ventes', sig.volatility) +
          signalRow('Précision passée', sig.accuracy, sig.accuracyNotYetEvaluated ? 'pas encore évaluée' : null) +
          signalRow('Qualité des données', sig.quality) +
        '</div>'
      : '<p class="text-muted small">Détail des signaux non disponible pour cette prédiction.</p>';

    const aiSection = currentAiResult
      ? '<div class="aip-detail-section">' +
          '<h6>Pourquoi l\'IA recommande ' + currentAiResult.quantity + ' unité(s) ?</h6>' +
          '<div class="aip-reasoning-block">' + (currentAiResult.reasoning || '—') + '</div>' +
          '<p class="small text-muted mt-2 mb-0">Modèle utilisé : ' + (currentAiResult.providerUsed || '—') + '. L\'IA a analysé l\'historique de ventes ci-dessous, le stock actuellement disponible, les quantités déjà en commande, et la tendance récente pour estimer la couverture nécessaire à la semaine à venir.</p>' +
        '</div>'
      : '<div class="aip-detail-section"><p class="text-muted small">Analyse IA pas encore disponible.</p></div>';

    return (
      '<button type="button" class="aip-back-btn" id="aip-back-btn"><iconify-icon icon="solar:arrow-left-linear"></iconify-icon>Retour à la recommandation</button>' +

      aiSection +

      '<div class="aip-detail-section">' +
        '<div class="d-flex align-items-center justify-content-between mb-2">' +
          '<h6 class="mb-0">Évolution des ventes</h6>' +
          '<div class="btn-group" id="aip-period-buttons">' + periodButtonsHtml(30) + '</div>' +
        '</div>' +
        '<div id="aip-sparkline-container">' + buildSparkline(p.dailyHistory) + '</div>' +
      '</div>' +

      '<div class="aip-detail-section">' +
        '<h6>Niveau de confiance de la prévision de base</h6>' +
        '<div class="aip-classic-card">' +
          '<div class="aip-classic-eyebrow">Calcul système (lissage exponentiel / moyenne simple)</div>' +
          '<div class="row g-2 mb-2">' +
            '<div class="col-6"><div class="text-muted small">Quantité prévue</div><div class="fs-20 fw-semibold">' + Math.round(p.predictedQuantity) + '</div></div>' +
            '<div class="col-6"><div class="text-muted small">Vente hebdo. prévue</div><div class="fs-20 fw-semibold">' + Math.round(p.predictedWeeklyDemand) + '</div></div>' +
            '<div class="col-6"><div class="text-muted small">Stock au calcul</div><div class="fs-20 fw-semibold">' + Math.round(p.stockAtPrediction) + '</div></div>' +
            '<div class="col-6"><div class="text-muted small">Déjà en commande</div><div class="fs-20 fw-semibold">' + Math.round(p.ordersAtPrediction) + '</div></div>' +
          '</div>' +
          '<div class="small text-muted mb-2">Score de confiance : <strong>' + (p.confidenceScore ?? '—') + '%</strong></div>' +
          signalsHtml +
        '</div>' +
      '</div>' +

      '<div class="aip-detail-section">' +
        '<h6>Résultat une fois la semaine terminée</h6>' +
        outcomeHtml +
      '</div>'
    );
  }

  function showDetailView(p) {
    const detailView = document.getElementById('aip-detail-view');
    const simpleView = document.getElementById('aip-simple-view');
    detailView.innerHTML = buildDetailViewHtml(p);
    simpleView.classList.add('hide');
    detailView.classList.add('show');

    document.getElementById('aip-back-btn').addEventListener('click', function () { showSimpleView(); });
    document.getElementById('aip-period-buttons').querySelectorAll('.aip-period-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('.aip-period-btn').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        loadHistoryForPeriod(parseInt(btn.dataset.days, 10));
      });
    });
  }

  function showSimpleView() {
    document.getElementById('aip-detail-view').classList.remove('show');
    document.getElementById('aip-simple-view').classList.remove('hide');
  }

  function openDetail(p) {
    currentDetailPrediction = p;
    currentAiResult = null;
    document.getElementById('aip-detail-title').textContent = p.label || p.ean;

    // Deux vues empilées dans le même conteneur : la vue simple (recommandation IA + quantité
    // modifiable) est visible par défaut, la vue détail ("Pourquoi ?") contient tout ce qui est
    // technique — jamais les deux en même temps, cf. demande explicite de ne pas "polluer" l'écran
    // principal avec les calculs internes (score de confiance, signaux, quantité du calcul
    // classique...) qui restent utilisés en interne mais ne doivent être vus qu'à la demande.
    document.getElementById('aip-detail-body').innerHTML =
      '<div id="aip-simple-view" class="aip-simple-view">' + aiLoadingHtml() + '</div>' +
      '<div id="aip-detail-view" class="aip-detail-view"></div>';

    showDetailPanel();
    runAiAnalysis(p);
  }

  const detailPanel = document.getElementById('aip-detail-panel');
  const detailBackdrop = document.getElementById('aip-detail-backdrop');

  function showDetailPanel() {
    detailBackdrop.hidden = false;
    // requestAnimationFrame : force le navigateur à peindre l'état initial (hors écran) avant
    // d'appliquer .show, sinon la transition CSS ne joue pas (les deux changements de style
    // arriveraient dans le même frame).
    requestAnimationFrame(function () { detailPanel.classList.add('show'); });
    detailPanel.setAttribute('aria-hidden', 'false');
  }

  function hideDetailPanel() {
    detailPanel.classList.remove('show');
    detailPanel.setAttribute('aria-hidden', 'true');
    setTimeout(function () { detailBackdrop.hidden = true; }, 250);
  }

  document.getElementById('aip-detail-close').addEventListener('click', hideDetailPanel);
  detailBackdrop.addEventListener('click', hideDetailPanel);

  shopSelect.addEventListener('change', loadProposalList);
  proposalSelect.addEventListener('change', loadPredictions);
  document.getElementById('aip-refresh').addEventListener('click', loadPredictions);
  prevBtn.addEventListener('click', function () { if (currentPage > 1) { currentPage--; renderPage(); } });
  nextBtn.addEventListener('click', function () { currentPage++; renderPage(); });

  loadShopList();
})();
