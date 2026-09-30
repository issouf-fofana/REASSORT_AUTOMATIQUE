import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from './api/client';
import { AIChatInput } from './components/ui/ai-chat-input';

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

// Couleur d'accent bleue réservée à ces graphiques du chatbot (demande explicite du 28/09/2026,
// après confirmation : le reste du site reste noir/blanc/gris strict, seuls ces graphiques en
// sortent pour rester lisibles/agréables — la courbe toute noire précédente se distinguait mal des
// points et du texte environnant).
const CHART_LINE_COLOR = '#2563eb';
const CHART_GRID_COLOR = '#e5e7eb';

function buildLineChart(dailyHistory: { date: string; quantity: number }[]): string {
  const width = 560;
  const height = 160;
  const padding = 28;
  const values = dailyHistory.map((d) => d.quantity || 0);
  const max = Math.max(...values, 1);
  const stepX = (width - padding * 2) / Math.max(values.length - 1, 1);

  const coords = values.map((v, i) => ({
    x: padding + i * stepX,
    y: height - padding - (v / max) * (height - padding * 2),
    v,
    date: dailyHistory[i].date,
  }));

  const points = coords.map((c) => c.x + ',' + c.y).join(' ');

  // Lignes de grille horizontales légères (0%, 50%, 100% de la hauteur utile) : repère visuel
  // discret sans surcharger le graphique, cohérent avec des lignes fines déjà utilisées ailleurs.
  const gridLines = [0, 0.5, 1]
    .map((frac) => {
      const y = padding + frac * (height - padding * 2);
      return '<line x1="' + padding + '" y1="' + y + '" x2="' + (width - padding) + '" y2="' + y + '" stroke="' + CHART_GRID_COLOR + '" stroke-width="1"></line>';
    })
    .join('');

  // <title> par point : tooltip natif du navigateur au survol (demande du 28/09/2026, "si je met le
  // curseur ça fait rien") — un cercle de hover invisible mais plus large (r=10) facilite le
  // ciblage à la souris, le point visible réel (r=3) reste discret par-dessus.
  const dots = coords
    .map((c) => {
      const title = escapeHtml(c.date) + ' : ' + c.v.toLocaleString('fr-FR');
      return (
        '<g>' +
        '<circle cx="' + c.x + '" cy="' + c.y + '" r="10" fill="transparent" style="cursor:pointer;"><title>' + title + '</title></circle>' +
        '<circle cx="' + c.x + '" cy="' + c.y + '" r="3.5" fill="' + CHART_LINE_COLOR + '" style="pointer-events:none;"></circle>' +
        '</g>'
      );
    })
    .join('');

  const firstLabel = dailyHistory[0].date;
  const lastLabel = dailyHistory[dailyHistory.length - 1].date;

  return (
    '<div class="aia-chart-wrap">' +
    '<svg viewBox="0 0 ' + width + ' ' + height + '" style="width:100%;height:auto;overflow:visible;">' +
    gridLines +
    '<polyline points="' + points + '" fill="none" stroke="' + CHART_LINE_COLOR + '" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"></polyline>' + dots +
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

// Mêmes mots-clés que VISUAL_REQUEST_KEYWORDS côté backend (chatbotService.js) — l'utilisateur doit
// demander explicitement un tableau/graphique pour qu'on lui en affiche un (bug trouvé le 25/09/2026 :
// une simple question texte comme "Quels articles risquent d'être en rupture ?" affichait la réponse
// PUIS un gros tableau non demandé, dès que toolResult contenait des lignes). Dupliqué ici uniquement
// pour reconstruire l'affichage de l'historique déjà enregistré (qui ne porte pas encore ce flag) —
// pour une nouvelle question, c'est `wantsVisual` calculé côté backend qui fait foi (cf. sendQuestion).
const VISUAL_REQUEST_KEYWORDS = ['graph', 'graphique', 'tableau', 'courbe', 'visuel', 'schema', 'diagramme'];

function isVisualRequest(question: string): boolean {
  const normalized = (question || '').toLowerCase();
  return VISUAL_REQUEST_KEYWORDS.some((kw) => normalized.includes(kw));
}

function buildVisualFromToolResult(toolResult: ToolResult | null | undefined, wantsVisual: boolean): string {
  if (!wantsVisual || !toolResult || !toolResult.found) return '';
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
  // Demande du 27/09/2026 : "IA doit connaître la personne qui est connectée [...] on doit avoir un
  // message d'accueil ex: Bonjour Issouf Fofana je suis l'IA Réassort" — window.reassortGetUser() lit
  // localStorage (reassort_user), posé une seule fois à la connexion (cf. reassort-auth.js) : jamais
  // besoin de le relire en continu, un seul appel au montage suffit.
  const [userName] = useState<string | null>(() => window.reassortGetUser()?.name || null);
  const [shopsById, setShopsById] = useState<Map<string, Shop>>(new Map());
  const [suggestedQuestions, setSuggestedQuestions] = useState<string[]>([]);
  const [suggestionsHidden, setSuggestionsHidden] = useState(() => localStorage.getItem(SUGGESTIONS_HIDDEN_KEY) === '1');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationsError, setConversationsError] = useState<string | null>(null);
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null);
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
            visualHtml = buildVisualFromToolResult(JSON.parse(assistantMsg.toolResult), isVisualRequest(userMsg?.content || ''));
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
          answerHtml: markdownLiteToHtml(finalResult.answer) + buildVisualFromToolResult(finalResult.toolResult, !!finalResult.wantsVisual),
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

      // Le suivi de demande d'évolution (§2-§9) tourne désormais en tâche de fond côté serveur,
      // APRÈS la fin de cette réponse (demande du 28/09/2026 : il ne doit plus retarder l'affichage
      // de la réponse principale) — quand aucun outil de données n'a répondu (toolResult absent),
      // ce suivi a pu se déclencher et ajouter une confirmation/clarification au message déjà
      // affiché, quelques secondes plus tard. Un seul re-fetch différé de cette conversation suffit
      // à la récupérer si elle arrive ; sans confirmation possible côté client de si ce suivi a
      // effectivement tourné, mieux vaut un re-fetch inutile de temps en temps qu'un texte enregistré
      // en base mais jamais vu par l'utilisateur avant de rouvrir la conversation.
      if (!finalResult.toolResult) {
        const convId = finalResult.conversationId;
        window.setTimeout(() => {
          if (currentConversationId === convId || !currentConversationId) refreshLastTurnIfUpdated(convId, turnIndex, q);
        }, 4000);
      }
    }

    abortControllerRef.current = null;
    setSending(false);
    scrollToBottom();
  }

  // Relit UNIQUEMENT le dernier message assistant de la conversation et remplace le texte affiché
  // s'il a changé (post-scriptum ajouté par runFeatureRequestTracking en tâche de fond) — ne touche
  // jamais aux tours précédents ni ne perturbe une saisie en cours.
  async function refreshLastTurnIfUpdated(conversationId: string, turnIndex: number, question: string) {
    try {
      const data = await apiFetch<ConversationDetail>(`/reassort/chatbot/conversations/${conversationId}`);
      const lastAssistant = [...data.messages].reverse().find((m) => m.role === 'assistant');
      if (!lastAssistant) return;
      setTurns((prev) => {
        if (turnIndex >= prev.length || prev[turnIndex].question !== question) return prev;
        const newHtml = markdownLiteToHtml(lastAssistant.content);
        if (prev[turnIndex].answerHtml.includes(newHtml) || newHtml.length <= prev[turnIndex].answerHtml.length) return prev;
        const next = [...prev];
        next[turnIndex] = { ...next[turnIndex], answerHtml: newHtml };
        return next;
      });
    } catch {
      // best-effort : un échec laisse simplement le texte déjà affiché tel quel
    }
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
        /* "L'assistant réfléchit..." (demande du 28/09/2026 : "quand j'ai posé une question il doit
           faire un truc qui montre que ça charge") — tant que le premier morceau de texte n'est pas
           encore arrivé (résolution de l'outil de données + latence avant le 1er chunk LLM, qui peut
           prendre plusieurs secondes), turn.streamText reste vide et seul un curseur clignotant SEUL
           s'affichait : trop discret, ressemblait à un gel plutôt qu'à un chargement en cours. */
        .aia-thinking { display: inline-flex; align-items: center; gap: .5rem; color: #6c757d; font-size: .9rem; }
        .aia-thinking-dots { display: inline-flex; gap: .25rem; }
        .aia-thinking-dots span { width: 6px; height: 6px; border-radius: 50%; background: #000000; animation: aia-thinking-bounce 1.2s ease-in-out infinite; }
        .aia-thinking-dots span:nth-child(2) { animation-delay: .15s; }
        .aia-thinking-dots span:nth-child(3) { animation-delay: .3s; }
        @keyframes aia-thinking-bounce { 0%, 60%, 100% { opacity: .25; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-3px); } }
        /* Style "plus pro" demandé le 27/09/2026 (l'outline Bootstrap brut, bordure grise fine,
           paraissait basique) : fond plein gris clair discret plutôt qu'un simple contour, sans
           bordure ni ombre — cohérent avec la palette noir/blanc/gris stricte du site (jamais de
           coin arrondi, cf. theme-override.css) tout en donnant un rendu plus soigné qu'un bouton
           Bootstrap générique. */
        .aia-suggestion-btn {
          text-align: left;
          background-color: #f1f3f5;
          border: none;
          color: #1a1a1a;
          font-weight: 500;
          transition: background-color .15s ease;
        }
        .aia-suggestion-btn:hover,
        .aia-suggestion-btn:focus {
          background-color: #000000;
          color: #ffffff;
        }
        .aia-chart-wrap { margin-top: .75rem; padding: .75rem 0 0; border-top: 1px solid #eeeeee; }
        .aia-table { font-size: .85rem; margin-top: .5rem; }
        .aia-table th { font-weight: 600; color: #666666; font-size: .75rem; text-transform: uppercase; letter-spacing: .02em; border-bottom-width: 2px; }
        .aia-empty-hint { color: #999999; text-align: center; padding: 2rem 1rem; }

        /* Écran d'accueil (demande du 30/09/2026, maquette fournie) : halo lumineux marine/ambre
           discret en fond, gros titre centré, champ de saisie flottant + pills de suggestion —
           palette du Tableau de bord/Proposition de commande, jamais le noir/violet de la maquette
           d'origine (hors charte du reste du site). */
        /* Centré verticalement dans #aia-chat-window (demande du 30/09/2026, "trop haut") — comme la
           maquette de référence, où le bloc d'accueil est au milieu de l'écran, pas collé en haut. */
        #aia-chat-window:has(.aia-hero) { display: flex; align-items: center; justify-content: center; }
        .aia-hero { position: relative; padding: 2rem 1rem; overflow: hidden; width: 100%; }
        .aia-hero-glow {
          position: absolute; top: -120px; left: 50%; transform: translateX(-50%);
          width: 640px; height: 320px; border-radius: 50%;
          background: radial-gradient(ellipse at center, rgba(27,42,74,.14) 0%, rgba(245,166,35,.08) 45%, transparent 75%);
          pointer-events: none;
        }
        .aia-hero-content { position: relative; z-index: 1; }
        .aia-hero-title { font-size: 2rem; font-weight: 700; color: #1B2A4A; margin-bottom: .5rem; letter-spacing: -.01em; }
        .aia-hero-subtitle { color: #5B6B85; font-size: 1rem; max-width: 480px; margin-left: auto; margin-right: auto; }
        .aia-hero-input { max-width: 640px; }
        .aia-hero-pill {
          background-color: #EDF1F7; border: 1px solid #D6DEEA; border-radius: 999px;
          color: #1B2A4A; font-size: .85rem; font-weight: 500; padding: .5rem 1.1rem;
          transition: background-color .15s ease, border-color .15s ease;
        }
        .aia-hero-pill:hover { background-color: #F5A623; border-color: #F5A623; color: #1B2A4A; }

        /* La bulle flottante de l'Assistant IA (widget global, cf. ai-assistant-widget.js) est fixe
           en bas-droite (56px + 24px de marge, z-index 1050) sur TOUTES les pages du site — elle
           chevauchait le bouton d'envoi de cette barre, elle-même étirée jusqu'au bord droit de la
           page. On réserve donc explicitement l'espace qu'elle occupe, uniquement sur cette page. */
        .aia-input-bar { padding: 1rem 1.25rem 1rem; border-top: 1px solid #e5e5e5; padding-right: calc(1.25rem + 80px); }

        @media (max-width: 768px) {
          .aia-layout { flex-direction: column; height: auto; }
          .aia-conv-list { width: 100%; max-height: 220px; }
          .aia-input-bar { padding-right: 1.25rem; padding-bottom: calc(1rem + 88px); }
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
            {!shopReady && (
              <span className="text-muted small">Sélectionnez un magasin (en haut de page)</span>
            )}
            <div className="dropdown">
              <button
                type="button"
                className="btn btn-outline-secondary btn-sm dropdown-toggle"
                data-bs-toggle="dropdown"
                aria-expanded="false"
              >
                {department ? department : 'Filtrer par rayon'}
                {subDepartment ? ` / ${subDepartment}` : ''}
              </button>
              <div className="dropdown-menu p-3" style={{ minWidth: 260 }}>
                <label className="form-label small text-muted mb-1">Rayon</label>
                <select
                  className="form-select form-select-sm mb-2"
                  value={department}
                  onChange={(e) => setDepartment(e.target.value)}
                >
                  <option value="">Tous les rayons</option>
                  {departments.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
                <label className="form-label small text-muted mb-1">Sous-rayon (optionnel)</label>
                <input
                  type="text"
                  className="form-control form-control-sm"
                  placeholder="Ex : biscuits sucrés"
                  value={subDepartment}
                  onChange={(e) => setSubDepartment(e.target.value)}
                />
              </div>
            </div>
            <a href="/ai-guide" className="small ms-auto">
              Ce que je peux vous demander
            </a>
          </div>

          <div id="aia-chat-window" ref={chatWindowRef}>
            {conversationError && <div className="text-danger small p-3">Erreur : {conversationError}</div>}
            {turns.length === 0 && !conversationError && (
              // Écran d'accueil (demande du 30/09/2026, maquette fournie) : gros titre centré, halo
              // lumineux discret en fond, champ de saisie flottant, suggestions en pills — dans la
              // palette marine/ambre déjà en place sur Tableau de bord/Proposition de commande
              // (jamais le noir/violet de la maquette de référence, hors charte du reste du site).
              <div className="aia-hero text-center">
                <div className="aia-hero-glow" aria-hidden="true"></div>
                <div className="aia-hero-content">
                  <div className="aia-hero-title">
                    {userName ? `Bonjour ${userName}` : 'Assistant IA Réassort'}
                  </div>
                  <p className="aia-hero-subtitle mb-4">
                    Posez une question sur les ventes, le stock, les ruptures ou la précision de l'IA — juste en tapant ci-dessous.
                  </p>
                  {!shopReady ? (
                    <p className="text-muted small">Sélectionnez un magasin (en haut de page) pour commencer.</p>
                  ) : (
                    <>
                      <div className="aia-hero-input mx-auto mb-3">
                        <AIChatInput
                          value={input}
                          onChange={setInput}
                          onSubmit={() => (abortControllerRef.current ? stopGeneration() : sendQuestion())}
                          disabled={!shopReady}
                          sending={sending}
                          placeholders={
                            suggestedQuestions.length
                              ? suggestedQuestions
                              : ["Ex : quels articles risquent d'être en rupture ?"]
                          }
                        />
                      </div>
                      {suggestedQuestions.length > 0 && (
                        <div className="d-flex flex-wrap justify-content-center gap-2 mx-auto" style={{ maxWidth: 720 }}>
                          {suggestedQuestions.slice(0, 7).map((q, i) => (
                            <button key={i} type="button" className="aia-hero-pill" onClick={() => sendQuestion(q)}>
                              {q}
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}
            {turns.map((turn, i) => (
              <div className="aia-turn" key={i}>
                <div className="aia-question">{turn.question}</div>
                <div className="aia-answer">
                  {turn.streaming ? (
                    turn.streamText ? (
                      <>
                        {turn.streamText}
                        <span className="aia-stream-cursor">▍</span>
                      </>
                    ) : (
                      <span className="aia-thinking">
                        L'assistant réfléchit
                        <span className="aia-thinking-dots">
                          <span></span><span></span><span></span>
                        </span>
                      </span>
                    )
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

          {/* Barre de saisie du bas masquée sur l'écran d'accueil (turns vide) : le nouveau champ
              flottant ci-dessus (aia-hero-input) la remplace tant qu'aucune question n'a été posée —
              évite deux champs de saisie visibles en même temps. */}
          {(turns.length > 0 || conversationError) && (
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
                      className="btn btn-sm aia-suggestion-btn"
                      onClick={() => sendQuestion(q)}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <AIChatInput
              value={input}
              onChange={setInput}
              onSubmit={() => (abortControllerRef.current ? stopGeneration() : sendQuestion())}
              disabled={!shopReady}
              sending={sending}
              placeholders={
                suggestedQuestions.length
                  ? suggestedQuestions
                  : ["Ex : quels articles risquent d'être en rupture ?"]
              }
            />
            {/* Demande du 27/09/2026 : "l'IA en bas aussi mets à jour" (capture de référence d'un
                autre produit portant un disclaimer sous la zone de saisie) — identité réelle du
                produit, jamais le nom de l'exemple fourni. */}
            <div className="text-center text-muted mt-1" style={{ fontSize: '0.75rem' }}>
              Assistant IA Réassort — peut faire des erreurs, vérifiez les informations importantes.
            </div>
          </div>
          )}
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
