'use client';

import { useState, useEffect, useRef } from 'react';

export default function LolaJarvisOnboarding() {
  const [step, setStep] = useState(1);
  const [salonName, setSalonName] = useState('');
  const [selectedIntegration, setSelectedIntegration] = useState('square');
  const [isSpeaking, setIsSpeaking] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationId: number;
    let width = (canvas.width = window.innerWidth);
    let height = (canvas.height = window.innerHeight);

    const handleResize = () => {
      if (!canvas) return;
      width = canvas.width = window.innerWidth;
      height = canvas.height = window.innerHeight;
    };
    window.addEventListener('resize', handleResize);

    const particleCount = 280;
    const particles = Array.from({ length: particleCount }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * 0.8,
      vy: (Math.random() - 0.5) * 0.8,
      size: Math.random() * 2 + 0.8,
      alpha: Math.random() * 0.7 + 0.3,
      targetRadius: 75 + Math.random() * 15,
      angle: Math.random() * Math.PI * 2,
    }));

    let t = 0;

    const render = () => {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
      ctx.fillRect(0, 0, width, height);

      const cx = width / 2;
      const cy = height / 2 - 60;
      t += 0.03;

      particles.forEach((p, index) => {
        if (isSpeaking) {
          // Converge from anywhere on screen into the central resonant circle
          p.angle += 0.02;
          const wave = Math.sin(p.angle * 6 + t * 4) * 16;
          const r = p.targetRadius + wave;

          const targetX = cx + Math.cos(p.angle) * r;
          const targetY = cy + Math.sin(p.angle) * r;

          p.x += (targetX - p.x) * 0.08;
          p.y += (targetY - p.y) * 0.08;
        } else {
          // Ambient ambient drift across full screen
          p.x += p.vx;
          p.y += p.vy;

          if (p.x < 0) p.x = width;
          if (p.x > width) p.x = 0;
          if (p.y < 0) p.y = height;
          if (p.y > height) p.y = 0;
        }

        ctx.beginPath();
        ctx.arc(p.x, p.y, isSpeaking ? p.size * 1.3 : p.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${p.alpha})`;
        ctx.shadowBlur = isSpeaking ? 12 : 3;
        ctx.shadowColor = '#ffffff';
        ctx.fill();
      });

      animationId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animationId);
      window.removeEventListener('resize', handleResize);
    };
  }, [isSpeaking]);

  return (
    <main className="relative min-h-screen bg-black text-white flex flex-col items-center justify-center p-6 selection:bg-white selection:text-black antialiased font-sans overflow-hidden">
      {/* Full-Screen Resonant Particle Canvas */}
      <canvas
        ref={canvasRef}
        onClick={() => setIsSpeaking(!isSpeaking)}
        className="fixed inset-0 z-0 cursor-pointer"
      />

      {/* Header Overlay */}
      <div className="absolute top-8 left-8 text-xs tracking-[0.3em] text-neutral-500 font-mono z-10 pointer-events-none">
        LOLADESK / JARVIS CORE ACTIVE
      </div>

      {/* Center Voice Orb Indicator */}
      <div 
        onClick={() => setIsSpeaking(!isSpeaking)}
        className="relative z-10 mb-12 cursor-pointer flex flex-col items-center justify-center group"
      >
        <div className="w-24 h-24 rounded-full flex flex-col items-center justify-center border border-white/20 backdrop-blur-md bg-white/5 transition-transform duration-500 group-hover:scale-110">
          <span className="text-xs font-mono tracking-[0.3em] text-white">LOLA</span>
          <span className="text-[9px] font-mono text-neutral-400 mt-1 uppercase tracking-widest">
            {isSpeaking ? 'RESONATING' : 'DRIFTING'}
          </span>
        </div>
      </div>

      {/* Steve Jobs Onboarding Wizard */}
      <div className="relative z-10 w-full max-w-sm space-y-8 backdrop-blur-xl bg-black/40 border border-white/10 p-8 rounded-3xl shadow-2xl">
        {step === 1 && (
          <div className="space-y-6 text-center">
            <h1 className="text-xl font-light tracking-tight text-white/90">
              What is the name of your salon?
            </h1>
            <input
              type="text"
              autoFocus
              placeholder="e.g. Maison Mi Amore"
              value={salonName}
              onChange={(e) => setSalonName(e.target.value)}
              className="w-full bg-neutral-900/90 border border-neutral-800 rounded-2xl px-5 py-4 text-center text-lg text-white placeholder-neutral-600 focus:outline-none focus:border-white transition-all duration-300"
            />
            <button
              onClick={() => setStep(2)}
              disabled={!salonName.trim()}
              className="w-full bg-white text-black font-medium py-4 rounded-2xl disabled:opacity-20 hover:bg-neutral-200 transition-all duration-300"
            >
              Continue
            </button>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-6 text-center">
            <h1 className="text-xl font-light tracking-tight text-white/90">
              Select your booking platform.
            </h1>
            <div className="grid grid-cols-2 gap-3">
              {['square', 'vagaro', 'shopify', 'custom'].map((item) => (
                <button
                  key={item}
                  onClick={() => setSelectedIntegration(item)}
                  className={`p-4 rounded-2xl border text-xs font-mono uppercase tracking-wider transition-all duration-300 ${
                    selectedIntegration === item
                      ? 'border-white bg-white text-black font-semibold'
                      : 'border-neutral-800 text-neutral-400 bg-neutral-900/50 hover:border-neutral-700'
                  }`}
                >
                  {item}
                </button>
              ))}
            </div>
            <button
              onClick={() => setStep(3)}
              className="w-full bg-white text-black font-medium py-4 rounded-2xl hover:bg-neutral-200 transition-all duration-300"
            >
              Provision Lola
            </button>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-6 text-center">
            <h1 className="text-xl font-light tracking-tight text-white/90">
              {salonName} is active.
            </h1>
            <p className="text-neutral-400 text-xs font-mono">
              JARVIS-LEVEL VOICE ENGINE ONLINE
            </p>
            <a
              href="/login"
              className="block w-full bg-white text-black font-medium py-4 rounded-2xl hover:bg-neutral-200 transition-all duration-300 text-center"
            >
              Enter Front Desk
            </a>
          </div>
        )}
      </div>
    </main>
  );
}
