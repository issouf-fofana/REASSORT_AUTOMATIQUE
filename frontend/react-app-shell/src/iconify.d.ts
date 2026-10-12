// Déclaration JSX pour <iconify-icon>, un custom element chargé via le script CDN dans index.html
// (pas un composant React) — utilisé partout dans le reste du site (Iconify Solar icons), repris
// tel quel dans les composants migrés pour un rendu visuel identique aux pages HTML classiques.
//
// React 19 a déplacé le namespace JSX vers React.JSX (plus le global `JSX` classique) — augmenter
// ce module plutôt que `declare global { namespace JSX }`, qui ne fonctionne plus avec cette version.
import type { DetailedHTMLProps, HTMLAttributes } from 'react';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'iconify-icon': DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        icon?: string;
      };
    }
  }
}
