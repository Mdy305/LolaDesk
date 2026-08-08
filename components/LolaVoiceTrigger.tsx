'use client';

import { useLolaVoice } from '@/hooks/useLolaVoice';

export function LolaVoiceTrigger() {
  const { isActive, isSpeaking, toggleVoice } = useLolaVoice();

  return (
    <button
      onClick={toggleVoice}
      aria-label="Toggle Lola Voice AI"
      className={`relative flex h-12 w-12 items-center justify-center rounded-full font-bold text-black transition-all ${
        isActive
          ? 'bg-lime-400 shadow-[0_0_20px_rgba(163,230,53,0.8)] scale-110'
          : 'bg-lime-400 hover:bg-lime-300'
      }`}
    >
      <span className="text-xl font-black">L</span>
      {isActive && (
        <span
          className={`absolute inset-0 rounded-full bg-lime-400/50 ${
            isSpeaking ? 'animate-ping' : 'animate-pulse'
          }`}
        />
      )}
    </button>
  );
}
