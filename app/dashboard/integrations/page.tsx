'use client';

import { useState } from 'react';

export default function TenantIntegrationsPage() {
  const [squareConnected, setSquareConnected] = useState(false);
  const [elevenLabsVoiceId, setElevenLabsVoiceId] = useState('21m00Tcm4TlvDq8ikWAM');
  const [isSaved, setIsSaved] = useState(false);

  const saveSettings = () => {
    setIsSaved(true);
    setTimeout(() => setIsSaved(false), 3000);
  };

  return (
    <div className="max-w-4xl mx-auto p-8 space-y-10 text-white font-sans">
      <div>
        <h1 className="text-3xl font-light tracking-tight">Integrations & Onboarding</h1>
        <p className="text-neutral-400 text-sm mt-1">Manage your multi-tenant calendar sync and voice configuration.</p>
      </div>

      {/* Calendar Platforms */}
      <div className="bg-neutral-900/60 border border-neutral-800 rounded-3xl p-6 space-y-6 backdrop-blur-xl">
        <h2 className="text-lg font-medium">Calendar Engine Integration</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="p-5 border border-neutral-800 rounded-2xl bg-black/40 flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-sm">Square Appointments</h3>
              <p className="text-xs text-neutral-500 mt-0.5">Real-time webhook sync & gap scheduling</p>
            </div>
            <button
              onClick={() => setSquareConnected(!squareConnected)}
              className={`px-4 py-2 rounded-xl text-xs font-mono uppercase tracking-wider transition-all ${
                squareConnected ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30' : 'bg-white text-black font-semibold'
              }`}
            >
              {squareConnected ? 'Connected' : 'Connect'}
            </button>
          </div>

          <div className="p-5 border border-neutral-800 rounded-2xl bg-black/40 flex items-center justify-between opacity-50">
            <div>
              <h3 className="font-semibold text-sm">Vagaro</h3>
              <p className="text-xs text-neutral-500 mt-0.5">Automated booking synchronization</p>
            </div>
            <span className="text-[10px] font-mono text-neutral-500 border border-neutral-800 px-2 py-1 rounded-lg">SOON</span>
          </div>
        </div>
      </div>

      {/* ElevenLabs Custom Voice Configuration */}
      <div className="bg-neutral-900/60 border border-neutral-800 rounded-3xl p-6 space-y-6 backdrop-blur-xl">
        <h2 className="text-lg font-medium">Lola Tenant Voice Engine</h2>
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-mono text-neutral-400 uppercase tracking-wider mb-2">
              ElevenLabs Voice ID
            </label>
            <input
              type="text"
              value={elevenLabsVoiceId}
              onChange={(e) => setElevenLabsVoiceId(e.target.value)}
              className="w-full bg-black/60 border border-neutral-800 rounded-2xl px-5 py-3 text-sm text-white focus:outline-none focus:border-white transition-all"
            />
          </div>
          <button
            onClick={saveSettings}
            className="bg-white text-black text-sm font-medium px-6 py-3 rounded-2xl hover:bg-neutral-200 transition-all"
          >
            {isSaved ? 'Voice ID Updated ✓' : 'Save Voice Configuration'}
          </button>
        </div>
      </div>
    </div>
  );
}
