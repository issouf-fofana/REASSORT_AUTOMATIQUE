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
      position: fixed; top: 0; right: 0; bottom: 0; width: 720px; max-width: 92vw;
      background-color: #ffffff; z-index: 1045; box-shadow: -4px 0 16px rgba(0,0,0,.15);
      transform: translateX(100%); transition: transform .25s ease, width .2s ease;
      display: flex; flex-direction: column;
    }
    /* Panneau élargi une fois la recommandation IA prête (vue à deux colonnes, demande du
       15/09/2026 : "afficher en grand pour voir toutes les données d'un coup", recommandation
       séparée du reste plutôt que tout empilé verticalement) — reste étroit pendant le chargement
       et sur les vues qui n'ont pas besoin de cette largeur (streaming, erreur). */
    .aip-detail-panel.aip-wide { width: 1180px; }
    .aip-detail-panel.show { transform: translateX(0); }
    .aip-detail-panel-header { display: flex; align-items: center; justify-content: space-between; padding: 1rem 1.25rem; flex-shrink: 0; }
    .aip-detail-panel-body { padding: 1.25rem; overflow-y: auto; flex-grow: 1; }
    .aip-period-btn.active { background-color: #000000 !important; color: #ffffff !important; border-color: #000000 !important; }

    .aip-simple-view { display: flex; flex-direction: column; gap: 1.25rem; }
    /* Vue à deux colonnes : la carte recommandation reste fixe et visible à gauche pendant que le
       reste (raisonnement, impact, ventes) défile indépendamment à droite — sur écran étroit,
       repasse en une seule colonne empilée (recommandation d'abord). */
    .aip-simple-view.aip-two-col {
      flex-direction: row; align-items: flex-start; gap: 1.75rem;
    }
    .aip-simple-view.aip-two-col > .aip-reco-column {
      flex: 0 0 340px; position: sticky; top: 0;
    }
    .aip-simple-view.aip-two-col > .aip-details-column {
      flex: 1 1 auto; min-width: 0;
    }
    @media (max-width: 900px) {
      .aip-simple-view.aip-two-col { flex-direction: column; }
      .aip-simple-view.aip-two-col > .aip-reco-column { position: static; flex-basis: auto; width: 100%; }
    }
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

    .aip-stream-cursor { animation: aip-blink 1s step-end infinite; }
    @keyframes aip-blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
    @media (prefers-reduced-motion: reduce) { .aip-stream-cursor { animation: none; } }

    .aip-ai-error-card { border: 1px solid #666666; padding: 1.5rem; text-align: center; }
    .aip-ai-error-card .aip-ai-retry { margin-top: .75rem; }

    .aip-qa-turn { font-size: .85rem; }
    .aip-qa-question { font-weight: 600; margin-bottom: .35rem; }
    .aip-qa-question::before { content: "Vous : "; font-weight: 400; color: #999; }
    .aip-qa-answer { border-left: 3px solid #000000; padding: .1rem 1rem; line-height: 1.5; }
    .aip-qa-answer p, .aip-reasoning-block p { margin: 0 0 .5rem; }
    .aip-qa-answer p:last-child, .aip-reasoning-block p:last-child { margin-bottom: 0; }
    .aip-md-list { margin: 0 0 .5rem; padding-left: 1.2rem; }
    .aip-md-list:last-child { margin-bottom: 0; }
    .aip-md-list li { margin-bottom: .3rem; }
    .aip-md-list li:last-child { margin-bottom: 0; }

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

    .aip-spark-hover-target { cursor: pointer; }
    .aip-spark-tooltip {
      position: absolute; top: 0; z-index: 10; pointer-events: none;
      background-color: #000000; color: #ffffff; padding: .4rem .65rem; font-size: .75rem;
      line-height: 1.4; white-space: nowrap; box-shadow: 0 2px 8px rgba(0,0,0,.25);
    }
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

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Convertisseur Markdown léger -> HTML pour les textes générés par l'IA (raisonnement, réponses
  // de suivi) : le prompt demande du gras (**mot**) et des puces ("- ") seulement quand c'est
  // pertinent (plusieurs raisons/chiffres distincts), jamais du Markdown complexe (titres, tableaux,
  // liens) — ce convertisseur reste volontairement minimal, pas une dépendance externe pour si peu.
  // Toujours échapper le HTML AVANT d'appliquer le Markdown : le texte source vient d'un LLM, jamais
  // fiable tel quel dans le DOM.
  function markdownLiteToHtml(text) {
    if (!text) return '';
    const escaped = escapeHtml(text);
    const lines = escaped.split('\n');
    const htmlParts = [];
    let listBuffer = [];

    function flushList() {
      if (listBuffer.length) {
        htmlParts.push('<ul class="aip-md-list">' + listBuffer.map(function (item) { return '<li>' + item + '</li>'; }).join('') + '</ul>');
        listBuffer = [];
      }
    }

    lines.forEach(function (rawLine) {
      const line = rawLine.trim();
      const bulletMatch = line.match(/^[-*]\s+(.*)/);
      if (bulletMatch) {
        listBuffer.push(applyInlineMarkdown(bulletMatch[1]));
        return;
      }
      flushList();
      if (line) htmlParts.push('<p>' + applyInlineMarkdown(line) + '</p>');
    });
    flushList();

    return htmlParts.join('');
  }

  function applyInlineMarkdown(str) {
    // Le gras (**mot**) est traité en premier : sinon les deux astérisques du gras seraient
    // consommés par erreur par la règle d'italique simple (*mot*) ci-dessous. Même comportement
    // que ai-assistant.js/ai-assistant-widget.js (fichiers volontairement indépendants, mais le
    // rendu doit rester identique quelle que soit la surface UI qui affiche une réponse IA).
    return str
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>');
  }

  function aiLoadingHtml() {
    return '<div class="aip-ai-loading">' +
      '<div class="aip-scan-bar"></div>' +
      '<div class="aip-loading-label">L\'IA analyse cet article</div>' +
      '<div class="aip-loading-detail">Historique de ventes, stock actuel, commandes en cours&hellip;</div>' +
      '</div>';
  }

  // Vue affichée PENDANT le streaming : la quantité apparaît dès qu'elle est connue (généralement
  // en tout début de réponse), suivie du texte d'explication qui s'écrit progressivement — comme
  // une conversation avec un assistant, plutôt qu'un panneau figé jusqu'à la réponse complète.
  function aiStreamingHtml() {
    return '<div class="aip-reco-card">' +
        '<div class="aip-reco-eyebrow"><iconify-icon icon="solar:magic-stick-3-bold"></iconify-icon>L\'IA analyse&hellip;</div>' +
        '<div class="aip-reco-quantity" id="aip-stream-quantity">&hellip;</div>' +
        '<div class="aip-reco-quantity-unit">unités recommandées</div>' +
      '</div>' +
      '<div class="aip-detail-section mt-3">' +
        '<h6>Raisonnement</h6>' +
        '<div class="aip-reasoning-block" id="aip-stream-text"><span class="aip-stream-cursor">▍</span></div>' +
      '</div>';
  }

  // Repli quand l'IA est indisponible (crédit fournisseur épuisé, réseau coupé...) : plutôt que de
  // laisser l'utilisateur sans rien d'exploitable, on affiche le calcul classique déjà connu (celui
  // qui a servi de point de départ à l'IA, disponible même sans elle) comme quantité de repli
  // explicitement marquée comme telle, puis les statistiques/tableau/graphique en dessous — ces
  // derniers ne dépendent d'aucun appel IA, seulement des ventes déjà en base locale.
  function aiErrorHtml(message, item) {
    const fallbackQuantity = item ? (item.classicQuantitySuggested ?? item.predictedQuantity) : null;
    const fallbackCard = (fallbackQuantity !== null && fallbackQuantity !== undefined)
      ? '<div class="aip-ai-error-card mb-3">' +
          '<p class="small mb-0"><strong><iconify-icon icon="solar:danger-triangle-bold-duotone"></iconify-icon> L\'IA n\'est pas disponible actuellement</strong> (' + escapeHtml(message) + ').<br>' +
          'La quantité ci-dessous reste basée sur une vraie analyse statistique des ventes réelles de cet article (moyenne, tendance, stock) — ce n\'est pas un calcul au hasard, seule l\'interprétation supplémentaire de l\'IA manque pour le moment.</p>' +
        '</div>' +
        '<div class="aip-reco-card">' +
          '<div class="aip-reco-eyebrow"><iconify-icon icon="solar:calculator-minimalistic-bold"></iconify-icon>Calcul statistique (sans IA)</div>' +
          '<div class="aip-reco-headline">D\'après l\'analyse des ventes de cet article, la quantité recommandée est de <strong>' + Math.round(fallbackQuantity) + ' unité(s)</strong>.</div>' +
          '<div class="aip-reco-quantity">' + Math.round(fallbackQuantity) + '</div>' +
          '<div class="aip-reco-quantity-unit">unités — calcul statistique, IA indisponible</div>' +
        '</div>'
      : '<div class="aip-ai-error-card mb-3">' +
          '<p class="small mb-0"><strong><iconify-icon icon="solar:danger-triangle-bold-duotone"></iconify-icon> L\'IA n\'est pas disponible actuellement</strong> (' + escapeHtml(message) + ').<br>' +
          'Aucun calcul de repli n\'est disponible pour cet article — voir tout de même l\'historique de ventes ci-dessous.</p>' +
        '</div>';
    return fallbackCard +
      '<div class="text-center mb-3">' +
        '<button type="button" class="btn btn-outline-dark btn-sm aip-ai-retry" id="aip-ai-retry-btn">Réessayer l\'analyse IA</button>' +
      '</div>' +
      (item
        ? '<div class="aip-detail-section mt-3">' +
            '<div class="d-flex align-items-center justify-content-between mb-2">' +
              '<h6 class="mb-0">Évolution des ventes</h6>' +
              '<div class="btn-group" id="aip-period-buttons">' + periodButtonsHtml(30) + '</div>' +
            '</div>' +
            '<div id="aip-sparkline-container"><p class="text-muted small">Chargement...</p></div>' +
            '<div id="aip-stats-container" class="mt-3"></div>' +
          '</div>' +
          '<div class="aip-detail-section">' +
            '<h6>Détail des ventes par jour</h6>' +
            '<div id="aip-history-table-container"><p class="text-muted small">Chargement...</p></div>' +
          '</div>' +
          (fallbackQuantity !== null && fallbackQuantity !== undefined
            ? '<div class="aip-detail-section"><div id="aip-impact-container"></div></div>'
            : '')
        : '');
  }

  // showReasoningInline : true juste après un streaming en direct (l'utilisateur vient de lire le
  // texte défiler à l'écran — le faire disparaître aussitôt derrière "Pourquoi ?" serait déroutant),
  // false pour un résultat déjà en cache (rien n'a été vu défiler, "Pourquoi ?" reste la première
  // consultation naturelle du raisonnement, cohérent avec le principe "jamais les calculs internes
  // en premier plan par défaut").
  // Deux quantités distinctes coexistent pour un même article, sans lien automatique entre elles :
  // celle déjà affichée dans le tableau (currentQuantityInTable, calculée à la génération de la
  // proposition — calcul classique, ou déjà ajustée par l'IA si AI_QUANTITY_ADJUSTMENT_ENABLED était
  // actif à ce moment-là) et celle que CE panneau vient de recalculer en direct (d.quantity, une
  // nouvelle analyse IA sur les données actuelles). Un écart entre les deux est normal (les données
  // ont pu changer depuis, ou l'IA raisonne différemment du calcul déterministe) mais restait
  // invisible à l'utilisateur, qui ne pouvait pas savoir pourquoi deux chiffres différents
  // apparaissaient pour le même article — affiché ici explicitement, avant même le gros chiffre.
  function comparisonBannerHtml(currentQuantityInTable, newQuantity) {
    if (currentQuantityInTable === undefined || currentQuantityInTable === null || currentQuantityInTable === newQuantity) return '';
    const diff = newQuantity - currentQuantityInTable;
    const diffLabel = (diff > 0 ? '+' : '') + diff;
    return '<div class="alert alert-info small mb-3">' +
      '<strong>Quantité actuellement dans la commande :</strong> ' + currentQuantityInTable + ' &nbsp;→&nbsp; ' +
      '<strong>Nouvelle recommandation IA :</strong> ' + newQuantity + ' <span class="text-muted">(' + diffLabel + ')</span><br>' +
      '<span class="text-muted">Cette analyse recalcule la quantité à partir des données actuelles — elle peut différer du chiffre déjà dans le tableau si les ventes ou le stock ont évolué depuis la génération de la proposition.</span>' +
      '</div>';
  }

  // Historique de la conversation de suivi pour l'article actuellement ouvert (remis à zéro à
  // chaque nouvelle ouverture du panneau ou nouvelle analyse) : permet l'enchaînement de questions
  // ("et pourquoi pas plus ?" après une 1ère réponse), transmis au backend à chaque nouvelle
  // question pour qu'il ait le contexte des échanges précédents sans avoir à le stocker côté serveur.
  let conversationHistory = [];

  // Section "Poser une question" — cf. demande explicite : le magasin doit pouvoir demander
  // librement "combien de jours ça couvre ?", "pourquoi pas plus ?", etc. et recevoir une réponse
  // calculée à partir des vraies données de l'article, pas un texte figé.
  function askQuestionSectionHtml() {
    return '<div class="aip-detail-section">' +
      '<h6>Poser une question à l\'IA</h6>' +
      '<div id="aip-qa-history"></div>' +
      '<div class="input-group">' +
        '<input type="text" class="form-control" id="aip-qa-input" placeholder="Ex : combien de jours cette commande va-t-elle couvrir ?">' +
        '<button type="button" class="btn btn-dark" id="aip-qa-send">Envoyer</button>' +
      '</div>' +
      '</div>';
  }

  function wireAskQuestion(item) {
    const input = document.getElementById('aip-qa-input');
    const sendBtn = document.getElementById('aip-qa-send');
    const historyEl = document.getElementById('aip-qa-history');
    if (!input || !sendBtn) return;

    async function send() {
      const question = input.value.trim();
      if (!question || !currentAiResult) return;
      input.value = '';
      sendBtn.disabled = true;

      const turnEl = document.createElement('div');
      turnEl.className = 'aip-qa-turn mb-3';
      turnEl.innerHTML =
        '<div class="aip-qa-question">' + escapeHtml(question) + '</div>' +
        '<div class="aip-qa-answer"><span class="aip-stream-cursor">▍</span></div>';
      historyEl.appendChild(turnEl);
      const answerEl = turnEl.querySelector('.aip-qa-answer');

      async function attemptFollowUp() {
        let streamedAnswer = '';
        const res = await window.reassortFetch('/reassort/proposal/' + item.proposalId + '/ai-ask-followup-stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ean: item.ean,
            previousQuantity: currentAiResult.quantity,
            previousReasoning: currentAiResult.reasoning,
            conversationHistory: conversationHistory,
            question: question,
          }),
        });
        if (!res.ok) throw new Error('Erreur serveur (' + res.status + ')');

        let finalAnswer = null;
        await consumeSseStream(res, function (eventName, data) {
          if (eventName === 'chunk') {
            streamedAnswer += data.text;
            answerEl.textContent = streamedAnswer;
            const cursor = document.createElement('span');
            cursor.className = 'aip-stream-cursor';
            cursor.textContent = '▍';
            answerEl.appendChild(cursor);
          } else if (eventName === 'error') {
            throw new Error(data.message);
          } else if (eventName === 'done') {
            finalAnswer = data.answer;
          }
        });
        if (!finalAnswer) throw new Error('Flux terminé sans réponse exploitable.');
        return finalAnswer;
      }

      // Une coupure réseau brève peut interrompre le flux SSE avant l'event "done" alors que le
      // serveur a bien traité la question (ajouté le 16/09/2026, même constat que les autres points
      // d'entrée IA de ce projet) — une seule retentative automatique avant d'afficher une erreur.
      let finalAnswer = null;
      let lastErr = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          finalAnswer = await attemptFollowUp();
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          if (attempt === 1) answerEl.innerHTML = '<span class="aip-stream-cursor">▍</span>';
        }
      }

      if (finalAnswer) {
        // Le Markdown (puces, gras) n'est appliqué qu'à la réponse complète, jamais pendant le
        // streaming caractère par caractère : une puce "- " non encore terminée casserait le rendu
        // HTML en cours de frappe (ex: <ul> ouvert sans <li> fermé). Le texte brut défile pendant le
        // streaming, puis le rendu final remplace tout une fois la réponse entière reçue.
        answerEl.innerHTML = markdownLiteToHtml(finalAnswer);
        conversationHistory.push({ question: question, answer: finalAnswer });
      } else {
        answerEl.innerHTML = '<span class="text-danger">Erreur : ' + escapeHtml(lastErr.message) + '</span>';
        if (window.reassortReportError) window.reassortReportError('Panneau recommandation IA (après 2 tentatives): ' + lastErr.message, lastErr.stack);
      }
      sendBtn.disabled = false;
    }

    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') send();
    });
  }

  // Deux colonnes une fois la recommandation prête (demande du 15/09/2026 : "afficher en grand...
  // séparé en deux, Recommandation IA à part et l'autre à part à droite") : colonne gauche =
  // recommandation + action (quantité à commander), toujours visible sans scroller ; colonne droite
  // = tout le reste (raisonnement, impact, ventes, questions), qui défile indépendamment. Le mode
  // "Pourquoi ?" (bouton, ancien affichage replié) disparaît : le raisonnement est maintenant
  // toujours visible directement dans la colonne de droite, plus besoin de le révéler au clic.
  function aiReadyHtml(d) {
    const leftColumn =
      '<div class="aip-reco-column">' +
        comparisonBannerHtml(currentItem ? currentItem.predictedQuantity : null, d.quantity) +
        '<div class="aip-reco-card">' +
          '<div class="aip-reco-eyebrow"><iconify-icon icon="solar:magic-stick-3-bold"></iconify-icon>Recommandation IA' + (d.fromCache ? ' <span class="text-muted" style="text-transform:none;letter-spacing:normal;">(déjà calculée à la génération)</span>' : '') + '</div>' +
          '<div class="aip-reco-headline">Pour cet article, l\'IA recommande de commander <strong>' + d.quantity + ' unité(s)</strong> pour la semaine à venir.</div>' +
          '<div class="aip-reco-quantity">' + d.quantity + '</div>' +
          '<div class="aip-reco-quantity-unit">unités recommandées</div>' +
        '</div>' +
        (d.fromCache ? '<button type="button" class="btn btn-link btn-sm p-0 mt-2" id="aip-reanalyze-btn">Relancer une analyse à jour (nouvel appel IA)</button>' : '') +
        '<div class="aip-order-qty-card mt-3">' +
          '<label for="aip-order-qty-input">Quantité à commander</label>' +
          '<div class="input-group">' +
            '<input type="number" min="0" step="1" class="form-control" id="aip-order-qty-input" value="' + d.quantity + '">' +
            '<button type="button" class="btn btn-dark" id="aip-order-qty-save">Appliquer</button>' +
          '</div>' +
          '<div class="aip-order-qty-hint" id="aip-order-qty-hint">L\'IA recommande ' + d.quantity + ' — vous pouvez commander moins ou plus selon votre jugement.</div>' +
        '</div>' +
      '</div>';

    const rightColumn =
      '<div class="aip-details-column">' +
        '<div class="aip-detail-section"><h6>Raisonnement</h6><div class="aip-reasoning-block">' + markdownLiteToHtml(d.reasoning || '') + '</div></div>' +
        '<div class="aip-detail-section">' +
          '<h6>Dernière commande &amp; impact</h6>' +
          buildRecentOrderBlock(currentItem || {}) +
          '<div id="aip-impact-container"></div>' +
        '</div>' +
        '<div class="aip-detail-section">' +
          '<div class="d-flex align-items-center justify-content-between mb-2">' +
            '<h6 class="mb-0">Évolution des ventes</h6>' +
            '<div class="btn-group" id="aip-period-buttons">' + periodButtonsHtml(30) + '</div>' +
          '</div>' +
          '<div id="aip-sparkline-container"><p class="text-muted small">Chargement...</p></div>' +
          '<div id="aip-stats-container" class="mt-3"></div>' +
        '</div>' +
        '<div class="aip-detail-section">' +
          '<h6>Détail des ventes par jour</h6>' +
          '<div id="aip-history-table-container"><p class="text-muted small">Chargement...</p></div>' +
        '</div>' +
        askQuestionSectionHtml() +
      '</div>';

    return leftColumn + rightColumn;
  }

  function wireSimpleViewEvents(item) {
    const whyBtn = document.getElementById('aip-why-btn');
    if (whyBtn) whyBtn.addEventListener('click', function () { showDetailView(item); });

    const reanalyzeBtn = document.getElementById('aip-reanalyze-btn');
    if (reanalyzeBtn) reanalyzeBtn.addEventListener('click', function () {
      conversationHistory = [];
      document.getElementById('aip-simple-view').innerHTML = aiLoadingHtml();
      runAiAnalysis(item);
    });

    conversationHistory = [];
    wireAskQuestion(item);

    // Graphique inclus directement dans la vue simple quand le raisonnement est déjà affiché
    // (juste après un streaming, cf. aiReadyHtml) : chargé via le même appel API que la vue détail
    // (pas via item.dailyHistory, jamais transmis par purchase-order.html) — sinon le graphique
    // restait invisible sur cette page faute de données, régression constatée après l'ajout du
    // raisonnement inline.
    const periodButtonsEl = document.getElementById('aip-period-buttons');
    if (periodButtonsEl) {
      const quantityForImpact = currentAiResult ? currentAiResult.quantity : item.predictedQuantity;
      loadHistoryForPeriod(item, 30, quantityForImpact);
      periodButtonsEl.querySelectorAll('.aip-period-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          periodButtonsEl.querySelectorAll('.aip-period-btn').forEach(function (b) { b.classList.remove('active'); });
          btn.classList.add('active');
          loadHistoryForPeriod(item, parseInt(btn.dataset.days, 10), quantityForImpact);
        });
      });
    }

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

  // Lit le flux SSE renvoyé par /ai-analyze-article-stream via fetch() + getReader() (EventSource
  // natif exclu : ne supporte ni POST ni header Authorization custom, requis par reassortFetch).
  // Appelle onEvent(eventName, data) pour chaque événement complet reçu (quantity/chunk/done/error).
  async function consumeSseStream(res, onEvent) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop(); // dernier événement potentiellement incomplet, conservé pour le prochain chunk

      for (const eventBlock of events) {
        const lines = eventBlock.split('\n');
        let eventName = 'message';
        let dataStr = '';
        for (const line of lines) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
        }
        if (!dataStr) continue;
        try {
          onEvent(eventName, JSON.parse(dataStr));
        } catch {
          // ligne data mal formée : ignorée plutôt que de faire planter tout le flux pour un
          // seul événement corrompu (le flux continue, l'événement 'done' final reste attendu).
        }
      }
    }
  }

  async function runAiAnalysis(item) {
    const myToken = ++aiAnalysisToken;
    currentAiResult = null;
    const resultBox = document.getElementById('aip-simple-view');
    if (!resultBox) return;
    resultBox.innerHTML = aiStreamingHtml();
    const quantityEl = document.getElementById('aip-stream-quantity');
    const textEl = document.getElementById('aip-stream-text');
    let streamedText = '';

    try {
      const res = await window.reassortFetch('/reassort/proposal/' + item.proposalId + '/ai-analyze-article-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ean: item.ean }),
      });
      if (!res.ok) throw new Error('Erreur serveur (' + res.status + ')');

      let finalResult = null;
      await consumeSseStream(res, function (eventName, data) {
        if (myToken !== aiAnalysisToken) return;
        if (eventName === 'quantity' && quantityEl) {
          quantityEl.textContent = data.quantity;
        } else if (eventName === 'chunk' && textEl) {
          streamedText += data.text;
          // textContent (pas innerHTML) : le texte de l'IA est affiché tel quel, jamais interprété
          // comme du HTML, pour éviter toute injection si la réponse contenait des caractères
          // spéciaux — le curseur clignotant est un nœud DOM séparé, rajouté après chaque mise à jour.
          textEl.textContent = streamedText;
          const cursor = document.createElement('span');
          cursor.className = 'aip-stream-cursor';
          cursor.textContent = '▍';
          textEl.appendChild(cursor);
        } else if (eventName === 'error') {
          throw new Error(data.message);
        } else if (eventName === 'done') {
          finalResult = data;
        }
      });
      if (myToken !== aiAnalysisToken) return;
      if (!finalResult) throw new Error('Flux terminé sans résultat exploitable.');

      currentAiResult = finalResult;
      const box = document.getElementById('aip-simple-view');
      if (box) {
        box.classList.add('aip-two-col');
        const panelEl = document.getElementById('aip-detail-panel');
        if (panelEl) panelEl.classList.add('aip-wide');
        box.innerHTML = aiReadyHtml(finalResult);
        wireSimpleViewEvents(item);
      }
    } catch (err) {
      if (myToken !== aiAnalysisToken) return;
      const box = document.getElementById('aip-simple-view');
      if (box) {
        box.innerHTML = aiErrorHtml(err.message, item);
        const retryBtn = document.getElementById('aip-ai-retry-btn');
        if (retryBtn) retryBtn.addEventListener('click', function () { runAiAnalysis(item); });

        // Repli statistique : les stats/tableau/graphique ne dépendent d'aucun appel IA, seulement
        // des ventes déjà en base locale — chargés même en cas d'échec IA pour que l'utilisateur ait
        // toujours quelque chose d'exploitable plutôt qu'un panneau vide.
        const periodButtonsEl = document.getElementById('aip-period-buttons');
        if (periodButtonsEl) {
          const fallbackQuantity = item.classicQuantitySuggested ?? item.predictedQuantity;
          loadHistoryForPeriod(item, 30, fallbackQuantity);
          periodButtonsEl.querySelectorAll('.aip-period-btn').forEach(function (btn) {
            btn.addEventListener('click', function () {
              periodButtonsEl.querySelectorAll('.aip-period-btn').forEach(function (b) { b.classList.remove('active'); });
              btn.classList.add('active');
              loadHistoryForPeriod(item, parseInt(btn.dataset.days, 10), fallbackQuantity);
            });
          });
        }
      }
    }
  }

  // Sparkline SVG inline : léger, pas de dépendance, suffisant pour 7-90 points journaliers.
  // Un identifiant unique par graphique (pas un seul id global) : le panneau peut reconstruire ce
  // graphique plusieurs fois dans une même session (changement de période 7j/30j/90j), et un id
  // dupliqué dans le DOM ferait pointer getElementById sur la première instance seulement.
  let sparklineInstanceCounter = 0;

  function buildSparkline(dailyHistory) {
    if (!dailyHistory || dailyHistory.length < 2) return '<p class="text-muted small">Pas assez d\'historique pour un graphique.</p>';
    const instanceId = 'aip-spark-' + (++sparklineInstanceCounter);
    const values = dailyHistory.map(function (d) { return d.quantity || 0; });
    const max = Math.max.apply(null, values.concat([1]));
    const width = 400;
    const height = 100;
    const step = width / (values.length - 1);
    const coords = values.map(function (v, i) {
      const x = i * step;
      const y = height - (v / max) * (height - 10) - 5;
      return { x: x, y: y };
    });
    const points = coords.map(function (c) { return c.x + ',' + c.y; }).join(' ');
    const dots = coords.map(function (c) { return '<circle cx="' + c.x + '" cy="' + c.y + '" r="2.5" fill="#000000"></circle>'; }).join('');
    // Cercles invisibles plus larges (rayon 10 au lieu de 2.5) superposés aux points visibles : une
    // cible de survol plus généreuse que le petit point réel, plus facile à atteindre avec la souris
    // sans agrandir visuellement les points affichés. data-date/data-value alimentent le tooltip au
    // survol (voir wireSparklineTooltip), un attribut par point plutôt qu'un événement par point
    // pour rester léger si l'historique est long (jusqu'à 90 jours).
    const hoverTargets = coords.map(function (c, i) {
      return '<circle cx="' + c.x + '" cy="' + c.y + '" r="10" fill="transparent" class="aip-spark-hover-target" ' +
        'data-date="' + dailyHistory[i].date + '" data-value="' + values[i] + '" data-x="' + c.x + '" data-y="' + c.y + '"></circle>';
    }).join('');
    const labels = '<div class="d-flex justify-content-between small text-muted mt-1">' +
      '<span>' + dailyHistory[0].date + '</span><span>' + dailyHistory[dailyHistory.length - 1].date + '</span></div>';
    return '<div class="aip-spark-wrap" id="' + instanceId + '" style="position:relative;">' +
      '<div class="aip-spark-tooltip" style="display:none;"></div>' +
      '<svg viewBox="0 0 ' + width + ' ' + height + '" style="width:100%;height:100px;overflow:visible;">' +
        '<polyline points="' + points + '" fill="none" stroke="#000000" stroke-width="2"></polyline>' + dots + hoverTargets +
      '</svg>' + labels +
      '</div>';
  }

  // Câble l'interactivité de survol sur TOUS les graphiques encore non initialisés présents dans le
  // panneau (marqués data-wired absent) : appelé juste après chaque insertion de buildSparkline()
  // dans le DOM (un <script> injecté via innerHTML ne s'exécute jamais, contrairement à un appel
  // JS direct après coup — cf. limitation standard du DOM).
  function wireSparklines() {
    document.querySelectorAll('.aip-spark-wrap:not([data-wired])').forEach(function (wrap) {
      wrap.dataset.wired = '1';
      wireSparklineTooltip(wrap);
    });
  }

  // Positionne et remplit la bulle de tooltip au survol d'un point — délégation d'événement sur le
  // conteneur du graphique plutôt qu'un listener par point (jusqu'à 90 points sur la période 90j).
  function wireSparklineTooltip(wrap) {
    const tooltip = wrap.querySelector('.aip-spark-tooltip');
    const svg = wrap.querySelector('svg');
    const svgWidth = svg.viewBox.baseVal.width;

    wrap.addEventListener('mousemove', function (e) {
      const target = e.target.closest('.aip-spark-hover-target');
      if (!target) { tooltip.style.display = 'none'; return; }
      const date = new Date(target.dataset.date);
      const dateLabel = date.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
      tooltip.innerHTML = '<strong>' + target.dataset.value + '</strong> unité(s)<br><span class="text-muted">' + dateLabel + '</span>';
      tooltip.style.display = '';
      // Position en % de la largeur réelle du wrap (le SVG est en viewBox, pas en pixels fixes) :
      // convertit la coordonnée x du point (0-400 dans le viewBox) en position horizontale relative.
      const xPct = (parseFloat(target.dataset.x) / svgWidth) * 100;
      tooltip.style.left = xPct + '%';
      // Le point le plus à droite pousserait la bulle hors du panneau (largeur fixe 480px) sans
      // ce garde-fou : on l'ancre à droite plutôt qu'à gauche passé 70% de la largeur.
      if (xPct > 70) {
        tooltip.style.transform = 'translate(-100%, -115%)';
      } else {
        tooltip.style.transform = 'translate(-10%, -115%)';
      }
    });
    wrap.addEventListener('mouseleave', function () { tooltip.style.display = 'none'; });
  };

  // Statistiques calculées directement à partir de l'historique réellement disponible (jamais une
  // période fixe artificielle) : moyenne journalière/hebdomadaire et tendance récente (comparaison
  // 1ère moitié vs 2e moitié de la période affichée) — cf. demande explicite de voir "la moyenne
  // aussi et d'autres calculs" à côté du tableau de ventes.
  function computeHistoryStats(dailyHistory) {
    if (!dailyHistory || dailyHistory.length === 0) return null;
    const values = dailyHistory.map(function (d) { return d.quantity || 0; });
    const total = values.reduce(function (a, b) { return a + b; }, 0);
    const avgDaily = total / values.length;
    const avgWeekly = avgDaily * 7;

    let trendPct = null;
    if (values.length >= 4) {
      const mid = Math.floor(values.length / 2);
      const firstHalf = values.slice(0, mid);
      const secondHalf = values.slice(mid);
      const avgFirst = firstHalf.reduce(function (a, b) { return a + b; }, 0) / firstHalf.length;
      const avgSecond = secondHalf.reduce(function (a, b) { return a + b; }, 0) / secondHalf.length;
      if (avgFirst > 0) trendPct = ((avgSecond - avgFirst) / avgFirst) * 100;
    }

    return {
      days: values.length,
      total: Math.round(total * 100) / 100,
      avgDaily: Math.round(avgDaily * 100) / 100,
      avgWeekly: Math.round(avgWeekly * 100) / 100,
      trendPct: trendPct !== null ? Math.round(trendPct) : null,
    };
  }

  // Tableau simple Date / Quantité vendue, du plus récent au plus ancien (cf. demande explicite —
  // format lisible en plus du graphique, pas à la place). Limité à 20 lignes affichées avec un
  // repli "voir plus" plutôt que de rendre le panneau interminable sur une période de 90 jours.
  const HISTORY_TABLE_INITIAL_ROWS = 10;

  function buildHistoryTable(dailyHistory) {
    if (!dailyHistory || dailyHistory.length === 0) return '<p class="text-muted small">Aucune vente sur cette période.</p>';
    const rows = dailyHistory.slice().reverse(); // plus récent en premier
    function rowHtml(d) {
      const dateLabel = new Date(d.date).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
      return '<tr><td>' + dateLabel + '</td><td class="text-end">' + d.quantity + '</td></tr>';
    }
    const visibleRows = rows.slice(0, HISTORY_TABLE_INITIAL_ROWS).map(rowHtml).join('');
    const hiddenRows = rows.slice(HISTORY_TABLE_INITIAL_ROWS).map(rowHtml).join('');
    const toggleBtn = hiddenRows
      ? '<button type="button" class="btn btn-link btn-sm p-0 mt-1" id="aip-history-table-toggle">Voir les ' + (rows.length - HISTORY_TABLE_INITIAL_ROWS) + ' jour(s) précédent(s)</button>'
      : '';
    return '<div class="table-responsive"><table class="table table-sm mb-0"><thead><tr><th>Date</th><th class="text-end">Quantité vendue</th></tr></thead>' +
      '<tbody>' + visibleRows + '<tbody id="aip-history-table-hidden" style="display:none;">' + hiddenRows + '</tbody></tbody></table></div>' +
      toggleBtn;
  }

  function wireHistoryTableToggle() {
    const btn = document.getElementById('aip-history-table-toggle');
    if (!btn) return;
    btn.addEventListener('click', function () {
      const hidden = document.getElementById('aip-history-table-hidden');
      hidden.style.display = '';
      btn.remove();
    });
  }

  // Bloc de statistiques (moyenne, tendance) sous forme de petites tuiles, à côté du tableau.
  function buildStatsBlock(stats) {
    if (!stats) return '';
    const trendHtml = stats.trendPct !== null
      ? '<div class="col-6"><div class="text-muted small">Tendance récente</div><div class="fs-20 fw-semibold ' + (stats.trendPct > 0 ? 'text-success' : stats.trendPct < 0 ? 'text-danger' : '') + '">' + (stats.trendPct > 0 ? '+' : '') + stats.trendPct + '%</div></div>'
      : '';
    return '<div class="aip-classic-card mb-3">' +
      '<div class="aip-classic-eyebrow">Calculs sur les ' + stats.days + ' jour(s) disponible(s)</div>' +
      '<div class="row g-2">' +
        '<div class="col-6"><div class="text-muted small">Moyenne / jour</div><div class="fs-20 fw-semibold">' + stats.avgDaily + '</div></div>' +
        '<div class="col-6"><div class="text-muted small">Moyenne / semaine</div><div class="fs-20 fw-semibold">' + stats.avgWeekly + '</div></div>' +
        trendHtml +
        '<div class="col-6"><div class="text-muted small">Total vendu</div><div class="fs-20 fw-semibold">' + stats.total + '</div></div>' +
      '</div>' +
    '</div>';
  }

  // Bloc "Dernière commande" — réutilisé dans la vue simple (pas seulement la vue détail) pour que
  // l'information soit visible sans clic supplémentaire, cf. demande explicite.
  function buildRecentOrderBlock(item) {
    if (!item.hasRecentOrder) return '';
    return '<div class="aip-classic-card mb-3">' +
      '<div class="aip-classic-eyebrow">Dernière commande (7 derniers jours, hors de cette analyse)</div>' +
      '<p class="small mb-0">Référence <strong>' + (item.recentOrderReference || '—') + '</strong>, passée le ' +
        (item.recentOrderDate ? new Date(item.recentOrderDate).toLocaleDateString('fr-FR') : '—') +
        (item.recentOrderCount && item.recentOrderCount > 1 ? ' (+ ' + (item.recentOrderCount - 1) + ' autre(s))' : '') + '.</p>' +
      '</div>';
  }

  // Bloc "Impact de cette commande" : stock avant/après + jours de couverture estimés à partir de
  // la moyenne journalière calculée sur l'historique disponible (cf. demande explicite : "le stock
  // avant la validation de la commande" et autres infos pertinentes pour l'analyse).
  function buildImpactBlock(item, quantity, stats) {
    const stockBefore = item.stockAtPrediction;
    if (stockBefore === undefined || stockBefore === null) return '';
    const stockAfter = stockBefore + quantity;
    const avgDaily = stats ? stats.avgDaily : null;
    const coverageDays = avgDaily && avgDaily > 0 ? Math.round((stockAfter / avgDaily) * 10) / 10 : null;
    return '<div class="aip-classic-card mb-3">' +
      '<div class="aip-classic-eyebrow">Impact de cette commande</div>' +
      '<div class="row g-2">' +
        '<div class="col-4"><div class="text-muted small">Stock avant</div><div class="fs-20 fw-semibold">' + Math.round(stockBefore) + '</div></div>' +
        '<div class="col-4"><div class="text-muted small">+ Commande</div><div class="fs-20 fw-semibold">' + quantity + '</div></div>' +
        '<div class="col-4"><div class="text-muted small">Stock après</div><div class="fs-20 fw-semibold">' + Math.round(stockAfter) + '</div></div>' +
      '</div>' +
      (coverageDays !== null ? '<div class="small text-muted mt-2">Couverture estimée après réception : environ <strong>' + coverageDays + ' jour(s)</strong> au rythme de vente actuel.</div>' : '') +
      '</div>';
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

  // quantityForImpact : la quantité recommandée à utiliser pour le bloc "Impact de cette commande"
  // (peut différer de item.predictedQuantity si l'utilisateur consulte après un streaming en
  // direct — currentAiResult.quantity est alors la valeur à jour) ; optionnel, retombe sur
  // item.predictedQuantity si absent.
  async function loadHistoryForPeriod(item, days, quantityForImpact) {
    const container = document.getElementById('aip-sparkline-container');
    const tableContainer = document.getElementById('aip-history-table-container');
    const statsContainer = document.getElementById('aip-stats-container');
    const impactContainer = document.getElementById('aip-impact-container');
    container.innerHTML = '<p class="text-muted small">Chargement...</p>';
    try {
      const res = await window.reassortFetch('/reassort/predictions/history?shop=' + encodeURIComponent(item.shopId) + '&ean=' + encodeURIComponent(item.ean) + '&days=' + days);
      const json = await res.json();
      if (!json.success) throw new Error(json.message);
      const dailyHistory = json.data.dailyHistory;
      container.innerHTML = buildSparkline(dailyHistory);
      wireSparklines();

      const stats = computeHistoryStats(dailyHistory);
      if (statsContainer) statsContainer.innerHTML = buildStatsBlock(stats);
      if (tableContainer) {
        tableContainer.innerHTML = buildHistoryTable(dailyHistory);
        wireHistoryTableToggle();
      }
      if (impactContainer) {
        const quantity = quantityForImpact !== undefined ? quantityForImpact : item.predictedQuantity;
        impactContainer.innerHTML = buildImpactBlock(item, quantity, stats);
      }
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
          '<div class="aip-reasoning-block">' + (currentAiResult.reasoning ? markdownLiteToHtml(currentAiResult.reasoning) : '—') + '</div>' +
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
    wireSparklines();

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

  // Si cet article a déjà été analysé par l'IA au moment de la génération (aiAdjusted=true,
  // AI_QUANTITY_ADJUSTMENT_ENABLED actif dans Paramètres > IA) ou lors d'un précédent clic
  // "Analyser" dans cette même session, le résultat (quantité + raisonnement) est déjà connu :
  // l'afficher directement sans nouvel appel réseau. Refaire systématiquement un appel LLM pour une
  // donnée déjà calculée était le comportement précédent — coûteux (appel API à chaque ouverture du
  // panneau) et inutilement lent, alors que rien n'a changé depuis le calcul initial.
  function existingResultFor(item) {
    if (item.generationAiAdjusted && item.generationAiReasoning) {
      return { quantity: item.predictedQuantity, reasoning: item.generationAiReasoning, providerUsed: null, fromCache: true };
    }
    return null;
  }

  window.openAiRecommendationPanel = function (item) {
    ensureStylesAndDom();
    currentItem = item;
    currentAiResult = null;
    document.getElementById('aip-detail-title').textContent = item.label || item.ean;
    document.getElementById('aip-detail-body').innerHTML =
      '<div id="aip-simple-view" class="aip-simple-view"></div>' +
      '<div id="aip-detail-view" class="aip-detail-view"></div>';
    // Panneau étroit par défaut à l'ouverture (chargement) : élargi (aip-wide/aip-two-col)
    // seulement une fois la recommandation effectivement prête à afficher, ci-dessous.
    document.getElementById('aip-detail-panel').classList.remove('aip-wide');
    document.getElementById('aip-simple-view').classList.remove('aip-two-col');
    showPanel();

    const existing = existingResultFor(item);
    if (existing) {
      currentAiResult = existing;
      const box = document.getElementById('aip-simple-view');
      // Le récapitulatif complet (raisonnement, tableau de ventes, stats, impact) doit être visible
      // directement même pour un résultat déjà calculé à la génération (pas seulement juste après un
      // streaming en direct) : un "Pourquoi ?" à cliquer en plus masquait ces détails sans raison,
      // alors que le magasin veut voir stock/moyenne/tendance dès l'ouverture du panneau.
      box.classList.add('aip-two-col');
      document.getElementById('aip-detail-panel').classList.add('aip-wide');
      box.innerHTML = aiReadyHtml(existing);
      wireSimpleViewEvents(item);
    } else {
      document.getElementById('aip-simple-view').innerHTML = aiLoadingHtml();
      runAiAnalysis(item);
    }
  };
})();
