import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from './api/client';

interface Shop {
  id: string;
  reference: string;
  name: string;
}

interface Conversation {
  id: string;
  title: string;
  rposShopId: string | null;
  department: string | null;
  subDepartment: string | null;
  updatedAt: string;
}

interface ChatbotMessage {
  role: string;
  content: string;
  toolResult?: string | null;
}

interface ConversationDetail {
  id: string;
  rposShopId: string | null;
  department: string | null;
  subDepartment: string | null;
  messages: ChatbotMessage[];
}

interface ToolResultLine {
  label?: string;
  ean?: string;
  quantity?: number;
  quantitySuggested?: number;
  stockAtGeneration?: number;
  stock?: number;
  daysUntilStockout?: number | null;
  revenueSharePct?: number;
}

interface ToolResult {
  found?: boolean;
  dailyHistory?: { date: string; quantity: number }[];
  topArticles?: ToolResultLine[];
  lines?: ToolResultLine[];
}

interface Turn {
  question: string;
  answerHtml: string;
  streaming?: boolean;
  streamText?: string;
  error?: string;
  interrupted?: boolean;
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function applyInlineMarkdown(str: string): string {
  return str.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>');
}

function markdownLiteToHtml(text: string): string {
  if (!text) return '';
  const escaped = escapeHtml(text);
  const lines = escaped.split('\n');
  const htmlParts: string[] = [];
  let listBuffer: string[] = [];
  function flushList() {
    if (listBuffer.length) {
      htmlParts.push('<ul class="aia-md-list">' + listBuffer.map((item) => '<li>' + item + '</li>').join('') + '</ul>');
      listBuffer = [];
    }
  }
  lines.forEach((rawLine) => {
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

function buildLineChart(dailyHistory: { date: string; quantity: number }[]): string {
  const width = 560;
  const height = 160;
  const padding = 28;
  const values = dailyHistory.map((d) => d.quantity || 0);
  const max = Math.max(...values, 1);
  const stepX = (width - padding * 2) / Math.max(values.length - 1, 1);

  const points = values
    .map((v, i) => {
      const x = padding + i * stepX;
      const y = height - padding - (v / max) * (height - padding * 2);
      return x + ',' + y;
    })
    .join(' ');

  const dots = values
    .map((v, i) => {
      const x = padding + i * stepX;
      const y = height - padding - (v / max) * (height - padding * 2);
      return '<circle cx="' + x + '" cy="' + y + '" r="3" fill="#000000"></circle>';
    })
    .join('');

  const firstLabel = dailyHistory[0].date;
  const lastLabel = dailyHistory[dailyHistory.length - 1].date;

  return (
    '<div class="aia-chart-wrap">' +
    '<svg viewBox="0 0 ' + width + ' ' + height + '" style="width:100%;height:auto;overflow:visible;">' +
    '<polyline points="' + points + '" fill="none" stroke="#000000" stroke-width="2"></polyline>' + dots +
    '</svg>' +
    '<div class="d-flex justify-content-between small text-muted mt-1"><span>' + escapeHtml(firstLabel) + '</span><span>' + escapeHtml(lastLabel) + '</span></div>' +
    '</div>'
  );
}

function buildArticlesTable(lines: ToolResultLine[], quantityLabel?: string): string {
  const hasStock = lines.some((l) => l.stockAtGeneration !== undefined || l.stock !== undefined);
  const hasDays = lines.some((l) => l.daysUntilStockout !== undefined && l.daysUntilStockout !== null);
  const hasQuantity = lines.some((l) => l.quantity !== undefined || l.quantitySuggested !== undefined);
  const hasRevenueShare = lines.some((l) => l.revenueSharePct !== undefined);
  const rows = lines
    .slice(0, 20)
    .map((l) => {
      const qty = l.quantity !== undefined ? l.quantity : l.quantitySuggested !== undefined ? l.quantitySuggested : '—';
      const stock = l.stockAtGeneration !== undefined ? l.stockAtGeneration : l.stock !== undefined ? l.stock : null;
      return (
        '<tr>' +
        '<td>' + escapeHtml(l.label || l.ean || '—') + '</td>' +
        (hasStock ? '<td class="text-end">' + (stock !== null ? stock : '—') + '</td>' : '') +
        (hasDays ? '<td class="text-end">' + (l.daysUntilStockout !== undefined && l.daysUntilStockout !== null ? Math.round(l.daysUntilStockout) + ' j' : '—') + '</td>' : '') +
        (hasQuantity ? '<td class="text-end">' + qty + '</td>' : '') +
        (hasRevenueShare ? '<td class="text-end">' + (l.revenueSharePct !== undefined ? l.revenueSharePct + ' %' : '—') + '</td>' : '') +
        '</tr>'
      );
    })
    .join('');

  return (
    '<div class="table-responsive mt-2"><table class="table table-sm aia-table">' +
    '<thead><tr><th>Article</th>' +
    (hasStock ? '<th class="text-end">Stock</th>' : '') +
    (hasDays ? '<th class="text-end">Rupture</th>' : '') +
    (hasQuantity ? '<th class="text-end">' + escapeHtml(quantityLabel || 'Quantité') + '</th>' : '') +
    (hasRevenueShare ? '<th class="text-end">Part du CA</th>' : '') +
    '</tr></thead>' +
    '<tbody>' + rows + '</tbody>' +
    '</table></div>'
  );
}

function buildVisualFromToolResult(toolResult: ToolResult | null | undefined): string {
  if (!toolResult || !toolResult.found) return '';
  if (Array.isArray(toolResult.dailyHistory) && toolResult.dailyHistory.length > 1) {
    return (
      buildLineChart(toolResult.dailyHistory) +
      (Array.isArray(toolResult.topArticles) && toolResult.topArticles.length
        ? buildArticlesTable(toolResult.topArticles, 'Quantité vendue')
        : '')
    );
  }
  if (Array.isArray(toolResult.lines) && toolResult.lines.length) {
    return buildArticlesTable(toolResult.lines);
  }
  return '';
}

async function consumeSseStream(res: Response, onEvent: (eventName: string, data: any) => void) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop()!;
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
        // événement mal formé ignoré
      }
    }
  }
}

