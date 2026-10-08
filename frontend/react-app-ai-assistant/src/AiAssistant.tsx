import { useCallback, useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { Copy, ThumbsDown, ThumbsUp } from 'lucide-react';
import { apiFetch } from './api/client';
import { AIChatInput } from './components/ui/ai-chat-input';
import { ThinkingOrb } from './components/ui/thinking-orb';

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
  createdAt: string;
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
  // Texte brut (avant conversion markdown → HTML), pour le bouton "Copier" — copier answerHtml
  // collerait des balises HTML dans le presse-papiers de l'utilisateur.
  answerText?: string;
  streaming?: boolean;
  streamText?: string;
  error?: string;
  interrupted?: boolean;
  // Purement visuel pour l'instant (30/09/2026) : aucune persistance backend, juste l'état du
  // bouton like/dislike affiché sous la réponse.
  feedback?: 'up' | 'down' | null;
}

// Date/heure de création affichée sous chaque titre de conversation (demande du 05/10/2026) —
// format court et relatif ("aujourd'hui 14h32", "hier 09h10", "05/10 14h32") plutôt qu'une date
// complète systématique, plus rapide à lire dans une liste compacte.
function formatConversationDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const isSameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (isSameDay(d, now)) return `Aujourd'hui ${time}`;
  if (isSameDay(d, yesterday)) return `Hier ${time}`;
  return `${d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })} ${time}`;
}

