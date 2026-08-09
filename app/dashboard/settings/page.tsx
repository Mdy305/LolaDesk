'use client';

import { useState } from 'react';

export default function SteveJobsRevenueControl() {
  const [gapFillActive, setGapFillActive] = useState(true);
  const [voiceDeskActive, setVoiceDeskActive] = useState(true);
  const [autoRebookActive, setAutoRebookActive] = useState(true);
  const [isSaved, setIsSaved] = useState(false);

  const handleSave = () => {
    setIsSaved(true);
    setTimeout(() => setIsSaved(false), 2500);
  };

  return (
    <main className="max-w-3xl mx-auto py-12 px-6 font-sans text-white selection:bg-white selection:text-black">
      {/* Top Value Header */}
      <div className="space-y-2 mb-12 text-center">
        <h1 className="text-3xl font-light tracking-tight">Revenue Control</h1>
        <p className="text-neutral-500 text-sm max-w-md mx-auto">
          Lola automates your front desk, recovers missed calls, and monetizes calendar downtime.
        </p>
      </div>

      {/* Main Revenue Toggles */}
      <div className="space-y-4">
        {/* Gap Scheduling Engine */}
        <div className="bg-neutral-900/50 border border-neutral-800 rounded-3xl p-6 flex items-center justify-between backdrop-blur-xl transition-all duration-300 hover:border-neutral-700">
          <div className="space-y-1">
            <div className="flex items-center space-x-2">
              <h2 className="text-base font-medium">Automatic Processing Gap-Fill</h2>
              <span className="text-[10px] font-mono bg-emerald-500/10 text-emerald-400 px-2 py-0.5 rounded-full border border-emerald-500/20">
                +$1,800/mo
              </span>
            </div>
            <p className="text-xs text-neutral-500">
              Detects chemical processing downtime and books secondary haircut/blowout clients.
            </p>
          </div>
          <button
            onClick={() => setGapFillActive(!gapFillActive)}
            className={`px-5 py-2.5 rounded-full text-xs font-mono uppercase tracking-wider transition-all duration-300 ${
              gapFillActive
                ? 'bg-white text-black font-semibold shadow-lg scale-105'
                : 'bg-neutral-800 text-neutral-500 hover:bg-neutral-700'
            }`}
          >
            {gapFillActive ? 'Active' : 'Paused'}
          </button>
        </div>

        {/* 24/7 Voice Front Desk */}
        <div className="bg-neutral-900/50 border border-neutral-800 rounded-3xl p-6 flex items-center justify-between backdrop-blur-xl transition-all duration-300 hover:border-neutral-700">
          <div className="space-y-1">
            <div className="flex items-center space-x-2">
              <h2 className="text-base font-medium">24/7 Smart Phone Front Desk</h2>
              <span className="text-[10px] font-mono bg-emerald-500/10 text-emerald-400 px-2 py-0.5 rounded-full border border-emerald-500/20">
                Zero Missed Calls
              </span>
            </div>
            <p className="text-xs text-neutral-500">
              Lola answers inbound phone calls, checks real-time availability, and completes bookings.
            </p>
          </div>
          <button
            onClick={() => setVoiceDeskActive(!voiceDeskActive)}
            className={`px-5 py-2.5 rounded-full text-xs font-mono uppercase tracking-wider transition-all duration-300 ${
              voiceDeskActive
                ? 'bg-white text-black font-semibold shadow-lg scale-105'
                : 'bg-neutral-800 text-neutral-500 hover:bg-neutral-700'
            }`}
          >
            {voiceDeskActive ? 'Active' : 'Paused'}
          </button>
        </div>

        {/* Client Rebooking Engine */}
        <div className="bg-neutral-900/50 border border-neutral-800 rounded-3xl p-6 flex items-center justify-between backdrop-blur-xl transition-all duration-300 hover:border-neutral-700">
          <div className="space-y-1">
            <div className="flex items-center space-x-2">
              <h2 className="text-base font-medium">Lapse Recovery & VIP Rebooking</h2>
              <span className="text-[10px] font-mono bg-emerald-500/10 text-emerald-400 px-2 py-0.5 rounded-full border border-emerald-500/20">
                Retention Engine
              </span>
            </div>
            <p className="text-xs text-neutral-500">
              Automatically texts clients due for color touchups at 6 weeks before they drop off.
            </p>
          </div>
          <button
            onClick={() => setAutoRebookActive(!autoRebookActive)}
            className={`px-5 py-2.5 rounded-full text-xs font-mono uppercase tracking-wider transition-all duration-300 ${
              autoRebookActive
                ? 'bg-white text-black font-semibold shadow-lg scale-105'
                : 'bg-neutral-800 text-neutral-500 hover:bg-neutral-700'
            }`}
          >
            {autoRebookActive ? 'Active' : 'Paused'}
          </button>
        </div>
      </div>

      {/* Primary Execution CTA */}
      <div className="mt-10">
        <button
          onClick={handleSave}
          className="w-full bg-white text-black font-medium py-4 rounded-2xl hover:bg-neutral-200 transition-all duration-300 shadow-2xl active:scale-[0.99]"
        >
          {isSaved ? 'Revenue Rules Applied ✓' : 'Save & Activate Automation'}
        </button>
      </div>
    </main>
  );
}
