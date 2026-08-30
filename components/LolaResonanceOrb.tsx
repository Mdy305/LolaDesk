'use client';

import { useEffect, useRef } from 'react';

interface LolaResonanceOrbProps {
  isActive: boolean;
  isSpeaking: boolean;
  audioLevel?: number;
}

export function LolaResonanceOrb({ isActive, isSpeaking, audioLevel = 0.2 }: LolaResonanceOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;
    let particles: Array<{ angle: number; speed: number; radius: number; size: number }> = [];

    for (let i = 0; i < 40; i++) {
      particles.push({
        angle: Math.random() * Math.PI * 2,
        speed: 0.01 + Math.random() * 0.02,
        radius: 25 + Math.random() * 15,
        size: 1.5 + Math.random() * 2,
      });
    }

    const render = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const centerX = canvas.width / 2;
      const centerY = canvas.height / 2;

      const scaleFactor = isSpeaking ? 1.5 + audioLevel * 1.2 : isActive ? 1.1 : 0.9;
      const baseGlowRadius = 30 * scaleFactor;

      const gradient = ctx.createRadialGradient(centerX, centerY, 5, centerX, centerY, baseGlowRadius + 20);
      gradient.addColorStop(0, 'rgba(163, 230, 53, 0.9)');
      gradient.addColorStop(0.5, isSpeaking ? 'rgba(163, 230, 53, 0.4)' : 'rgba(163, 230, 53, 0.15)');
      gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');

      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(centerX, centerY, baseGlowRadius + 20, 0, Math.PI * 2);
      ctx.fill();

      particles.forEach((p) => {
        p.angle += p.speed * (isSpeaking ? 2.5 : 1);
        const dynamicRadius = p.radius * scaleFactor + Math.sin(p.angle * 3) * (isSpeaking ? 6 : 2);
        const x = centerX + Math.cos(p.angle) * dynamicRadius;
        const y = centerY + Math.sin(p.angle) * dynamicRadius;

        ctx.fillStyle = isSpeaking ? '#ffffff' : '#a3e635';
        ctx.beginPath();
        ctx.arc(x, y, p.size * (isSpeaking ? 1.4 : 1), 0, Math.PI * 2);
        ctx.fill();
      });

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => cancelAnimationFrame(animationFrameId);
  }, [isActive, isSpeaking, audioLevel]);

  return (
    <div className="relative flex items-center justify-center w-20 h-20">
      <canvas ref={canvasRef} width={100} height={100} className="absolute inset-0 pointer-events-none" />
      <div
        className={`relative z-10 flex h-12 w-12 items-center justify-center rounded-full text-black font-black text-xl transition-all ${
          isActive ? 'bg-lime-400 scale-105' : 'bg-lime-400/80 hover:bg-lime-400'
        }`}
      >
        L
      </div>
    </div>
  );
}
