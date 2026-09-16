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
    #aiw-header-actions { display: flex; align-items: center; gap: .5rem; }
    #aiw-guide-btn { background: none; border: 1px solid #ffffff; color: #ffffff; font-size: .75rem; font-weight: 600; cursor: pointer; line-height: 1; width: 20px; height: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center; padding: 0; text-decoration: none; }
    #aiw-close-btn { background: none; border: none; color: #ffffff; font-size: 1.2rem; cursor: pointer; line-height: 1; }
    #aiw-context-bar { padding: .5rem .75rem; border-bottom: 1px solid #e5e5e5; flex-shrink: 0; }
    #aiw-shop-context { display: block; }
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
      '<div id="aiw-header"><span class="aiw-title">Assistant IA</span>' +
        '<div class="aiw-header-actions">' +
          '<a href="/ai-guide" id="aiw-guide-btn" aria-label="Ce que je peux vous demander" title="Ce que je peux vous demander">?</a>' +
          '<button type="button" id="aiw-close-btn" aria-label="Fermer">&times;</button>' +
        '</div>' +
      '</div>' +
      '<div id="aiw-context-bar"><span id="aiw-shop-context" class="text-muted small"></span></div>' +
      '<div id="aiw-messages"><div class="aiw-empty-hint">Posez une question sur les ventes, le stock ou les ruptures de ce magasin.</div></div>' +
      '<div id="aiw-input-bar"><div class="input-group"><input type="text" class="form-control" id="aiw-input" placeholder="Votre question..." disabled><button type="button" class="btn btn-dark" id="aiw-send-btn" disabled>Envoyer</button></div></div>' +
      '<div id="aiw-footer-link"><a href="/ai-assistant">Ouvrir en plein écran &amp; voir l\'historique</a></div>';

    document.body.appendChild(toggleBtn);
    document.body.appendChild(win);
    return { toggleBtn, win };
  }

  function init() {
    if (!window.reassortFetch) { setTimeout(init, 200); return; } // attend reassort-auth.js
    if (!window.reassortGetActiveShop) { setTimeout(init, 200); return; } // attend global-shop-selector.js
    const { toggleBtn, win } = buildDom();
    const shopContextEl = win.querySelector('#aiw-shop-context');
    const messagesEl = win.querySelector('#aiw-messages');
    const input = win.querySelector('#aiw-input');
    const sendBtn = win.querySelector('#aiw-send-btn');
    const closeBtn = win.querySelector('#aiw-close-btn');

    let currentConversationId = null;

    // Le widget suit désormais le SÉLECTEUR DE MAGASIN GLOBAL de la topbar (demande du 16/09/2026 :
    // un ADMIN/SUPERVISOR voyait "308" en haut de page mais le widget répondait pour un autre
    // magasin resté sélectionné dans son propre <select> indépendant, jamais synchronisé — deux
    // sources de vérité pour "quel magasin" sur la même page). Pour un rôle à magasin unique
    // (DIRECTOR/DEPARTMENT_HEAD/SHELF_STOCKER, ex-STORE), reassortGetActiveShop() renvoie toujours
    // null (pas de sélecteur affiché pour eux) : le magasin effectif est alors déterminé côté
    // serveur par resolveShopId (req.user.rposShopId), jamais par ce paramètre.
    function currentShopId() {
      const user = window.reassortGetUser && window.reassortGetUser();
      if (user && window.reassortIsSingleShopRole(user.role)) return user.rposShopId || null;
      const shop = window.reassortGetActiveShop();
      return shop ? shop.id : null;
    }

    function refreshContextDisplay() {
      const user = window.reassortGetUser && window.reassortGetUser();
      let label;
      if (user && window.reassortIsSingleShopRole(user.role)) {
        label = user.rposShopName ? user.rposShopReference + ' - ' + user.rposShopName : null;
      } else {
        const shop = window.reassortGetActiveShop();
        label = shop ? shop.reference + ' - ' + shop.name : null;
      }
      shopContextEl.textContent = label || 'Sélectionnez un magasin (en haut de page)';
      const hasShop = !!currentShopId();
      input.disabled = !hasShop;
      sendBtn.disabled = !hasShop;
    }

    // Changer de magasin en haut de page pendant que le widget est ouvert doit repartir sur une
    // conversation neuve (une conversation est rattachée à un magasin précis côté serveur) — même
    // logique que l'ancien shopSelect.addEventListener('change', ...) qu'il remplace.
    window.reassortOnActiveShopChange(function () {
      currentConversationId = null;
      messagesEl.innerHTML = '<div class="aiw-empty-hint">Posez une question sur les ventes, le stock ou les ruptures de ce magasin.</div>';
      refreshContextDisplay();
    });
    refreshContextDisplay();

    // Une tentative d'appel + streaming (sans gestion d'erreur ni retry) : isolée pour être rejouable
    // telle quelle par sendQuestion en cas de coupure réseau en cours de flux (cf. plus bas).
    async function attemptQuestion(question, answerEl) {
      let streamedAnswer = '';
      const res = await window.reassortFetch('/reassort/chatbot/ask-stream?shop=' + encodeURIComponent(currentShopId() || ''), {
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
      return finalResult;
    }

    async function sendQuestion() {
      const question = input.value.trim();
      if (!question || !currentShopId()) return;
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

      // Une coupure réseau brève (latence, micro-déconnexion) peut interrompre le flux SSE avant
      // l'event "done" alors que le serveur a bien traité la question — observé en usage réel sans
      // jamais avoir pu être reproduit ni côté serveur (curl direct systématiquement correct) ni dans
      // un navigateur automatisé en local, ce qui pointe vers l'environnement réseau du poste plutôt
      // qu'un bug de code (ajouté le 16/09/2026). Une seule retentative automatique, jamais en
      // boucle : si la deuxième tentative échoue aussi, il s'agit d'un vrai problème (réseau coupé,
      // serveur down) à signaler, pas à masquer par des tentatives indéfinies.
      let finalResult = null;
      let lastErr = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          finalResult = await attemptQuestion(question, answerEl);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          if (attempt === 1) {
            answerEl.innerHTML = '<span class="aiw-stream-cursor">▍</span>';
          }
        }
      }

      if (finalResult) {
        answerEl.innerHTML = markdownLiteToHtml(finalResult.answer);
        currentConversationId = finalResult.conversationId;
      } else {
        answerEl.innerHTML = '<span class="text-danger">Erreur : ' + escapeHtml(lastErr.message) + '</span>';
        if (window.reassortReportError) window.reassortReportError('Widget Assistant IA (après 2 tentatives): ' + lastErr.message, lastErr.stack);
      }

      sendBtn.disabled = false;
      input.disabled = false;
      input.focus();
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    toggleBtn.addEventListener('click', function () {
      win.classList.toggle('show');
      if (win.classList.contains('show')) input.focus();
    });
    closeBtn.addEventListener('click', function () { win.classList.remove('show'); });
    sendBtn.addEventListener('click', sendQuestion);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') sendQuestion(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
