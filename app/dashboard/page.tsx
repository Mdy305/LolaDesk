'use client';

import { useState, useEffect, useRef } from 'react';

export default function LolaCentralCoreDashboard() {
  const [isResonating, setIsResonating] = useState(true);
  const [command, setCommand] = useState('');
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Central Resonant Lola Particle System
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationId: number;
    let t = 0;

    const render = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      const baseRadius = 80;
      const particleCount = 75;

      t += 0.03;

      for (let i = 0; i < particleCount; i++) {
        const angle = (i / particleCount) * Math.PI * 2 + t * 0.4;
        const wave = Math.sin(angle * 6 + t * 3) * (isResonating ? 18 : 4);
        const r = baseRadius + wave;

        const x = cx + Math.cos(angle) * r;
        const y = cy + Math.sin(angle) * r;

        ctx.beginPath();
        ctx.arc(x, y, isResonating ? 3 : 1.5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
        ctx.shadowBlur = isResonating ? 16 : 4;
        ctx.shadowColor = '#ffffff';
        ctx.fill();
      }

      animationId = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animationId);
  }, [isResonating]);

  return (
    <div className="min-h-screen bg-black text-white flex flex-col items-center justify-between p-8 font-sans antialiased selection:bg-white selection:text-black">
      {/* Top Single-Line Header */}
      <header className="w-full max-w-4xl flex items-center justify-between text-xs font-mono tracking-widest text-neutral-500 border-b border-neutral-900 pb-6">
        <div>LOLADESK / OS</div>
        <div className="text-white font-semibold">MMA SALON</div>
        <div className="flex items-center space-x-2">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
          <span className="text-emerald-400">VOICE CORE ONLINE</span>
        </div>
      </header>

      {/* Main Center Stage: Lola Ultra Voice Assistant */}
      <main className="flex flex-col items-center justify-center my-auto cursor-pointer group" onClick={() => setIsResonating(!isResonating)}>
        <div className="relative mb-8">
          <div className="absolute -inset-8 rounded-full bg-white/5 blur-2xl opacity-40 group-hover:opacity-80 transition duration-700"></div>
          <canvas ref={canvasRef} width={280} height={280} className="relative z-10 block" />
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none z-20">
            <span className="text-sm font-mono tracking-[0.4em] text-white font-semibold">LOLA</span>
            <span className="text-[10px] font-mono text-neutral-400 mt-1 uppercase tracking-widest">
              {isResonating ? 'LISTENING & RESONATING' : 'STANDBY'}
            </span>
          </div>
        </div>

        <p className="text-xl font-light text-neutral-300 tracking-tight text-center max-w-md">
          "Tap to speak or execute actions for MMA Salon."
        </p>
      </main>

      {/* Bottom Minimalist Execution Command Bar */}
      <footer className="w-full max-w-2xl pb-4">
        <form onSubmit={(e) => { e.preventDefault(); setCommand(''); }} className="relative">
          <input
            type="text"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="Ask Lola to fill gaps, check calls, or rebook clients..."
            className="w-full bg-neutral-900/90 border border-neutral-800 rounded-2xl px-6 py-4 text-sm text-white placeholder-neutral-600 focus:outline-none focus:border-white transition-all shadow-2xl"
          />
          <button type="submit" className="absolute right-3 top-2.5 bg-white text-black text-xs font-semibold px-5 py-2 rounded-xl hover:bg-neutral-200 transition-all">
            Run
          </button>
        </form>
      </footer>
    </div>
  );
}
