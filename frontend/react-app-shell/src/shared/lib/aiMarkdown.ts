import { marked } from 'marked';
import DOMPurify from 'dompurify';

// Rendu markdown des réponses du chatbot, extrait de AiAssistant.tsx (13/10/2026) pour être
// réutilisé tel quel par FloatingAiWidget.tsx — une réponse IA doit s'afficher identiquement,
// que l'utilisateur la lise dans le widget flottant ou sur la page dédiée /ai-assistant.
// `breaks: true` : un simple retour à la ligne suffit à structurer la réponse, pas besoin d'un
// double saut de ligne. DOMPurify sanitise le HTML produit avant tout dangerouslySetInnerHTML —
// le texte vient d'une IA, jamais garanti inoffensif.
marked.setOptions({ breaks: true });

export function renderAiMarkdown(text: string): string {
  if (!text) return '';
  return DOMPurify.sanitize(marked.parse(text, { async: false }));
}
