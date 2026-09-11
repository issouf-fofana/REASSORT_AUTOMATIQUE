(function () {
  const shopSelect = document.getElementById('aia-shop');
  const departmentSelect = document.getElementById('aia-department');
  const subDepartmentInput = document.getElementById('aia-subdepartment');
  const chatWindow = document.getElementById('aia-chat-window');
  const emptyHint = document.getElementById('aia-empty-hint');
  const suggestionsContainer = document.getElementById('aia-suggestions-container');
  const input = document.getElementById('aia-input');
  const sendBtn = document.getElementById('aia-send-btn');
  const newConvBtn = document.getElementById('aia-new-conv-btn');
  const convItemsEl = document.getElementById('aia-conv-items');

  let suggestedQuestions = [];
  let conversations = [];
  let currentConversationId = null;

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
    const rows = lines.slice(0, 20).map(function (l) {
      const qty = l.quantity !== undefined ? l.quantity : (l.quantitySuggested !== undefined ? l.quantitySuggested : '—');
      const stock = l.stockAtGeneration !== undefined ? l.stockAtGeneration : (l.stock !== undefined ? l.stock : null);
      return '<tr>' +
        '<td>' + escapeHtml(l.label || l.ean || '—') + '</td>' +
        (hasStock ? '<td class="text-end">' + (stock !== null ? stock : '—') + '</td>' : '') +
        (hasDays ? '<td class="text-end">' + (l.daysUntilStockout !== undefined && l.daysUntilStockout !== null ? Math.round(l.daysUntilStockout) + ' j' : '—') + '</td>' : '') +
        '<td class="text-end">' + qty + '</td>' +
        '</tr>';
    }).join('');

    return '<div class="table-responsive mt-2"><table class="table table-sm aia-table">' +
      '<thead><tr><th>Article</th>' + (hasStock ? '<th class="text-end">Stock</th>' : '') + (hasDays ? '<th class="text-end">Rupture</th>' : '') + '<th class="text-end">' + escapeHtml(quantityLabel || 'Quantité') + '</th></tr></thead>' +
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
      if (shopSelect.value) onShopReady();
    } catch (err) {
      shopSelect.innerHTML = '<option value="">Erreur: ' + err.message + '</option>';
    }
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

      if (json.data.rposShopId && shopSelect.querySelector('option[value="' + json.data.rposShopId + '"]')) {
        shopSelect.value = json.data.rposShopId;
        onShopReady();
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
    emptyHint.style.display = shopSelect.value ? 'none' : '';
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
    loadDepartments(shopSelect.value);
  }

  async function sendQuestion() {
    const question = input.value.trim();
    if (!question || !shopSelect.value) return;
    input.value = '';
    sendBtn.disabled = true;
    input.disabled = true;
    emptyHint.style.display = 'none';

    const answerEl = appendTurn(question, '<span class="aia-stream-cursor">▍</span>');
    chatWindow.scrollTop = chatWindow.scrollHeight;
    let streamedAnswer = '';

    try {
      const res = await window.reassortFetch('/reassort/chatbot/ask-stream?shop=' + encodeURIComponent(shopSelect.value), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: currentConversationId,
          department: departmentSelect.value || null,
          subDepartment: subDepartmentInput.value.trim() || null,
          question: question,
        }),
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
      answerEl.innerHTML = markdownLiteToHtml(finalResult.answer) + buildVisualFromToolResult(finalResult.toolResult);

      const isNewConversation = !currentConversationId;
      currentConversationId = finalResult.conversationId;
      if (isNewConversation) await loadConversations();
      else renderConversationList();
    } catch (err) {
      answerEl.innerHTML = '<span class="text-danger">Erreur : ' + escapeHtml(err.message) + '</span>';
    } finally {
      sendBtn.disabled = false;
      input.disabled = false;
      input.focus();
      chatWindow.scrollTop = chatWindow.scrollHeight;
    }
  }

  shopSelect.addEventListener('change', function () {
    startNewConversation();
    if (shopSelect.value) onShopReady();
  });

  newConvBtn.addEventListener('click', startNewConversation);
  sendBtn.addEventListener('click', sendQuestion);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') sendQuestion();
  });

  loadShopList();
  loadSuggestedQuestions();
  loadConversations();
})();