const SUGGESTIONS_HIDDEN_KEY = 'aia-suggestions-hidden';

export function AiAssistant() {
  const [shopsById, setShopsById] = useState<Map<string, Shop>>(new Map());
  const [suggestedQuestions, setSuggestedQuestions] = useState<string[]>([]);
  const [suggestionsHidden, setSuggestionsHidden] = useState(() => localStorage.getItem(SUGGESTIONS_HIDDEN_KEY) === '1');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationsError, setConversationsError] = useState<string | null>(null);
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
  const [shopLabel, setShopLabel] = useState<string | null>(null);
  const [shopReady, setShopReady] = useState(false);
  const [department, setDepartment] = useState('');
  const [departments, setDepartments] = useState<string[]>([]);
  const [subDepartment, setSubDepartment] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [conversationError, setConversationError] = useState<string | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const chatWindowRef = useRef<HTMLDivElement>(null);
  const [deleteModalId, setDeleteModalId] = useState<string | null>(null);

  const currentShopId = useCallback(() => {
    const user = window.reassortGetUser();
    if (user && window.reassortIsSingleShopRole(user.role)) return user.rposShopId || null;
    const shop = window.reassortGetActiveShop();
    return shop ? shop.id : null;
  }, []);

  const loadDepartments = useCallback(async (shopId: string) => {
    try {
      const data = await apiFetch<{ predictions: { department?: string }[] }>(`/reassort/predictions?shop=${encodeURIComponent(shopId)}`);
      const depts = Array.from(new Set(data.predictions.map((p) => p.department).filter(Boolean))).sort() as string[];
      setDepartments(depts);
    } catch {
      setDepartments([]);
    }
  }, []);

  const refreshShopContext = useCallback(() => {
    const user = window.reassortGetUser();
    let label: string | null;
    if (user && window.reassortIsSingleShopRole(user.role)) {
      label = user.rposShopName ? `${user.rposShopReference} - ${user.rposShopName}` : null;
    } else {
      const shop = window.reassortGetActiveShop();
      label = shop ? `${shop.reference} - ${shop.name}` : null;
    }
    setShopLabel(label);
    const shopId = currentShopId();
    setShopReady(!!shopId);
    if (shopId) loadDepartments(shopId);
  }, [currentShopId, loadDepartments]);

  const loadConversations = useCallback(async () => {
    try {
      const data = await apiFetch<Conversation[]>('/reassort/chatbot/conversations');
      setConversations(data);
      setConversationsError(null);
    } catch (err) {
      setConversationsError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  function startNewConversation() {
    setCurrentConversationId(null);
    setTurns([]);
    setConversationError(null);
  }

  async function openConversation(id: string) {
    try {
      const data = await apiFetch<ConversationDetail>(`/reassort/chatbot/conversations/${id}`);
      setCurrentConversationId(id);
      setConversationError(null);

      const user = window.reassortGetUser();
      const convShop = data.rposShopId ? shopsById.get(data.rposShopId) : null;
      if (convShop && !(user && window.reassortIsSingleShopRole(user.role)) && convShop.id !== currentShopId()) {
        window.reassortSetActiveShop({ id: convShop.id, reference: convShop.reference, name: convShop.name });
      }
      setDepartment(data.department || '');
      setSubDepartment(data.subDepartment || '');

      const newTurns: Turn[] = [];
      for (let i = 0; i < data.messages.length; i += 2) {
        const userMsg = data.messages[i];
        const assistantMsg = data.messages[i + 1];
        let visualHtml = '';
        if (assistantMsg?.toolResult) {
          try {
            visualHtml = buildVisualFromToolResult(JSON.parse(assistantMsg.toolResult));
          } catch {
            // résultat mal formé, ignoré
          }
        }
        newTurns.push({
          question: userMsg ? userMsg.content : '',
          answerHtml: assistantMsg ? markdownLiteToHtml(assistantMsg.content) + visualHtml : '',
        });
      }
      setTurns(newTurns);
    } catch (err) {
      setConversationError(err instanceof Error ? err.message : String(err));
    }
  }

  async function confirmDeleteConversation() {
    if (!deleteModalId) return;
    const id = deleteModalId;
    await window.reassortFetch(`/reassort/chatbot/conversations/${id}`, { method: 'DELETE' });
    if (id === currentConversationId) startNewConversation();
    setDeleteModalId(null);
    loadConversations();
  }

  async function attemptQuestion(
    question: string,
    signal: AbortSignal,
    onChunk: (partial: string) => void,
  ): Promise<{ finalResult: any; streamedAnswer: string }> {
    let streamedAnswer = '';
    const res = await window.reassortFetch(`/reassort/chatbot/ask-stream?shop=${encodeURIComponent(currentShopId() || '')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: currentConversationId,
        department: department || null,
        subDepartment: subDepartment.trim() || null,
        question,
      }),
      signal,
    });
    if (!res.ok) throw new Error(`Erreur serveur (${res.status})`);

    let finalResult: any = null;
    await consumeSseStream(res, (eventName, data) => {
      if (eventName === 'chunk') {
        streamedAnswer += data.text;
        onChunk(streamedAnswer);
      } else if (eventName === 'error') {
        throw new Error(data.message);
      } else if (eventName === 'done') {
        finalResult = data;
      }
    });
    if (!finalResult) throw new Error('Flux terminé sans réponse exploitable.');
    return { finalResult, streamedAnswer };
  }

  async function sendQuestion(question?: string) {
    const q = (question ?? input).trim();
    if (!q || !currentShopId()) return;
    setInput('');
    setSending(true);

    const turnIndex = turns.length;
    setTurns((prev) => [...prev, { question: q, answerHtml: '', streaming: true, streamText: '' }]);
    scrollToBottom();

    let finalResult: any = null;
    let streamedAnswer = '';
    let lastErr: any = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      abortControllerRef.current = new AbortController();
      try {
        const result = await attemptQuestion(q, abortControllerRef.current.signal, (partial) => {
          setTurns((prev) => {
            const next = [...prev];
            next[turnIndex] = { ...next[turnIndex], streamText: partial };
            return next;
          });
          scrollToBottom();
        });
        finalResult = result.finalResult;
        streamedAnswer = result.streamedAnswer;
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        streamedAnswer = '';
        if ((err as Error).name === 'AbortError' || attempt === 2) break;
      }
    }

    setTurns((prev) => {
      const next = [...prev];
      if (finalResult) {
        next[turnIndex] = {
          question: q,
          answerHtml: markdownLiteToHtml(finalResult.answer) + buildVisualFromToolResult(finalResult.toolResult),
        };
      } else if (lastErr?.name === 'AbortError') {
        next[turnIndex] = {
          question: q,
          answerHtml: markdownLiteToHtml(streamedAnswer),
          interrupted: true,
        };
      } else {
        next[turnIndex] = {
          question: q,
          answerHtml: '',
          error: lastErr instanceof Error ? lastErr.message : String(lastErr),
        };
        if (window.reassortReportError) {
          window.reassortReportError(`Assistant IA (après 2 tentatives): ${lastErr?.message}`, lastErr?.stack);
        }
      }
      return next;
    });

    if (finalResult) {
      const isNewConversation = !currentConversationId;
      setCurrentConversationId(finalResult.conversationId);
      if (isNewConversation) loadConversations();
      else setConversations((prev) => [...prev]);
    }

    abortControllerRef.current = null;
    setSending(false);
    scrollToBottom();
  }

  function stopGeneration() {
    abortControllerRef.current?.abort();
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      if (chatWindowRef.current) chatWindowRef.current.scrollTop = chatWindowRef.current.scrollHeight;
    });
  }

  function toggleSuggestions() {
    const next = !suggestionsHidden;
    localStorage.setItem(SUGGESTIONS_HIDDEN_KEY, next ? '1' : '0');
    setSuggestionsHidden(next);
  }

  useEffect(() => {
    (async () => {
      try {
        const data = await apiFetch<{ id: string; reference: string; name: string }[]>('/reassort/shops');
        setShopsById(new Map(data.map((s) => [s.id, s])));
      } catch {
        // best-effort : un échec laisse juste la restauration de magasin inopérante
      }

      function initShopContext() {
        if (!window.reassortGetActiveShop) {
          setTimeout(initShopContext, 200);
          return;
        }
        window.reassortOnActiveShopChange(() => {
          startNewConversation();
          refreshShopContext();
        });
        refreshShopContext();
      }
      initShopContext();
    })();

    apiFetch<string[]>('/reassort/chatbot/suggested-questions')
      .then(setSuggestedQuestions)
      .catch(() => {});

    loadConversations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <style>{`
        .aia-layout { display: flex; gap: 1rem; height: calc(100vh - 220px); min-height: 480px; }
        .aia-conv-list { width: 280px; flex-shrink: 0; background-color: #ffffff; border: 1px solid #e5e5e5; overflow-y: auto; }
        .aia-conv-item { display: flex; align-items: center; justify-content: space-between; padding: .65rem .85rem; cursor: pointer; border-bottom: 1px solid #f0f0f0; font-size: .85rem; }
        .aia-conv-item:hover { background-color: #f5f5f5; }
        .aia-conv-item.active { background-color: #000000; color: #ffffff; }
        .aia-conv-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-grow: 1; }
        .aia-conv-delete { opacity: .5; margin-left: .5rem; flex-shrink: 0; }
        .aia-conv-delete:hover { opacity: 1; }
        .aia-conv-item.active .aia-conv-delete { color: #ffffff; }

        .aia-main { flex-grow: 1; display: flex; flex-direction: column; background-color: #ffffff; border: 1px solid #e5e5e5; min-width: 0; }
        .aia-context-bar { padding: .75rem 1rem; border-bottom: 1px solid #e5e5e5; display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; }
        .aia-context-bar select, .aia-context-bar input { max-width: 220px; }

        #aia-chat-window { flex-grow: 1; overflow-y: auto; padding: 1.25rem; }
        .aia-turn { margin-bottom: 2rem; padding-bottom: 2rem; border-bottom: 1px solid #f0f0f0; }
        .aia-turn:last-child { margin-bottom: 0; padding-bottom: 0; border-bottom: none; }
        .aia-question { font-weight: 600; margin-bottom: .75rem; font-size: 1rem; }
        .aia-answer { border-left: 3px solid #000000; padding: .25rem 1.25rem; line-height: 1.65; font-size: .93rem; }
        .aia-answer p { margin: 0 0 .75rem; }
        .aia-answer p:last-child { margin-bottom: 0; }
        .aia-md-list { margin: .25rem 0 .75rem; padding-left: 1.4rem; }
        .aia-md-list:last-child { margin-bottom: 0; }
        .aia-md-list li { margin-bottom: .6rem; }
        .aia-md-list li:last-child { margin-bottom: 0; }
        .aia-stream-cursor { display: inline-block; animation: aia-blink 1s step-end infinite; }
        @keyframes aia-blink { 50% { opacity: 0; } }
        .aia-suggestion-btn { text-align: left; }
        .aia-chart-wrap { margin-top: .75rem; padding: .75rem 0 0; border-top: 1px solid #eeeeee; }
        .aia-table { font-size: .85rem; margin-top: .5rem; }
        .aia-table th { font-weight: 600; color: #666666; font-size: .75rem; text-transform: uppercase; letter-spacing: .02em; border-bottom-width: 2px; }
        .aia-empty-hint { color: #999999; text-align: center; padding: 2rem 1rem; }

        .aia-input-bar { padding: .85rem 1rem; border-top: 1px solid #e5e5e5; }

        @media (max-width: 768px) {
          .aia-layout { flex-direction: column; height: auto; }
          .aia-conv-list { width: 100%; max-height: 220px; }
        }
      `}</style>

      <div className="alert alert-light border small mb-3">
        <strong>À quoi ça sert :</strong> posez une question en langage naturel sur les ventes, le
        stock, les ruptures, les surstocks ou la précision de l'IA pour un magasin. Les réponses sont
        basées uniquement sur les données réelles enregistrées — jamais inventées.
      </div>

      <div className="aia-layout">
        <div className="aia-conv-list">
          <div className="p-2 border-bottom">
            <button type="button" className="btn btn-dark btn-sm w-100" onClick={startNewConversation}>
              + Nouvelle conversation
            </button>
          </div>
          <div>
            {conversationsError ? (
              <div className="p-3 text-danger small">Erreur : {conversationsError}</div>
            ) : conversations.length === 0 ? (
              <div className="p-3 text-muted small">Aucune conversation pour le moment.</div>
            ) : (
              conversations.map((c) => (
                <div
                  key={c.id}
                  className={`aia-conv-item${c.id === currentConversationId ? ' active' : ''}`}
                  onClick={() => openConversation(c.id)}
                >
                  <span className="aia-conv-title">{c.title}</span>
                  <iconify-icon
                    icon="solar:trash-bin-minimalistic-linear"
                    className="aia-conv-delete"
                    onClick={(e: any) => {
                      e.stopPropagation();
                      setDeleteModalId(c.id);
                    }}
                  ></iconify-icon>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="aia-main">
          <div className="aia-context-bar">
            <span className="text-muted small fw-semibold">{shopLabel || 'Sélectionnez un magasin (en haut de page)'}</span>
            <select className="form-select form-select-sm" value={department} onChange={(e) => setDepartment(e.target.value)}>
              <option value="">Tous les rayons</option>
              {departments.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <input
              type="text"
              className="form-control form-control-sm"
              placeholder="Sous-rayon (optionnel)"
              value={subDepartment}
              onChange={(e) => setSubDepartment(e.target.value)}
            />
            <a href="/ai-guide" className="btn btn-outline-dark btn-sm">
              Ce que je peux vous demander
            </a>
          </div>

          <div id="aia-chat-window" ref={chatWindowRef}>
            {conversationError && <div className="text-danger small p-3">Erreur : {conversationError}</div>}
            {turns.length === 0 && !conversationError && (
              <div className="aia-empty-hint">
                {shopReady
                  ? 'Sélectionnez un magasin puis posez une question, ou choisissez une suggestion ci-dessous.'
                  : 'Sélectionnez un magasin puis posez une question, ou choisissez une suggestion ci-dessous.'}
              </div>
            )}
            {turns.map((turn, i) => (
              <div className="aia-turn" key={i}>
                <div className="aia-question">{turn.question}</div>
                <div className="aia-answer">
                  {turn.streaming ? (
                    <>
                      {turn.streamText}
                      <span className="aia-stream-cursor">▍</span>
                    </>
                  ) : turn.error ? (
                    <span className="text-danger">Erreur : {turn.error}</span>
                  ) : (
                    <>
                      <span dangerouslySetInnerHTML={{ __html: turn.answerHtml }} />
                      {turn.interrupted && <div className="text-muted small mt-1">(réponse interrompue)</div>}
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="aia-input-bar">
            <div className="d-flex justify-content-between align-items-center mb-1">
              <span className="small text-muted">Suggestions de questions</span>
              <button type="button" className="btn btn-link btn-sm p-0" onClick={toggleSuggestions}>
                {suggestionsHidden ? 'Afficher' : 'Masquer'}
              </button>
            </div>
            {!suggestionsHidden && (
              <div className="mb-2">
                <div className="d-flex flex-wrap gap-2">
                  {suggestedQuestions.map((q, i) => (
                    <button
                      key={i}
                      type="button"
                      className="btn btn-outline-secondary btn-sm aia-suggestion-btn"
                      onClick={() => sendQuestion(q)}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="input-group">
              <input
                type="text"
                className="form-control"
                placeholder="Ex : quels articles risquent d'être en rupture ?"
                disabled={!shopReady}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !abortControllerRef.current) sendQuestion();
                }}
              />
              <button
                type="button"
                className={sending ? 'btn btn-outline-danger' : 'btn btn-dark'}
                disabled={!shopReady}
                onClick={() => (abortControllerRef.current ? stopGeneration() : sendQuestion())}
              >
                {sending ? 'Arrêter' : 'Envoyer'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {deleteModalId && (
        <>
          <div className="modal fade show" style={{ display: 'block' }} tabIndex={-1} role="dialog">
            <div className="modal-dialog modal-dialog-centered" role="document">
              <div className="modal-content">
                <div className="modal-header">
                  <h5 className="modal-title">Supprimer la conversation</h5>
                  <button type="button" className="btn-close" onClick={() => setDeleteModalId(null)}></button>
                </div>
                <div className="modal-body">
                  <p className="mb-0">
                    Cette conversation et tous ses messages seront définitivement supprimés. Cette action est
                    irréversible.
                  </p>
                </div>
                <div className="modal-footer">
                  <button type="button" className="btn btn-outline-secondary" onClick={() => setDeleteModalId(null)}>
                    Annuler
                  </button>
                  <button type="button" className="btn btn-danger" onClick={confirmDeleteConversation}>
                    Supprimer
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show"></div>
        </>
      )}
    </div>
  );
}
