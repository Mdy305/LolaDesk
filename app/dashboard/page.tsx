'use client';

import { useState, useEffect, useRef } from 'react';

export default function LolaJarvisDashboard() {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [status, setStatus] = useState('VOICE CORE STANDBY');
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);

  // Initialize Microphone & Web Audio API Visualizer
  const startVoiceCapture = async () => {
    try {
      if (!isListening) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        const analyser = audioCtx.createAnalyser();
        const source = audioCtx.createMediaStreamSource(stream);
        
        analyser.fftSize = 64;
        source.connect(analyser);
        
        audioCtxRef.current = audioCtx;
        analyserRef.current = analyser;
        setIsListening(true);
        setStatus('LOLA LISTENING & RESONATING');
      } else {
        if (audioCtxRef.current) audioCtxRef.current.close();
        setIsListening(false);
        setStatus('VOICE CORE STANDBY');
      }
    } catch (err) {
      console.error('Microphone access error:', err);
      setIsListening(!isListening);
      setStatus(isListening ? 'VOICE CORE STANDBY' : 'RESONATING');
    }
  };

  // Canvas Resonant Particle Renderer
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationId: number;
    let t = 0;
    const dataArray = new Uint8Array(32);

    const render = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      const baseRadius = 85;
      const particleCount = 90;

      t += 0.035;

      let audioFrequency = 0;
      if (analyserRef.current && isListening) {
        analyserRef.current.getByteFrequencyData(dataArray);
        audioFrequency = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
      }

      for (let i = 0; i < particleCount; i++) {
        const angle = (i / particleCount) * Math.PI * 2 + t * 0.4;
        // Dynamic resonance amplification based on real-time audio input
        const audioBoost = (audioFrequency / 255) * 35;
        const wave = Math.sin(angle * 7 + t * 4) * (isListening ? 14 + audioBoost : 3);
        const r = baseRadius + wave;

        const x = cx + Math.cos(angle) * r;
        const y = cy + Math.sin(angle) * r;

        ctx.beginPath();
        ctx.arc(x, y, isListening ? 3.2 : 1.5, 0, Math.PI * 2);
        ctx.fillStyle = isListening ? 'rgba(255, 255, 255, 0.98)' : 'rgba(255, 255, 255, 0.4)';
        ctx.shadowBlur = isListening ? 18 : 4;
        ctx.shadowColor = '#ffffff';
        ctx.fill();
      }

      animationId = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animationId);
  }, [isListening]);

  return (
    <div className="min-h-screen bg-black text-white flex flex-col items-center justify-between p-8 font-sans antialiased selection:bg-white selection:text-black">
      {/* Top Header Bar */}
      <header className="w-full max-w-5xl flex items-center justify-between text-xs font-mono tracking-widest text-neutral-500 border-b border-neutral-900 pb-6">
        <div>LOLADESK / OS</div>
        <div className="text-white font-semibold">MMA SALON</div>
        <div className="flex items-center space-x-2">
          <span className={`w-2 h-2 rounded-full ${isListening ? 'bg-emerald-400 animate-pulse' : 'bg-neutral-600'}`}></span>
          <span className={isListening ? 'text-emerald-400' : 'text-neutral-500'}>{status}</span>
        </div>
      </header>

      {/* Main Stage: Jarvis-Level Lola Particle Core */}
      <main className="flex flex-col items-center justify-center my-auto cursor-pointer group" onClick={startVoiceCapture}>
        <div className="relative mb-8">
          <div className="absolute -inset-10 rounded-full bg-white/5 blur-3xl opacity-40 group-hover:opacity-90 transition duration-700"></div>
          <canvas ref={canvasRef} width={320} height={320} className="relative z-10 block" />
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none z-20">
            <span className="text-lg font-mono tracking-[0.4em] text-white font-semibold">LOLA</span>
            <span className="text-[9px] font-mono text-neutral-400 mt-1 uppercase tracking-widest">
              {isListening ? 'TAP TO STOP' : 'TAP TO TALK'}
            </span>
          </div>
        </div>

        <p className="text-xl font-light text-neutral-300 tracking-tight text-center max-w-md">
          {isListening ? '"Lola is listening to your command..."' : '"Tap Lola to speak or direct MMA Salon."' }
        </p>
      </main>

      {/* Bottom Command Bar */}
      <footer className="w-full max-w-2xl pb-4">
        <form onSubmit={(e) => { e.preventDefault(); setTranscript(''); }} className="relative">
          <input
            type="text"
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            placeholder="Direct Lola to fill gaps, check phone calls, or rebook clients..."
            className="w-full bg-neutral-900/90 border border-neutral-800 rounded-2xl px-6 py-4 text-sm text-white placeholder-neutral-600 focus:outline-none focus:border-white transition-all shadow-2xl"
          />
          <button type="submit" className="absolute right-3 top-2.5 bg-white text-black text-xs font-semibold px-5 py-2 rounded-xl hover:bg-neutral-200 transition-all">
            Execute
          </button>
        </form>
      </footer>
    </div>
  );
}
