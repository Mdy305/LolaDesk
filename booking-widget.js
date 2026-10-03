/* ============================================================================
 * LolaDesk Booking Widget \u2014 the open-source, embeddable booking system.
 * \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
 * Drop Lola's booking engine onto ANY website with one script tag. No SDK, no
 * build step, no account code. The widget talks to the same /api/public-booking
 * endpoint Lola's voice uses, so web, phone, and dashboard bookings all share
 * one conflict-free calendar.
 *
 *   <script src="https://www.loladesk.com/booking-widget.js"
 *           data-tenant="YOUR-SLUG"
 *           data-accent="#ccff00"   (optional)
 *           data-mode="inline"      (inline | modal, default inline)
 *           data-base="/api/public-booking"  (optional, same-origin default)
 *   ></script>
 *
 * Modal mode adds a floating "Book now" button that opens the flow.
 * Inline mode renders the full flow immediately after the script tag.
 * ========================================================================== */
(function () {
  'use strict';

  var SCRIPT = document.currentScript;
  var cfg = {
    tenant: (SCRIPT && SCRIPT.getAttribute('data-tenant')) || '',
    accent: (SCRIPT && SCRIPT.getAttribute('data-accent')) || '#ccff00',
    mode: (SCRIPT && SCRIPT.getAttribute('data-mode')) || 'inline',
    base: (SCRIPT && SCRIPT.getAttribute('data-base')) || ''
  };
  // Embedded on a salon's own website or Google Business link: talk to the
  // LolaDesk server the script came from, not the host site.
  if (!cfg.base) {
    try { cfg.base = new URL(SCRIPT.src, location.href).origin + '/api/public-booking'; }
    catch (e) { cfg.base = '/api/public-booking'; }
  }

  // Fall back to the classic ?t= / ?slug= query params when data-tenant is absent.
  var Q = new URLSearchParams(location.search);
  if (!cfg.tenant) cfg.tenant = Q.get('t') || Q.get('slug') || '';
  // Manage deep link (/book?t=slug&code=AB3X7Q): open "manage" with the code filled in.
  cfg.code = (Q.get('code') || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 12).toUpperCase();
  cfg.phone = (Q.get('phone') || '').slice(0, 24);

  var API = cfg.base.replace(/\/$/, '');
  // Legal pages live on LolaDesk even when the widget sits on a salon's own site.
  var LEGAL = API.replace(/\/api\/public-booking$/, '') || '';
  var ORIGIN = LEGAL; // the LolaDesk server (add-to-calendar file, legal pages)
  var state = { catalog: null, service: null, staff: null, time: null, date: null };
  var TZ = ''; // salon time zone, from the catalog
  function tzOpt(o) { if (TZ) o.timeZone = TZ; return o; }
  function salonToday() {
    try { return new Date().toLocaleDateString('en-CA', tzOpt({ year: 'numeric', month: '2-digit', day: '2-digit' })); }
    catch (e) { return new Date().toISOString().slice(0, 10); }
  }

  var SHEET = [
    ':host{all:initial;--bg:#050506;--surface:#141416;--surface2:#19191d;--line:#25252b;--text:#f6f6f7;--muted:#92929b;--dim:#5c5c65;--accent:' + cfg.accent + ';--accent2:#e4ff78;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text","Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased;color:var(--text)}',
    '*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}',
    '.lw{background:var(--bg);color:var(--text);min-height:100%;padding:36px 22px 72px;border-radius:18px;border:1px solid var(--line)}',
    '.lw-name{font-size:27px;font-weight:600;letter-spacing:-.02em;margin-bottom:3px}',
    '.lw-meta{color:var(--muted);font-size:13px;margin-bottom:28px}',
    '.lw-step{display:none}.lw-step.on{display:block;animation:lwin .3s cubic-bezier(.22,1,.36,1)}',
    '@keyframes lwin{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',
    '.lw-label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.12em;margin-bottom:14px}',
    '.lw-back{color:var(--muted);font-size:13px;cursor:pointer;margin-bottom:16px;display:inline-block;background:none;border:none;padding:0;font-family:inherit}',
    '.lw-back:hover{color:var(--text)}',
    '.lw-opts{display:flex;flex-direction:column;gap:8px}',
    '.lw-opt{background:var(--surface);border:.5px solid var(--line);border-radius:14px;padding:15px 18px;text-align:left;color:var(--text);cursor:pointer;transition:.15s;display:flex;justify-content:space-between;align-items:center;width:100%;font-family:inherit;font-size:14.5px}',
    '.lw-opt:hover{border-color:var(--accent);background:var(--surface2)}',
    '.lw-opt.sel{border-color:var(--accent);background:var(--surface2)}',
    '.lw-opt b{font-weight:500}',
    '.lw-opt .meta{font-size:12px;color:var(--muted);margin-top:2px;font-weight:400}',
    '.lw-price{font-size:14px;color:var(--accent2);white-space:nowrap;margin-left:12px;font-weight:400}',
    '.lw-slots{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:4px}',
    '.lw-slot{background:var(--surface);border:.5px solid var(--line);border-radius:10px;padding:12px 6px;text-align:center;color:var(--text);cursor:pointer;font-size:13px;transition:.15s;width:100%;font-family:inherit}',
    '.lw-slot:hover,.lw-slot.sel{border-color:var(--accent);color:var(--accent2)}',
    '.lw-date{width:100%;border:1px solid var(--line);background:var(--surface);color:var(--text);border-radius:12px;padding:13px 15px;font-size:14px;margin-bottom:16px;outline:none;font-family:inherit}',
    '.lw-date:focus{border-color:var(--accent)}',
    '.lw-fld{margin-bottom:14px}.lw-fld label{display:block;font-size:11px;color:var(--muted);margin-bottom:6px}',
    '.lw-inp{width:100%;border:1px solid var(--line);background:var(--surface);color:var(--text);border-radius:12px;padding:13px 15px;font-size:14px;outline:none;font-family:inherit}',
    '.lw-inp:focus{border-color:var(--accent)}',
    '.lw-summary{background:var(--surface2);border-radius:12px;padding:14px 16px;margin-bottom:18px;font-size:13px;color:var(--muted);line-height:1.6}',
    '.lw-summary b{color:var(--text);font-weight:500}',
    '.lw-btn{width:100%;padding:14px;border-radius:12px;font-size:14px;font-weight:600;cursor:pointer;border:none;margin-top:8px;font-family:inherit;background:var(--text);color:#080809}',
    '.lw-btn:disabled{opacity:.4;cursor:not-allowed}',
    '.lw-btn:not(:disabled):hover{background:var(--accent2)}',
    '.lw-err{color:#ff8a8a;font-size:12.5px;margin-top:10px;min-height:16px}',
    '.lw-legal{font-size:11px;line-height:1.5;color:var(--muted);margin-top:10px}',
    '.lw-legal a{color:inherit;text-decoration:underline}',
    '.lw-empty{color:var(--dim);font-size:13px;padding:18px 0;text-align:center}',
    '.lw-wl{margin-top:6px;padding:14px;border:.5px solid rgba(204,255,0,.25);border-radius:14px;background:rgba(204,255,0,.04)}',
    '.lw-wl-t{font-size:13.5px;font-weight:650;color:var(--text);margin-bottom:3px}',
    '.lw-wl-s{font-size:12px;color:var(--muted);line-height:1.6;margin-bottom:10px}',
    '.lw-wl-fld{margin-bottom:8px}.lw-wl-fld input{width:100%;box-sizing:border-box;background:var(--surface2);border:.5px solid var(--border);border-radius:10px;padding:10px 12px;color:var(--text);font-size:13px;font-family:inherit;outline:none}',
    '.lw-wl-consent{display:flex;gap:9px;align-items:flex-start;margin-bottom:10px;cursor:pointer}',
    '.lw-wl-consent input{width:16px;height:16px;margin-top:1px;accent-color:#ccff00;cursor:pointer}',
    '.lw-wl-consent span{font-size:11.5px;color:var(--muted);line-height:1.5}',
    '.lw-wl-fld input:focus{border-color:rgba(204,255,0,.5)}',
    '.lw-wl-btn{width:100%;padding:11px;border-radius:10px;border:none;background:var(--accent);color:#080809;font-size:13px;font-weight:650;cursor:pointer;font-family:inherit}',
    '.lw-wl-btn:disabled{opacity:.5;cursor:wait}',
    '.lw-wl-ok{font-size:13px;color:var(--accent2);padding:6px 0;text-align:center}',
    '.lw-orb{width:52px;height:52px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#f1ffc0,var(--accent) 55%,#7a9e00);margin:0 auto 18px}',
    '.lw-done-title{font-size:22px;font-weight:600;text-align:center;margin-bottom:8px}',
    '.lw-done-sub{color:var(--muted);font-size:14px;text-align:center;line-height:1.7}',
    '.lw-code{background:var(--surface2);border-radius:12px;padding:12px 16px;margin:18px 0 4px;font-size:14px;color:var(--muted);text-align:center}',
    '.lw-code b{color:var(--accent2);font-weight:600;letter-spacing:.08em}',
    '.lw-link{display:block;margin:16px auto 0;background:none;border:none;color:var(--muted);font-size:13px;cursor:pointer;text-decoration:underline;font-family:inherit;padding:0}',
    '.lw-link:hover{color:var(--accent2)}',
    '.lw-note{color:var(--muted);font-size:13px;line-height:1.6;margin:-6px 0 16px}',
    '.lw-card{background:var(--surface);border:.5px solid var(--line);border-radius:14px;padding:16px 18px;margin-bottom:16px}',
    '.lw-card-when{font-size:16px;font-weight:600;letter-spacing:-.01em;margin-bottom:6px}',
    '.lw-card-meta{font-size:12.5px;color:var(--muted);margin-top:2px}',
    /* modal chrome */
    '.lw-fab{position:fixed;right:22px;bottom:22px;z-index:2147483000;background:var(--accent);color:#080809;border:none;border-radius:999px;padding:15px 22px;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit;box-shadow:0 8px 28px rgba(0,0,0,.5)}',
    '.lw-fab:hover{background:var(--accent2)}',
    '.lw-overlay{position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:18px}',
    '.lw-overlay .lw{width:100%;max-width:520px;min-height:0;max-height:92vh;overflow:auto;border-radius:22px}',
    '.lw-close{position:absolute;top:14px;right:16px;background:none;border:none;color:var(--muted);font-size:22px;cursor:pointer;font-family:inherit;line-height:1}',
    /* \u2500\u2500\u2500 polish additions: progress bar, skeletons, deposit chip, focus rings \u2500\u2500\u2500 */
    '.lw-progress{display:flex;gap:6px;margin:0 0 22px;padding:0}',
    '.lw-progress i{flex:1;height:3px;border-radius:2px;background:var(--surface2);transition:background .3s cubic-bezier(.22,1,.36,1)}',
    '.lw-progress i.on{background:var(--accent);box-shadow:0 0 8px rgba(204,255,0,.35)}',
    '.lw-progress i.done{background:var(--accent2)}',
    '.lw-slot-sk{background:linear-gradient(90deg,var(--surface) 0%,var(--surface2) 50%,var(--surface) 100%);background-size:200% 100%;animation:lwsk 1.4s ease-in-out infinite;border-radius:10px;height:39px}',
    '@keyframes lwsk{0%{background-position:200% 0}100%{background-position:-200% 0}}',
    '@media(prefers-reduced-motion:reduce){.lw-slot-sk{animation:none}.lw-step.on{animation:none}}',
    '.lw-deposit{display:inline-flex;align-items:center;gap:6px;background:var(--accent);color:#080809;padding:4px 10px;border-radius:20px;font-size:11.5px;font-weight:700;letter-spacing:.02em;margin-top:8px;text-transform:uppercase}',
    '.lw-summary .deposit-line{color:var(--accent2);margin-top:6px;font-size:12.5px;font-weight:500}',
    '.lw-welcome{background:linear-gradient(180deg,rgba(204,255,0,.08),transparent);border:.5px solid rgba(204,255,0,.25);border-radius:14px;padding:14px 16px;margin-bottom:16px;font-size:13px;color:var(--text);line-height:1.55}',
    '.lw-welcome b{color:var(--accent2);font-weight:600}',
    '.lw-welcome .quick{display:inline-block;margin-top:8px;background:var(--surface2);border:.5px solid var(--line);border-radius:20px;padding:6px 12px;font-size:12px;color:var(--text);cursor:pointer;font-family:inherit;font-weight:600}',
    '.lw-welcome .quick:hover{border-color:var(--accent);color:var(--accent2)}',
    '.lw-opt:focus-visible,.lw-slot:focus-visible,.lw-btn:focus-visible,.lw-inp:focus-visible,.lw-date:focus-visible,.lw-link:focus-visible,.lw-back:focus-visible{outline:2px solid var(--accent);outline-offset:2px}',
    '.lw-inp,.lw-date{transition:border-color .18s cubic-bezier(.22,1,.36,1),box-shadow .18s cubic-bezier(.22,1,.36,1)}',
    '.lw-inp:focus,.lw-date:focus{box-shadow:0 0 0 3px rgba(204,255,0,.14)}',
    '.lw-step.on{animation:lwin .32s cubic-bezier(.22,1,.36,1)}',
    '@keyframes lwin{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}',
    /* menu groups, add-ons, open-days strip, hold timer, policy */
    '.lw-cat{font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.12em;margin:18px 0 8px}',
    '.lw-cat:first-child{margin-top:0}',
    '.lw-opt .desc{font-size:12px;color:var(--muted);margin-top:4px;line-height:1.45;font-weight:400}',
    '.lw-opt>span:first-child{min-width:0;flex:1}',
    '.lw-chip{display:inline-block;margin-top:6px;font-size:10.5px;letter-spacing:.04em;color:var(--accent2);border:.5px solid rgba(204,255,0,.35);border-radius:20px;padding:2px 8px}',
    '.lw-days{display:flex;gap:6px;overflow-x:auto;padding:2px 0 10px;margin-bottom:6px;scrollbar-width:none;-webkit-overflow-scrolling:touch}',
    '.lw-days::-webkit-scrollbar{display:none}',
    '.lw-day{flex:0 0 auto;width:54px;background:var(--surface);border:.5px solid var(--line);border-radius:12px;padding:8px 0;text-align:center;color:var(--text);cursor:pointer;font-family:inherit}',
    '.lw-day small{display:block;font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}',
    '.lw-day b{display:block;font-size:16px;font-weight:600;margin-top:2px}',
    '.lw-day i{display:block;width:5px;height:5px;border-radius:50%;margin:5px auto 0;background:transparent}',
    '.lw-day.open i{background:var(--accent)}',
    '.lw-day.closed{opacity:.45}',
    '.lw-day.sel{border-color:var(--accent);background:var(--surface2)}',
    '.lw-day:focus-visible{outline:2px solid var(--accent);outline-offset:2px}',
    '.lw-more{display:flex;align-items:center;gap:8px;margin-bottom:14px;font-size:12px;color:var(--muted)}',
    '.lw-more .lw-date{margin:0;padding:8px 10px;font-size:13px;width:auto;flex:1;min-width:0}',
    '.lw-next{margin:4px 0 12px;padding:14px;border:.5px solid var(--line);border-radius:14px;background:var(--surface)}',
    '.lw-next-t{font-size:13px;color:var(--text);margin-bottom:10px}',
    '.lw-hold{font-size:12px;color:var(--muted);margin:-6px 0 14px}',
    '.lw-hold b{color:var(--accent2);font-weight:600}',
    '.lw-policy{font-size:12px;color:var(--muted);line-height:1.55;border-top:.5px solid var(--line);padding-top:10px;margin-top:10px}',
    '.lw-check{display:flex;gap:10px;align-items:flex-start;margin:6px 0 4px;cursor:pointer}',
    '.lw-check input{width:18px;height:18px;margin-top:1px;accent-color:#ccff00;flex:0 0 auto}',
    '.lw-check span{font-size:13px;line-height:1.45}',
    '.lw-actions{display:flex;flex-direction:column;gap:8px;margin-top:16px}',
    '.lw-btn.ghost{background:var(--surface2);color:var(--text);border:.5px solid var(--line)}',
    'a.lw-btn{display:block;text-align:center;text-decoration:none}'
  ].join('\n');


  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) { return '$' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: Number(n) % 1 ? 2 : 0, maximumFractionDigits: 2 }); }
  function cents(c) { return money(Number(c || 0) / 100); }
  function timeLabel(iso) {
    try { return new Date(iso).toLocaleTimeString([], tzOpt({ hour: 'numeric', minute: '2-digit' })); }
    catch (e) { return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  }
  function whenLabel(iso) {
    try { return new Date(iso).toLocaleString([], tzOpt({ weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })); }
    catch (e) { return new Date(iso).toLocaleString([], { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  }
  // A salon-calendar date key (YYYY-MM-DD) shown as a label. Noon UTC keeps
  // the weekday right in every time zone.
  function dayParts(key) {
    var d = new Date(key + 'T12:00:00Z');
    return {
      wd: d.toLocaleDateString([], { weekday: 'short', timeZone: 'UTC' }),
      day: d.getUTCDate(),
      long: d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' })
    };
  }
  function addDays(key, n) {
    var d = new Date(key + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  function apiGet(action, extra) {
    var p = new URLSearchParams(Object.assign({ action: action, tenant: cfg.tenant }, extra));
    return fetch(API + '?' + p.toString()).then(function (r) { return r.json(); })
      .then(function (j) { if (!j.ok) { var e = new Error(j.message || j.error || 'Request failed'); e.data = j; throw e; } return j; });
  }
  function apiPost(body) {
    return fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ tenant: cfg.tenant }, body)) })
      .then(function (r) { return r.json(); });
  }

  // ── polish helpers ──────────────────────────────────────
  var BOOK_STEPS = ['service', 'staff', 'time', 'details', 'done'];
  function progressHtml(current, hasStaff) {
    var steps = hasStaff === false ? ['service', 'time', 'details', 'done'] : BOOK_STEPS;
    var idx = steps.indexOf(current);
    if (idx < 0) return '';
    return '<div class="lw-progress" role="progressbar" aria-valuemin="0" aria-valuemax="' + (steps.length - 1) + '" aria-valuenow="' + idx + '" aria-label="Booking progress step ' + (idx + 1) + ' of ' + steps.length + '">' +
      steps.map(function (_, i) {
        var cls = i < idx ? 'done' : (i === idx ? 'on' : '');
        return '<i class="' + cls + '"></i>';
      }).join('') + '</div>';
  }

  // Phone: US numbers format as (555) 555-5555; anything starting with "+" is
  // international and kept as typed (digits, spaces, dashes).
  function phoneDigits(v) { return String(v || '').replace(/\D/g, ''); }
  function phoneValid(v) {
    var s = String(v || '').trim(), d = phoneDigits(s);
    if (!/^[+\d\s().-]+$/.test(s)) return false;
    if (s.charAt(0) === '+') return d.length >= 8 && d.length <= 15;
    return d.length === 10 || (d.length === 11 && d.charAt(0) === '1') || (d.length >= 8 && d.length <= 15);
  }
  function fmtPhone(v) {
    var s = String(v || '');
    if (s.trim().charAt(0) === '+') return '+' + s.replace(/[^\d\s-]/g, '').replace(/^\s+/, '').slice(0, 20);
    var d = phoneDigits(s);
    if (d.length > 10) return d.slice(0, 15);
    if (!d) return '';
    if (d.length < 4) return d;
    if (d.length < 7) return '(' + d.slice(0, 3) + ') ' + d.slice(3);
    return '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
  }
  function wirePhone(input, onValid) {
    if (!input) return;
    input.addEventListener('input', function () {
      input.value = fmtPhone(input.value);
      try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) {}
      if (onValid && phoneValid(input.value)) onValid(input.value);
    });
    input.addEventListener('blur', function () {
      if (onValid && phoneValid(input.value)) onValid(input.value);
    });
  }

  // Returning visitor: the server answers with a FIRST name only.
  var CLIENT_CACHE = {};
  function lookupClient(phone) {
    var key = phoneDigits(phone);
    if (!phoneValid(phone)) return Promise.resolve(null);
    if (CLIENT_CACHE[key] !== undefined) return Promise.resolve(CLIENT_CACHE[key]);
    return apiPost({ action: 'client_lookup', client_phone: phone }).then(function (j) {
      var c = j && j.ok && j.client ? j.client : null;
      CLIENT_CACHE[key] = c;
      return c;
    }).catch(function () { CLIENT_CACHE[key] = null; return null; });
  }

  function focusFirst(host) {
    try {
      var el = host.querySelector('input, button.lw-opt, button.lw-btn');
      if (el && el.focus) el.focus({ preventScroll: true });
    } catch (e) {}
  }

  function Widget(root) {
    this.root = root;
    this.host = root.querySelector('.lw');
    this.addons = [];
  }
  Widget.prototype.render = function (html) {
    this.host.innerHTML = (this.header || '') + html;
    tickHold(this);
  };
  Widget.prototype.msg = function (kind, text) {
    var e = this.host.querySelector('.lw-err');
    if (e) e.textContent = text || '';
  };

  // ── 5-minute hold on the picked time ─────────────────────
  function releaseHold(w) {
    var h = w.hold; w.hold = null;
    if (h && h.hold_token) apiPost({ action: 'release_hold', hold_token: h.hold_token }).catch(function () {});
  }
  function holdLeft(w) { return w.hold ? Math.max(0, Date.parse(w.hold.expires_at) - Date.now()) : 0; }
  function holdText(w) {
    var left = holdLeft(w);
    if (!w.hold) return '';
    if (!left) return 'Your hold has expired — you can still try to confirm, or pick the time again.';
    var m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
    return 'We’re holding this time for you for <b>' + m + ':' + (s < 10 ? '0' : '') + s + '</b>.';
  }
  function tickHold(w) {
    var el = w.host.querySelector('.lw-hold');
    if (el) el.innerHTML = holdText(w);
    if (w._tick) return;
    w._tick = setInterval(function () {
      var e = w.host.querySelector('.lw-hold');
      if (e) e.innerHTML = holdText(w);
    }, 1000);
  }

  function errText(result, fallback) {
    var r = result || {};
    var phone = r.salon_phone || (state.catalog && state.catalog.phone) || '';
    if (r.error === 'within_policy_window') return 'Your appointment is less than ' + (r.window_hours || '') + ' hours away, so it can’t be changed online. ' + (phone ? 'Please call the salon at ' + phone + '.' : 'Please call the salon.');
    if (r.error === 'rate_limited' || r.error === 'booking_disabled') return r.message || fallback;
    if (r.error === 'hold_expired') return 'Your hold on this time ran out — go back and pick the time again.';
    if (r.error === 'addon_unavailable') return 'There isn’t room for ' + (r.service_name || 'that add-on') + ' right after — remove it or pick another time.';
    if (r.error === 'code_not_found') return 'No booking matches that code.';
    if (r.error === 'code_phone_mismatch') return 'That code and phone don’t match a booking.';
    if (r.error === 'appointment_passed') return 'That appointment has already passed.';
    if (r.error === 'not_reschedulable') return 'That booking can no longer be changed.';
    if (r.error === 'not_cancellable') return 'That booking is no longer cancellable.';
    if (r.conflict) return 'That time was just taken — go back and pick another.';
    return r.message || (r.error && !/^[a-z_]+$/.test(r.error) ? r.error : fallback);
  }

  function policyHtml(c, depositNote) {
    var lines = [];
    var h = Number(c.cancellation_window_hours || 0);
    if (h) lines.push('Need to cancel or move it? You can do it online up to ' + h + ' hours before your appointment; after that, please call the salon' + (c.phone ? ' at ' + esc(c.phone) : '') + '.');
    if (depositNote) lines.push(depositNote);
    return lines.length ? '<div class="lw-policy">' + lines.join('<br>') + '</div>' : '';
  }

  // ── step 1: the menu, grouped by category ────────────────
  function depositChip(s, c) {
    if (!s.deposit_cents) return '';
    return '<span class="lw-chip">' + (c.deposit_everyone ? cents(s.deposit_cents) + ' deposit' : 'Deposit may apply') + '</span>';
  }
  function stepService(w, c) {
    releaseHold(w);
    w.addons = []; w.time = null; w.managing = null;
    if (!c.enabled) {
      w.render('<div class="lw-note" style="margin:0 0 16px">' + esc(c.message || 'Online booking is turned off right now.') + '</div>' +
        '<button class="lw-link" data-cancel>Manage an existing appointment</button>');
      w.host.querySelector('[data-cancel]').addEventListener('click', function () { stepManage(w); });
      return;
    }
    if (!c.services || !c.services.length) {
      w.render('<div class="lw-empty">No services listed yet.</div>');
      return;
    }
    var hasStaff = !!(c.staff && c.staff.length);
    var groups = [], byCat = {};
    c.services.forEach(function (s, i) {
      var k = s.category || '';
      if (!byCat[k]) { byCat[k] = []; groups.push(k); }
      byCat[k].push(i);
    });
    var named = groups.some(function (g) { return !!g; });
    var html = groups.map(function (g) {
      return (named ? '<div class="lw-cat">' + esc(g || 'More services') + '</div>' : '') +
        '<div class="lw-opts" role="list">' + byCat[g].map(function (i) {
          var s = c.services[i];
          return '<button class="lw-opt" role="listitem" data-i="' + i + '" aria-label="Choose ' + esc(s.name) + (s.price != null ? ' for ' + money(s.price) : '') + '"><span><b>' + esc(s.name) + '</b>' +
            (s.duration_minutes ? '<div class="meta">' + s.duration_minutes + ' min</div>' : '') +
            (s.description ? '<div class="desc">' + esc(s.description) + '</div>' : '') + depositChip(s, c) +
            '</span>' + (s.price != null ? '<span class="lw-price">' + money(s.price) + '</span>' : '') + '</button>';
        }).join('') + '</div>';
    }).join('');
    w.render(
      progressHtml('service', hasStaff) +
      '<div class="lw-step on" data-step="service" role="region" aria-label="Choose a service">' +
      '<div class="lw-label">Choose a service</div>' + html +
      '<button class="lw-link" data-cancel>Manage or cancel an appointment</button></div>'
    );
    focusFirst(w.host);
    w.host.querySelectorAll('.lw-opt').forEach(function (b) {
      b.addEventListener('click', function () {
        w.service = c.services[Number(b.getAttribute('data-i'))];
        w.staff = null;
        if (hasStaff) stepStaff(w, c); else stepTime(w, c);
      });
    });
    w.host.querySelector('[data-cancel]').addEventListener('click', function () { stepManage(w); });
  }

  // ── step 2: who ─────────────────────────────────────────
  function stepStaff(w, c) {
    var opts = [];
    if (w.managing) {
      // Rescheduling: keep the stylist they have — their real id, so the times
      // shown are THAT stylist's free times.
      var cur = w.managing.booking && w.managing.booking.staff;
      if (cur && cur.id) opts.push('<button class="lw-opt" data-keep="1"><span><b>Keep ' + esc(cur.name || 'my current team member') + '</b></span></button>');
    } else if (c.allow_any_staff) {
      opts.push('<button class="lw-opt" data-i="-1"><span><b>Any available</b><div class="meta">We’ll match you with the best free team member</div></span></button>');
    }
    (c.staff || []).forEach(function (s, i) {
      if (w.managing && w.managing.booking && w.managing.booking.staff && w.managing.booking.staff.id === s.id) return;
      opts.push('<button class="lw-opt" data-i="' + i + '"><span><b>' + esc(s.name) + '</b>' +
        (s.role ? '<div class="meta">' + esc(s.role) + '</div>' : '') + '</span></button>');
    });
    w.render(
      progressHtml(w.managing ? '' : 'staff', true) +
      '<div class="lw-step on" data-step="staff" role="region" aria-label="Choose a team member"><button class="lw-back" data-back aria-label="Back">← Back</button>' +
      '<div class="lw-label">Choose a team member</div><div class="lw-opts" role="list">' + opts.join('') + '</div></div>'
    );
    focusFirst(w.host);
    w.host.querySelector('[data-back]').addEventListener('click', function () {
      if (w.managing) { renderManageCard(w, w.managing.booking, w.managing.policy); return; }
      stepService(w, c);
    });
    w.host.querySelectorAll('.lw-opt').forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.getAttribute('data-keep')) { w.staff = w.managing.booking.staff; stepTime(w, c); return; }
        var i = Number(b.getAttribute('data-i'));
        w.staff = i === -1 ? null : c.staff[i];
        stepTime(w, c);
      });
    });
  }

  // ── step 3: when ────────────────────────────────────────
  function stepTime(w, c) {
    releaseHold(w);
    var today = salonToday();
    var date = (w.date && w.date >= today) ? w.date : today;
    var hasStaff = !!(c.staff && c.staff.length);
    var chips = [];
    for (var i = 0; i < 14; i++) {
      var k = addDays(today, i), p = dayParts(k);
      chips.push('<button class="lw-day' + (k === date ? ' sel' : '') + '" data-day="' + k + '" aria-label="' + esc(p.long) + '"><small>' + esc(p.wd) + '</small><b>' + p.day + '</b><i></i></button>');
    }
    w.render(
      progressHtml(w.managing ? '' : 'time', hasStaff) +
      '<div class="lw-step on" data-step="time" role="region" aria-label="Pick a time"><button class="lw-back" data-back aria-label="Back">← Back</button>' +
      '<div class="lw-label">' + (w.managing ? 'Pick a new time' : 'Pick a time') + (w.staff ? ' · ' + esc(w.staff.name) : '') + '</div>' +
      '<div class="lw-days" role="list" aria-label="Next two weeks">' + chips.join('') + '</div>' +
      '<label class="lw-more">Another date <input type="date" class="lw-date" id="lwDate" value="' + date + '" min="' + today + '" aria-label="Choose another date"/></label>' +
      '<div class="lw-err" role="alert"></div>' +
      '<div class="lw-slots" id="lwSlots" role="list" aria-live="polite" aria-busy="true"></div></div>'
    );
    function pick(k) {
      w.date = k;
      w.host.querySelectorAll('.lw-day').forEach(function (b) { b.classList.toggle('sel', b.getAttribute('data-day') === k); });
      var inp = w.host.querySelector('#lwDate'); if (inp) inp.value = k;
      loadSlots(w, c, k);
    }
    w.host.querySelectorAll('.lw-day').forEach(function (b) {
      b.addEventListener('click', function () { pick(b.getAttribute('data-day')); });
    });
    var input = w.host.querySelector('#lwDate');
    input.addEventListener('change', function () { if (input.value) pick(input.value); });
    w.host.querySelector('[data-back]').addEventListener('click', function () {
      if (w.managing) { if (hasStaff || (w.managing.booking && w.managing.booking.staff)) stepStaff(w, c); else renderManageCard(w, w.managing.booking, w.managing.policy); return; }
      if (hasStaff) stepStaff(w, c); else stepService(w, c);
    });
    // Mark which of the next 14 days have any opening.
    var od = { service_id: w.service.id, from: today, days: 14 };
    if (w.staff) od.staff_id = w.staff.id;
    apiGet('open_days', od).then(function (j) {
      (j.days || []).forEach(function (d) {
        var b = w.host.querySelector('.lw-day[data-day="' + d.date + '"]');
        if (b) { b.classList.add(d.open ? 'open' : 'closed'); if (!d.open) b.setAttribute('aria-label', b.getAttribute('aria-label') + ' (fully booked)'); }
      });
    }).catch(function () {});
    w.date = date;
    loadSlots(w, c, date);
  }

  function loadSlots(w, c, date) {
    var host = w.host.querySelector('#lwSlots');
    if (!host) return;
    host.setAttribute('aria-busy', 'true');
    var sk = [];
    for (var i = 0; i < 9; i++) sk.push('<div class="lw-slot-sk" aria-hidden="true"></div>');
    host.innerHTML = sk.join('');
    var p = { service_id: w.service.id, date: date, limit: 200, one_per_time: 1 };
    if (w.staff) p.staff_id = w.staff.id;
    apiGet('availability', p).then(function (data) {
      if (w.date !== date) return; // user moved on to another day
      var now = Date.now();
      var slots = (data.slots || []).filter(function (s) { var t = Date.parse(s.starts_at); return t && t >= now; });
      host.setAttribute('aria-busy', 'false');
      if (!slots.length) { renderNoTimes(w, c, host, date, data.next_open); return; }
      host.innerHTML = slots.map(function (s) {
        return '<button class="lw-slot" data-iso="' + esc(s.starts_at) + '" role="listitem" aria-label="' + esc(timeLabel(s.starts_at)) + '">' + esc(timeLabel(s.starts_at)) + '</button>';
      }).join('');
      host.querySelectorAll('.lw-slot').forEach(function (b) {
        b.addEventListener('click', function () {
          host.querySelectorAll('.lw-slot').forEach(function (x) { x.classList.remove('sel'); });
          b.classList.add('sel');
          w.time = b.getAttribute('data-iso');
          if (w.managing) { stepRescheduleConfirm(w); return; }
          holdTime(w, c, b);
        });
      });
    }).catch(function (e) {
      host.setAttribute('aria-busy', 'false');
      host.innerHTML = '<div class="lw-empty">' + esc(e.message) + '</div>';
    });
  }

  // Hold the picked time for 5 minutes, then offer add-ons that fit.
  function holdTime(w, c, btn) {
    var err = w.host.querySelector('.lw-err');
    if (btn) { btn.disabled = true; btn.textContent = 'Holding…'; }
    releaseHold(w);
    apiPost({ action: 'hold', channel: 'public_web', service_id: w.service.id, staff_id: w.staff ? w.staff.id : null, starts_at: w.time, ttl_seconds: 300 })
      .then(function (r) {
        if (!r.ok || !r.hold) {
          if (err) err.textContent = errText(r, 'That time was just taken — pick another.');
          loadSlots(w, c, w.date);
          return;
        }
        w.hold = r.hold;
        w.heldStaff = r.hold.staff_name ? { id: r.hold.staff_id, name: r.hold.staff_name } : (w.staff || null);
        return apiPost({ action: 'addons', hold_token: r.hold.hold_token }).then(function (a) {
          var list = (a && a.ok && a.addons) || [];
          if (list.length) stepAddons(w, c, list); else { w.addons = []; stepDetails(w, c); }
        }, function () { w.addons = []; stepDetails(w, c); });
      })
      .catch(function (e) {
        if (err) err.textContent = e.message || 'Something went wrong.';
        if (btn) { btn.disabled = false; btn.textContent = timeLabel(w.time); }
      });
  }

  function renderNoTimes(w, c, host, date, next) {
    var html = '<div class="lw-empty" style="grid-column:1/-1">No open times on ' + esc(dayParts(date).long) + '.</div>';
    if (next && next.date) {
      html += '<div class="lw-next" style="grid-column:1/-1"><div class="lw-next-t">Next opening: <b>' + esc(dayParts(next.date).long) + '</b></div>' +
        '<div class="lw-slots">' + (next.times || []).map(function (t) {
          return '<button class="lw-slot" data-next="' + esc(t) + '">' + esc(timeLabel(t)) + '</button>';
        }).join('') + '</div><button class="lw-link" data-goto="' + esc(next.date) + '" style="margin-top:10px">See all times that day</button></div>';
    }
    html += '<div style="grid-column:1/-1" id="lwWlBox"></div>';
    host.innerHTML = html;
    host.querySelectorAll('[data-next]').forEach(function (b) {
      b.addEventListener('click', function () {
        w.time = b.getAttribute('data-next'); w.date = next.date;
        if (w.managing) { stepRescheduleConfirm(w); return; }
        holdTime(w, c, b);
      });
    });
    var go = host.querySelector('[data-goto]');
    if (go) go.addEventListener('click', function () {
      var k = go.getAttribute('data-goto'); w.date = k;
      var chip = w.host.querySelector('.lw-day[data-day="' + k + '"]');
      w.host.querySelectorAll('.lw-day').forEach(function (b) { b.classList.toggle('sel', b === chip); });
      var inp = w.host.querySelector('#lwDate'); if (inp) inp.value = k;
      loadSlots(w, c, k);
    });
    if (!w.managing) renderWaitlist(w, c, host.querySelector('#lwWlBox'), date);
  }

  function renderWaitlist(w, c, host, date) {
    host.innerHTML = '<div class="lw-wl"><div class="lw-wl-t">Get first dibs when a slot opens</div>' +
      '<div class="lw-wl-s">Leave your name and phone — ' + esc(c.tenant_name || 'the salon') + ' can text you when ' + esc(w.service.name) + ' has an opening.</div>' +
      '<div class="lw-wl-fld"><input id="lwWlName" placeholder="Your name" autocomplete="name"/></div>' +
      '<div class="lw-wl-fld"><input id="lwWlPhone" type="tel" inputmode="tel" placeholder="Mobile number" autocomplete="tel"/></div>' +
      '<label class="lw-wl-consent"><input type="checkbox" id="lwWlConsent"/><span>Yes — text me at this number when a slot opens. Msg &amp; data rates may apply. Reply STOP to opt out. <a href="' + LEGAL + '/sms-terms" target="_blank" rel="noopener" style="color:inherit">Terms</a></span></label>' +
      '<button class="lw-wl-btn" id="lwWlGo">Join the waitlist</button><div class="lw-wl-ok" id="lwWlOk" role="status"></div></div>';
    wirePhone(host.querySelector('#lwWlPhone'));
    host.querySelector('#lwWlGo').addEventListener('click', function () {
      var name = host.querySelector('#lwWlName').value.trim();
      var phone = host.querySelector('#lwWlPhone').value.trim();
      var ok = host.querySelector('#lwWlOk');
      var consent = host.querySelector('#lwWlConsent').checked;
      if (!name || !phoneValid(phone)) { ok.textContent = 'Please add your name and a valid mobile number.'; return; }
      if (!consent) { ok.textContent = 'Please check the box so we can text you when a slot opens.'; return; }
      var btn = host.querySelector('#lwWlGo');
      btn.disabled = true; btn.textContent = 'Adding…';
      apiPost({ action: 'waitlist_add', channel: 'public_widget', service_id: w.service.id, service_name: w.service.name, staff_id: w.staff ? w.staff.id : null, date: date, client_name: name, client_phone: phone, sms_consent: true })
        .then(function (result) {
          if (!result.ok) { ok.textContent = errText(result, 'Could not join the waitlist.'); btn.disabled = false; btn.textContent = 'Join the waitlist'; return; }
          ok.textContent = 'You’re on the waitlist.';
          btn.style.display = 'none';
        })
        .catch(function (e) { ok.textContent = e.message || 'Something went wrong.'; btn.disabled = false; btn.textContent = 'Join the waitlist'; });
    });
  }

  // ── add-ons: real menu services the same stylist can do right after ──
  function stepAddons(w, c, list) {
    w.addons = w.addons || [];
    var picked = {};
    w.addons.forEach(function (a) { picked[a.id] = true; });
    w.render(
      '<div class="lw-step on" data-step="addons" role="region" aria-label="Add-ons"><button class="lw-back" data-back aria-label="Back">← Back</button>' +
      '<div class="lw-label">Add something?</div>' +
      '<div class="lw-hold" aria-live="polite"></div>' +
      '<p class="lw-note">' + esc((w.heldStaff && w.heldStaff.name) || 'Your stylist') + ' has time right after your ' + esc(w.service.name) + ' for these:</p>' +
      '<div class="lw-opts">' + list.map(function (a, i) {
        return '<label class="lw-opt" style="cursor:pointer"><span><b>' + esc(a.name) + '</b><div class="meta">+' + a.duration_minutes + ' min</div>' +
          (a.description ? '<div class="desc">' + esc(a.description) + '</div>' : '') + '</span>' +
          '<span class="lw-price">+' + money(a.price) + ' <input type="checkbox" data-a="' + i + '"' + (picked[a.id] ? ' checked' : '') + ' aria-label="Add ' + esc(a.name) + '" style="margin-left:8px;accent-color:#ccff00;width:18px;height:18px;vertical-align:middle"/></span></label>';
      }).join('') + '</div>' +
      '<div class="lw-actions"><button class="lw-btn" id="lwAddonsNext">Continue</button></div></div>'
    );
    w.host.querySelector('[data-back]').addEventListener('click', function () { w.addons = []; stepTime(w, c); });
    w.host.querySelector('#lwAddonsNext').addEventListener('click', function () {
      var sel = [];
      w.host.querySelectorAll('input[data-a]').forEach(function (x) { if (x.checked) sel.push(list[Number(x.getAttribute('data-a'))]); });
      w.addons = sel;
      stepDetails(w, c, list);
    });
  }

  // ── step 4: details + confirm ───────────────────────────
  function depositLine(q) {
    if (!q) return '';
    if (q.required && q.amount_cents) return 'A ' + cents(q.amount_cents) + ' deposit is required to hold this appointment — you’ll pay it securely with Stripe right after booking (we’ll also text you the link). It goes toward your service.';
    if (q.maybe && q.amount_cents) return 'A deposit of ' + cents(q.amount_cents) + ' may be required (for example for new clients) — if so, you’ll pay it securely right after booking.';
    return '';
  }
  function stepDetails(w, c, addonList) {
    var hasStaff = !!(c.staff && c.staff.length);
    var staff = w.heldStaff || w.staff;
    var items = [w.service].concat(w.addons || []);
    var total = items.reduce(function (s, x) { return s + Number(x.price || 0); }, 0);
    w.render(
      progressHtml('details', hasStaff) +
      '<div class="lw-step on" data-step="details" role="region" aria-label="Your details"><button class="lw-back" data-back aria-label="Back">← Back</button>' +
      '<div class="lw-label">Your details</div>' +
      '<div class="lw-hold" aria-live="polite"></div>' +
      '<div id="lwWelcome"></div>' +
      '<div class="lw-summary"><b>' + items.map(function (x) { return esc(x.name); }).join(' + ') + '</b>' + (staff ? ' with <b>' + esc(staff.name) + '</b>' : '') +
      '<br>' + esc(whenLabel(w.time)) + (total ? ' · ' + money(total) : '') +
      '<div class="deposit-line" id="lwDep"></div>' + policyHtml(c, '') + '</div>' +
      '<div class="lw-fld"><label for="lwPhone">Mobile phone</label><input class="lw-inp" id="lwPhone" type="tel" inputmode="tel" placeholder="(555) 555-5555 or +44…" autocomplete="tel"/></div>' +
      '<div class="lw-fld"><label for="lwName">Name</label><input class="lw-inp" id="lwName" placeholder="Your name" autocomplete="name"/></div>' +
      '<div class="lw-fld"><label for="lwEmail">Email' + (c.require_email ? '' : ' (optional)') + '</label><input class="lw-inp" id="lwEmail" type="email" autocomplete="email"' + (c.require_email ? ' required' : '') + '/></div>' +
      '<button class="lw-btn" id="lwBook">Confirm booking</button><div class="lw-err" role="alert" aria-live="polite"></div>' +
      '<div class="lw-legal">By booking, you agree to get texts about this appointment (confirmation, reminders, changes) from ' + esc(c.tenant_name || 'the salon') + ' at this number. Msg frequency varies; msg &amp; data rates may apply. Reply STOP to opt out, HELP for help. Consent is not a condition of purchase. Calls with the salon may be recorded and answered by an AI assistant. <a href="' + LEGAL + '/sms-terms" target="_blank" rel="noopener">Messaging Terms</a> · <a href="' + LEGAL + '/privacy" target="_blank" rel="noopener">Privacy</a></div></div>'
    );
    var phoneInput = w.host.querySelector('#lwPhone');
    var nameInput = w.host.querySelector('#lwName');
    var welcome = w.host.querySelector('#lwWelcome');
    var dep = w.host.querySelector('#lwDep');
    var ids = items.map(function (x) { return x.id; });
    function quote(phone) {
      if (!c.deposit_may_apply) return;
      var q = { service_ids: ids };
      if (phone) q.client_phone = phone;
      apiPost(Object.assign({ action: 'deposit_quote' }, q)).then(function (r) {
        if (r && r.ok) { w.quote = r; if (dep) dep.textContent = depositLine(r); }
      }).catch(function () {});
    }
    quote(null);
    wirePhone(phoneInput, function (phone) {
      quote(phone);
      lookupClient(phone).then(function (cl) {
        if (!cl || !cl.first_name) return;
        if (welcome && !welcome.innerHTML) welcome.innerHTML = '<div class="lw-welcome">Welcome back, <b>' + esc(cl.first_name) + '</b>.</div>';
      });
    });
    w.host.querySelector('[data-back]').addEventListener('click', function () {
      if (addonList && addonList.length) stepAddons(w, c, addonList); else stepTime(w, c);
    });
    w.host.querySelector('#lwBook').addEventListener('click', function () { confirmBook(w, c); });
    focusFirst(w.host);
    if (nameInput) nameInput.setAttribute('autocapitalize', 'words');
  }

  function confirmBook(w, c) {
    var name = w.host.querySelector('#lwName').value.trim();
    var phone = w.host.querySelector('#lwPhone').value.trim();
    var email = w.host.querySelector('#lwEmail').value.trim();
    var err = w.host.querySelector('.lw-err');
    var btn = w.host.querySelector('#lwBook');
    if (!name) { err.textContent = 'Please add your name.'; return; }
    if (!phoneValid(phone)) { err.textContent = 'Please enter a valid mobile number (with country code if outside the US).'; return; }
    if (c.require_email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { err.textContent = 'Please add your email — this salon asks for it to book online.'; return; }
    err.textContent = '';
    btn.disabled = true; btn.textContent = 'Booking…';
    var items = [w.service].concat(w.addons || []);
    apiPost({
      action: 'book', channel: 'public_web',
      service_id: w.service.id, service_ids: items.map(function (x) { return x.id; }),
      staff_id: w.hold ? null : (w.staff ? w.staff.id : null), hold_token: w.hold ? w.hold.hold_token : null,
      starts_at: w.time, client_name: name, client_phone: phone, client_email: email || null,
      sms_consent: 'transactional', consent_text_version: '2026-10-01'
    }).then(function (result) {
      if (!result.ok) {
        err.textContent = errText(result, 'Could not complete booking.');
        btn.disabled = false; btn.textContent = 'Confirm booking';
        return;
      }
      w.hold = null; // converted into the booking
      renderDone(w, c, result, phone, items);
    }).catch(function (e) {
      err.textContent = e.message || 'Something went wrong.';
      btn.disabled = false; btn.textContent = 'Confirm booking';
    });
  }

  function renderDone(w, c, result, phone, items) {
    var b = result.booking || {};
    var code = b.confirmation_code;
    var staffName = b.staff_name || (w.heldStaff && w.heldStaff.name) || '';
    var calHref = result.calendar_path ? ORIGIN + result.calendar_path : '';
    var pay = result.payment_link && /^https:\/\//.test(result.payment_link) ? result.payment_link : '';
    var sub = esc(items.map(function (x) { return x.name; }).join(' + ')) + (staffName ? ' with ' + esc(staffName) : '') + '<br>' + esc(whenLabel(b.start_time || w.time)) + '.';
    sub += result.texted ? '<br>We’ve texted your confirmation.' : '<br>Keep the code below — you’ll need it to change or cancel online.';
    var payHtml = '';
    if (pay) {
      payHtml = '<div class="lw-summary" style="margin-top:14px"><div class="deposit-line" style="margin-top:0">A ' + cents(result.deposit && result.deposit.amount_cents) + ' deposit holds this appointment.' +
        (result.texted ? ' We also texted you the payment link.' : '') + '</div><div class="lw-hold" id="lwPayNote" style="margin:6px 0 0">Taking you to secure payment…</div></div>' +
        '<a class="lw-btn" href="' + esc(pay) + '" id="lwPay" rel="noopener">Pay deposit securely</a>';
    }
    w.render(
      '<div class="lw-step on" data-step="done" role="status" aria-live="polite"><div class="lw-orb"></div>' +
      '<div class="lw-done-title">You’re booked!</div>' +
      '<div class="lw-done-sub">' + sub + '</div>' +
      (code ? '<div class="lw-code">Your code: <b>' + esc(code) + '</b></div>' : '') +
      payHtml +
      '<div class="lw-actions">' + (calHref ? '<a class="lw-btn ghost" href="' + esc(calHref) + '" download="appointment.ics">Add to calendar</a>' : '') + '</div>' +
      policyHtml(c, '') +
      '<button class="lw-link" data-cancel>Manage or cancel this appointment</button></div>'
    );
    w.host.querySelector('[data-cancel]').addEventListener('click', function () { stepManage(w, { code: code, phone: phone }); });
    if (pay) {
      // The deposit is what holds the slot: go straight to Stripe's page.
      setTimeout(function () { try { (window.top || window).location.href = pay; } catch (e) { location.href = pay; } }, 2500);
    }
  }

  // ── self-service: look up by code + phone, then reschedule/cancel ──
  function stepManage(w, prefill) {
    releaseHold(w);
    prefill = prefill || {};
    var code = (prefill.code || (w.managing && w.managing.code) || '').trim();
    var phone = prefill.phone || (w.managing && w.managing.phone) || '';
    w.render(
      '<div class="lw-step on" data-step="manage"><button class="lw-back" data-back>← Back</button>' +
      '<div class="lw-label">Manage an appointment</div>' +
      '<p class="lw-note">Find your booking with the code from your confirmation.</p>' +
      '<div class="lw-fld"><label for="lwMCode">Confirmation code</label><input class="lw-inp" id="lwMCode" value="' + esc(code) + '" placeholder="e.g. AB3X7Q" autocomplete="off"/></div>' +
      '<div class="lw-fld"><label for="lwMPhone">Phone used to book</label><input class="lw-inp" id="lwMPhone" type="tel" inputmode="tel" value="' + esc(phone) + '" placeholder="(555) 555-5555"/></div>' +
      '<button class="lw-btn" id="lwLookup">Find my appointment</button><div class="lw-err" role="alert"></div></div>'
    );
    w.host.querySelector('[data-back]').addEventListener('click', function () { w.managing = null; if (w.catalog) stepService(w, w.catalog); });
    w.host.querySelector('#lwLookup').addEventListener('click', function () { doLookup(w); });
    wirePhone(w.host.querySelector('#lwMPhone'));
    var f = w.host.querySelector(code ? '#lwMPhone' : '#lwMCode');
    try { if (f) f.focus({ preventScroll: true }); } catch (e) {}
  }

  function doLookup(w) {
    var code = w.host.querySelector('#lwMCode').value.trim().toUpperCase();
    var phone = w.host.querySelector('#lwMPhone').value.trim();
    var err = w.host.querySelector('.lw-err');
    var btn = w.host.querySelector('#lwLookup');
    if (!code || !phone) { err.textContent = 'Enter your code and the phone you booked with.'; return; }
    err.textContent = '';
    btn.disabled = true; btn.textContent = 'Finding…';
    apiPost({ action: 'lookup', channel: 'public_widget', code: code, client_phone: phone })
      .then(function (result) {
        if (!result.ok) {
          err.textContent = errText(result, 'Could not find that booking.');
          btn.disabled = false; btn.textContent = 'Find my appointment';
          return;
        }
        w.managing = { code: code, phone: phone, booking: result.booking, policy: result.policy || null };
        renderManageCard(w, result.booking, result.policy);
      })
      .catch(function (e) {
        err.textContent = e.message || 'Something went wrong.';
        btn.disabled = false; btn.textContent = 'Find my appointment';
      });
  }

  function renderManageCard(w, b, policy) {
    var cancelled = b.status === 'cancelled' || b.status === 'canceled';
    var staffName = (b.staff && b.staff.name) || '';
    var locked = policy && policy.can_change_online === false && !cancelled;
    var phone = (policy && policy.salon_phone) || (w.catalog && w.catalog.phone) || '';
    w.render(
      '<div class="lw-step on" data-step="manage-card">' +
      '<div class="lw-label">' + esc((b.service && b.service.name) || 'Appointment') + (staffName ? ' · ' + esc(staffName) : '') + '</div>' +
      '<div class="lw-card">' +
      '<div class="lw-card-when">' + esc(whenLabel(b.start_time)) + '</div>' +
      (b.service && b.service.price != null ? '<div class="lw-card-meta">' + money(b.service.price) + (b.service.duration_minutes ? ' · ' + b.service.duration_minutes + ' min' : '') + '</div>' : '') +
      (cancelled ? '<div class="lw-card-meta" style="color:#ff7a7a">This appointment is cancelled.</div>' : '') +
      '</div>' +
      (cancelled ? '<button class="lw-btn" id="lwNewBook">Book a new appointment</button>' :
        locked ? '<p class="lw-note">Your appointment is less than ' + esc(policy.cancellation_window_hours) + ' hours away, so it can’t be changed online. ' + (phone ? 'Please call the salon at <b>' + esc(phone) + '</b>.' : 'Please call the salon.') + '</p>' :
        '<button class="lw-btn" id="lwResched">Pick a new time</button>' +
        '<button class="lw-link" data-cancel>Cancel this appointment instead</button>') +
      '<div class="lw-err" role="alert"></div></div>'
    );
    if (cancelled) {
      w.host.querySelector('#lwNewBook').addEventListener('click', function () {
        w.managing = null;
        if (w.catalog) stepService(w, w.catalog);
      });
      return;
    }
    if (locked) return;
    w.host.querySelector('#lwResched').addEventListener('click', function () { startReschedule(w); });
    w.host.querySelector('[data-cancel]').addEventListener('click', function () {
      stepCancel(w, { code: w.managing.code, phone: w.managing.phone });
    });
  }

  function startReschedule(w) {
    var b = w.managing && w.managing.booking;
    if (!b || !b.service) { stepManage(w); return; }
    var cat = w.catalog;
    var svc = (cat.services || []).filter(function (s) { return s.id === b.service.id; })[0] || null;
    if (!svc) { w.msg('warn', 'That service is no longer offered online — please book a new appointment instead.'); return; }
    w.service = svc;
    // Default: the same stylist (their id, so availability is theirs).
    w.staff = b.staff && b.staff.id ? { id: b.staff.id, name: b.staff.name } : null;
    if (cat.staff && cat.staff.length) stepStaff(w, cat); else stepTime(w, cat);
  }

  function stepRescheduleConfirm(w) {
    w.render(
      '<div class="lw-step on" data-step="rconfirm"><button class="lw-back" data-back>← Back</button>' +
      '<div class="lw-label">Move your appointment</div>' +
      '<div class="lw-summary"><b>' + esc(w.service.name) + '</b>' +
      (w.staff ? ' with <b>' + esc(w.staff.name) + '</b>' : '') +
      '<br>New time: <b>' + esc(whenLabel(w.time)) + '</b>' + policyHtml(w.catalog || {}, '') + '</div>' +
      '<button class="lw-btn" id="lwReschedBtn">Confirm new time</button><div class="lw-err" role="alert"></div></div>'
    );
    w.host.querySelector('[data-back]').addEventListener('click', function () { stepTime(w, w.catalog); });
    w.host.querySelector('#lwReschedBtn').addEventListener('click', function () { doReschedule(w); });
  }

  function doReschedule(w) {
    var m = w.managing;
    var err = w.host.querySelector('.lw-err');
    var btn = w.host.querySelector('#lwReschedBtn');
    btn.disabled = true; btn.textContent = 'Moving your appointment…';
    apiPost({
      action: 'reschedule', channel: 'public_widget',
      code: m.code, client_phone: m.phone,
      starts_at: w.time, staff_id: w.staff ? w.staff.id : null
    }).then(function (result) {
      if (!result.ok) {
        err.textContent = errText(result, 'Could not reschedule.');
        btn.disabled = false; btn.textContent = 'Confirm new time';
        return;
      }
      var when = whenLabel(w.time);
      var code = m.code, phone = m.phone;
      w.managing = null;
      var calHref = ORIGIN + '/api/calendar.ics?code=' + encodeURIComponent(code) + '&phone=' + encodeURIComponent(phone);
      w.render(
        '<div class="lw-step on" data-step="rescheduled"><div class="lw-orb"></div>' +
        '<div class="lw-done-title">You’re all set</div>' +
        '<div class="lw-done-sub">Your appointment is now <b>' + esc(when) + '</b>.<br>Your code stays the same: <b>' + esc(code) + '</b>.</div>' +
        '<div class="lw-actions"><a class="lw-btn ghost" href="' + esc(calHref) + '" download="appointment.ics">Add to calendar</a></div>' +
        '<button class="lw-link" data-more>Manage another appointment</button></div>'
      );
      w.host.querySelector('[data-more]').addEventListener('click', function () { stepManage(w); });
    }).catch(function (e) {
      err.textContent = e.message || 'Something went wrong.';
      btn.disabled = false; btn.textContent = 'Confirm new time';
    });
  }

  function stepCancel(w, prefill) {
    prefill = prefill || {};
    w.render(
      '<div class="lw-step on" data-step="cancel"><button class="lw-back" data-back>← Back</button>' +
      '<div class="lw-label">Cancel an appointment</div>' +
      '<div class="lw-fld"><label for="lwCode">Confirmation code</label><input class="lw-inp" id="lwCode" value="' + esc(prefill.code || '') + '" placeholder="e.g. AB3X7Q" autocomplete="off"/></div>' +
      '<div class="lw-fld"><label for="lwCancelPhone">Phone used to book</label><input class="lw-inp" id="lwCancelPhone" type="tel" inputmode="tel" value="' + esc(prefill.phone || '') + '" placeholder="(555) 555-5555"/></div>' +
      policyHtml(w.catalog || {}, '') +
      '<button class="lw-btn" id="lwCancelBtn">Cancel appointment</button><div class="lw-err" role="alert"></div></div>'
    );
    w.host.querySelector('[data-back]').addEventListener('click', function () {
      if (w.managing) { renderManageCard(w, w.managing.booking, w.managing.policy); return; }
      if (w.catalog) stepService(w, w.catalog);
    });
    w.host.querySelector('#lwCancelBtn').addEventListener('click', function () { doCancel(w); });
    wirePhone(w.host.querySelector('#lwCancelPhone'));
  }

  function doCancel(w) {
    var code = w.host.querySelector('#lwCode').value.trim();
    var phone = w.host.querySelector('#lwCancelPhone').value.trim();
    var err = w.host.querySelector('.lw-err');
    var btn = w.host.querySelector('#lwCancelBtn');
    if (!code || !phone) { err.textContent = 'Enter your code and the phone you booked with.'; return; }
    err.textContent = '';
    btn.disabled = true; btn.textContent = 'Cancelling…';
    apiPost({ action: 'cancel', channel: 'public_widget', code: code, client_phone: phone })
      .then(function (result) {
        if (!result.ok) {
          err.textContent = errText(result, 'Could not cancel.');
          btn.disabled = false; btn.textContent = 'Cancel appointment';
          return;
        }
        w.managing = null;
        w.render(
          '<div class="lw-step on" data-step="cancelled"><div class="lw-orb" style="background:radial-gradient(circle at 35% 30%,#ffd9c0,#ff7a7a 55%,#7a1e00)"></div>' +
          '<div class="lw-done-title">Cancelled</div>' +
          '<div class="lw-done-sub">Your appointment is cancelled.<br>' +
          '<button class="lw-link" data-rebook>Book something else</button></div></div>'
        );
        w.host.querySelector('[data-rebook]').addEventListener('click', function () {
          if (w.catalog) stepService(w, w.catalog);
        });
      })
      .catch(function (e) {
        err.textContent = e.message || 'Something went wrong.';
        btn.disabled = false; btn.textContent = 'Cancel appointment';
      });
  }

  // Silent adoption beacon — fires on every boot, first-party AND embedded
  // sites, so LolaDesk knows which salons actually put the widget online.
  function beacon() {
    try {
      var p = new URLSearchParams({
        tenant: cfg.tenant, kind: 'widget_load',
        origin: (location.href || '').slice(0, 300),
        host: (location.host || '').slice(0, 120)
      });
      var url = API.replace(/\/[^/]*$/, '/widget-beacon') + '?' + p.toString();
      if (navigator.sendBeacon) { navigator.sendBeacon(url, ''); }
      else { fetch(url, { method: 'POST', keepalive: true }).catch(function () {}); }
    } catch (e) { /* never break the widget */ }
  }

  function boot() {
    if (!cfg.tenant) {
      var missing = document.createElement('div');
      missing.textContent = 'Booking widget: missing data-tenant attribute.';
      (SCRIPT.parentNode || document.body).appendChild(missing);
      return;
    }
    beacon();

    var host = document.createElement('div');
    host.id = 'loladesk-widget';
    var shadow = host.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = SHEET;
    shadow.appendChild(style);
    var frame = document.createElement('div');
    frame.className = 'lw';
    shadow.appendChild(frame);

    var open = null;
    if (cfg.mode === 'modal') {
      shadow.removeChild(frame);
      var fab = document.createElement('button');
      fab.className = 'lw-fab';
      fab.textContent = (SCRIPT && SCRIPT.getAttribute('data-label')) || 'Book now';
      shadow.appendChild(fab);
      var overlay = document.createElement('div');
      overlay.className = 'lw-overlay';
      overlay.style.display = 'none';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      var box = document.createElement('div');
      box.style.cssText = 'position:relative;width:100%;max-width:520px';
      var close = document.createElement('button');
      close.className = 'lw-close'; close.setAttribute('aria-label', 'Close'); close.textContent = '✕';
      close.style.zIndex = '2';
      box.appendChild(close); box.appendChild(frame); overlay.appendChild(box);
      shadow.appendChild(overlay);
      var hide = function () { overlay.style.display = 'none'; fab.style.display = ''; };
      open = function () { overlay.style.display = 'flex'; fab.style.display = 'none'; };
      close.addEventListener('click', hide);
      overlay.addEventListener('click', function (e) { if (e.target === overlay) hide(); });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && overlay.style.display !== 'none') hide(); });
      fab.addEventListener('click', open);
      document.addEventListener('click', function (e) {
        var t = e.target && e.target.closest && e.target.closest('[data-loladesk-book]');
        if (t) { e.preventDefault(); open(); }
      });
      document.body.appendChild(host);
    } else {
      (SCRIPT.parentNode || document.body).appendChild(host);
    }

    var w = new Widget(shadow);
    w.render('<div class="lw-name">Loading…</div>');
    window.addEventListener('pagehide', function () { if (w.hold) releaseHold(w); });

    apiGet('catalog').then(function (data) {
      var salon = data.salon || {};
      var bk = data.booking || {};
      TZ = salon.timezone || data.timezone || '';
      try { if (TZ) new Date().toLocaleString([], { timeZone: TZ }); } catch (e) { TZ = ''; }
      var dp = data.deposit_policy || null;
      var c = {
        name: salon.name || data.name || 'Book an appointment',
        location: salon.location || data.location || '',
        phone: salon.phone || '',
        tenant_name: salon.name || data.name || '',
        enabled: bk.enabled !== false,
        message: bk.message || '',
        allow_any_staff: bk.allow_any_staff !== false,
        require_email: bk.require_email === true,
        cancellation_window_hours: bk.cancellation_window_hours != null ? bk.cancellation_window_hours : (salon.cancellation_window_hours || 0),
        deposit_may_apply: !!(salon.deposit_may_apply || (dp && dp.collects)),
        deposit_everyone: !!(dp && dp.who === 'everyone'),
        services: data.services || [], staff: data.staff || []
      };
      state.catalog = c;
      w.catalog = c;
      w.header = '<div class="lw-name">' + esc(c.name) + '</div>' +
        (c.location ? '<div class="lw-meta">' + esc(c.location) + '</div>' : '<div class="lw-meta"></div>');
      // Deep link: /book?t=slug&code=AB3X7Q opens "manage" with the code filled in.
      if (cfg.code) { if (open) open(); stepManage(w, { code: cfg.code, phone: cfg.phone }); }
      else stepService(w, c);
    }).catch(function (e) {
      w.render('<div class="lw-name">Unavailable</div><div class="lw-meta">' + esc(e.message) + '</div>');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
