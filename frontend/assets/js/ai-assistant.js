(function () {
  const shopContextEl = document.getElementById('aia-shop-context');
  const departmentSelect = document.getElementById('aia-department');
  const subDepartmentInput = document.getElementById('aia-subdepartment');
  const chatWindow = document.getElementById('aia-chat-window');
  const emptyHint = document.getElementById('aia-empty-hint');
  const suggestionsContainer = document.getElementById('aia-suggestions-container');
  const suggestionsToggleBtn = document.getElementById('aia-suggestions-toggle');
  const input = document.getElementById('aia-input');
  const sendBtn = document.getElementById('aia-send-btn');
  const newConvBtn = document.getElementById('aia-new-conv-btn');
  const convItemsEl = document.getElementById('aia-conv-items');

  let suggestedQuestions = [];
  let conversations = [];
  let currentConversationId = null;
  let shopsById = new Map(); // chargée une fois, utilisée pour retrouver reference/name d'un rposShopId (ex: rouvrir une ancienne conversation d'un autre magasin, cf. openConversation)

  async function loadShopsMap() {
    try {
      const res = await window.reassortFetch('/reassort/shops');
      const json = await res.json();
      if (json.success) shopsById = new Map(json.data.map(function (s) { return [s.id, s]; }));
    } catch (err) { /* best-effort : un échec laisse juste la restauration de magasin inopérante */ }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function markdownLiteToHtml(text) {
    if (!text) return '';
    const escaped = escapeHtml(text);
    const lines = escaped.split('\n');
    const htmlParts = [];
    let listBuffer = [];
    function flushList() {
      if (listBuffer.length) {
        htmlParts.push('<ul class="aia-md-list">' + listBuffer.map(function (item) { return '<li>' + item + '</li>'; }).join('') + '</ul>');
        listBuffer = [];
      }
    }
    lines.forEach(function (rawLine) {
      const line = rawLine.trim();
      const bulletMatch = line.match(/^[-*]\s+(.*)/);
      if (bulletMatch) { listBuffer.push(applyInlineMarkdown(bulletMatch[1])); return; }
      flushList();
      if (line) htmlParts.push('<p>' + applyInlineMarkdown(line) + '</p>');
    });
    flushList();
    return htmlParts.join('');
  }

  function applyInlineMarkdown(str) {
    // Le gras (**mot**) est traité en premier : sinon les deux astérisques du gras seraient
    // consommés par erreur par la règle d'italique simple (*mot*) ci-dessous.
    return str
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>');
  }

  // Construit un graphique (SVG, pas de librairie) ou un tableau directement à partir des vraies
  // données de l'outil appelé (toolResult), jamais reformatées par le LLM : évite qu'un rendu
  // visuel s'appuie sur un chiffre halluciné ou déformé en le redécrivant dans le texte de réponse.
  function buildVisualFromToolResult(toolResult) {
    if (!toolResult || !toolResult.found) return '';

    if (Array.isArray(toolResult.dailyHistory) && toolResult.dailyHistory.length > 1) {
      return buildLineChart(toolResult.dailyHistory) + (Array.isArray(toolResult.topArticles) && toolResult.topArticles.length ? buildArticlesTable(toolResult.topArticles, 'Quantité vendue') : '');
    }
    if (Array.isArray(toolResult.lines) && toolResult.lines.length) {
      return buildArticlesTable(toolResult.lines);
    }
    return '';
  }

  function buildLineChart(dailyHistory) {
    const width = 560;
    const height = 160;
    const padding = 28;
    const values = dailyHistory.map(function (d) { return d.quantity || 0; });
    const max = Math.max.apply(null, values.concat([1]));
    const stepX = (width - padding * 2) / Math.max(values.length - 1, 1);

    const points = values.map(function (v, i) {
      const x = padding + i * stepX;
      const y = height - padding - (v / max) * (height - padding * 2);
      return x + ',' + y;
    }).join(' ');

    const dots = values.map(function (v, i) {
      const x = padding + i * stepX;
      const y = height - padding - (v / max) * (height - padding * 2);
      return '<circle cx="' + x + '" cy="' + y + '" r="3" fill="#000000"></circle>';
    }).join('');

    const firstLabel = dailyHistory[0].date;
    const lastLabel = dailyHistory[dailyHistory.length - 1].date;

    return '<div class="aia-chart-wrap">' +
      '<svg viewBox="0 0 ' + width + ' ' + height + '" style="width:100%;height:auto;overflow:visible;">' +
        '<polyline points="' + points + '" fill="none" stroke="#000000" stroke-width="2"></polyline>' + dots +
      '</svg>' +
      '<div class="d-flex justify-content-between small text-muted mt-1"><span>' + escapeHtml(firstLabel) + '</span><span>' + escapeHtml(lastLabel) + '</span></div>' +
      '</div>';
  }

  function buildArticlesTable(lines, quantityLabel) {
    const hasStock = lines.some(function (l) { return l.stockAtGeneration !== undefined || l.stock !== undefined; });
    const hasDays = lines.some(function (l) { return l.daysUntilStockout !== undefined && l.daysUntilStockout !== null; });
    // La quantité (vendue ou proposée) n'existe pas sur toutes les formes de "lines" — getParetoArticles
    // (part du chiffre d'affaires) ne renvoie que revenueSharePct/cumulativePct, jamais une quantité.
    // Sans cette détection, la colonne "Quantité" s'affichait quand même avec un tiret sur chaque ligne
    // (bug trouvé le 16/09/2026 : "quantité il n'affiche rien"), plutôt que de simplement ne pas
    // afficher une colonne qui n'a pas de sens pour cet outil.
    const hasQuantity = lines.some(function (l) { return l.quantity !== undefined || l.quantitySuggested !== undefined; });
    const hasRevenueShare = lines.some(function (l) { return l.revenueSharePct !== undefined; });
    const rows = lines.slice(0, 20).map(function (l) {
      const qty = l.quantity !== undefined ? l.quantity : (l.quantitySuggested !== undefined ? l.quantitySuggested : '—');
      const stock = l.stockAtGeneration !== undefined ? l.stockAtGeneration : (l.stock !== undefined ? l.stock : null);
      return '<tr>' +
        '<td>' + escapeHtml(l.label || l.ean || '—') + '</td>' +
        (hasStock ? '<td class="text-end">' + (stock !== null ? stock : '—') + '</td>' : '') +
        (hasDays ? '<td class="text-end">' + (l.daysUntilStockout !== undefined && l.daysUntilStockout !== null ? Math.round(l.daysUntilStockout) + ' j' : '—') + '</td>' : '') +
        (hasQuantity ? '<td class="text-end">' + qty + '</td>' : '') +
        (hasRevenueShare ? '<td class="text-end">' + (l.revenueSharePct !== undefined ? l.revenueSharePct + ' %' : '—') + '</td>' : '') +
        '</tr>';
    }).join('');

    return '<div class="table-responsive mt-2"><table class="table table-sm aia-table">' +
      '<thead><tr><th>Article</th>' + (hasStock ? '<th class="text-end">Stock</th>' : '') + (hasDays ? '<th class="text-end">Rupture</th>' : '') + (hasQuantity ? '<th class="text-end">' + escapeHtml(quantityLabel || 'Quantité') + '</th>' : '') + (hasRevenueShare ? '<th class="text-end">Part du CA</th>' : '') + '</tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
      '</table></div>';
  }

  async function consumeSseStream(res, onEvent) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop();
      for (const eventBlock of events) {
        const lines = eventBlock.split('\n');
        let eventName = 'message';
        let dataStr = '';
        for (const line of lines) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
        }
        if (!dataStr) continue;
        try { onEvent(eventName, JSON.parse(dataStr)); } catch { /* événement mal formé ignoré */ }
      }
    }
  }

  // Suit désormais le SÉLECTEUR DE MAGASIN GLOBAL de la topbar (demande du 16/09/2026 : un
  // ADMIN/SUPERVISOR voyait un magasin en haut de page mais cette page répondait pour un autre
  // magasin resté sélectionné dans son propre <select> indépendant, jamais synchronisé — deux
  // sources de vérité pour "quel magasin" sur la même page). Pour un rôle à magasin unique
  // (DIRECTOR/DEPARTMENT_HEAD/SHELF_STOCKER, ex-STORE), reassortGetActiveShop() renvoie toujours
  // null (pas de sélecteur affiché pour eux) : le magasin effectif est alors déterminé côté serveur
  // par resolveShopId (req.user.rposShopId), jamais par ce paramètre.
  function currentShopId() {
    const user = window.reassortGetUser && window.reassortGetUser();
    if (user && window.reassortIsSingleShopRole(user.role)) return user.rposShopId || null;
    const shop = window.reassortGetActiveShop();
    return shop ? shop.id : null;
  }

  function refreshShopContext() {
    const user = window.reassortGetUser && window.reassortGetUser();
    let label;
    if (user && window.reassortIsSingleShopRole(user.role)) {
      label = user.rposShopName ? user.rposShopReference + ' - ' + user.rposShopName : null;
    } else {
      const shop = window.reassortGetActiveShop();
      label = shop ? shop.reference + ' - ' + shop.name : null;
    }
    shopContextEl.textContent = label || 'Sélectionnez un magasin (en haut de page)';
    if (currentShopId()) onShopReady();
    else { input.disabled = true; sendBtn.disabled = true; }
  }

  async function loadDepartments(shopId) {
    departmentSelect.innerHTML = '<option value="">Tous les rayons</option>';
    try {
      const res = await window.reassortFetch('/reassort/predictions?shop=' + encodeURIComponent(shopId));
      const json = await res.json();
      if (!json.success || !json.data.predictions) return;
      const departments = Array.from(new Set(json.data.predictions.map(function (p) { return p.department; }).filter(Boolean))).sort();
      departmentSelect.innerHTML = '<option value="">Tous les rayons</option>' +
        departments.map(function (d) { return '<option value="' + escapeHtml(d) + '">' + escapeHtml(d) + '</option>'; }).join('');
    } catch { /* liste de rayons optionnelle */ }
  }

  async function loadSuggestedQuestions() {
    try {
      const res = await window.reassortFetch('/reassort/chatbot/suggested-questions');
      const json = await res.json();
      if (json.success) suggestedQuestions = json.data;
      renderSuggestions();
    } catch { /* suggestions optionnelles */ }
  }

  function renderSuggestions() {
    suggestionsContainer.innerHTML = '<div class="d-flex flex-wrap gap-2">' +
      suggestedQuestions.map(function (q) {
        return '<button type="button" class="btn btn-outline-secondary btn-sm aia-suggestion-btn">' + escapeHtml(q) + '</button>';
      }).join('') +
      '</div>';
    suggestionsContainer.querySelectorAll('.aia-suggestion-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        input.value = btn.textContent;
        sendQuestion();
      });
    });
  }

  // Masquer/afficher les suggestions (demande du 15/09/2026) : la liste prend de la place en
  // permanence au-dessus du champ de saisie — état mémorisé par utilisateur pour rester replié
  // d'une session à l'autre si c'est le choix fait une fois.
  const SUGGESTIONS_HIDDEN_KEY = 'aia-suggestions-hidden';
  function applySuggestionsVisibility() {
    const hidden = localStorage.getItem(SUGGESTIONS_HIDDEN_KEY) === '1';
    suggestionsContainer.style.display = hidden ? 'none' : '';
    suggestionsToggleBtn.textContent = hidden ? 'Afficher' : 'Masquer';
  }
  suggestionsToggleBtn.addEventListener('click', function () {
    const hidden = localStorage.getItem(SUGGESTIONS_HIDDEN_KEY) === '1';
    localStorage.setItem(SUGGESTIONS_HIDDEN_KEY, hidden ? '0' : '1');
    applySuggestionsVisibility();
  });
  applySuggestionsVisibility();

  async function loadConversations() {
    try {
      const res = await window.reassortFetch('/reassort/chatbot/conversations');
      const json = await res.json();
      if (!json.success) throw new Error(json.message);
      conversations = json.data;
      renderConversationList();
    } catch (err) {
      convItemsEl.innerHTML = '<div class="p-3 text-danger small">Erreur : ' + escapeHtml(err.message) + '</div>';
    }
  }

  function renderConversationList() {
    if (!conversations.length) {
      convItemsEl.innerHTML = '<div class="p-3 text-muted small">Aucune conversation pour le moment.</div>';
      return;
    }
    convItemsEl.innerHTML = conversations.map(function (c) {
      return '<div class="aia-conv-item' + (c.id === currentConversationId ? ' active' : '') + '" data-id="' + c.id + '">' +
        '<span class="aia-conv-title">' + escapeHtml(c.title) + '</span>' +
        '<iconify-icon icon="solar:trash-bin-minimalistic-linear" class="aia-conv-delete" data-id="' + c.id + '"></iconify-icon>' +
        '</div>';
    }).join('');
    convItemsEl.querySelectorAll('.aia-conv-item').forEach(function (el) {
      el.addEventListener('click', function (e) {
        if (e.target.closest('.aia-conv-delete')) return;
        openConversation(el.dataset.id);
      });
    });
    convItemsEl.querySelectorAll('.aia-conv-delete').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        askDeleteConversation(el.dataset.id);
      });
    });
  }

  // Modale Bootstrap au lieu de confirm() natif (style système non cohérent avec le reste de
  // l'interface) : cf. modal #aia-delete-modal dans ai-assistant.html.
  const deleteModalEl = document.getElementById('aia-delete-modal');
  const deleteConfirmBtn = document.getElementById('aia-delete-confirm-btn');
  let deleteModal = null;
  let pendingDeleteId = null;

  function askDeleteConversation(id) {
    pendingDeleteId = id;
    if (!deleteModal) deleteModal = new bootstrap.Modal(deleteModalEl);
    deleteModal.show();
  }

  deleteConfirmBtn.addEventListener('click', async function () {
    if (!pendingDeleteId) return;
    await window.reassortFetch('/reassort/chatbot/conversations/' + pendingDeleteId, { method: 'DELETE' });
    if (pendingDeleteId === currentConversationId) startNewConversation();
    pendingDeleteId = null;
    deleteModal.hide();
    loadConversations();
  });

  async function openConversation(id) {
    try {
      const res = await window.reassortFetch('/reassort/chatbot/conversations/' + id);
      const json = await res.json();
      if (!json.success) throw new Error(json.message);
      currentConversationId = id;
      renderConversationList();

      // Rouvrir une ancienne conversation d'un autre magasin met à jour le sélecteur GLOBAL (topbar)
      // plutôt qu'un état local à cette page — un seul magasin actif partagé par toute
      // l'application, jamais deux affichages divergents (cf. currentShopId ci-dessus). Pas
      // d'action pour un rôle à magasin unique (rien à changer, un seul magasin possible).
      const user = window.reassortGetUser && window.reassortGetUser();
      const convShop = json.data.rposShopId ? shopsById.get(json.data.rposShopId) : null;
      if (convShop && !(user && window.reassortIsSingleShopRole(user.role)) && convShop.id !== currentShopId()) {
        window.reassortSetActiveShop({ id: convShop.id, reference: convShop.reference, name: convShop.name });
      }
      departmentSelect.value = json.data.department || '';
      subDepartmentInput.value = json.data.subDepartment || '';

      chatWindow.innerHTML = '';
      emptyHint.style.display = 'none';
      for (let i = 0; i < json.data.messages.length; i += 2) {
        const userMsg = json.data.messages[i];
        const assistantMsg = json.data.messages[i + 1];
        let visualHtml = '';
        if (assistantMsg && assistantMsg.toolResult) {
          try { visualHtml = buildVisualFromToolResult(JSON.parse(assistantMsg.toolResult)); } catch { /* résultat mal formé, ignoré */ }
        }
        appendTurn(userMsg ? userMsg.content : '', assistantMsg ? markdownLiteToHtml(assistantMsg.content) + visualHtml : '');
      }
      chatWindow.scrollTop = chatWindow.scrollHeight;
    } catch (err) {
      chatWindow.innerHTML = '<div class="text-danger small p-3">Erreur : ' + escapeHtml(err.message) + '</div>';
    }
  }

  function startNewConversation() {
    currentConversationId = null;
    chatWindow.innerHTML = '';
    chatWindow.appendChild(emptyHint);
    emptyHint.style.display = currentShopId() ? 'none' : '';
    renderConversationList();
  }

  function appendTurn(question, answerHtml) {
    const turnEl = document.createElement('div');
    turnEl.className = 'aia-turn';
    turnEl.innerHTML =
      '<div class="aia-question">' + escapeHtml(question) + '</div>' +
      '<div class="aia-answer">' + answerHtml + '</div>';
    chatWindow.appendChild(turnEl);
    return turnEl.querySelector('.aia-answer');
  }

  function onShopReady() {
    input.disabled = false;
    sendBtn.disabled = false;
    loadDepartments(currentShopId());
  }

  // Contrôleur de la génération en cours (permet de l'interrompre via le bouton "Arrêter" —
  // demande du 15/09/2026 : "comment je fais pour couper la réflexion en cas d'erreur", ex: une
  // réponse qui part visiblement de travers, comme un dump JSON brut au lieu d'un texte reformulé).
  let currentAbortController = null;

  function setSendingState(isSending) {
    input.disabled = isSending;
    if (isSending) {
      sendBtn.textContent = 'Arrêter';
      sendBtn.classList.remove('btn-dark');
      sendBtn.classList.add('btn-outline-danger');
    } else {
      sendBtn.textContent = 'Envoyer';
      sendBtn.classList.remove('btn-outline-danger');
      sendBtn.classList.add('btn-dark');
    }
  }

  // Une tentative d'appel + streaming (sans gestion d'erreur ni retry) : isolée pour être rejouable
  // telle quelle par sendQuestion en cas de coupure réseau en cours de flux (cf. plus bas). Retourne
  // { finalResult, streamedAnswer } — streamedAnswer permet d'afficher le texte partiel déjà reçu
  // même si l'utilisateur interrompt (Abort) pendant cette tentative précise.
  async function attemptQuestion(question, answerEl, signal) {
    let streamedAnswer = '';
    const res = await window.reassortFetch('/reassort/chatbot/ask-stream?shop=' + encodeURIComponent(currentShopId() || ''), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: currentConversationId,
        department: departmentSelect.value || null,
        subDepartment: subDepartmentInput.value.trim() || null,
        question: question,
      }),
      signal: signal,
    });
    if (!res.ok) throw new Error('Erreur serveur (' + res.status + ')');

    let finalResult = null;
    await consumeSseStream(res, function (eventName, data) {
      if (eventName === 'chunk') {
        streamedAnswer += data.text;
        answerEl.textContent = streamedAnswer;
        const cursor = document.createElement('span');
        cursor.className = 'aia-stream-cursor';
        cursor.textContent = '▍';
        answerEl.appendChild(cursor);
        chatWindow.scrollTop = chatWindow.scrollHeight;
      } else if (eventName === 'error') {
        throw new Error(data.message);
      } else if (eventName === 'done') {
        finalResult = data;
      }
    });
    if (!finalResult) throw new Error('Flux terminé sans réponse exploitable.');
    return { finalResult, streamedAnswer };
  }

  async function sendQuestion() {
    const question = input.value.trim();
    if (!question || !currentShopId()) return;
    input.value = '';
    setSendingState(true);
    emptyHint.style.display = 'none';

    const answerEl = appendTurn(question, '<span class="aia-stream-cursor">▍</span>');
    chatWindow.scrollTop = chatWindow.scrollHeight;

    // Une coupure réseau brève (latence, micro-déconnexion) peut interrompre le flux SSE avant
    // l'event "done" alors que le serveur a bien traité la question — observé en usage réel sans
    // jamais avoir pu être reproduit ni côté serveur (curl direct systématiquement correct) ni dans
    // un navigateur automatisé en local (ajouté le 16/09/2026). Une seule retentative automatique,
    // jamais si l'échec vient d'un Abort volontaire (bouton "Arrêter" — retenter irait à l'encontre
    // de la demande explicite de l'utilisateur).
    let finalResult = null;
    let streamedAnswer = '';
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      currentAbortController = new AbortController();
      try {
        const result = await attemptQuestion(question, answerEl, currentAbortController.signal);
        finalResult = result.finalResult;
        streamedAnswer = result.streamedAnswer;
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        streamedAnswer = ''; // repart d'un tour vide à la tentative suivante, pas de texte partiel dupliqué
        if (err.name === 'AbortError' || attempt === 2) break;
        answerEl.innerHTML = '<span class="aia-stream-cursor">▍</span>';
      }
    }

    if (finalResult) {
      answerEl.innerHTML = markdownLiteToHtml(finalResult.answer) + buildVisualFromToolResult(finalResult.toolResult);
      const isNewConversation = !currentConversationId;
      currentConversationId = finalResult.conversationId;
      if (isNewConversation) await loadConversations();
      else renderConversationList();
    } else if (lastErr.name === 'AbortError') {
      // Interruption volontaire (bouton "Arrêter") : le texte déjà reçu reste affiché tel quel,
      // avec une mention explicite, plutôt qu'un message d'erreur qui laisserait croire à un bug.
      answerEl.innerHTML = markdownLiteToHtml(streamedAnswer) + '<div class="text-muted small mt-1">(réponse interrompue)</div>';
    } else {
      answerEl.innerHTML = '<span class="text-danger">Erreur : ' + escapeHtml(lastErr.message) + '</span>';
      if (window.reassortReportError) window.reassortReportError('Assistant IA (après 2 tentatives): ' + lastErr.message, lastErr.stack);
    }

    currentAbortController = null;
    setSendingState(false);
    input.focus();
    chatWindow.scrollTop = chatWindow.scrollHeight;
  }

  function stopGeneration() {
    if (currentAbortController) currentAbortController.abort();
  }

  // Changer de magasin en haut de page (sélecteur global) repart sur une conversation neuve — une
  // conversation est rattachée à un magasin précis côté serveur, jamais mélangée entre deux
  // magasins (remplace l'ancien shopSelect.addEventListener('change', ...) propre à cette page).
  function initShopContext() {
    if (!window.reassortGetActiveShop) { setTimeout(initShopContext, 200); return; } // attend global-shop-selector.js
    window.reassortOnActiveShopChange(function () {
      startNewConversation();
      refreshShopContext();
    });
    refreshShopContext();
  }

  newConvBtn.addEventListener('click', startNewConversation);
  sendBtn.addEventListener('click', function () {
    if (currentAbortController) stopGeneration();
    else sendQuestion();
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !currentAbortController) sendQuestion();
  });

  loadShopsMap().then(initShopContext);
  loadSuggestedQuestions();
  loadConversations();
})();
