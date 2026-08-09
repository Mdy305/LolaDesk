'use client';

import { useState } from 'react';

export default function SteveJobsSettings() {
  const [squareConnected, setSquareConnected] = useState(true);
  const [voiceActive, setVoiceActive] = useState(true);
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  return (
    <div className="max-w-2xl mx-auto py-12 px-6 font-sans text-white">
      {/* Brand Header */}
      <div className="space-y-1 mb-12 text-center">
        <h1 className="text-3xl font-light tracking-tight">Setup. Made Simple.</h1>
        <p className="text-neutral-500 text-sm">Lola handles the front desk. You handle the art.</p>
      </div>

      {/* Control Cards */}
      <div className="space-y-6">
        {/* Calendar Sync Card */}
        <div className="bg-neutral-900/40 border border-neutral-800 rounded-3xl p-6 flex items-center justify-between backdrop-blur-md">
          <div className="space-y-1">
            <h2 className="text-base font-medium">Square Booking Engine</h2>
            <p className="text-xs text-neutral-500">Automatic calendar & gap fill synchronization</p>
          </div>
          <button
            onClick={() => setSquareConnected(!squareConnected)}
            className={`px-5 py-2.5 rounded-full text-xs font-mono uppercase tracking-wider transition-all duration-300 ${
              squareConnected 
                ? 'bg-white text-black font-semibold shadow-lg' 
                : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'
            }`}
          >
            {squareConnected ? 'Connected' : 'Connect'}
          </button>
        </div>

        {/* AI Voice Operations Card */}
        <div className="bg-neutral-900/40 border border-neutral-800 rounded-3xl p-6 flex items-center justify-between backdrop-blur-md">
          <div className="space-y-1">
            <h2 className="text-base font-medium">Lola Voice Front Desk</h2>
            <p className="text-xs text-neutral-500">24/7 inbound phone coverage & automatic booking</p>
          </div>
          <button
            onClick={() => setVoiceActive(!voiceActive)}
            className={`px-5 py-2.5 rounded-full text-xs font-mono uppercase tracking-wider transition-all duration-300 ${
              voiceActive 
                ? 'bg-white text-black font-semibold shadow-lg' 
                : 'bg-neutral-800 text-neutral-400 hover:bg-neutral-700'
            }`}
          >
            {voiceActive ? 'Active' : 'Disabled'}
          </button>
        </div>

        {/* Action Button */}
        <div className="pt-6">
          <button
            onClick={handleSave}
            className="w-full bg-white text-black font-medium py-4 rounded-2xl hover:bg-neutral-200 transition-all duration-300 shadow-xl active:scale-[0.99]"
          >
            {saved ? 'Changes Saved ✓' : 'Save Setup'}
          </button>
        </div>
      </div>
    </div>
  );
}
