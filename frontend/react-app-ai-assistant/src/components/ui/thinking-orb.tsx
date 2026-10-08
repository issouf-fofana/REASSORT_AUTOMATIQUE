import { useEffect, useRef } from 'react';

// Sphère de points en rotation, inspirée de la démo "MorphOrb" fournie le 08/10/2026, mais réduite
// à SA SEULE partie utile pour ce chat : l'indicateur "en train de réfléchir" entre l'envoi de la
// question et le premier mot de la réponse. Le morphing complet de la démo (barre de saisie qui se
// transforme en bulle, puis en orbe, puis en carte de réponse) a été volontairement écarté — il
// remplacerait tout le flux de streaming/conversations déjà en place (SSE, historique, pièces
// jointes), un chantier hors de portée de "animer le chargement". Palette marine/ambre du site
// (#1B2A4A / #F5A623), jamais le noir/blanc de la démo d'origine.
const RINGS = 10;
const TAU = Math.PI * 2;

interface Dot {
  x: number;
  y: number;
  z: number;
}

const DOTS: Dot[] = (() => {
  const out: Dot[] = [];
  for (let k = 0; k < RINGS; k++) {
    const y = 1 - ((k + 0.5) / RINGS) * 2;
    const r = Math.sqrt(1 - y * y);
    const m = Math.max(3, Math.round(16 * r));
    for (let j = 0; j < m; j++) {
      const a = (j / m) * TAU + k * 0.4;
      out.push({ x: Math.cos(a) * r, y, z: Math.sin(a) * r });
    }
  }
  return out;
})();

export function ThinkingOrb({ size = 64 }: { size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const R = size * 0.34;
    const C0 = size / 2;
    const tiltCos = Math.cos(0.4);
    const tiltSin = Math.sin(0.4);

    let rot = 0;
    let raf = 0;
    let last = performance.now();
    let dead = false;

    const draw = () => {
      if (dead) return;
      const now = performance.now();
      const dt = reduced ? 0.016 : Math.min(0.05, (now - last) / 1000);
      last = now;
      rot += dt * (reduced ? 0.15 : 1.1);

      ctx.clearRect(0, 0, size, size);
      const cy = Math.cos(rot);
      const sy = Math.sin(rot);

      const projected = DOTS.map((d) => {
        const x1 = d.x * cy + d.z * sy;
        const z1 = -d.x * sy + d.z * cy;
        const y2 = d.y * tiltCos - z1 * tiltSin;
        const z2 = d.y * tiltSin + z1 * tiltCos;
        const f = 2.6 / (2.6 - z2);
        const depth = (z2 + 1) / 2;
        return { x: C0 + x1 * R * f, y: C0 - y2 * R * f, depth, r: (0.9 + depth * 1.3) * f };
      });

      projected.sort((a, b) => a.depth - b.depth);
      for (const p of projected) {
        const alpha = 0.25 + p.depth * 0.75;
        const amberMix = p.depth * 0.35;
        const r = Math.round(lerp(27, 245, amberMix));
        const g = Math.round(lerp(42, 166, amberMix));
        const b = Math.round(lerp(74, 35, amberMix));
        ctx.fillStyle = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, TAU);
        ctx.fill();
      }

      raf = requestAnimationFrame(draw);
    };

    function lerp(a: number, b: number, t: number) {
      return a + (b - a) * t;
    }

    raf = requestAnimationFrame(draw);
    return () => {
      dead = true;
      cancelAnimationFrame(raf);
    };
  }, [size]);

  return <canvas ref={canvasRef} style={{ width: size, height: size, display: 'block' }} aria-hidden="true" />;
}
