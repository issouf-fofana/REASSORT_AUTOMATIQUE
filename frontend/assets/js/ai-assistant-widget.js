/**
 * Bouton flottant Assistant IA (CAHIER_DES_CHARGES.md §34, étape 11) : accessible depuis n'importe
 * quelle page (inclus dans chaque .html, comme layout.js), ouvre une fenêtre de chat compacte sans
 * changer de page. Réutilise le même backend que ai-assistant.html (chatbot/ask-stream,
 * chatbot/conversations) — une conversation démarrée ici apparaît aussi dans la page dédiée.
 *
 * Volontairement un fichier séparé de ai-assistant.js (pas de fonctions partagées) : les deux
 * s'exécutent parfois sur la même page si l'utilisateur ouvre le widget depuis /ai-assistant, et
 * dupliquer quelques dizaines de lignes coûte moins cher qu'un couplage entre deux scripts chargés
 * indépendamment selon la page.
 */
(function () {
  // N'affiche pas le widget sur la page de connexion (pas encore de compte utilisateur/magasin).
  if (window.location.pathname === '/login' || window.location.pathname.indexOf('auth-signin') !== -1) return;

  const CSS = `
    #aiw-toggle-btn {
      position: fixed; bottom: 24px; right: 24px; width: 56px; height: 56px; border-radius: 50%;
      background-color: #000000; color: #ffffff; border: none; box-shadow: 0 4px 16px rgba(0,0,0,.25);
      z-index: 1050; display: flex; align-items: center; justify-content: center; font-size: 1.5rem;
      cursor: pointer;
    }
    #aiw-toggle-btn:hover { background-color: #222222; }
    #aiw-window {
      position: fixed; bottom: 92px; right: 24px; width: 380px; max-width: 92vw; height: 520px;
      max-height: 75vh; background-color: #ffffff; border: 1px solid #e5e5e5; border-radius: 8px;
      box-shadow: 0 8px 32px rgba(0,0,0,.2); z-index: 1050; display: none; flex-direction: column;
      overflow: hidden;
    }
    #aiw-window.show { display: flex; }
    #aiw-header { padding: .75rem 1rem; background-color: #000000; color: #ffffff; display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
    #aiw-header .aiw-title { font-weight: 600; font-size: .95rem; }
    #aiw-close-btn { background: none; border: none; color: #ffffff; font-size: 1.2rem; cursor: pointer; line-height: 1; }
    #aiw-context-bar { padding: .5rem .75rem; border-bottom: 1px solid #e5e5e5; flex-shrink: 0; }
    #aiw-context-bar select { font-size: .8rem; }
    #aiw-messages { flex-grow: 1; overflow-y: auto; padding: .85rem; }
    .aiw-turn { margin-bottom: 1rem; }
    .aiw-turn:last-child { margin-bottom: 0; }
    .aiw-question { font-weight: 600; font-size: .85rem; margin-bottom: .3rem; }
    .aiw-answer { border-left: 2px solid #000000; padding: 0 .75rem; font-size: .85rem; line-height: 1.5; }
    .aiw-answer p { margin: 0 0 .4rem; }
    .aiw-answer p:last-child { margin-bottom: 0; }
    .aiw-md-list { margin: 0 0 .4rem; padding-left: 1.1rem; }
    .aiw-md-list li { margin-bottom: .25rem; }
    .aiw-stream-cursor { display: inline-block; animation: aiw-blink 1s step-end infinite; }
    @keyframes aiw-blink { 50% { opacity: 0; } }
    .aiw-empty-hint { color: #999999; text-align: center; padding: 1.5rem 1rem; font-size: .85rem; }
    #aiw-input-bar { padding: .6rem .75rem; border-top: 1px solid #e5e5e5; flex-shrink: 0; }
    #aiw-input-bar .form-control, #aiw-input-bar .btn { font-size: .85rem; }
    #aiw-footer-link { text-align: center; padding: .4rem; font-size: .75rem; border-top: 1px solid #e5e5e5; flex-shrink: 0; }
  `;

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Même comportement que ai-assistant.js/ai-recommendation-panel.js : gras traité avant
  // l'italique simple (sinon les astérisques du gras seraient consommés par erreur par la règle
  // d'italique). Fichiers volontairement indépendants (pas de fonctions partagées entre le widget
  // et la page dédiée), mais le rendu d'une même réponse IA doit rester identique partout.
  function applyInlineMarkdown(str) {
    return str
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>');
  }

  function markdownLiteToHtml(text) {
    if (!text) return '';
    const escaped = escapeHtml(text);
    const lines = escaped.split('\n');
    const htmlParts = [];
    let listBuffer = [];
    function flushList() {
      if (listBuffer.length) {
        htmlParts.push('<ul class="aiw-md-list">' + listBuffer.map(function (item) { return '<li>' + item + '</li>'; }).join('') + '</ul>');
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
        try { onEvent(eventName, JSON.parse(dataStr)); } catch { /* ignoré */ }
      }
    }
  }

  function buildDom() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'aiw-toggle-btn';
    toggleBtn.type = 'button';
    toggleBtn.setAttribute('aria-label', 'Ouvrir l\'assistant IA');
    toggleBtn.innerHTML = '<iconify-icon icon="solar:chat-round-dots-bold"></iconify-icon>';

    const win = document.createElement('div');
    win.id = 'aiw-window';
    win.innerHTML =
      '<div id="aiw-header"><span class="aiw-title">Assistant IA</span><button type="button" id="aiw-close-btn" aria-label="Fermer">&times;</button></div>' +
      '<div id="aiw-context-bar"><select id="aiw-shop" class="form-select form-select-sm"><option value="">Chargement...</option></select></div>' +
      '<div id="aiw-messages"><div class="aiw-empty-hint">Posez une question sur les ventes, le stock ou les ruptures de ce magasin.</div></div>' +
      '<div id="aiw-input-bar"><div class="input-group"><input type="text" class="form-control" id="aiw-input" placeholder="Votre question..." disabled><button type="button" class="btn btn-dark" id="aiw-send-btn" disabled>Envoyer</button></div></div>' +
      '<div id="aiw-footer-link"><a href="/ai-assistant">Ouvrir en plein écran &amp; voir l\'historique</a></div>';

    document.body.appendChild(toggleBtn);
    document.body.appendChild(win);
    return { toggleBtn, win };
  }

  function init() {
    if (!window.reassortFetch) { setTimeout(init, 200); return; } // attend reassort-auth.js
    const { toggleBtn, win } = buildDom();
    const shopSelect = win.querySelector('#aiw-shop');
    const messagesEl = win.querySelector('#aiw-messages');
    const input = win.querySelector('#aiw-input');
    const sendBtn = win.querySelector('#aiw-send-btn');
    const closeBtn = win.querySelector('#aiw-close-btn');

    let currentConversationId = null;

    async function loadShopList() {
      try {
        const res = await window.reassortFetch('/reassort/shops');
        const json = await res.json();
        if (!json.success) throw new Error(json.message);
        shopSelect.innerHTML = json.data
          .sort(function (a, b) { return (a.reference || '').localeCompare(b.reference || ''); })
          .map(function (s) { return '<option value="' + s.id + '">' + s.reference + ' - ' + s.name + '</option>'; })
          .join('');
        if (shopSelect.value) { input.disabled = false; sendBtn.disabled = false; }
      } catch (err) {
        shopSelect.innerHTML = '<option value="">Erreur</option>';
      }
    }

    shopSelect.addEventListener('change', function () {
      currentConversationId = null;
      messagesEl.innerHTML = '<div class="aiw-empty-hint">Posez une question sur les ventes, le stock ou les ruptures de ce magasin.</div>';
      input.disabled = !shopSelect.value;
      sendBtn.disabled = !shopSelect.value;
    });

    async function sendQuestion() {
      const question = input.value.trim();
      if (!question || !shopSelect.value) return;
      input.value = '';
      sendBtn.disabled = true;
      input.disabled = true;

      const emptyHint = messagesEl.querySelector('.aiw-empty-hint');
      if (emptyHint) emptyHint.remove();

      const turnEl = document.createElement('div');
      turnEl.className = 'aiw-turn';
      turnEl.innerHTML = '<div class="aiw-question">' + escapeHtml(question) + '</div><div class="aiw-answer"><span class="aiw-stream-cursor">▍</span></div>';
      messagesEl.appendChild(turnEl);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      const answerEl = turnEl.querySelector('.aiw-answer');
      let streamedAnswer = '';

      try {
        const res = await window.reassortFetch('/reassort/chatbot/ask-stream?shop=' + encodeURIComponent(shopSelect.value), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ conversationId: currentConversationId, question: question }),
        });
        if (!res.ok) throw new Error('Erreur serveur (' + res.status + ')');

        let finalResult = null;
        await consumeSseStream(res, function (eventName, data) {
          if (eventName === 'chunk') {
            streamedAnswer += data.text;
            answerEl.textContent = streamedAnswer;
            const cursor = document.createElement('span');
            cursor.className = 'aiw-stream-cursor';
            cursor.textContent = '▍';
            answerEl.appendChild(cursor);
            messagesEl.scrollTop = messagesEl.scrollHeight;
          } else if (eventName === 'error') {
            throw new Error(data.message);
          } else if (eventName === 'done') {
            finalResult = data;
          }
        });
        if (!finalResult) throw new Error('Flux terminé sans réponse exploitable.');
        answerEl.innerHTML = markdownLiteToHtml(finalResult.answer);
        currentConversationId = finalResult.conversationId;
      } catch (err) {
        answerEl.innerHTML = '<span class="text-danger">Erreur : ' + escapeHtml(err.message) + '</span>';
      } finally {
        sendBtn.disabled = false;
        input.disabled = false;
        input.focus();
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
    }

    toggleBtn.addEventListener('click', function () {
      win.classList.toggle('show');
      if (win.classList.contains('show')) input.focus();
    });
    closeBtn.addEventListener('click', function () { win.classList.remove('show'); });
    sendBtn.addEventListener('click', sendQuestion);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') sendQuestion(); });

    loadShopList();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
