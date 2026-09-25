import { useEffect, useRef, useState } from 'react';
import { Mic, Send } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';

// Adapté du composant "AI Chat Input" (21st.dev, demande du 24/09/2026) : au lieu de son état
// interne factice (inputValue local, bouton d'envoi décoratif), ce composant est contrôlé par le
// parent (AiAssistant.tsx) — même contrat qu'un <input> standard, pour continuer à piloter
// sendQuestion/stopGeneration/abortController déjà en place, sans dupliquer cette logique ici.
interface AIChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  sending?: boolean;
  placeholders: string[];
}

const AIChatInput = ({ value, onChange, onSubmit, disabled, sending, placeholders }: AIChatInputProps) => {
  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  const [showPlaceholder, setShowPlaceholder] = useState(true);
  const [isActive, setIsActive] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const activePlaceholders = placeholders.length ? placeholders : ['Posez votre question...'];

  useEffect(() => {
    if (isActive || value) return;
    const interval = setInterval(() => {
      setShowPlaceholder(false);
      setTimeout(() => {
        setPlaceholderIndex((prev) => (prev + 1) % activePlaceholders.length);
        setShowPlaceholder(true);
      }, 400);
    }, 3000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, value, activePlaceholders.length]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        if (!value) setIsActive(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [value]);

  const placeholderContainerVariants = {
    initial: {},
    animate: { transition: { staggerChildren: 0.025 } },
    exit: { transition: { staggerChildren: 0.015, staggerDirection: -1 } },
  };

  const letterVariants = {
    initial: { opacity: 0, filter: 'blur(12px)', y: 10 },
    animate: {
      opacity: 1,
      filter: 'blur(0px)',
      y: 0,
      transition: {
        opacity: { duration: 0.25 },
        filter: { duration: 0.4 },
        y: { type: 'spring' as const, stiffness: 80, damping: 20 },
      },
    },
    exit: {
      opacity: 0,
      filter: 'blur(12px)',
      y: -10,
      transition: {
        opacity: { duration: 0.2 },
        filter: { duration: 0.3 },
        y: { type: 'spring' as const, stiffness: 80, damping: 20 },
      },
    },
  };

  function submit() {
    if (disabled) return;
    onSubmit();
  }

  return (
    <div ref={wrapperRef} className="reassort-ai-input-root w-full">
      <motion.div
        className="w-full rounded-[28px] bg-white border border-neutral-200"
        animate={{ boxShadow: isActive || value ? '0 8px 28px 0 rgba(0,0,0,0.12)' : '0 1px 3px 0 rgba(0,0,0,0.06)' }}
        onClick={() => setIsActive(true)}
      >
        <div className="flex items-center gap-1.5 p-2 rounded-full bg-white w-full">
          <div className="relative flex-1 min-w-0">
            <input
              type="text"
              value={value}
              disabled={disabled}
              onChange={(e) => onChange(e.target.value)}
              onFocus={() => setIsActive(true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              className="w-full border-0 outline-none rounded-md py-2.5 px-4 text-[0.95rem] bg-transparent font-normal text-black disabled:opacity-50"
              style={{ position: 'relative', zIndex: 1 }}
            />
            <div className="absolute left-0 top-0 w-full h-full pointer-events-none flex items-center px-4">
              <AnimatePresence mode="wait">
                {showPlaceholder && !isActive && !value && (
                  <motion.span
                    key={placeholderIndex}
                    className="text-neutral-400 select-none whitespace-nowrap overflow-hidden text-ellipsis text-[0.95rem]"
                    variants={placeholderContainerVariants}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                  >
                    {activePlaceholders[placeholderIndex].split('').map((char, i) => (
                      <motion.span key={i} variants={letterVariants} style={{ display: 'inline-block' }}>
                        {char === ' ' ? ' ' : char}
                      </motion.span>
                    ))}
                  </motion.span>
                )}
              </AnimatePresence>
            </div>
          </div>

          <button
            className="hidden sm:flex p-2.5 rounded-full text-neutral-300 cursor-not-allowed flex-shrink-0"
            title="Micro (indisponible)"
            type="button"
            tabIndex={-1}
            disabled
          >
            <Mic size={19} />
          </button>
          <button
            className={`flex items-center gap-1 p-2.5 rounded-full font-medium justify-center transition flex-shrink-0 ${
              sending ? 'bg-red-600 hover:bg-red-700 text-white' : 'bg-black hover:bg-neutral-800 text-white'
            } disabled:opacity-40`}
            title={sending ? 'Arrêter' : 'Envoyer'}
            type="button"
            disabled={!sending && disabled}
            onClick={submit}
          >
            <Send size={18} />
          </button>
        </div>
      </motion.div>
    </div>
  );
};

export { AIChatInput };
