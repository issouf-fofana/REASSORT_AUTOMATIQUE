import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { consumeSseStream } from '../lib/sseStream';
import { renderAiMarkdown } from '../lib/aiMarkdown';
import { useAuth } from '../auth/AuthProvider';

// Portage React de assets/js/ai-assistant-widget.js (13/10/2026, "il reste quel fonctionnalité ?"
// → widget IA flottant jamais reconstruit depuis la fusion SPA, absent sur toutes les pages
// migrées contrairement aux 19 anciennes pages HTML, qui le chargent toutes). Monté une seule fois
// dans App.tsx, hors de <Routes/>, pour rester visible au fil des navigations internes (jamais
// démonté/remonté à chaque changement de page, contrairement au script vanilla d'origine qui se
// réinjectait entièrement à chaque rechargement complet).
//
// Masqué sur /login (pas encore de compte/magasin, même exception que l'original) ET sur
// /ai-assistant (choix explicite de l'utilisateur : la page dédiée a déjà son propre chat plein
// écran, pas besoin d'une bulle flottante en plus au même endroit).
//
// Réutilise consumeSseStream/renderAiMarkdown de AiAssistant.tsx (extraits en module partagé) pour
// un rendu identique à la page dédiée — reste volontairement un composant séparé (markup/état
// propres) plutôt qu'un simple mode compact de AiAssistant.tsx : les deux peuvent exister dans le
// DOM en même temps sur certaines pages (contrairement à l'original, jamais sur /ai-assistant ici),
// et le widget garde un historique local (currentConversationId) distinct de la page dédiée.
interface ChatTurn {
  question: string;
  answerHtml: string | null;
  error: string | null;
}