// Juste le prénom pour l'accueil façon "Morning, Arihant!" (maquette du 08/10/2026) — userName
// porte le nom complet (ex: "Issouf Fofana"), trop long pour un titre de bienvenue compact.
function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] || fullName;
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Remplace l'ancien parseur maison (markdownLiteToHtml, gras/italique/listes à puces seulement) par
// `marked` (30/09/2026, demande "bien formaté comme les autres sites") : titres, listes numérotées,
// tableaux, blocs de code, tout le markdown standard. `breaks: true` conserve le même comportement
// que l'ancien parseur pour un simple retour à la ligne (pas besoin d'un double saut de ligne pour
// que l'IA structure sa réponse). DOMPurify sanitise le HTML produit avant dangerouslySetInnerHTML —
// le texte vient d'une IA, jamais garanti inoffensif.
marked.setOptions({ breaks: true });
function renderMarkdown(text: string): string {
  if (!text) return '';
  return DOMPurify.sanitize(marked.parse(text, { async: false }));
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
  // Recherche par texte dans l'historique des conversations (demande du 05/10/2026) — filtre en
  // base sur le titre ET le contenu des échanges (cf. GET /chatbot/conversations?search=), avec un
  // debounce pour ne pas relancer la requête à chaque frappe.
  const [conversationSearch, setConversationSearch] = useState('');
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
  // Actions sous une réponse (30/09/2026) : copiedIndex affiche "Copié" temporairement sur le bon
  // tour ; feedback (like/dislike) est purement visuel pour l'instant, cf. Turn.feedback.
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  function toggleFeedback(turnIndex: number, value: 'up' | 'down') {
    setTurns((prev) => {
      const next = [...prev];
      const current = next[turnIndex];
      if (!current) return prev;
      next[turnIndex] = { ...current, feedback: current.feedback === value ? null : value };
      return next;
    });
  }

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

  const loadConversations = useCallback(async (search?: string) => {
    try {
      const qs = search ? `?search=${encodeURIComponent(search)}` : '';
      const data = await apiFetch<Conversation[]>(`/reassort/chatbot/conversations${qs}`);
      setConversations(data);
      setConversationsError(null);
    } catch (err) {
      setConversationsError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Debounce de la recherche (300ms) — évite un appel serveur à chaque frappe, cf. champ de
  // recherche dans aia-conv-list plus bas.
  useEffect(() => {
    const timer = setTimeout(() => { loadConversations(conversationSearch); }, 300);
    return () => clearTimeout(timer);
  }, [conversationSearch, loadConversations]);

  function startNewConversation() {
    setCurrentConversationId(null);
    setTurns([]);
    setConversationError(null);
    // Retire ?conversation=... de l'URL (demande du 05/10/2026 : "quand j'actualise il quitte la
    // conversation" — l'URL est la source de vérité qui permet de rester sur la bonne conversation
    // après un rafraîchissement, cf. openConversation ci-dessous et la restauration au montage).
    const url = new URL(window.location.href);
    url.searchParams.delete('conversation');
    window.history.pushState({}, '', url);
  }

  async function openConversation(id: string) {
    try {
      const data = await apiFetch<ConversationDetail>(`/reassort/chatbot/conversations/${id}`);
      setCurrentConversationId(id);
      setConversationError(null);
      // Conversation active persistée dans l'URL (bug du 05/10/2026, voir commentaire ci-dessus) —
      // pushState plutôt que replaceState : permet aussi au bouton "précédent" du navigateur de
      // naviguer entre les conversations ouvertes dans cette session.
      const url = new URL(window.location.href);
      url.searchParams.set('conversation', id);
      window.history.pushState({}, '', url);

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
          answerHtml: assistantMsg ? renderMarkdown(assistantMsg.content) + visualHtml : '',
          answerText: assistantMsg?.content,
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
          answerHtml: renderMarkdown(finalResult.answer) + buildVisualFromToolResult(finalResult.toolResult, !!finalResult.wantsVisual),
          answerText: finalResult.answer,
        };
      } else if (lastErr?.name === 'AbortError') {
        next[turnIndex] = {
          question: q,
          answerHtml: renderMarkdown(streamedAnswer),
          answerText: streamedAnswer,
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
        const newHtml = renderMarkdown(lastAssistant.content);
        if (prev[turnIndex].answerHtml.includes(newHtml) || newHtml.length <= prev[turnIndex].answerHtml.length) return prev;
        const next = [...prev];
        next[turnIndex] = { ...next[turnIndex], answerHtml: newHtml, answerText: lastAssistant.content };
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

    // loadConversations() du montage initial géré par le useEffect debounce ci-dessus (se déclenche
    // aussi au montage, conversationSearch valant '' au départ) — pas la peine de le dupliquer ici.

    // Restaure la conversation active depuis l'URL au chargement (bug du 05/10/2026 : "quand
    // j'actualise il quitte sur la conversation") — après le chargement des magasins ci-dessus
    // (openConversation restaure le magasin actif associé à la conversation, a besoin de shopsById
    // déjà rempli). Un ID invalide/supprimé échoue silencieusement vers l'écran d'accueil habituel.
    const conversationIdFromUrl = new URLSearchParams(window.location.search).get('conversation');
    if (conversationIdFromUrl) {
      openConversation(conversationIdFromUrl).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <style>{`
        .aia-layout { display: flex; gap: 1rem; height: calc(100vh - 220px); min-height: 480px; }
        /* Bouton "Nouvelle conversation" en marine (demande du 05/10/2026, "la couleur noir corrige
           met le bleu du site") plutôt que le noir Bootstrap par défaut (btn-dark) — cohérent avec
           la palette marine/ambre du reste du site. */
        .aia-btn-navy { background-color: #1B2A4A; border-color: #1B2A4A; color: #fff; }
        .aia-btn-navy:hover, .aia-btn-navy:focus { background-color: #14203a; border-color: #14203a; color: #fff; }
        .aia-conv-list { width: 280px; flex-shrink: 0; background-color: #ffffff; border: 1px solid #e5e5e5; overflow-y: auto; }
        .aia-conv-item { display: flex; align-items: center; justify-content: space-between; padding: .55rem .85rem; cursor: pointer; border-bottom: 1px solid #f0f0f0; font-size: .85rem; }
        .aia-conv-item:hover { background-color: #f5f5f5; }
        .aia-conv-item.active { background-color: #1B2A4A; color: #ffffff; }
        .aia-conv-main { overflow: hidden; flex-grow: 1; min-width: 0; }
        .aia-conv-title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .aia-conv-date { display: block; font-size: .72rem; color: #999; margin-top: .1rem; }
        .aia-conv-item.active .aia-conv-date { color: #ccc; }
        .aia-conv-delete { opacity: .5; margin-left: .5rem; flex-shrink: 0; }
        .aia-conv-delete:hover { opacity: 1; }
        .aia-conv-item.active .aia-conv-delete { color: #ffffff; }

        .aia-main { flex-grow: 1; display: flex; flex-direction: column; background-color: #ffffff; border: 1px solid #e5e5e5; min-width: 0; }
        .aia-context-bar { padding: .75rem 1rem; border-bottom: 1px solid #e5e5e5; display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; }
        .aia-context-bar select, .aia-context-bar input { max-width: 220px; }

        #aia-chat-window { flex-grow: 1; overflow-y: auto; padding: 1.25rem; }
        /* Bulles de chat (demande du 08/10/2026, maquette fournie) : question alignée à droite dans
           une bulle marine foncée, réponse alignée à gauche dans une bulle grise claire — remplace
           l'ancien style "question en gras + réponse en bordure gauche", qui ne ressemblait pas à un
           vrai fil de discussion. Palette marine/ambre du site conservée (jamais le noir strict de
           la maquette d'origine). */
        .aia-turn { display: flex; flex-direction: column; gap: .6rem; margin-bottom: 1.25rem; }
        .aia-turn:last-child { margin-bottom: 0; }
        .aia-bubble { max-width: 78%; padding: .7rem 1rem; border-radius: 16px; line-height: 1.55; font-size: .93rem; }
        .aia-bubble-question { align-self: flex-end; background-color: #1B2A4A; color: #ffffff; border-bottom-right-radius: 4px; }
        .aia-bubble-answer { align-self: flex-start; background-color: #F1F3F5; color: #1a1a1a; border-bottom-left-radius: 4px; }
        .aia-bubble-answer.aia-bubble-error { background-color: #FBEAEA; color: #8a2f27; }
        .aia-answer p { margin: 0 0 .75rem; }
        .aia-answer p:last-child { margin-bottom: 0; }
        .aia-md-list { margin: .25rem 0 .75rem; padding-left: 1.4rem; }
        .aia-md-list:last-child { margin-bottom: 0; }
        .aia-md-list li { margin-bottom: .6rem; }
        .aia-md-list li:last-child { margin-bottom: 0; }
        .aia-stream-cursor { display: inline-block; animation: aia-blink 1s step-end infinite; }
        @keyframes aia-blink { 50% { opacity: 0; } }
        .aia-stream-live::after {
          content: '▍';
          display: inline-block;
          margin-left: 2px;
          animation: aia-blink 1s step-end infinite;
        }
        .aia-answer h1, .aia-answer h2, .aia-answer h3 {
          font-weight: 600;
          color: #1B2A4A;
          margin: 1rem 0 .5rem;
          line-height: 1.3;
        }
        .aia-answer h1:first-child, .aia-answer h2:first-child, .aia-answer h3:first-child { margin-top: 0; }
        .aia-answer h1 { font-size: 1.15rem; }
        .aia-answer h2 { font-size: 1.05rem; }
        .aia-answer h3 { font-size: .98rem; }
        .aia-answer ul, .aia-answer ol { margin: .25rem 0 .75rem; padding-left: 1.4rem; }
        .aia-answer ul:last-child, .aia-answer ol:last-child { margin-bottom: 0; }
        .aia-answer li { margin-bottom: .4rem; }
        .aia-answer li:last-child { margin-bottom: 0; }
        .aia-answer code {
          background: #F1F3F5;
          color: #1B2A4A;
          padding: .1rem .35rem;
          border-radius: 4px;
          font-size: .85em;
        }
        .aia-answer pre {
          background: #1B2A4A;
          color: #F5F7FA;
          padding: .85rem 1rem;
          border-radius: 6px;
          overflow-x: auto;
          margin: .5rem 0 .75rem;
        }
        .aia-answer pre code {
          background: transparent;
          color: inherit;
          padding: 0;
          font-size: .82rem;
        }
        .aia-answer table {
          width: 100%;
          border-collapse: collapse;
          font-size: .85rem;
          margin: .5rem 0 .75rem;
        }
        .aia-answer th, .aia-answer td {
          padding: .45rem .6rem;
          border-bottom: 1px solid #eeeeee;
          text-align: left;
        }
        .aia-answer th {
          font-weight: 600;
          color: #1B2A4A;
          font-size: .75rem;
          text-transform: uppercase;
          letter-spacing: .02em;
          border-bottom: 2px solid #1B2A4A;
        }
        .aia-answer blockquote {
          margin: .5rem 0 .75rem;
          padding: .25rem 1rem;
          border-left: 3px solid #F5A623;
          color: #5B6B85;
        }
        .aia-answer-actions {
          display: flex;
          align-items: center;
          gap: .4rem;
          margin-top: .75rem;
        }
        .aia-answer-action-btn {
          display: inline-flex;
          align-items: center;
          gap: .3rem;
          background: transparent;
          border: none;
          color: #9aa4b2;
          font-size: .78rem;
          padding: .3rem .5rem;
          border-radius: 6px;
          cursor: pointer;
          transition: background-color .15s ease, color .15s ease;
        }
        .aia-answer-action-btn:hover {
          background-color: #F1F3F5;
          color: #1B2A4A;
        }
        .aia-answer-action-btn.active {
          color: #F5A623;
        }
        /* "L'assistant réfléchit..." (demande du 28/09/2026, remplacé par une vraie sphère de points
           en rotation le 08/10/2026 — maquette fournie d'un indicateur plus visible/vivant, premier
           essai en CSS pur jugé "pas bien fait" par comparaison à la démo). Tant que le premier
           morceau de texte n'est pas encore arrivé (résolution de l'outil de données + latence avant
           le 1er chunk LLM, qui peut prendre plusieurs secondes), turn.streamText reste vide et un
           simple curseur clignotant seul paraissait trop discret, comme un gel plutôt qu'un
           chargement en cours. ThinkingOrb (canvas, cf. components/ui/thinking-orb.tsx) dessine la
           sphère elle-même ; ce halo CSS n'ajoute plus qu'un anneau pulsant discret autour, dans la
           palette marine/ambre du site (jamais le noir/blanc de la démo d'origine). */
        .aia-thinking { display: inline-flex; align-items: center; gap: .65rem; color: #5B6B85; font-size: .88rem; }
        .aia-thinking-orb-wrap { position: relative; width: 34px; height: 34px; flex-shrink: 0; }
        .aia-thinking-orb-ring {
          position: absolute; inset: -6px; border-radius: 50%;
          border: 1.5px solid rgba(245,166,35,.4);
          animation: aia-orb-ring 1.6s ease-in-out infinite;
        }
        @keyframes aia-orb-ring { 0%, 100% { transform: scale(0.92); opacity: .55; } 50% { transform: scale(1.12); opacity: 0; } }
        @media (prefers-reduced-motion: reduce) {
          .aia-thinking-orb-ring { animation: none; }
        }
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
          background-color: #1B2A4A;
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
        /* Bouton "Nouvelle conversation" en haut à droite du bloc d'accueil (maquette du 08/10/2026,
           coin supérieur droit de la carte "New Chat") — redondant avec le bouton de la colonne de
           gauche, mais accessible directement depuis l'écran d'accueil sans aller chercher ailleurs. */
        .aia-hero-restart {
          position: absolute; top: 0; right: 1rem; width: 36px; height: 36px; border-radius: 50%;
          background-color: #ffffff; border: 1px solid #e5e5e5; color: #1B2A4A;
          display: flex; align-items: center; justify-content: center; font-size: 1.05rem;
          transition: background-color .15s ease, transform .15s ease;
        }
        .aia-hero-restart:hover { background-color: #F1F3F5; transform: rotate(45deg); }
        /* Badge rond marine au-dessus du titre, même esprit que la maquette (icône dans un badge
           arrondi au-dessus du message de bienvenue) — logo Réassort Automatique (demande du
           08/10/2026 : "pas le logo du template par défaut"), pas une icône générique de bulle de
           chat sans rapport avec le produit. */
        .aia-hero-icon {
          width: 88px; height: 88px; border-radius: 24px; margin: 0 auto 1.1rem;
          background: linear-gradient(135deg, #1B2A4A 0%, #2d4068 100%);
          display: flex; align-items: center; justify-content: center;
          box-shadow: 0 10px 28px rgba(27,42,74,.25);
        }
        .aia-hero-icon img { width: 56px; height: 56px; object-fit: contain; }
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
            <button type="button" className="btn aia-btn-navy btn-sm w-100 mb-2" onClick={startNewConversation}>
              + Nouvelle conversation
            </button>
            <div className="position-relative">
              <iconify-icon
                icon="solar:magnifer-linear"
                style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#999', fontSize: '.9rem' }}
              ></iconify-icon>
              <input
                type="search"
                className="form-control form-control-sm"
                style={{ paddingLeft: 30 }}
                placeholder="Rechercher une conversation..."
                value={conversationSearch}
                onChange={(e) => setConversationSearch(e.target.value)}
              />
            </div>
          </div>
          <div>
            {conversationsError ? (
              <div className="p-3 text-danger small">Erreur : {conversationsError}</div>
            ) : conversations.length === 0 ? (
              <div className="p-3 text-muted small">
                {conversationSearch ? 'Aucune conversation ne correspond à cette recherche.' : 'Aucune conversation pour le moment.'}
              </div>
            ) : (
              conversations.map((c) => (
                <div
                  key={c.id}
                  className={`aia-conv-item${c.id === currentConversationId ? ' active' : ''}`}
                  onClick={() => openConversation(c.id)}
                >
                  <div className="aia-conv-main">
                    <span className="aia-conv-title">{c.title}</span>
                    <span className="aia-conv-date">{formatConversationDate(c.createdAt)}</span>
                  </div>
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
                  <button
                    type="button"
                    className="aia-hero-restart"
                    title="Nouvelle conversation"
                    onClick={startNewConversation}
                  >
                    <iconify-icon icon="solar:refresh-bold-duotone"></iconify-icon>
                  </button>
                  <div className="aia-hero-icon" aria-hidden="true">
                    <img src="/assets/images/logo-reassort.png" alt="" />
                  </div>
                  <div className="aia-hero-title">
                    {userName ? `Bonjour ${firstName(userName)} !` : 'Assistant IA Réassort'}
                  </div>
                  <p className="aia-hero-subtitle mb-4">
                    Sur quoi travaille-t-on aujourd'hui ? Posez une question sur les ventes, le stock, les
                    ruptures ou la précision de l'IA.
                  </p>
                  {!shopReady ? (
                    <p className="text-muted small">Sélectionnez un magasin (en haut de page) pour commencer.</p>
                  ) : (
                    <>
                      {suggestedQuestions.length > 0 && (
                        <div className="d-flex flex-wrap justify-content-center gap-2 mx-auto mb-3" style={{ maxWidth: 720 }}>
                          {suggestedQuestions.slice(0, 7).map((q, i) => (
                            <button key={i} type="button" className="aia-hero-pill" onClick={() => sendQuestion(q)}>
                              {q}
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="aia-hero-input mx-auto">
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
                    </>
                  )}
                </div>
              </div>
            )}
            {turns.map((turn, i) => (
              <div className="aia-turn" key={i}>
                <div className="aia-bubble aia-bubble-question">{turn.question}</div>
                <div className={`aia-bubble aia-bubble-answer aia-answer${turn.error ? ' aia-bubble-error' : ''}`}>
                  {turn.streaming ? (
                    turn.streamText ? (
                      // Rendu markdown déjà pendant le streaming (demande du 30/09/2026 : "bien
                      // formaté comme les autres sites") — le curseur clignotant vient en CSS
                      // (::after sur .aia-stream-live) plutôt qu'un <span> séparé, pour ne jamais
                      // casser une balise HTML tronquée en milieu de flux (ex: un <strong> ouvert
                      // par marked sur un morceau de texte pas encore complet).
                      <span className="aia-stream-live" dangerouslySetInnerHTML={{ __html: renderMarkdown(turn.streamText) }} />
                    ) : (
                      <span className="aia-thinking">
                        <span className="aia-thinking-orb-wrap" aria-hidden="true">
                          <span className="aia-thinking-orb-ring"></span>
                          <ThinkingOrb size={34} />
                        </span>
                        L'assistant réfléchit...
                      </span>
                    )
                  ) : turn.error ? (
                    <span className="text-danger">Erreur : {turn.error}</span>
                  ) : (
                    <>
                      <span dangerouslySetInnerHTML={{ __html: turn.answerHtml }} />
                      {turn.interrupted && <div className="text-muted small mt-1">(réponse interrompue)</div>}
                      <div className="aia-answer-actions">
                        <button
                          type="button"
                          className="aia-answer-action-btn"
                          title="Copier la réponse"
                          onClick={() => {
                            if (!turn.answerText) return;
                            navigator.clipboard.writeText(turn.answerText);
                            setCopiedIndex(i);
                            window.setTimeout(() => setCopiedIndex((cur) => (cur === i ? null : cur)), 1500);
                          }}
                        >
                          <Copy size={14} />
                          {copiedIndex === i ? 'Copié' : 'Copier'}
                        </button>
                        <button
                          type="button"
                          className={`aia-answer-action-btn${turn.feedback === 'up' ? ' active' : ''}`}
                          title="Réponse utile"
                          onClick={() => toggleFeedback(i, 'up')}
                        >
                          <ThumbsUp size={14} />
                        </button>
                        <button
                          type="button"
                          className={`aia-answer-action-btn${turn.feedback === 'down' ? ' active' : ''}`}
                          title="Réponse pas utile"
                          onClick={() => toggleFeedback(i, 'down')}
                        >
                          <ThumbsDown size={14} />
                        </button>
                      </div>
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
