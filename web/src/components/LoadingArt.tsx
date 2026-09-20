import { useEffect, useRef } from 'react';

import { FIELD, advanceParticle, fieldParticles, pixelPosition } from '../texture';

/**
 * The loading art: a screen of black pixels on white, and nothing else.
 *
 * The screen is a grid of 256 x 256 pixels. A particle IS one pixel: it moves in
 * whole pixels only, along one axis, and may only turn a quarter turn — never
 * backwards, never at an angle. It never grows and it leaves no trail.
 *
 * The field is drawn on a canvas: a few thousand moving pixels are far cheaper
 * to draw than to animate as SVG children.
 */

export function LoadingArt({ label = 'working' }: { label?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // ── the field ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const context = canvas.getContext('2d');
    if (!context) return undefined;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const speedFactor = reduce ? 0.25 : 1;
    let width = 0;
    let height = 0;
    let particles = fieldParticles();

    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      const box = canvas.getBoundingClientRect();
      width = Math.max(1, Math.round(box.width));
      height = Math.max(1, Math.round(box.height));
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    resize();

    let frame = 0;
    let last = performance.now();
    const draw = (now: number) => {
      // A long frame must not teleport the pixels: cap the step.
      const seconds = Math.min(0.25, (now - last) / 1000) * speedFactor;
      last = now;
      particles = particles.map((particle) => advanceParticle(particle, seconds));

      const unit = width / FIELD;
      const fieldSize = FIELD * unit;
      context.fillStyle = '#fff';
      context.fillRect(0, 0, width, height);
      for (const particle of particles) {
        const pixel = pixelPosition(particle);
        const size = pixel.size * unit;
        context.fillStyle = `rgba(0, 0, 0, ${particle.opacity.toFixed(3)})`;
        context.fillRect(pixel.x * unit, pixel.y * unit, size, size);
        // A pixel that crosses an edge appears on the other side too.
        if (pixel.x * unit < size) context.fillRect(pixel.x * unit + fieldSize, pixel.y * unit, size, size);
        else if (pixel.x * unit > fieldSize - size) context.fillRect(pixel.x * unit - fieldSize, pixel.y * unit, size, size);
        if (pixel.y * unit < size) context.fillRect(pixel.x * unit, pixel.y * unit + fieldSize, size, size);
        else if (pixel.y * unit > fieldSize - size) context.fillRect(pixel.x * unit, pixel.y * unit - fieldSize, size, size);
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);

    window.addEventListener('resize', resize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <div className="loading-art" role="img" aria-label={label}>
      <canvas className="la-canvas" ref={canvasRef} />
    </div>
  );
}
