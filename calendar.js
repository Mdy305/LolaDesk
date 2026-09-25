/* ============================================================
   CALENDAR — day agenda + white atom
   The atom breathes in the corner. Tap it: it grows, listens,
   answers, shrinks back. Vanilla JS. Self-contained.
   ============================================================ */

(function () {
  'use strict';

  // ── Date helpers ─────────────────────────────────────────
  const state = { offset: 0 }; // days from today

  function activeDate() {
    const d = new Date();
    d.setDate(d.getDate() + state.offset);
    return d;
  }
  function isoDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  function fmtLong(d) {
    return d.toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric'
    });
  }
  function labelFor(d) {
    const today = new Date(); today.setHours(0,0,0,0);
    const tgt = new Date(d); tgt.setHours(0,0,0,0);
    const diff = Math.round((tgt - today) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    if (diff === -1) return 'Yesterday';
    return d.toLocaleDateString('en-US', { weekday: 'long' });
  }

  function renderHead() {
    const d = activeDate();
    document.querySelector('.day-label').textContent = labelFor(d);
    document.getElementById('dayDate').textContent = fmtLong(d);
    document.getElementById('navToday').style.display = state.offset === 0 ? 'none' : '';
  }

  // ── Agenda fetch ─────────────────────────────────────────
  async function loadAgenda() {
    const el = document.getElementById('dayAgenda');
    el.innerHTML = '<div class="day-loading">Loading&hellip;</div>';
    const dateStr = isoDate(activeDate());
    try {
      const r = await fetch(`/api/appointments?date=${dateStr}`, { credentials: 'include' });
      if (!r.ok) {
        if (r.status === 401) { location.href = '/login?next=%2Fcalendar.html'; return; }
        throw new Error('load');
      }
      const data = await r.json();
      const rows = Array.isArray(data) ? data
        : (data.appointments || data.rows || data.data || []);
      if (!rows.length) return renderEmpty(el, dateStr);
      renderAgenda(el, rows);
    } catch {
      renderEmpty(el, dateStr);
    }
  }

  function renderEmpty(el, dateStr) {
    const isToday = dateStr === isoDate(new Date());
    el.innerHTML = `<div class="day-empty">${
      isToday ? 'Nothing on today. Lola is watching the phones.'
              : 'Nothing on this day yet.'
    }</div>`;
  }

  function renderAgenda(el, rows) {
    const sorted = rows.slice().sort((a, b) => timeVal(a) - timeVal(b));
    el.innerHTML = sorted.map(r => {
      const t = fmtTime(r.start_time || r.time || r.starts_at || '');
      const name = r.client_name || r.name || 'Client';
      const svc = r.service || r.service_name || r.service_title || '';
      const sty = r.stylist_name || r.stylist || r.staff_name || '';
      return `
        <div class="appt">
          <div class="appt-time">${escapeHtml(t)}</div>
          <div class="appt-body">
            <div class="appt-name">${escapeHtml(name)}</div>
            <div class="appt-service">${escapeHtml(svc)}</div>
          </div>
          <div class="appt-stylist">${escapeHtml(sty)}</div>
        </div>
      `;
    }).join('');
  }

  function timeVal(r) {
    const t = String(r.start_time || r.time || r.starts_at || '');
    const m = /(\d{1,2}):(\d{2})/.exec(t);
    return m ? parseInt(m[1],10) * 60 + parseInt(m[2],10) : 9999;
  }
  function fmtTime(v) {
    const m = /(\d{1,2}):(\d{2})/.exec(String(v || ''));
    if (!m) return '';
    let h = parseInt(m[1], 10);
    const mm = m[2];
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${mm} ${ap}`;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  // ── Nav ───────────────────────────────────────────────────
  document.getElementById('navPrev').addEventListener('click', () => {
    state.offset -= 1; renderHead(); loadAgenda();
  });
  document.getElementById('navNext').addEventListener('click', () => {
    state.offset += 1; renderHead(); loadAgenda();
  });
  document.getElementById('navToday').addEventListener('click', () => {
    state.offset = 0; renderHead(); loadAgenda();
  });

  renderHead();
  loadAgenda();

  // ── The Atom (canvas drawing) ─────────────────────────────
  const canvas = document.getElementById('atomCanvas');
  const g = canvas.getContext('2d');
  const atomBtn = document.getElementById('atom');
  const overlay = document.getElementById('atomOverlay');
  const closeBtn = document.getElementById('atomOverlayClose');
  const transcript = document.getElementById('atomTranscript');
  const caption = document.getElementById('atomCaption');

  const W = canvas.width, H = canvas.height, CX = W/2, CY = H/2;
  let level = 0;      // 0..1 realtime
  let smoothed = 0;
  let phase = 0;
  let engaged = false;

  function draw() {
    phase += 0.018;
    smoothed += (level - smoothed) * 0.22;
    const breath = 0.5 + 0.5 * Math.sin(phase);
    const pulse = Math.max(smoothed, breath * 0.12);

    g.clearRect(0, 0, W, H);

    // Outer soft glow
    const glowR = 32 + pulse * 40;
    let grad = g.createRadialGradient(CX, CY, 4, CX, CY, glowR);
    grad.addColorStop(0,    `rgba(255,255,255,${0.85 - pulse * 0.25})`);
    grad.addColorStop(0.55, `rgba(215,230,255,${0.28 + pulse * 0.35})`);
    grad.addColorStop(1,    'rgba(200,215,240,0)');
    g.fillStyle = grad;
    g.beginPath(); g.arc(CX, CY, glowR, 0, Math.PI * 2); g.fill();

    // Core
    const coreR = 18 + pulse * 5;
    grad = g.createRadialGradient(CX - 4, CY - 4, 0, CX, CY, coreR);
    grad.addColorStop(0,   'rgba(255,255,255,1)');
    grad.addColorStop(0.7, 'rgba(240,245,255,0.96)');
    grad.addColorStop(1,   'rgba(200,215,240,0.6)');
    g.fillStyle = grad;
    g.beginPath(); g.arc(CX, CY, coreR, 0, Math.PI * 2); g.fill();

    // Thin ring
    g.strokeStyle = `rgba(120,140,170,${0.12 + pulse * 0.35})`;
    g.lineWidth = 0.8;
    g.beginPath(); g.arc(CX, CY, coreR + 5 + pulse * 4, 0, Math.PI * 2); g.stroke();

    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);

  // ── Audio (mic in + TTS out) ─────────────────────────────
  const AC = window.AudioContext || window.webkitAudioContext;
  const actx = AC ? new AC() : null;
  let micStarted = false;

  async function armMic() {
    if (!actx || micStarted) return;
    micStarted = true;
    try {
      if (actx.state === 'suspended') await actx.resume();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      const src = actx.createMediaStreamSource(stream);
      const an = actx.createAnalyser();
      an.fftSize = 512; an.smoothingTimeConstant = 0.6;
      src.connect(an);
      const buf = new Uint8Array(an.frequencyBinCount);
      (function tick() {
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const n = (buf[i] - 128) / 128;
          sum += n * n;
        }
        level = Math.min(1, Math.sqrt(sum / buf.length) * 5);
        requestAnimationFrame(tick);
      })();
    } catch (err) {
      console.warn('[calendar] mic denied:', err && err.name);
      micStarted = false;
      caption.textContent = 'Mic blocked — enable in browser';
    }
  }

  async function speak(text) {
    if (!text || !actx) return;
    caption.textContent = 'Speaking';
    try {
      const r = await fetch(`/api/speak-lola?text=${encodeURIComponent(text)}`, {
        credentials: 'include'
      });
      if (!r.ok) throw new Error('tts ' + r.status);
      const arr = await r.arrayBuffer();
      const buf = await actx.decodeAudioData(arr.slice(0));
      const src = actx.createBufferSource();
      src.buffer = buf;
      const an = actx.createAnalyser();
      an.fftSize = 512; an.smoothingTimeConstant = 0.5;
      src.connect(an); an.connect(actx.destination);
      const data = new Uint8Array(an.frequencyBinCount);
      let running = true;
      src.onended = () => { running = false; level = 0; caption.textContent = 'Listening…'; };
      src.start(0);
      (function tick() {
        if (!running) return;
        an.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const n = (data[i] - 128) / 128;
          sum += n * n;
        }
        level = Math.min(1, Math.sqrt(sum / data.length) * 4.5);
        requestAnimationFrame(tick);
      })();
    } catch (err) {
      console.warn('[calendar] tts failed:', err && err.message);
      caption.textContent = 'Listening…';
    }
  }

  async function askLola(question) {
    const endpoints = ['/api/lola/ask', '/api/lola', '/api/lola-brain'];
    for (const ep of endpoints) {
      try {
        const r = await fetch(ep, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ question, message: question, text: question })
        });
        if (!r.ok) continue;
        const d = await r.json().catch(() => ({}));
        const ans = d.answer || d.text || d.reply || d.message || '';
        if (ans) return ans;
      } catch { /* try next */ }
    }
    return '';
  }

  // ── Speech recognition (browser) ─────────────────────────
  let recognition = null;
  function startRecognition() {
    const R = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!R) {
      caption.textContent = 'Voice unsupported — Chrome/Safari only';
      return null;
    }
    const rec = new R();
    rec.lang = 'en-US';
    rec.interimResults = true;
    rec.continuous = false;
    let finalText = '';
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalText += res[0].transcript;
        else interim += res[0].transcript;
      }
      transcript.textContent = (finalText + interim).trim();
      transcript.classList.add('show');
    };
    rec.onerror = (e) => {
      console.warn('[calendar] rec error:', e.error);
    };
    rec.onend = async () => {
      const q = finalText.trim();
      if (!q) { setTimeout(disengage, 800); return; }
      caption.textContent = 'Thinking';
      const ans = await askLola(q);
      if (ans) {
        transcript.textContent = ans;
        transcript.classList.add('show');
        await speak(ans);
        setTimeout(() => { transcript.classList.remove('show'); }, 6000);
      } else {
        transcript.textContent = "I couldn't reach the brain — try again.";
        setTimeout(disengage, 2500);
      }
    };
    try { rec.start(); } catch {}
    return rec;
  }

  // ── Engage / disengage ────────────────────────────────────
  function engage() {
    if (engaged) return;
    engaged = true;
    atomBtn.classList.add('expanded');
    overlay.classList.add('on');
    caption.textContent = 'Listening…';
    transcript.textContent = '';
    transcript.classList.remove('show');
    armMic();
    recognition = startRecognition();
  }
  function disengage() {
    if (!engaged) return;
    engaged = false;
    atomBtn.classList.remove('expanded');
    overlay.classList.remove('on');
    transcript.classList.remove('show');
    if (recognition) { try { recognition.stop(); } catch {} recognition = null; }
    level = 0;
  }

  atomBtn.addEventListener('click', (e) => { e.stopPropagation(); engage(); });
  closeBtn.addEventListener('click', (e) => { e.stopPropagation(); disengage(); });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) disengage(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') disengage(); });

  // ── Wake-word: say "Lola" anywhere to open her ────────────
  let wake = null;
  function armWake() {
    const R = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!R || wake) return;
    try {
      wake = new R();
      wake.lang = 'en-US';
      wake.continuous = true;
      wake.interimResults = true;
      wake.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = e.results[i][0].transcript.toLowerCase();
          if (/\blola\b/.test(t) && !engaged) {
            try { wake.stop(); } catch {}
            engage();
            return;
          }
        }
      };
      wake.onend = () => {
        wake = null;
        if (!engaged) setTimeout(armWake, 500);
      };
      wake.onerror = () => { wake = null; };
      wake.start();
    } catch { wake = null; }
  }
  // Kick off after the first user gesture (browsers require it)
  document.addEventListener('click', armWake, { once: true });

  console.info('[calendar] ready — atom lives top-right, tap or say "Lola"');
})();
