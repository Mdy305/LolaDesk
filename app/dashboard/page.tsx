'use client';

import { useState, useEffect, useRef } from 'react';

export default function SteveJobsLolaDashboard() {
  const [isResonating, setIsResonating] = useState(true);
  const [query, setQuery] = useState('');
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Alive Resonant Lola Particle Sphere
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
      const baseRadius = 55;
      const count = 50;

      t += 0.03;

      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2 + t * 0.4;
        const wave = Math.sin(angle * 5 + t * 3) * (isResonating ? 12 : 3);
        const r = baseRadius + wave;

        const x = cx + Math.cos(angle) * r;
        const y = cy + Math.sin(angle) * r;

        ctx.beginPath();
        ctx.arc(x, y, isResonating ? 2.2 : 1.2, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
        ctx.shadowBlur = isResonating ? 14 : 3;
        ctx.shadowColor = '#ffffff';
        ctx.fill();
      }

      animationId = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animationId);
  }, [isResonating]);

  return (
    <div className="min-h-screen bg-black text-white flex font-sans antialiased selection:bg-white selection:text-black">
      {/* Sleek One-Line Sidebar */}
      <aside className="w-56 border-r border-neutral-900 p-6 flex flex-col justify-between h-screen bg-black">
        <div className="space-y-10">
          <div className="text-xs font-mono tracking-[0.3em] text-neutral-400">LOLADESK</div>
          <nav className="space-y-2">
            <a href="/dashboard" className="block px-4 py-3 rounded-2xl bg-white text-black font-semibold text-xs tracking-wider uppercase transition-all">
              Command
            </a>
            <a href="/dashboard/bookings" className="block px-4 py-3 rounded-2xl text-neutral-400 hover:text-white hover:bg-neutral-900/60 text-xs tracking-wider uppercase transition-all">
              Schedule
            </a>
            <a href="/dashboard/settings" className="block px-4 py-3 rounded-2xl text-neutral-400 hover:text-white hover:bg-neutral-900/60 text-xs tracking-wider uppercase transition-all">
              Revenue Engine
            </a>
          </nav>
        </div>

        <div className="text-[10px] font-mono text-neutral-600">
          MMA SALON · ONLINE
        </div>
      </aside>

      {/* Main Focus Command Area */}
      <main className="flex-1 flex flex-col items-center justify-between p-12 relative overflow-hidden">
        {/* Top Metric Bar - Ultra Clean */}
        <div className="w-full max-w-2xl flex justify-between items-center text-xs font-mono text-neutral-500 border-b border-neutral-900 pb-6">
          <div>TODAY: <span className="text-white font-medium">$2,840</span></div>
          <div>APPOINTMENTS: <span className="text-white font-medium">7</span></div>
          <div>GAP REVENUE: <span className="text-emerald-400 font-medium">+$420</span></div>
        </div>

        {/* Center Alive Lola Core */}
        <div className="flex flex-col items-center justify-center my-auto cursor-pointer" onClick={() => setIsResonating(!isResonating)}>
          <div className="relative mb-6">
            <canvas ref={canvasRef} width={200} height={200} className="block" />
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <span className="text-xs font-mono tracking-[0.3em] text-white">LOLA</span>
              <span className="text-[9px] font-mono text-emerald-400 mt-1 uppercase tracking-widest">
                {isResonating ? 'LISTENING' : 'READY'}
              </span>
            </div>
          </div>

          <h1 className="text-2xl font-light text-neutral-200 tracking-tight text-center max-w-sm">
            "All calls covered. Gap schedules optimized."
          </h1>
        </div>

        {/* Minimalist Command Input */}
        <div className="w-full max-w-xl">
          <form onSubmit={(e) => { e.preventDefault(); setQuery(''); }} className="relative">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Tell Lola what to do..."
              className="w-full bg-neutral-900/80 border border-neutral-800 rounded-2xl px-6 py-4 text-sm text-white placeholder-neutral-600 focus:outline-none focus:border-white transition-all shadow-2xl"
            />
            <button type="submit" className="absolute right-3 top-2.5 bg-white text-black text-xs font-semibold px-4 py-2 rounded-xl hover:bg-neutral-200 transition-all">
              Execute
            </button>
          </form>
        </div>
      </main>
    </div>
  );
}
