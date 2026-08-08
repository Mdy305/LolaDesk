/* ═══════════════════════════════════════════════════════════════
   LolaWakeBurst — the moment Lola comes alive.
   ════════════════════════════════════════════════════════════════
   On wake (voice wake-word or tap), a field of micro-particles
   rushes in from all around the screen and converges on the orb,
   forming a bright resonant ring right as she wakes — then settles
   back into her normal ambient particle field.

   API:
     LolaWakeBurst.trigger(targetEl)   // targetEl = element to converge on

   Respects prefers-reduced-motion: does a quick, calm flash instead
   of the full particle sweep.
   ═══════════════════════════════════════════════════════════════ */
(function(global){
  'use strict';

  const REDUCED = typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const PALETTE = [
    [204,255,0], [222,255,92], [140,255,190], [255,255,255]
  ];

  let canvas = null, ctx = null, raf = 0, particles = [], running = false, dpr = 1;

  function ensureCanvas(){
    if(canvas) return canvas;
    canvas = document.createElement('canvas');
    canvas.id = 'lolaWakeBurstCanvas';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:9999;opacity:0;transition:opacity .25s';
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d');
    resize();
    window.addEventListener('resize', resize, { passive:true });
    return canvas;
  }

  function resize(){
    if(!canvas) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    ctx.setTransform(dpr,0,0,dpr,0,0);
  }

  function rgba(c,a){ return `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0,Math.min(1,a))})`; }
  function easeOutCubic(t){ return 1 - Math.pow(1-t, 3); }
  function easeInCubic(t){ return t*t*t; }

  function spawnParticles(cx, cy){
    const W = window.innerWidth, H = window.innerHeight;
    const count = Math.round(Math.min(140, Math.max(60, (W*H)/9000)));
    particles = [];
    for(let i=0;i<count;i++){
      // spawn around the screen edges / far field, biased outward
      const angle = Math.random()*Math.PI*2;
      const edgeDist = Math.max(W,H) * (0.55 + Math.random()*0.55);
      const sx = cx + Math.cos(angle)*edgeDist;
      const sy = cy + Math.sin(angle)*edgeDist*0.72;
      // slight arc via a perpendicular bow offset so paths feel organic, not robotic
      const bow = (Math.random()-0.5) * edgeDist * 0.28;
      particles.push({
        sx, sy, cx, cy, bow,
        delay: Math.random()*0.30,
        dur: 0.62 + Math.random()*0.30,
        size: 1.1 + Math.random()*2.2,
        color: PALETTE[(Math.random()*PALETTE.length)|0],
        seed: Math.random()*Math.PI*2
      });
    }
  }

  function trigger(targetEl){
    ensureCanvas();
    const rect = targetEl && targetEl.getBoundingClientRect
      ? targetEl.getBoundingClientRect()
      : { left: window.innerWidth/2, top: window.innerHeight/2, width:0, height:0 };
    const cx = rect.left + rect.width/2;
    const cy = rect.top + rect.height/2;

    if(REDUCED){
      canvas.style.opacity = '1';
      ctx.clearRect(0,0,canvas.width,canvas.height);
      const g = ctx.createRadialGradient(cx,cy,0,cx,cy,140);
      g.addColorStop(0, 'rgba(204,255,0,.35)');
      g.addColorStop(1, 'rgba(204,255,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0,0,window.innerWidth,window.innerHeight);
      setTimeout(()=>{ canvas.style.opacity = '0'; }, 260);
      return;
    }

    spawnParticles(cx, cy);
    canvas.style.opacity = '1';
    running = true;
    const start = performance.now();
    const totalDur = Math.max(...particles.map(p=>p.delay+p.dur)) + 0.18; // + merge flash tail

    cancelAnimationFrame(raf);
    function frame(now){
      const t = (now - start) / 1000;
      ctx.clearRect(0,0,window.innerWidth,window.innerHeight);
      ctx.globalCompositeOperation = 'lighter';

      let arrived = 0;
      for(const p of particles){
        const local = (t - p.delay) / p.dur;
        if(local <= 0) continue;
        if(local >= 1){ arrived++; continue; }
        const e = easeInCubic(Math.min(1,local*0.55)) * 0 + easeOutCubic(local); // converge fast, ease into landing
        // quadratic bezier via the bow offset for an organic curved pull
        const mx = (p.sx+p.cx)/2 - p.bow * Math.sin(p.seed);
        const my = (p.sy+p.cy)/2 + p.bow * Math.cos(p.seed);
        const x = (1-e)*(1-e)*p.sx + 2*(1-e)*e*mx + e*e*p.cx;
        const y = (1-e)*(1-e)*p.sy + 2*(1-e)*e*my + e*e*p.cy;
        const alpha = local < 0.85 ? 0.85 : 0.85*(1-(local-0.85)/0.15);
        const sz = p.size * (0.6 + e*0.9);
        ctx.fillStyle = rgba(p.color, alpha);
        ctx.beginPath(); ctx.arc(x,y,sz,0,7); ctx.fill();
        // faint trailing streak toward the core
        ctx.strokeStyle = rgba(p.color, alpha*0.25);
        ctx.lineWidth = sz*0.6;
        ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(x+(p.cx-x)*0.14, y+(p.cy-y)*0.14); ctx.stroke();
      }

      // merge flash once most particles have landed
      const landedRatio = arrived / particles.length;
      if(landedRatio > 0.5){
        const flashT = Math.min(1, (landedRatio-0.5)/0.5);
        const r = 60 + flashT*90;
        const g = ctx.createRadialGradient(cx,cy,0,cx,cy,r);
        g.addColorStop(0, rgba([255,255,255], 0.5*(1-flashT)));
        g.addColorStop(0.4, rgba(PALETTE[0], 0.32*(1-flashT)));
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(cx,cy,r,0,7); ctx.fill();
      }

      if(t < totalDur && running){
        raf = requestAnimationFrame(frame);
      }else{
        running = false;
        canvas.style.opacity = '0';
        setTimeout(()=>{ if(ctx) ctx.clearRect(0,0,window.innerWidth,window.innerHeight); }, 260);
      }
    }
    raf = requestAnimationFrame(frame);
  }

  global.LolaWakeBurst = { trigger };
})(window);