export function FloatingAiWidget() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, isSingleShopRole } = useAuth();

  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [shopLabel, setShopLabel] = useState<string | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Même logique que currentShopId()/refreshContextDisplay() de l'original : un rôle à magasin
  // unique n'a pas de sélecteur global (reassortGetActiveShop() y renvoie toujours null), le
  // magasin effectif pour ces comptes est déterminé côté serveur (resolveShopId), jamais ici.
  function currentShopId(): string | null {
    if (user && isSingleShopRole(user.role)) return user.rposShopId || null;
    const shop = window.reassortGetActiveShop();
    return shop ? shop.id : null;
  }

  function refreshShopLabel() {
    if (user && isSingleShopRole(user.role)) {
      setShopLabel(user.rposShopName ? `${user.rposShopReference} - ${user.rposShopName}` : null);
      return;
    }
    const shop = window.reassortGetActiveShop();
    setShopLabel(shop ? `${shop.reference} - ${shop.name}` : null);
  }

  useEffect(() => {
    refreshShopLabel();
    // Changer de magasin pendant que le widget est ouvert repart sur une conversation neuve (une
    // conversation est rattachée à un magasin précis côté serveur) — même comportement que l'event
    // listener reassortOnActiveShopChange de l'original.
    window.reassortOnActiveShopChange(() => {
      setConversationId(null);
      setTurns([]);
      refreshShopLabel();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (messagesRef.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
  }, [turns]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  async function attemptQuestion(question: string, onChunk: (partial: string) => void): Promise<{ answer: string; conversationId: string }> {
    let streamedAnswer = '';
    const res = await window.reassortFetch(`/reassort/chatbot/ask-stream?shop=${encodeURIComponent(currentShopId() || '')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId, question }),
    });
    if (!res.ok) throw new Error(`Erreur serveur (${res.status})`);

    let finalResult: { answer: string; conversationId: string } | null = null;
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
    return finalResult;
  }

  async function sendQuestion() {
    const question = input.trim();
    if (!question || !currentShopId() || sending) return;
    setInput('');
    setSending(true);

    const turnIndex = turns.length;
    setTurns((prev) => [...prev, { question, answerHtml: null, error: null }]);

    // Une seule retentative automatique en cas de coupure réseau en cours de flux (même
    // raisonnement que l'original : observé en usage réel, jamais reproduit en environnement
    // contrôlé — pointe vers le réseau du poste plutôt qu'un bug de code, jamais de boucle infinie).
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const result = await attemptQuestion(question, (partial) => {
          setTurns((prev) => {
            const next = [...prev];
            next[turnIndex] = { ...next[turnIndex], answerHtml: renderAiMarkdown(partial) };
            return next;
          });
        });
        setTurns((prev) => {
          const next = [...prev];
          next[turnIndex] = { question, answerHtml: renderAiMarkdown(result.answer), error: null };
          return next;
        });
        setConversationId(result.conversationId);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
      }
    }

    if (lastErr) {
      setTurns((prev) => {
        const next = [...prev];
        next[turnIndex] = { question, answerHtml: null, error: lastErr!.message };
        return next;
      });
      window.reassortReportError?.(`Widget Assistant IA (après 2 tentatives): ${lastErr.message}`, lastErr.stack);
    }

    setSending(false);
    inputRef.current?.focus();
  }

  if (location.pathname === '/login' || location.pathname === '/ai-assistant') return null;

  const hasShop = !!currentShopId();

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Ouvrir l'assistant IA"
        style={{
          position: 'fixed', bottom: 24, right: 24, width: 56, height: 56, borderRadius: '50%',
          background: 'linear-gradient(135deg, #1B2A4A 0%, #2d4068 100%)', color: '#F5A623', border: 'none',
          boxShadow: '0 6px 20px rgba(27,42,74,.35)', zIndex: 1050,
          display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0,
        }}
      >
        <img src="/assets/images/logo-reassort.png" alt="" style={{ width: 30, height: 30, objectFit: 'contain' }} />
      </button>

      {open && (
        <div
          style={{
            position: 'fixed', bottom: 92, right: 24, width: 380, maxWidth: '92vw', height: 520, maxHeight: '75vh',
            background: '#ffffff', border: '1px solid #e5e5e5', borderRadius: 16,
            boxShadow: '0 16px 40px rgba(27,42,74,.22)', zIndex: 1050,
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }}
        >
          <div style={{ padding: '.85rem 1rem', background: '#1B2A4A', color: '#ffffff', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
            <span style={{ fontWeight: 600, fontSize: '.95rem', display: 'flex', alignItems: 'center', gap: '.5rem' }}>
              <img src="/assets/images/logo-reassort.png" alt="" style={{ width: 20, height: 20, objectFit: 'contain' }} />
              Assistant IA
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem' }}>
              <button
                type="button"
                onClick={() => navigate('/ai-guide')}
                title="Ce que je peux vous demander"
                aria-label="Ce que je peux vous demander"
                style={{ background: 'none', border: '1px solid rgba(255,255,255,.5)', color: '#ffffff', fontSize: '.75rem', fontWeight: 600, cursor: 'pointer', lineHeight: 1, width: 20, height: 20, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}
              >
                ?
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Fermer"
                style={{ background: 'none', border: 'none', color: '#ffffff', fontSize: '1.2rem', cursor: 'pointer', lineHeight: 1, opacity: .85 }}
              >
                ×
              </button>
            </div>
          </div>

          <div style={{ padding: '.5rem .75rem', borderBottom: '1px solid #e5e5e5', flexShrink: 0 }}>
            <span className="text-muted small">{shopLabel || 'Sélectionnez un magasin (en haut de page)'}</span>
          </div>

          <div ref={messagesRef} style={{ flexGrow: 1, overflowY: 'auto', padding: '.85rem', background: '#FAFBFC' }}>
            {turns.length === 0 ? (
              <div style={{ color: '#999999', textAlign: 'center', padding: '1.5rem 1rem', fontSize: '.85rem' }}>
                Posez une question sur les ventes, le stock ou les ruptures de ce magasin.
              </div>
            ) : (
              turns.map((turn, i) => (
                <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: '.45rem', marginBottom: i === turns.length - 1 ? 0 : '1rem' }}>
                  <div style={{ alignSelf: 'flex-end', maxWidth: '85%', background: '#1B2A4A', color: '#ffffff', fontSize: '.85rem', padding: '.55rem .8rem', borderRadius: 14, borderBottomRightRadius: 4 }}>
                    {turn.question}
                  </div>
                  <div style={{ alignSelf: 'flex-start', maxWidth: '85%', background: '#F1F3F5', color: '#1a1a1a', padding: '.55rem .8rem', borderRadius: 14, borderBottomLeftRadius: 4, fontSize: '.85rem', lineHeight: 1.5 }}>
                    {turn.error ? (
                      <span className="text-danger">Erreur : {turn.error}</span>
                    ) : turn.answerHtml === null ? (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.5rem', color: '#5B6B85' }}>
                        <span
                          style={{
                            position: 'relative', width: 24, height: 24, flexShrink: 0, borderRadius: '50%',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            background: 'linear-gradient(135deg, #1B2A4A 0%, #2d4068 100%)',
                            boxShadow: '0 3px 10px rgba(27,42,74,.3)',
                          }}
                        >
                          <img src="/assets/images/logo-reassort.png" alt="" className="aiw-thinking-logo" style={{ width: 15, height: 15 }} />
                        </span>
                        Réflexion en cours...
                      </span>
                    ) : (
                      <span dangerouslySetInnerHTML={{ __html: turn.answerHtml }} />
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          <div style={{ padding: '.6rem .75rem', borderTop: '1px solid #e5e5e5', flexShrink: 0 }}>
            <div className="input-group">
              <input
                ref={inputRef}
                type="text"
                className="form-control"
                style={{ fontSize: '.85rem', borderRadius: '999px 0 0 999px' }}
                placeholder="Votre question..."
                value={input}
                disabled={!hasShop || sending}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') sendQuestion();
                }}
              />
              <button
                type="button"
                className="btn"
                style={{ fontSize: '.85rem', borderRadius: '0 999px 999px 0', background: '#1B2A4A', borderColor: '#1B2A4A', color: '#ffffff' }}
                disabled={!hasShop || sending}
                onClick={sendQuestion}
              >
                Envoyer
              </button>
            </div>
          </div>

          <div style={{ textAlign: 'center', padding: '.4rem', fontSize: '.75rem', borderTop: '1px solid #e5e5e5', flexShrink: 0 }}>
            <button
              type="button"
              onClick={() => navigate('/ai-assistant')}
              style={{ background: 'none', border: 'none', color: '#1B2A4A', cursor: 'pointer', padding: 0, font: 'inherit' }}
            >
              Ouvrir en plein écran &amp; voir l'historique
            </button>
          </div>
        </div>
      )}

      <style>{`
        @keyframes aiw-logo-spin { from { transform: rotateY(0deg); } to { transform: rotateY(360deg); } }
        .aiw-thinking-logo { animation: aiw-logo-spin 1.8s linear infinite; }
      `}</style>
    </>
  );
}
