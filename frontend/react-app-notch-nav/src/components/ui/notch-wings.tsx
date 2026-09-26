import { cn } from '@/lib/utils';

// SVG des coins incurvés "aile" reliant les îlots noirs de la barre notch (repris du composant
// adaptive-notch-navigation-bar fourni par l'utilisateur le 26/09/2026) — donne l'effet d'île
// flottante en haut de page plutôt que des rectangles collés bord à bord. currentColor = couleur du
// texte du wrapper (toujours text-zinc-950, jamais dark:, le site n'a pas de thème sombre).
interface WingProps {
  className?: string;
}

export function NotchLeftWing({ className }: WingProps) {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 20 20"
      fill="none"
      shapeRendering="geometricPrecision"
      className={cn('pointer-events-none absolute right-full top-0 size-4 overflow-visible select-none text-zinc-950', className)}
    >
      <path d="M 0 0 C 11.046 0 20 8.954 20 20 H 21 V -1 H 0 Z" fill="currentColor" />
    </svg>
  );
}

export function NotchRightWing({ className }: WingProps) {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 20 20"
      fill="none"
      shapeRendering="geometricPrecision"
      className={cn('pointer-events-none absolute left-full top-0 size-4 overflow-visible select-none text-zinc-950', className)}
    >
      <path d="M 20 0 C 8.954 0 0 8.954 0 20 H -1 V -1 H 20 Z" fill="currentColor" />
    </svg>
  );
}
