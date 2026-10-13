// Consommateur de flux Server-Sent Events, extrait de AiAssistant.tsx (13/10/2026) pour être
// réutilisé tel quel par FloatingAiWidget.tsx (widget flottant de chat, même backend
// /reassort/chatbot/ask-stream) — une seule implémentation du parsing SSE, jamais deux copies à
// synchroniser entre la page dédiée et le widget.
export async function consumeSseStream(res: Response, onEvent: (eventName: string, data: any) => void) {
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
