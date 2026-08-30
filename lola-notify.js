/* ═══════════════════════════════════════════════════════════════
   LolaNotify — ONE floating live notification for the whole app.
   ════════════════════════════════════════════════════════════════
   A luxury front-desk OS shows ONE thing at a time, elegantly.
   Every toast in the product (voice wake, live bookings/calls/
   messages, errors) routes through this single glass notification —
   queued, never stacked, never overlapping. It is Lola speaking to
   the owner while they work.

   Design:
     · One floating glass pill, top-center, below the topbar
     · Hairline lime border, soft glow, SF Pro display type
     · Icon + "LOLA · LIVE" eyebrow + title + sub + time
     · A thin progress bar counts down the auto-dismiss
     · Tones: booking ▣ · call ⌕ · message ✉ · lead ＋ · error ▲ ·
              plain ✦
     · Queue: if one is showing, the next waits its turn
     · sticky: true keeps it until dismissed (tap to dismiss)
     · Respects prefers-reduced-motion

   API:
     LolaNotify.show({ icon, title, sub, tone, sticky, duration })
     LolaNotify.clear()
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  if (global.LolaNotify) return;

  const REDUCED = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const TONES = {
    booking:  { icon: '▣', color: '#ccff00' },
    call:     { icon: '⌕', color: '#8affc4' },
    message:  { icon: '✉', color: '#dcff66' },
    lead:     { icon: '＋', color: '#dcff66' },
    error:    { icon: '▲', color: '#ffb340' },
    plain:    { icon: '✦', color: '#ccff00' }
  };

  const queue = [];
  let el = null, iconEl = null, titleEl = null, subEl = null, timeEl = null, progressEl = null, closeEl = null;
  let timer = null, currentOpts = null;

  function mount() {
    if (el) return;
    // Defensive: never allow two notification elements (double-loads, hot
    // reloads, script re-injection).
    const existing = document.getElementById('lolaNotify');
    if (existing) existing.remove();
    el = document.createElement('div');
    el.id = 'lolaNotify';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.style.cssText = [
      'position:fixed', 'top:52px', 'left:50%', 'transform:translateX(-50%) translateY(-14px)',
      'z-index:99999', 'display:flex', 'align-items:flex-start', 'gap:12px',
      'min-width:min(340px,calc(100vw - 36px))', 'max-width:min(440px,calc(100vw - 36px))',
      'padding:13px 15px 15px', 'border-radius:18px',
      'border:1px solid rgba(204,255,0,.22)',
      'background:linear-gradient(180deg,rgba(16,17,20,.92),rgba(10,11,13,.94))',
      'backdrop-filter:blur(22px) saturate(1.4)', '-webkit-backdrop-filter:blur(22px) saturate(1.4)',
      'color:#f4f4f5', 'font:500 13px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",sans-serif',
      'box-shadow:0 24px 70px rgba(0,0,0,.5),0 0 0 1px rgba(204,255,0,.04),0 0 34px rgba(204,255,0,.07)',
      'opacity:0', 'pointer-events:none', 'transition:opacity .28s ease,transform .28s cubic-bezier(.22,1,.36,1)'
    ].join(';');

    iconEl = document.createElement('span');
    iconEl.style.cssText = 'flex:0 0 auto;width:34px;height:34px;border-radius:11px;display:grid;place-items:center;font-size:15px;background:rgba(204,255,0,.08);';
    el.appendChild(iconEl);

    const body = document.createElement('div');
    body.style.cssText = 'flex:1;min-width:0;';

    const eyebrow = document.createElement('div');
    eyebrow.textContent = 'LOLA · LIVE';
    eyebrow.style.cssText = 'font-size:9px;letter-spacing:.22em;color:#ccff00;opacity:.85;margin-bottom:3px;';
    body.appendChild(eyebrow);

    titleEl = document.createElement('div');
    titleEl.style.cssText = 'font-size:13.5px;font-weight:650;color:#f6f6f8;letter-spacing:.01em;line-height:1.3;';
    body.appendChild(titleEl);

    subEl = document.createElement('div');
    subEl.style.cssText = 'font-size:11.5px;color:rgba(255,255,255,.52);margin-top:3px;line-height:1.45;';
    body.appendChild(subEl);

    const foot = document.createElement('div');
    foot.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:9px;';
    timeEl = document.createElement('span');
    timeEl.style.cssText = 'font-size:10px;color:rgba(255,255,255,.34);letter-spacing:.04em;';
    foot.appendChild(timeEl);
    closeEl = document.createElement('button');
    closeEl.type = 'button';
    closeEl.setAttribute('aria-label', 'Dismiss');
    closeEl.textContent = '✕';
    closeEl.style.cssText = 'border:0;background:rgba(255,255,255,.06);color:rgba(255,255,255,.6);width:22px;height:22px;border-radius:8px;font-size:10px;cursor:pointer;display:grid;place-items:center;';
    closeEl.onclick = (e) => { e.stopPropagation(); dismiss(); };
    foot.appendChild(closeEl);
    body.appendChild(foot);
    el.appendChild(body);

    progressEl = document.createElement('div');
    progressEl.style.cssText = 'position:absolute;left:16px;right:16px;bottom:10px;height:2px;border-radius:2px;background:rgba(204,255,0,.14);overflow:hidden;';
    const bar = document.createElement('div');
    bar.id = 'lolaNotifyBar';
    bar.style.cssText = 'height:100%;width:100%;background:linear-gradient(90deg,#ccff00,#dcff66);transform-origin:left;transform:scaleX(0);';
    progressEl.appendChild(bar);
    el.appendChild(progressEl);

    el.onclick = () => dismiss();
    document.body.appendChild(el);
  }

  function setTone(tone) {
    const t = TONES[tone] || TONES.plain;
    iconEl.textContent = t.icon;
    iconEl.style.color = t.color;
    iconEl.style.background = hexToRgba(t.color, 0.1);
    progressEl.style.borderColor = 'transparent';
    const bar = progressEl.firstChild;
    bar.style.background = 'linear-gradient(90deg,' + t.color + ',' + (tone === 'call' ? '#b8ffd8' : '#dcff66') + ')';
  }

  function hexToRgba(hex, a) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  function nowTime() {
    try {
      return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } catch (e) { return ''; }
  }

  function showNext() {
    const opts = queue.shift();
    if (!opts) { currentOpts = null; return; }
    currentOpts = opts;
    mount();
    const t = TONES[opts.tone] || TONES.plain;
    setTone(opts.tone);
    iconEl.textContent = t.icon;
    titleEl.textContent = opts.title || '';
    subEl.textContent = opts.sub || '';
    timeEl.textContent = nowTime();
    closeEl.style.display = opts.sticky ? 'grid' : 'none';

    if (REDUCED) {
      el.style.opacity = '1';
      el.style.transform = 'translateX(-50%)';
      el.style.pointerEvents = 'auto';
    } else {
      el.style.pointerEvents = 'auto';
      el.style.opacity = '0';
      el.style.transform = 'translateX(-50%) translateY(-14px)';
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          el.style.opacity = '1';
          el.style.transform = 'translateX(-50%) translateY(0)';
        });
      });
    }

    const duration = opts.sticky ? 0 : (opts.duration || (opts.tone === 'error' ? 6500 : 4600));
    const bar = progressEl.firstChild;
    if (!opts.sticky && !REDUCED) {
      bar.style.transition = 'none';
      bar.style.transform = 'scaleX(0)';
      requestAnimationFrame(() => {
        bar.style.transition = 'transform ' + duration + 'ms linear';
        bar.style.transform = 'scaleX(1)';
      });
    } else {
      bar.style.transition = 'none';
      bar.style.transform = 'scaleX(0)';
    }
    clearTimeout(timer);
    if (!opts.sticky) timer = setTimeout(dismiss, duration);
  }

  function dismiss() {
    clearTimeout(timer);
    if (!el) { currentOpts = null; return; }
    if (REDUCED) {
      el.style.opacity = '0';
      el.style.pointerEvents = 'none';
      showNext();
      return;
    }
    el.style.opacity = '0';
    el.style.transform = 'translateX(-50%) translateY(-12px)';
    el.style.pointerEvents = 'none';
    setTimeout(showNext, 240);
  }

  function show(opts) {
    queue.push(opts || {});
    if (!currentOpts) showNext();
  }

  function clear() {
    queue.length = 0;
    clearTimeout(timer);
    if (el) {
      el.style.opacity = '0';
      el.style.pointerEvents = 'none';
    }
    currentOpts = null;
  }

  global.LolaNotify = { show, clear };
})(window);
