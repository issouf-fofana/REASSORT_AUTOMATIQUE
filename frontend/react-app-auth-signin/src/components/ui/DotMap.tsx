import { useEffect, useRef, useState } from 'react';

// Adapté du composant "Travel Connect Sign In" (21st.dev, demande du 25/09/2026) : palette
// bleu/indigo d'origine remplacée par noir/gris (contrainte du site : noir/blanc/gris partout,
// cf. THEME_SYSTEM.md), reste identique à l'original sinon (canvas animé, points en forme de
// mappemonde, trajets qui se dessinent en boucle). Ajout du 25/09/2026 : les points réagissent au
// curseur (effet magnétique/répulsion) — chaque point garde sa position d'origine (baseX/baseY) et
// s'en écarte temporairement selon sa distance à la souris, puis y revient (interpolation) quand le
// curseur s'éloigne ou quitte le panneau.
type RoutePoint = { x: number; y: number; delay: number };
type Dot = { baseX: number; baseY: number; x: number; y: number; radius: number; opacity: number };

export function DotMap() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

  const routes: { start: RoutePoint; end: RoutePoint; color: string }[] = [
    { start: { x: 100, y: 150, delay: 0 }, end: { x: 200, y: 80, delay: 2 }, color: '#3f3f46' },
    { start: { x: 200, y: 80, delay: 2 }, end: { x: 260, y: 120, delay: 4 }, color: '#3f3f46' },
    { start: { x: 50, y: 50, delay: 1 }, end: { x: 150, y: 180, delay: 3 }, color: '#3f3f46' },
    { start: { x: 280, y: 60, delay: 0.5 }, end: { x: 180, y: 180, delay: 2.5 }, color: '#3f3f46' },
  ];

  function generateDots(width: number, height: number): Dot[] {
    const dots: Dot[] = [];
    const gap = 12;
    const dotRadius = 1;
    for (let x = 0; x < width; x += gap) {
      for (let y = 0; y < height; y += gap) {
        const isInMapShape =
          (x < width * 0.25 && x > width * 0.05 && (y < height * 0.4 && y > height * 0.1)) ||
          (x < width * 0.25 && x > width * 0.15 && (y < height * 0.8 && y > height * 0.4)) ||
          (x < width * 0.45 && x > width * 0.3 && (y < height * 0.35 && y > height * 0.15)) ||
          (x < width * 0.5 && x > width * 0.35 && (y < height * 0.65 && y > height * 0.35)) ||
          (x < width * 0.7 && x > width * 0.45 && (y < height * 0.5 && y > height * 0.1)) ||
          (x < width * 0.8 && x > width * 0.65 && (y < height * 0.8 && y > height * 0.6));
        if (isInMapShape && Math.random() > 0.3) {
          dots.push({ baseX: x, baseY: y, x, y, radius: dotRadius, opacity: Math.random() * 0.5 + 0.2 });
        }
      }
    }
    return dots;
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resizeObserver = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setDimensions({ width, height });
      canvas.width = width;
      canvas.height = height;
    });
    resizeObserver.observe(canvas.parentElement as Element);
    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    if (!dimensions.width || !dimensions.height) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dots = generateDots(dimensions.width, dimensions.height);
    let animationFrameId: number;
    let startTime = Date.now();

    // Position souris en coordonnées du canvas ; null quand le curseur est hors du panneau (les
    // points reviennent alors tranquillement à leur position d'origine).
    const mouse = { x: null as number | null, y: null as number | null };
    const REPEL_RADIUS = 70;
    const REPEL_STRENGTH = 18;
    const EASE = 0.15;

    function onMouseMove(e: MouseEvent) {
      const rect = canvas!.getBoundingClientRect();
      mouse.x = e.clientX - rect.left;
      mouse.y = e.clientY - rect.top;
    }
    function onMouseLeave() {
      mouse.x = null;
      mouse.y = null;
    }
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseleave', onMouseLeave);

    function updateDots() {
      dots.forEach((dot) => {
        let targetX = dot.baseX;
        let targetY = dot.baseY;
        if (mouse.x !== null && mouse.y !== null) {
          const dx = dot.baseX - mouse.x;
          const dy = dot.baseY - mouse.y;
          const dist = Math.hypot(dx, dy);
          if (dist < REPEL_RADIUS && dist > 0.01) {
            const force = (1 - dist / REPEL_RADIUS) * REPEL_STRENGTH;
            targetX = dot.baseX + (dx / dist) * force;
            targetY = dot.baseY + (dy / dist) * force;
          }
        }
        dot.x += (targetX - dot.x) * EASE;
        dot.y += (targetY - dot.y) * EASE;
      });
    }

    function drawDots() {
      ctx!.clearRect(0, 0, dimensions.width, dimensions.height);
      dots.forEach((dot) => {
        ctx!.beginPath();
        ctx!.arc(dot.x, dot.y, dot.radius, 0, Math.PI * 2);
        ctx!.fillStyle = `rgba(63, 63, 70, ${dot.opacity})`;
        ctx!.fill();
      });
    }

    function drawRoutes() {
      const currentTime = (Date.now() - startTime) / 1000;
      routes.forEach((route) => {
        const elapsed = currentTime - route.start.delay;
        if (elapsed <= 0) return;
        const duration = 3;
        const progress = Math.min(elapsed / duration, 1);
        const x = route.start.x + (route.end.x - route.start.x) * progress;
        const y = route.start.y + (route.end.y - route.start.y) * progress;

        ctx!.beginPath();
        ctx!.moveTo(route.start.x, route.start.y);
        ctx!.lineTo(x, y);
        ctx!.strokeStyle = route.color;
        ctx!.lineWidth = 1.5;
        ctx!.stroke();

        ctx!.beginPath();
        ctx!.arc(route.start.x, route.start.y, 3, 0, Math.PI * 2);
        ctx!.fillStyle = route.color;
        ctx!.fill();

        ctx!.beginPath();
        ctx!.arc(x, y, 3, 0, Math.PI * 2);
        ctx!.fillStyle = '#18181b';
        ctx!.fill();

        ctx!.beginPath();
        ctx!.arc(x, y, 6, 0, Math.PI * 2);
        ctx!.fillStyle = 'rgba(24, 24, 27, 0.35)';
        ctx!.fill();

        if (progress === 1) {
          ctx!.beginPath();
          ctx!.arc(route.end.x, route.end.y, 3, 0, Math.PI * 2);
          ctx!.fillStyle = route.color;
          ctx!.fill();
        }
      });
    }

    function animate() {
      updateDots();
      drawDots();
      drawRoutes();
      const currentTime = (Date.now() - startTime) / 1000;
      if (currentTime > 15) startTime = Date.now();
      animationFrameId = requestAnimationFrame(animate);
    }
    animate();

    return () => {
      cancelAnimationFrame(animationFrameId);
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mouseleave', onMouseLeave);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dimensions]);

  return (
    <div className="relative w-full h-full overflow-hidden">
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
    </div>
  );
}
