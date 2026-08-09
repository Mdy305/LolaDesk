'use client';

import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { 
  Users, 
  PhoneCall, 
  Inbox, 
  Calendar, 
  TrendingUp, 
  Users2, 
  Smartphone, 
  Zap, 
  Search 
} from 'lucide-react';

export default function MinimalVoiceDashboard() {
  const [isListening, setIsListening] = useState(true);
  const [audioLevel, setAudioLevel] = useState(1);

  // Simulates dynamic voice input audio levels for the animation
  useEffect(() => {
    const interval = setInterval(() => {
      setAudioLevel(Math.random() * 0.6 + 0.8);
    }, 150);
    return () => clearInterval(interval);
  }, []);

  const navItems = [
    { name: 'Clients', icon: Users, href: '/clients' },
    { name: 'Calls', icon: PhoneCall, href: '/calls' },
    { name: 'Inbox', icon: Inbox, href: '/inbox' },
    { name: 'Calendar', icon: Calendar, href: '/calendar' },
    { name: 'Revenue', icon: TrendingUp, href: '/revenue' },
    { name: 'Team', icon: Users2, href: '/team' },
    { name: 'Lola Line', icon: Smartphone, href: '/lola-line' },
    { name: 'Growth Studio', icon: Zap, href: '/growth-studio' },
  ];

  return (
    <div className="flex h-screen w-screen bg-black text-white font-sans overflow-hidden">
      
      {/* 1. LEFT NAVIGATION SIDEBAR */}
      <aside className="w-64 border-r border-zinc-800/60 bg-zinc-950/50 flex flex-col justify-between p-4 z-20">
        <div className="space-y-6">
          {/* Brand Header */}
          <div className="flex items-center justify-between px-2 py-1">
            <span className="font-bold tracking-wider text-sm text-zinc-200 uppercase">LolaDesk</span>
            <span className="text-xs text-emerald-400 bg-emerald-950/60 border border-emerald-800/40 px-2 py-0.5 rounded-full">Active</span>
          </div>

          {/* Single Column Menu */}
          <nav className="space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <a
                  key={item.name}
                  href={item.href}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-zinc-400 hover:text-white hover:bg-zinc-900 transition-colors duration-150"
                >
                  <Icon className="w-4 h-4 text-zinc-400" />
                  <span>{item.name}</span>
                </a>
              );
            })}
          </nav>
        </div>

        {/* Command Search Bar Trigger */}
        <div className="pt-4 border-t border-zinc-900">
          <button className="w-full flex items-center justify-between px-3 py-2 bg-zinc-900/80 hover:bg-zinc-900 text-zinc-400 text-xs rounded-lg border border-zinc-800/80 transition-colors">
            <span className="flex items-center gap-2">
              <Search className="w-3.5 h-3.5" />
              Search or command...
            </span>
            <kbd className="bg-zinc-800 text-zinc-300 px-1.5 py-0.5 rounded text-[10px]">⌘K</kbd>
          </button>
        </div>
      </aside>

      {/* RIGHT MAIN VIEW (TOP NOTIFICATION + BLACK SCREEN VOICE INTERFACE) */}
      <main className="flex-1 flex flex-col h-full relative">
        
        {/* 2. TOP SINGLE-LINE NOTIFICATION BAR */}
        <header className="h-12 border-b border-zinc-900 bg-zinc-950/80 px-6 flex items-center justify-between z-10">
          <div className="flex items-center gap-3 overflow-hidden text-xs text-zinc-300">
            <span className="flex h-2 w-2 relative flex-shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
            </span>
            <p className="truncate font-medium">
              3 VIP clients haven't rebooked • $420 revenue at risk
            </p>
          </div>
          <button className="text-xs text-zinc-400 hover:text-white underline ml-4 flex-shrink-0">
            Fix issue
          </button>
        </header>

        {/* 3. FULL-SCREEN INTERACTIVE LOLA VOICE ANIMATION */}
        <section className="flex-1 flex flex-col items-center justify-center relative bg-black">
          
          {/* Ambient Glow Aura */}
          <motion.div
            animate={{
              scale: isListening ? [1 * audioLevel, 1.25 * audioLevel, 1 * audioLevel] : 1,
              opacity: isListening ? [0.25, 0.4, 0.25] : 0.1,
            }}
            transition={{ repeat: Infinity, duration: 2, ease: "easeInOut" }}
            className="absolute w-96 h-96 rounded-full bg-gradient-to-tr from-indigo-600/30 via-purple-500/20 to-emerald-500/30 blur-3xl"
          />

          {/* Interactive Voice Sphere */}
          <div 
            onClick={() => setIsListening(!isListening)}
            className="relative cursor-pointer flex items-center justify-center"
          >
            {/* Outer Resonating Ring */}
            <motion.div
              animate={{
                scale: isListening ? [1, 1.15 * audioLevel, 1] : 1,
                rotate: 360,
              }}
              transition={{
                scale: { repeat: Infinity, duration: 1.5, ease: "easeInOut" },
                rotate: { repeat: Infinity, duration: 12, ease: "linear" }
              }}
              className="w-56 h-56 rounded-full border border-zinc-700/50 bg-gradient-to-tr from-zinc-900/60 to-zinc-950/80 backdrop-blur-md flex items-center justify-center shadow-2xl shadow-indigo-950/30"
            >
              {/* Inner Core Animation */}
              <motion.div
                animate={{
                  scale: isListening ? [0.9 * audioLevel, 1.1 * audioLevel, 0.9 * audioLevel] : 0.9,
                }}
                transition={{ repeat: Infinity, duration: 1.2, ease: "easeInOut" }}
                className="w-40 h-40 rounded-full bg-gradient-to-br from-indigo-500 via-purple-500 to-emerald-400 opacity-90 blur-sm flex items-center justify-center"
              />
            </motion.div>
          </div>

          {/* Voice State Text */}
          <div className="mt-12 text-center space-y-2 z-10">
            <p className="text-zinc-400 text-xs tracking-widest uppercase font-mono">
              {isListening ? 'Lola is listening...' : 'Tap orb to start'}
            </p>
            <h2 className="text-lg font-light text-zinc-200">
              "How can I help you manage MMA Salon today?"
            </h2>
          </div>
        </section>
      </main>
    </div>
  );
}
