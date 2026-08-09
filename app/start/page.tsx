'use client';

import { useState, useEffect, useRef } from 'react';

export default function SteveJobsOnboarding() {
  const [step, setStep] = useState(1);
  const [salonName, setSalonName] = useState('');
  const [bookingSystem, setBookingSystem] = useState('square');
  const [isListening, setIsListening] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Resonant Lola particle circle animation
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;
    let angle = 0;

    const render = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const centerX = canvas.width / 2;
      const centerY = canvas.height / 2;
      const radius = 70;
      const particleCount = 40;

      angle += 0.02;

      for (let i = 0; i < particleCount; i++) {
        const particleAngle = (i / particleCount) * Math.PI * 2 + angle;
        // Resonant wave perturbation on audio interaction
        const wave = Math.sin(particleAngle * 5 + angle * 2) * (isListening ? 12 : 4);
        const currentRadius = radius + wave;

        const x = centerX + Math.cos(particleAngle) * currentRadius;
        const y = centerY + Math.sin(particleAngle) * currentRadius;

        ctx.beginPath();
        ctx.arc(x, y, isListening ? 3 : 2, 0, Math.PI * 2);
        ctx.fillStyle = isListening ? 'rgba(255, 255, 255, 0.95)' : 'rgba(255, 255, 255, 0.4)';
        ctx.shadowBlur = isListening ? 15 : 5;
        ctx.shadowColor = '#ffffff';
        ctx.fill();
      }

      animationFrameId = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animationFrameId);
  }, [isListening]);

  return (
    <main className="min-h-screen bg-black text-white flex flex-col items-center justify-center p-6 font-sans antialiased">
      {/* Dynamic Particle Sphere */}
      <div 
        className="relative mb-8 cursor-pointer transition-transform duration-300 hover:scale-105"
        onClick={() => setIsListening(!isListening)}
      >
        <canvas ref={canvasRef} width={220} height={220} className="block" />
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="text-xs tracking-widest text-neutral-400 font-medium">LOLA</span>
          <span className="text-[10px] text-neutral-600 mt-1">{isListening ? 'LISTENING' : 'TAP TO VOICE'}</span>
        </div>
      </div>

      {/* Steve Jobs Style Wizard */}
      <div className="w-full max-w-md space-y-8 transition-all duration-500 ease-out">
        {step === 1 && (
          <div className="space-y-6 text-center">
            <h1 className="text-3xl font-semibold tracking-tight">One simple step for your salon.</h1>
            <p className="text-neutral-400 text-sm">What is the name of your studio or business?</p>
            <input
              type="text"
              placeholder="e.g. Maison Mi Amore"
              value={salonName}
              onChange={(e) => setSalonName(e.target.value)}
              className="w-full bg-neutral-900 border border-neutral-800 rounded-2xl px-5 py-4 text-center text-lg focus:outline-none focus:border-white transition-colors"
            />
            <button
              onClick={() => setStep(2)}
              disabled={!salonName.trim()}
              className="w-full bg-white text-black font-medium py-4 rounded-2xl disabled:opacity-30 hover:bg-neutral-200 transition-all"
            >
              Continue →
            </button>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-6 text-center">
            <h1 className="text-3xl font-semibold tracking-tight">Connect your calendar.</h1>
            <p className="text-neutral-400 text-sm">Select your current booking platform for automatic sync.</p>
            <div className="grid grid-cols-2 gap-3">
              {['square', 'vagaro', 'shopify', 'custom'].map((platform) => (
                <button
                  key={platform}
                  onClick={() => setBookingSystem(platform)}
                  className={`p-4 rounded-2xl border text-sm font-medium capitalize transition-all ${
                    bookingSystem === platform
                      ? 'border-white bg-neutral-900 text-white'
                      : 'border-neutral-800 text-neutral-500 hover:border-neutral-700'
                  }`}
                >
                  {platform}
                </button>
              ))}
            </div>
            <button
              onClick={() => setStep(3)}
              className="w-full bg-white text-black font-medium py-4 rounded-2xl hover:bg-neutral-200 transition-all"
            >
              Initialize LolaDesk →
            </button>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-6 text-center">
            <h1 className="text-3xl font-semibold tracking-tight">Lola is ready.</h1>
            <p className="text-neutral-400 text-sm">Your multi-tenant workspace for {salonName || 'your salon'} has been provisioned.</p>
            <a
              href="/login"
              className="block w-full bg-white text-black font-medium py-4 rounded-2xl hover:bg-neutral-200 transition-all"
            >
              Enter Workspace
            </a>
          </div>
        )}
      </div>
    </main>
  );
}
