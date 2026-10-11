/* ============================================================================
 * LolaDesk Booking Widget — the open-source, embeddable booking system.
 * ════════════════════════════════════════════════════════════════════════════
 * Drop Lola's booking engine onto ANY website with one script tag. No SDK, no
 * build step, no account code. The widget talks to the same /api/public-booking
 * endpoint Lola's voice uses, so web, phone, and dashboard bookings all share
 * one conflict-free calendar.
 *
 *   <script src="https://www.loladesk.com/booking-widget.js"
 *           data-tenant="YOUR-SLUG"
 *           data-accent="#b08d57"   (optional — else the salon's own color, else neutral)
 *           data-theme="light"      (optional: light | dark — default follows the device)
 *           data-mode="inline"      (inline | modal, default inline)
 *           data-base="/api/public-booking"  (optional, same-origin default)
 *   ></script>
 *
 * Modal mode adds a floating "Book now" button that opens the flow.
 * Inline mode renders the full flow immediately after the script tag.
 * The salon's own page lives at /b/<slug> (or /book?t=<slug>).
 * ========================================================================== */
(function () {
  'use strict';

  var SCRIPT = document.currentScript;
  var attr = function (k) { return (SCRIPT && SCRIPT.getAttribute(k)) || ''; };
  var cfg = {
    tenant: attr('data-tenant'),
    accent: /^#[0-9a-f]{6}$/i.test(attr('data-accent')) ? attr('data-accent') : '',
    theme: attr('data-theme'),
    mode: attr('data-mode') || 'inline',
    base: attr('data-base'),
    page: attr('data-page') === '1' // the hosted booking page (book.html): owns title + meta
  };
  // Embedded on a salon's own website or Google Business link: talk to the
  // LolaDesk server the script came from, not the host site.
  if (!cfg.base) {
    try { cfg.base = new URL(SCRIPT.src, location.href).origin + '/api/public-booking'; }
    catch (e) { cfg.base = '/api/public-booking'; }
  }

  // The salon: data-tenant, else /b/<slug>, else the classic ?t= / ?slug= params.
  var Q = new URLSearchParams(location.search);
  if (!cfg.tenant) {
    var pm = /^\/b\/([^/?#]+)/.exec(location.pathname || '');
    if (pm) { try { cfg.tenant = decodeURIComponent(pm[1]); } catch (e) { cfg.tenant = pm[1]; } }
  }
  if (!cfg.tenant) cfg.tenant = Q.get('t') || Q.get('slug') || '';
  cfg.tenant = String(cfg.tenant).trim().slice(0, 80);
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

  // ── color: the salon's accent (or a neutral ink), always legible ──────────
  function rgb(hex) { var n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function lum(hex) {
    var c = rgb(hex).map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function onColor(hex) { var L = lum(hex); return (1.05 / (L + 0.05)) >= ((L + 0.05) / 0.05) ? '#ffffff' : '#111111'; }
  function accentVars(hex) {
    var INK_L = '#161616', INK_D = '#f4f3f1';
    var ok = /^#[0-9a-f]{6}$/i.test(hex || '');
    // A near-white accent vanishes on white, a near-black one on dark: use ink there.
    var l = ok && lum(hex) < 0.62 ? hex : INK_L;
    var d = ok && lum(hex) > 0.06 ? hex : INK_D;
    return '--acc-l:' + l + ';--on-acc-l:' + onColor(l) + ';--acc-d:' + d + ';--on-acc-d:' + onColor(d);
  }

  var EASE = 'cubic-bezier(.22,1,.36,1)';
  var LIGHT = '--bg:#ffffff;--page:#ffffff;--surface:#f7f6f4;--surface2:#efeeeb;--line:#e7e5e1;--line2:#d9d6d0;--text:#151515;--muted:#6a6862;--dim:#98958e;--ok:#1f7a4d;--bad:#b42318;--shadow:0 1px 2px rgba(20,20,20,.04),0 8px 28px rgba(20,20,20,.06);--accent:var(--acc-l);--on-accent:var(--on-acc-l)';
  var DARK = '--bg:#0d0d0e;--page:#0d0d0e;--surface:#17171a;--surface2:#1f1f23;--line:#2a2a2f;--line2:#3a3a40;--text:#f4f3f1;--muted:#a3a19b;--dim:#6f6d68;--ok:#6fd39b;--bad:#ff8a80;--shadow:0 1px 2px rgba(0,0,0,.3),0 10px 30px rgba(0,0,0,.35);--accent:var(--acc-d);--on-accent:var(--on-acc-d)';

  var SHEET = [
    ':host{all:initial;display:block}',
    '.lw{' + accentVars('') + ';' + LIGHT + ';font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display","Helvetica Neue",Inter,"Segoe UI",Roboto,Arial,sans-serif;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;color:var(--text);background:var(--bg);font-size:15px;line-height:1.45;text-align:left;-webkit-tap-highlight-color:transparent}',
    '.lw.t-dark{' + DARK + '}',
    '@media (prefers-color-scheme:dark){.lw:not(.t-light){' + DARK + '}}',
    '*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}',
    '.lw{min-height:100%;padding:28px 20px 40px;border-radius:20px;border:1px solid var(--line)}',
    '.lw.lw-page{border:0;border-radius:0;padding:max(20px,env(safe-area-inset-top)) 20px 56px;background:transparent}',
    '@media (min-width:640px){.lw.lw-page{border:1px solid var(--line);border-radius:24px;padding:36px 36px 40px;background:var(--bg);box-shadow:var(--shadow)}}',
    'button,input,a{font:inherit;color:inherit}',
    'button{-webkit-appearance:none;appearance:none}',
    '.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}',
    /* header */
    '.lw-cover{height:132px;margin:-8px 0 -30px;border-radius:16px;background:var(--surface2) center/cover no-repeat}',
    '.lw-head{display:flex;align-items:center;gap:14px;margin-bottom:26px}',
    '.lw-cover+.lw-head{flex-direction:column;align-items:flex-start;gap:12px}',
    '.lw-logo{flex:0 0 auto;width:56px;height:56px;border-radius:16px;overflow:hidden;background:var(--surface);border:1px solid var(--line);display:flex;align-items:center;justify-content:center}',
    '.lw-cover+.lw-head .lw-logo{width:64px;height:64px;border:3px solid var(--bg);box-shadow:var(--shadow);margin-left:12px}',
    '.lw-logo img{width:100%;height:100%;object-fit:cover;display:block}',
    '.lw-mono{width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:var(--accent);color:var(--on-accent);font-family:ui-serif,"New York","Iowan Old Style",Georgia,"Times New Roman",serif;font-size:21px;letter-spacing:.04em}',
    '.lw-name{font-size:22px;font-weight:650;letter-spacing:-.02em;line-height:1.2}',
    '.lw-meta{color:var(--muted);font-size:13.5px;margin-top:3px;display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center}',
    '.lw-star{color:var(--text);font-weight:600}',
    '.lw-head.compact{margin-bottom:18px;gap:10px}',
    '.lw-head.compact .lw-logo{width:32px;height:32px;border-radius:10px}',
    '.lw-head.compact .lw-mono{font-size:13px}',
    '.lw-head.compact .lw-name{font-size:15px;font-weight:600;letter-spacing:-.01em}',
    /* progress */
    '.lw-progress{display:flex;gap:8px;margin:0 0 10px;list-style:none}',
    '.lw-progress li{flex:1;min-width:0;font-size:11.5px;font-weight:600;letter-spacing:.02em;color:var(--dim);padding-top:9px;border-top:2px solid var(--line);transition:color .3s ' + EASE + ',border-color .3s ' + EASE + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.lw-progress li.done{color:var(--muted);border-color:var(--text)}',
    '.lw-progress li.on{color:var(--text);border-color:var(--accent)}',
    '.lw-progress li span{opacity:.6;margin-right:5px;font-variant-numeric:tabular-nums}',
    /* steps */
    '.lw-step{display:none}.lw-step.on{display:block;animation:lwin .28s ' + EASE + '}',
    '@keyframes lwin{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',
    '.lw-top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px}',
    '.lw-back{color:var(--muted);font-size:14px;cursor:pointer;background:none;border:none;padding:10px 12px 10px 0;min-height:44px;display:inline-flex;align-items:center;gap:6px}',
    '.lw-back:hover{color:var(--text)}',
    '.lw-h{font-size:20px;font-weight:650;letter-spacing:-.02em;line-height:1.25;margin:0 0 16px}',
    '.lw-label{font-size:12px;color:var(--muted);font-weight:600;letter-spacing:.06em;text-transform:uppercase;margin:0 0 12px}',
    '.lw-sub{font-size:14px;color:var(--muted);margin:-8px 0 18px}',
    /* option rows (services, stylists, add-ons) */
    '.lw-opts{display:flex;flex-direction:column;gap:10px}',
    '.lw-opt{background:var(--bg);border:1px solid var(--line);border-radius:16px;padding:14px 16px;min-height:68px;text-align:left;cursor:pointer;display:flex;gap:14px;align-items:center;width:100%;transition:border-color .18s ' + EASE + ',background .18s ' + EASE + ',transform .12s ' + EASE + '}',
    '.lw-opt:hover{border-color:var(--line2);background:var(--surface)}',
    '.lw-opt:active{transform:scale(.99)}',
    '.lw-opt.sel{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent) inset}',
    '.lw-opt b{font-weight:600;font-size:15.5px;letter-spacing:-.01em;display:block}',
    '.lw-opt .meta{font-size:13px;color:var(--muted);margin-top:2px}',
    '.lw-opt .desc{font-size:13px;color:var(--muted);margin-top:4px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
    '.lw-body{min-width:0;flex:1}',
    '.lw-price{font-size:15px;font-weight:600;white-space:nowrap;margin-left:auto;padding-left:10px;font-variant-numeric:tabular-nums;align-self:flex-start;margin-top:1px}',
    '.lw-chev{flex:0 0 auto;color:var(--dim);font-size:18px;line-height:1}',
    '.lw-thumb{flex:0 0 auto;width:60px;height:60px;border-radius:12px;background:var(--surface2) center/cover no-repeat}',
    '.lw-av{flex:0 0 auto;width:52px;height:52px;border-radius:50%;background:var(--surface2) center/cover no-repeat;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:16px;color:var(--muted);letter-spacing:.02em}',
    '.lw-av.any{background:var(--surface);border:1px dashed var(--line2);font-size:20px}',
    '.lw-next{display:inline-flex;align-items:center;gap:6px;margin-top:6px;font-size:12.5px;font-weight:600;color:var(--ok)}',
    '.lw-next::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}',
    '.lw-next.none{color:var(--dim)}',
    '.lw-next.none::before{display:none}',
    '.lw-next-sk{display:inline-block;margin-top:8px;width:110px;height:12px;border-radius:6px}',
    '.lw-cat{font-size:12px;color:var(--muted);font-weight:600;letter-spacing:.06em;text-transform:uppercase;margin:26px 0 10px}',
    '.lw-cat:first-child{margin-top:0}',
    '.lw-chip{display:inline-block;margin-top:7px;font-size:11.5px;font-weight:600;color:var(--muted);background:var(--surface);border:1px solid var(--line);border-radius:20px;padding:2px 9px}',
    /* days + slots */
    '.lw-days{display:flex;gap:8px;overflow-x:auto;padding:2px 2px 12px;margin:0 -2px 4px;scrollbar-width:none;-webkit-overflow-scrolling:touch;scroll-snap-type:x proximity}',
    '.lw-days::-webkit-scrollbar{display:none}',
    '.lw-day{flex:0 0 auto;width:58px;min-height:70px;background:var(--bg);border:1px solid var(--line);border-radius:14px;padding:9px 0 8px;text-align:center;cursor:pointer;scroll-snap-align:start;transition:border-color .18s ' + EASE + ',background .18s ' + EASE + '}',
    '.lw-day small{display:block;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-weight:600}',
    '.lw-day b{display:block;font-size:18px;font-weight:600;margin-top:2px;font-variant-numeric:tabular-nums}',
    '.lw-day i{display:block;width:5px;height:5px;border-radius:50%;margin:5px auto 0;background:transparent}',
    '.lw-day.open i{background:var(--ok)}',
    '.lw-day.closed{color:var(--dim)}.lw-day.closed b{color:var(--dim);font-weight:500}',
    '.lw-day:hover{border-color:var(--line2)}',
    '.lw-day.sel{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}',
    '.lw-day.sel small,.lw-day.sel b{color:var(--on-accent)}.lw-day.sel i{background:var(--on-accent)}',
    '.lw-more{display:flex;align-items:center;gap:10px;margin:0 0 18px;font-size:13px;color:var(--muted)}',
    '.lw-more .lw-date{margin:0;padding:9px 12px;font-size:14px;width:auto;flex:1;min-width:0;min-height:42px}',
    '.lw-dayname{font-size:15px;font-weight:600;margin:0 0 12px;letter-spacing:-.01em}',
    '.lw-part{font-size:12px;color:var(--muted);font-weight:600;letter-spacing:.04em;margin:10px 0 0;grid-column:1/-1}',
    '.lw-part:first-child{margin-top:0}',
    '.lw-slots{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}',
    '@media (min-width:480px){.lw-slots{grid-template-columns:repeat(4,1fr)}}',
    '.lw-slot{background:var(--bg);border:1px solid var(--line);border-radius:12px;min-height:48px;padding:0 6px;text-align:center;cursor:pointer;font-size:14.5px;font-weight:500;width:100%;font-variant-numeric:tabular-nums;transition:border-color .15s ' + EASE + ',background .15s ' + EASE + '}',
    '.lw-slot:hover{border-color:var(--line2);background:var(--surface)}',
    '.lw-slot.sel,.lw-slot:disabled{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}',
    '.lw-sk{background:linear-gradient(90deg,var(--surface) 0%,var(--surface2) 50%,var(--surface) 100%);background-size:200% 100%;animation:lwsk 1.4s ease-in-out infinite}',
    '.lw-slot-sk{border-radius:12px;height:48px}',
    '@keyframes lwsk{0%{background-position:200% 0}100%{background-position:-200% 0}}',
    '.lw-empty{color:var(--muted);font-size:14px;padding:18px 0 6px;text-align:center}',
    '.lw-nextbox{margin:10px 0 4px;padding:16px;border:1px solid var(--line);border-radius:16px;background:var(--surface)}',
    '.lw-nextbox-t{font-size:14px;margin-bottom:12px}',
    /* forms */
    '.lw-date,.lw-inp{width:100%;border:1px solid var(--line2);background:var(--bg);color:var(--text);border-radius:12px;padding:13px 14px;font-size:16px;min-height:50px;outline:none;transition:border-color .18s ' + EASE + ',box-shadow .18s ' + EASE + '}',
    '.lw-date:focus,.lw-inp:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--surface2)}',
    '.lw-fld{margin-bottom:14px}.lw-fld label{display:block;font-size:13px;font-weight:600;color:var(--text);margin-bottom:6px}',
    '.lw-fld label em{font-style:normal;font-weight:400;color:var(--muted)}',
    '.lw-summary{background:var(--surface);border-radius:16px;padding:16px;margin-bottom:18px;font-size:14px;color:var(--muted);line-height:1.55}',
    '.lw-summary b{color:var(--text);font-weight:600}',
    '.lw-sum-row{display:flex;justify-content:space-between;gap:12px}',
    '.lw-sum-when{color:var(--text);font-size:15px;font-weight:600;margin-top:2px}',
    '.lw-sum-total{font-variant-numeric:tabular-nums;color:var(--text);font-weight:600;white-space:nowrap}',
    '.lw-summary .deposit-line{color:var(--text);margin-top:8px;font-size:13px}',
    '.lw-summary .deposit-line:empty{display:none}',
    '.lw-btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:54px;padding:14px 18px;border-radius:14px;font-size:16px;font-weight:600;letter-spacing:-.01em;cursor:pointer;border:none;margin-top:8px;background:var(--accent);color:var(--on-accent);text-decoration:none;text-align:center;transition:opacity .15s ' + EASE + ',transform .12s ' + EASE + '}',
    '.lw-btn:not(:disabled):hover{opacity:.9}',
    '.lw-btn:not(:disabled):active{transform:scale(.99)}',
    '.lw-btn:disabled{opacity:.45;cursor:not-allowed}',
    '.lw-btn.ghost{background:var(--bg);color:var(--text);border:1px solid var(--line2)}',
    '.lw-btn.ghost:hover{background:var(--surface);opacity:1}',
    '.lw-err{color:var(--bad);font-size:13.5px;margin-top:10px;min-height:18px}',
    '.lw-err:empty{min-height:0;margin:0}',
    '.lw-legal{font-size:11.5px;line-height:1.55;color:var(--dim);margin-top:14px}',
    '.lw-legal a{color:inherit;text-decoration:underline}',
    '.lw-note{color:var(--muted);font-size:14px;line-height:1.6;margin:0 0 16px}',
    '.lw-hold{font-size:13px;color:var(--muted);margin:0 0 14px;display:flex;align-items:center;gap:8px}',
    '.lw-hold:empty{display:none}',
    '.lw-hold b{color:var(--text);font-weight:600;font-variant-numeric:tabular-nums}',
    '.lw-policy{font-size:12.5px;color:var(--muted);line-height:1.55;border-top:1px solid var(--line);padding-top:10px;margin-top:12px}',
    '.lw-welcome{background:var(--surface);border-radius:14px;padding:12px 14px;margin-bottom:16px;font-size:14px;color:var(--text)}',
    '.lw-welcome b{font-weight:600}',
    '.lw-check{display:flex;gap:10px;align-items:flex-start;margin:6px 0 4px;cursor:pointer}',
    '.lw-check input{width:20px;height:20px;margin-top:1px;accent-color:var(--accent);flex:0 0 auto}',
    '.lw-check span{font-size:13px;line-height:1.45}',
    '.lw-box{flex:0 0 auto;width:24px;height:24px;accent-color:var(--accent);cursor:pointer}',
    '.lw-actions{display:flex;flex-direction:column;gap:8px;margin-top:18px}',
    '.lw-row2{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
    '.lw-row2 .lw-btn{margin-top:0;font-size:14.5px;min-height:50px}',
    '.lw-link{display:block;margin:20px auto 0;background:none;border:none;color:var(--muted);font-size:14px;cursor:pointer;text-decoration:underline;text-underline-offset:3px;padding:8px 4px;min-height:40px}',
    '.lw-link:hover{color:var(--text)}',
    /* waitlist */
    '.lw-wl{margin-top:10px;padding:16px;border:1px solid var(--line);border-radius:16px;background:var(--surface)}',
    '.lw-wl-t{font-size:15px;font-weight:600;color:var(--text);margin-bottom:3px}',
    '.lw-wl-s{font-size:13px;color:var(--muted);line-height:1.55;margin-bottom:12px}',
    '.lw-wl-fld{margin-bottom:8px}.lw-wl-fld input{width:100%;background:var(--bg);border:1px solid var(--line2);border-radius:12px;padding:12px 13px;min-height:48px;color:var(--text);font-size:16px;outline:none}',
    '.lw-wl-fld input:focus{border-color:var(--accent)}',
    '.lw-wl-consent{display:flex;gap:10px;align-items:flex-start;margin:4px 0 12px;cursor:pointer}',
    '.lw-wl-consent input{width:18px;height:18px;margin-top:1px;accent-color:var(--accent);cursor:pointer;flex:0 0 auto}',
    '.lw-wl-consent span{font-size:12px;color:var(--muted);line-height:1.5}',
    '.lw-wl-btn{width:100%;min-height:48px;border-radius:12px;border:none;background:var(--accent);color:var(--on-accent);font-size:15px;font-weight:600;cursor:pointer}',
    '.lw-wl-btn:disabled{opacity:.5;cursor:wait}',
    '.lw-wl-ok{font-size:13px;color:var(--text);padding-top:8px;text-align:center}',
    '.lw-wl-ok:empty{display:none}',
    /* done */
    '.lw-orb{width:60px;height:60px;border-radius:50%;background:var(--accent);color:var(--on-accent);margin:6px auto 18px;display:flex;align-items:center;justify-content:center;animation:lwpop .45s ' + EASE + '}',
    '.lw-orb svg{width:28px;height:28px}',
    '.lw-orb.bad{background:var(--surface2);color:var(--muted)}',
    '@keyframes lwpop{from{transform:scale(.6);opacity:0}to{transform:none;opacity:1}}',
    '.lw-done-title{font-size:24px;font-weight:650;letter-spacing:-.02em;text-align:center;margin-bottom:8px}',
    '.lw-done-sub{color:var(--muted);font-size:15px;text-align:center;line-height:1.65}',
    '.lw-done-sub b{color:var(--text);font-weight:600}',
    '.lw-code{background:var(--surface);border-radius:14px;padding:12px 16px;margin:18px 0 4px;font-size:14px;color:var(--muted);text-align:center}',
    '.lw-code b{color:var(--text);font-weight:650;letter-spacing:.12em;font-variant-numeric:tabular-nums}',
    '.lw-pay{margin-top:18px;padding:16px;border-radius:16px;border:1px solid var(--accent);background:var(--surface)}',
    '.lw-pay-t{font-size:15px;font-weight:600;margin-bottom:4px}',
    '.lw-pay-s{font-size:13px;color:var(--muted);line-height:1.55}',
    '.lw-card{background:var(--surface);border-radius:16px;padding:16px 18px;margin-bottom:16px}',
    '.lw-card-when{font-size:17px;font-weight:600;letter-spacing:-.01em;margin-bottom:6px}',
    '.lw-card-meta{font-size:13.5px;color:var(--muted);margin-top:2px}',
    '.lw-foot{margin-top:28px;text-align:center;font-size:11.5px;color:var(--dim)}',
    '.lw-foot a{color:inherit;text-decoration:none}',
    /* modal chrome */
    '.lw-fab{position:fixed;right:20px;bottom:20px;z-index:2147483000;border:none;border-radius:999px;padding:15px 22px;min-height:52px;font-size:15px;font-weight:650;cursor:pointer;box-shadow:0 10px 30px rgba(0,0,0,.25);font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif}',
    '.lw-overlay{position:fixed;inset:0;z-index:2147483001;background:rgba(10,10,10,.5);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);display:flex;align-items:flex-end;justify-content:center;padding:0}',
    '@media (min-width:640px){.lw-overlay{align-items:center;padding:24px}}',
    '.lw-overlay .lw{width:100%;max-width:520px;min-height:0;max-height:92vh;overflow:auto;border-radius:24px 24px 0 0;box-shadow:var(--shadow)}',
    '@media (min-width:640px){.lw-overlay .lw{border-radius:24px}}',
    '.lw-close{position:absolute;top:12px;right:12px;width:40px;height:40px;border-radius:50%;background:rgba(127,127,127,.14);border:none;color:inherit;font-size:16px;cursor:pointer;line-height:1;z-index:2}',
    /* focus + motion */
    '.lw-opt:focus-visible,.lw-slot:focus-visible,.lw-btn:focus-visible,.lw-inp:focus-visible,.lw-date:focus-visible,.lw-link:focus-visible,.lw-back:focus-visible,.lw-day:focus-visible,.lw-wl-btn:focus-visible,.lw-fab:focus-visible,.lw-close:focus-visible{outline:2px solid var(--accent);outline-offset:2px}',
    '@media (prefers-reduced-motion:reduce){.lw *,.lw{animation:none!important;transition:none!important}}'
  ].join('\n');

  var ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  var ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>';

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
  function hourOf(iso) {
    try { return parseInt(new Date(iso).toLocaleString('en-US', tzOpt({ hour: 'numeric', hour12: false })), 10) % 24; }
    catch (e) { return new Date(iso).getHours(); }
  }
  // A salon-calendar date key (YYYY-MM-DD) shown as a label. Noon UTC keeps
  // the weekday right in every time zone.
  function dayParts(key) {
    var d = new Date(key + 'T12:00:00Z');
    return {
      wd: d.toLocaleDateString([], { weekday: 'short', timeZone: 'UTC' }),
      day: d.getUTCDate(),
      md: d.toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' }),
      long: d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' })
    };
  }
  function addDays(key, n) {
    var d = new Date(key + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  // "Today 2:30 PM" · "Tomorrow 10 AM" · "Tue 2:30 PM" · "Tue, Oct 21 · 2:30 PM"
  function nextLabel(iso, dateKey) {
    var today = salonToday(), t = timeLabel(iso);
    if (dateKey === today) return 'Today ' + t;
    if (dateKey === addDays(today, 1)) return 'Tomorrow ' + t;
    var p = dayParts(dateKey);
    return (dateKey <= addDays(today, 6) ? p.wd : p.wd + ', ' + p.md) + ' ' + t;
  }
  function initials(name) {
    var parts = String(name || '').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '·';
    return (parts[0].charAt(0) + (parts.length > 1 ? parts[parts.length - 1].charAt(0) : '')).toUpperCase();
  }
  function cssUrl(u) { return 'url(&quot;' + esc(String(u).replace(/["\\\n\r]/g, '')) + '&quot;)'; }
  function safeUrl(u) { var s = String(u || ''); return /^https:\/\//i.test(s) || /^\/(?!\/)/.test(s) ? s : ''; }

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

  // ── progress: 1 Service · 2 Time · 3 Details ─────────────
  var PHASE = { service: 0, staff: 0, time: 1, addons: 1, details: 2 };
  function progressHtml(current) {
    var idx = PHASE[current];
    if (idx == null) return '';
    var names = ['Service', 'Time', 'Details'];
    return '<ol class="lw-progress" aria-label="Booking progress: step ' + (idx + 1) + ' of 3, ' + names[idx] + '">' +
      names.map(function (n, i) {
        return '<li class="' + (i < idx ? 'done' : (i === idx ? 'on' : '')) + '"' + (i === idx ? ' aria-current="step"' : '') + '><span>' + (i + 1) + '</span>' + n + '</li>';
      }).join('') + '</ol>';
  }
  function backHtml() { return '<button class="lw-back" data-back aria-label="Back"><span aria-hidden="true">←</span> Back</button>'; }

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

  // Keyboard users land on the step's first control; touch users are not
  // thrown around (no focus = no surprise keyboard on phones).
  var KEYBOARD = false;
  function focusFirst(host) {
    if (!KEYBOARD) return;
    try {
      var el = host.querySelector('.lw-step.on input, .lw-step.on button.lw-opt, .lw-step.on button.lw-btn');
      if (el && el.focus) el.focus({ preventScroll: true });
    } catch (e) {}
  }

  function Widget(root) {
    this.root = root;
    this.host = root.querySelector('.lw');
    this.addons = [];
    this._next = {};
  }
  // full=true: the salon's full header (menu screen); otherwise a compact one.
  Widget.prototype.render = function (html, full) {
    this.host.innerHTML = (full ? (this.header || '') : (this.headerCompact || '')) + html + (this.footer || '');
    tickHold(this);
    // Each step starts at its top (long menus on phones).
    try {
      var r = this.host.getBoundingClientRect();
      if (this.host.scrollTop) this.host.scrollTop = 0;
      if (cfg.page && r.top < 0) window.scrollTo({ top: Math.max(0, window.scrollY + r.top - 8), behavior: 'auto' });
    } catch (e) {}
  };
  Widget.prototype.msg = function (kind, text) {
    var e = this.host.querySelector('.lw-err');
    if (e) e.textContent = text || '';
  };

  // ── "next available": one call per service, shared by every screen ──
  function nextOpen(w, serviceId) {
    var c = w._next[serviceId];
    if (c && Date.now() - c.at < 120000) return c.p;
    var p = apiGet('next_open', { service_id: serviceId, days: 14 }).catch(function () { return null; });
    w._next[serviceId] = { at: Date.now(), p: p };
    return p;
  }
  function forgetNext(w) { if (w.service) delete w._next[w.service.id]; }
  // Open dates (and the first one) for a stylist — or anyone when staffId is null.
  function openInfo(j, staffId) {
    if (!j) return null;
    var useStaff = staffId && j.staff && j.staff.length;
    if (useStaff) {
      var s = j.staff.filter(function (x) { return x.staff_id === staffId; })[0];
      return { first: s ? s.date : null, at: s ? s.starts_at : null, days: s ? s.open_days || [] : [] };
    }
    return { first: j.earliest ? j.earliest.date : null, at: j.earliest ? j.earliest.starts_at : null,
      days: (j.days || []).filter(function (d) { return d.open; }).map(function (d) { return d.date; }) };
  }

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
    return 'We’re holding this time for you for <b>' + m + ':' + (s < 10 ? '0' : '') + s + '</b>';
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
  function durLabel(m) {
    m = Number(m || 0); if (!m) return '';
    var h = Math.floor(m / 60), r = m % 60;
    return h ? h + ' hr' + (r ? ' ' + r + ' min' : '') : m + ' min';
  }
  function stepService(w, c) {
    releaseHold(w);
    w.addons = []; w.time = null; w.managing = null; w.date = null;
    if (!c.enabled) {
      w.render('<div class="lw-step on"><p class="lw-note">' + esc(c.message || 'Online booking is turned off right now.') + '</p>' +
        (c.phone ? '<a class="lw-btn" href="tel:' + esc(String(c.phone).replace(/[^\d+]/g, '')) + '">Call ' + esc(c.phone) + '</a>' : '') +
        '<button class="lw-link" data-cancel>Manage an existing appointment</button></div>', true);
      w.host.querySelector('[data-cancel]').addEventListener('click', function () { stepManage(w); });
      return;
    }
    if (!c.services || !c.services.length) {
      w.render('<div class="lw-step on"><div class="lw-empty">No services listed yet.</div></div>', true);
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
      return (named ? '<div class="lw-cat" role="heading" aria-level="3">' + esc(g || 'More services') + '</div>' : '') +
        '<div class="lw-opts" role="list">' + byCat[g].map(function (i) {
          var s = c.services[i];
          var img = safeUrl(s.photo_url);
          return '<button class="lw-opt" role="listitem" data-i="' + i + '" aria-label="Choose ' + esc(s.name) + (s.price != null ? ' for ' + money(s.price) : '') + (s.duration_minutes ? ', ' + durLabel(s.duration_minutes) : '') + '">' +
            (img ? '<span class="lw-thumb" style="background-image:' + cssUrl(img) + '" aria-hidden="true"></span>' : '') +
            '<span class="lw-body"><b>' + esc(s.name) + '</b>' +
            (s.duration_minutes ? '<div class="meta">' + durLabel(s.duration_minutes) + '</div>' : '') +
            (s.description ? '<div class="desc">' + esc(s.description) + '</div>' : '') + depositChip(s, c) +
            '</span>' + (s.price != null ? '<span class="lw-price">' + money(s.price) + '</span>' : '') + '</button>';
        }).join('') + '</div>';
    }).join('');
    w.render(
      progressHtml('service') +
      '<div class="lw-step on" data-step="service" role="region" aria-label="Choose a service">' +
      '<h2 class="lw-h">Choose a service</h2>' + html +
      '<button class="lw-link" data-cancel>Manage or cancel an appointment</button></div>', true
    );
    focusFirst(w.host);
    w.host.querySelectorAll('.lw-opt').forEach(function (b) {
      b.addEventListener('click', function () {
        w.service = c.services[Number(b.getAttribute('data-i'))];
        w.staff = null; w.date = null;
        nextOpen(w, w.service.id); // starts now; the next screens read it
        if (hasStaff) stepStaff(w, c); else stepTime(w, c);
      });
    });
    w.host.querySelector('[data-cancel]').addEventListener('click', function () { stepManage(w); });
  }

  // ── step 2: who ─────────────────────────────────────────
  function avatarHtml(s) {
    var img = safeUrl(s && s.photo_url);
    return img ? '<span class="lw-av" style="background-image:' + cssUrl(img) + '" aria-hidden="true"></span>'
      : '<span class="lw-av" aria-hidden="true">' + esc(initials(s && s.name)) + '</span>';
  }
  function stepStaff(w, c) {
    var opts = [];
    if (w.managing) {
      // Rescheduling: keep the stylist they have — their real id, so the times
      // shown are THAT stylist's free times.
      var cur = w.managing.booking && w.managing.booking.staff;
      if (cur && cur.id) opts.push('<button class="lw-opt" data-keep="1" data-sid="' + esc(cur.id) + '">' + avatarHtml(cur) + '<span class="lw-body"><b>Keep ' + esc(cur.name || 'my current team member') + '</b><span class="lw-nx"></span></span><span class="lw-chev" aria-hidden="true">›</span></button>');
    } else if (c.allow_any_staff) {
      opts.push('<button class="lw-opt" data-i="-1" data-sid=""><span class="lw-av any" aria-hidden="true">✦</span><span class="lw-body"><b>Any available</b><div class="meta">The first free team member</div><span class="lw-nx"></span></span><span class="lw-chev" aria-hidden="true">›</span></button>');
    }
    (c.staff || []).forEach(function (s, i) {
      if (w.managing && w.managing.booking && w.managing.booking.staff && w.managing.booking.staff.id === s.id) return;
      opts.push('<button class="lw-opt" data-i="' + i + '" data-sid="' + esc(s.id) + '">' + avatarHtml(s) + '<span class="lw-body"><b>' + esc(s.name) + '</b>' +
        (s.role ? '<div class="meta">' + esc(s.role) + '</div>' : '') +
        (s.bio ? '<div class="desc">' + esc(s.bio) + '</div>' : '') +
        '<span class="lw-nx"></span></span><span class="lw-chev" aria-hidden="true">›</span></button>');
    });
    w.render(
      progressHtml(w.managing ? '' : 'staff') +
      '<div class="lw-step on" data-step="staff" role="region" aria-label="Choose a team member">' + backHtml() +
      '<h2 class="lw-h">Who would you like?</h2>' +
      (w.service ? '<p class="lw-sub">' + esc(w.service.name) + (w.service.duration_minutes ? ' · ' + durLabel(w.service.duration_minutes) : '') + '</p>' : '') +
      '<div class="lw-opts" role="list">' + opts.join('') + '</div></div>'
    );
    focusFirst(w.host);
    // "Next: Tue 2:30 PM" on each card once the one next_open call lands.
    var cards = w.host.querySelectorAll('.lw-opt .lw-nx');
    cards.forEach(function (el) { el.innerHTML = '<span class="lw-next-sk lw-sk" aria-hidden="true"></span>'; });
    var svc = w.service;
    nextOpen(w, svc.id).then(function (j) {
      if (w.service !== svc) return;
      w.host.querySelectorAll('.lw-opt[data-sid]').forEach(function (b) {
        var el = b.querySelector('.lw-nx'); if (!el) return;
        if (!j) { el.innerHTML = ''; return; }
        var info = openInfo(j, b.getAttribute('data-sid') || null);
        el.innerHTML = info && info.at
          ? '<span class="lw-next">Next: ' + esc(nextLabel(info.at, info.first)) + '</span>'
          : '<span class="lw-next none">No openings in the next 2 weeks</span>';
      });
    });
    w.host.querySelector('[data-back]').addEventListener('click', function () {
      if (w.managing) { renderManageCard(w, w.managing.booking, w.managing.policy); return; }
      stepService(w, c);
    });
    w.host.querySelectorAll('.lw-opt').forEach(function (b) {
      b.addEventListener('click', function () {
        w.date = null;
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
    var chosen = (w.date && w.date >= today) ? w.date : null;
    var hasStaff = !!(c.staff && c.staff.length);
    var chips = [];
    for (var i = 0; i < 14; i++) {
      var k = addDays(today, i), p = dayParts(k);
      chips.push('<button class="lw-day' + (k === chosen ? ' sel' : '') + '" data-day="' + k + '" aria-label="' + esc(p.long) + '"' + (k === chosen ? ' aria-pressed="true"' : ' aria-pressed="false"') + '><small>' + esc(i === 0 ? 'Today' : p.wd) + '</small><b>' + p.day + '</b><i></i></button>');
    }
    var who = w.staff ? ' with ' + esc(w.staff.name) : '';
    w.render(
      progressHtml(w.managing ? '' : 'time') +
      '<div class="lw-step on" data-step="time" role="region" aria-label="Pick a time">' + backHtml() +
      '<h2 class="lw-h">' + (w.managing ? 'Pick a new time' : 'Pick a time') + '</h2>' +
      '<p class="lw-sub">' + esc(w.service.name) + who + '</p>' +
      '<div class="lw-days" role="group" aria-label="Next two weeks">' + chips.join('') + '</div>' +
      '<label class="lw-more">Another date <input type="date" class="lw-date" id="lwDate" value="' + (chosen || today) + '" min="' + today + '" aria-label="Choose another date"/></label>' +
      '<div class="lw-dayname" id="lwDayName" aria-live="polite"></div>' +
      '<div class="lw-err" role="alert"></div>' +
      '<div class="lw-slots" id="lwSlots" role="list" aria-live="polite" aria-busy="true"></div></div>'
    );
    skeleton(w);
    var strip = w.host.querySelector('.lw-days');
    function pick(k, user) {
      if (user) w._userDay = true;
      w.date = k;
      w.host.querySelectorAll('.lw-day').forEach(function (b) {
        var on = b.getAttribute('data-day') === k;
        b.classList.toggle('sel', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
        if (on && strip) { try { strip.scrollLeft = Math.max(0, b.offsetLeft - strip.offsetLeft - 70); } catch (e) {} }
      });
      var inp = w.host.querySelector('#lwDate'); if (inp) inp.value = k;
      loadSlots(w, c, k);
    }
    w.host.querySelectorAll('.lw-day').forEach(function (b) {
      b.addEventListener('click', function () { pick(b.getAttribute('data-day'), true); });
    });
    var input = w.host.querySelector('#lwDate');
    input.addEventListener('change', function () { if (input.value) pick(input.value, true); });
    w.host.querySelector('[data-back]').addEventListener('click', function () {
      if (w.managing) { if (hasStaff || (w.managing.booking && w.managing.booking.staff)) stepStaff(w, c); else renderManageCard(w, w.managing.booking, w.managing.policy); return; }
      if (hasStaff) stepStaff(w, c); else stepService(w, c);
    });
    function mark(open) {
      var set = {}; (open || []).forEach(function (d) { set[d] = true; });
      w.host.querySelectorAll('.lw-day').forEach(function (b) {
        var d = b.getAttribute('data-day');
        b.classList.toggle('open', !!set[d]); b.classList.toggle('closed', !set[d]);
        if (!set[d] && !/no openings/.test(b.getAttribute('aria-label'))) b.setAttribute('aria-label', b.getAttribute('aria-label') + ' (no openings)');
      });
    }
    // One next_open call (usually already answered while they chose a
    // stylist) gives the open days AND the first open day — the strip lands
    // there, not on a closed or full today. A day they picked themselves
    // (coming back from details) loads at the same time, in parallel.
    w._userDay = false;
    var svc = w.service, staffId = w.staff ? w.staff.id : null;
    if (chosen) pick(chosen);
    nextOpen(w, svc.id).then(function (j) {
      if (w.service !== svc || !w.host.querySelector('#lwSlots')) return;
      var info = openInfo(j, staffId);
      if (info) mark(info.days);
      if (chosen || w._userDay) return;
      if (info) { pick(info.first || today); return; }
      // next_open unavailable (older server): open days + today, in parallel.
      var od = { service_id: svc.id, from: today, days: 14 };
      if (staffId) od.staff_id = staffId;
      apiGet('open_days', od).then(function (r) {
        mark((r.days || []).filter(function (d) { return d.open; }).map(function (d) { return d.date; }));
      }).catch(function () {});
      pick(today);
    });
  }

  function skeleton(w) {
    var host = w.host.querySelector('#lwSlots');
    if (!host) return;
    host.setAttribute('aria-busy', 'true');
    var sk = [];
    for (var i = 0; i < 9; i++) sk.push('<div class="lw-slot-sk lw-sk" aria-hidden="true"></div>');
    host.innerHTML = sk.join('');
  }

  function loadSlots(w, c, date) {
    var host = w.host.querySelector('#lwSlots');
    if (!host) return;
    var dn = w.host.querySelector('#lwDayName');
    if (dn) dn.textContent = dayParts(date).long;
    skeleton(w);
    var p = { service_id: w.service.id, date: date, limit: 200, one_per_time: 1 };
    if (w.staff) p.staff_id = w.staff.id;
    apiGet('availability', p).then(function (data) {
      if (w.date !== date) return; // user moved on to another day
      var now = Date.now();
      var slots = (data.slots || []).filter(function (s) { var t = Date.parse(s.starts_at); return t && t >= now; });
      host.setAttribute('aria-busy', 'false');
      if (!slots.length) { renderNoTimes(w, c, host, date, data.next_open); return; }
      var parts = [['Morning', []], ['Afternoon', []], ['Evening', []]];
      slots.forEach(function (s) { var h = hourOf(s.starts_at); parts[h < 12 ? 0 : (h < 17 ? 1 : 2)][1].push(s); });
      var used = parts.filter(function (x) { return x[1].length; });
      host.innerHTML = used.map(function (x) {
        return (used.length > 1 ? '<div class="lw-part" role="presentation">' + x[0] + '</div>' : '') + x[1].map(function (s) {
          return '<button class="lw-slot" data-iso="' + esc(s.starts_at) + '" role="listitem" aria-label="' + esc(timeLabel(s.starts_at) + ', ' + dayParts(date).long) + '">' + esc(timeLabel(s.starts_at)) + '</button>';
        }).join('');
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
      host.innerHTML = '<div class="lw-empty" style="grid-column:1/-1">' + esc(e.message) + '</div>';
    });
  }

  // Hold the picked time for 5 minutes; the add-ons that fit come back in
  // the same answer (with_addons), so there is no second round trip.
  function holdTime(w, c, btn) {
    var err = w.host.querySelector('.lw-err');
    if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
    releaseHold(w);
    apiPost({ action: 'hold', channel: 'public_web', service_id: w.service.id, staff_id: w.staff ? w.staff.id : null, starts_at: w.time, ttl_seconds: 300, with_addons: true })
      .then(function (r) {
        if (!r.ok || !r.hold) {
          if (err) err.textContent = errText(r, 'That time was just taken — pick another.');
          forgetNext(w);
          loadSlots(w, c, w.date);
          return;
        }
        w.hold = r.hold;
        w.heldStaff = r.hold.staff_name ? { id: r.hold.staff_id, name: r.hold.staff_name } : (w.staff || null);
        var next = function (list) { if (list.length) stepAddons(w, c, list); else { w.addons = []; stepDetails(w, c); } };
        if (Array.isArray(r.addons)) { next(r.addons); return; }
        // Older server: ask separately.
        return apiPost({ action: 'addons', hold_token: r.hold.hold_token }).then(function (a) {
          next((a && a.ok && a.addons) || []);
        }, function () { w.addons = []; stepDetails(w, c); });
      })
      .catch(function (e) {
        if (err) err.textContent = e.message || 'Something went wrong.';
        if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); btn.classList.remove('sel'); }
      });
  }

  function renderNoTimes(w, c, host, date, next) {
    var html = '<div class="lw-empty" style="grid-column:1/-1">No open times on ' + esc(dayParts(date).long) + '.</div>';
    if (next && next.date) {
      html += '<div class="lw-nextbox" style="grid-column:1/-1"><div class="lw-nextbox-t">Next opening: <b>' + esc(dayParts(next.date).long) + '</b></div>' +
        '<div class="lw-slots">' + (next.times || []).map(function (t) {
          return '<button class="lw-slot" data-next="' + esc(t) + '">' + esc(timeLabel(t)) + '</button>';
        }).join('') + '</div><button class="lw-link" data-goto="' + esc(next.date) + '" style="margin:10px 0 0">See all times that day</button></div>';
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
      var k = go.getAttribute('data-goto'); w.date = k; w._userDay = true;
      w.host.querySelectorAll('.lw-day').forEach(function (b) { var on = b.getAttribute('data-day') === k; b.classList.toggle('sel', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
      var inp = w.host.querySelector('#lwDate'); if (inp) inp.value = k;
      loadSlots(w, c, k);
    });
    if (!w.managing) renderWaitlist(w, c, host.querySelector('#lwWlBox'), date);
  }

  function renderWaitlist(w, c, host, date) {
    host.innerHTML = '<div class="lw-wl"><div class="lw-wl-t">Get first dibs when a slot opens</div>' +
      '<div class="lw-wl-s">Leave your name and phone — ' + esc(c.tenant_name || 'the salon') + ' can text you when ' + esc(w.service.name) + ' has an opening.</div>' +
      '<div class="lw-wl-fld"><input id="lwWlName" placeholder="Your name" autocomplete="name" aria-label="Your name"/></div>' +
      '<div class="lw-wl-fld"><input id="lwWlPhone" type="tel" inputmode="tel" placeholder="Mobile number" autocomplete="tel" aria-label="Mobile number"/></div>' +
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
      progressHtml('addons') +
      '<div class="lw-step on" data-step="addons" role="region" aria-label="Add-ons">' + backHtml() +
      '<h2 class="lw-h">Add something?</h2>' +
      '<div class="lw-hold" aria-live="polite"></div>' +
      '<p class="lw-note">' + esc((w.heldStaff && w.heldStaff.name) || 'Your stylist') + ' has time right after your ' + esc(w.service.name) + ' for these:</p>' +
      '<div class="lw-opts">' + list.map(function (a, i) {
        return '<label class="lw-opt" style="cursor:pointer"><input type="checkbox" class="lw-box" data-a="' + i + '"' + (picked[a.id] ? ' checked' : '') + ' aria-label="Add ' + esc(a.name) + '"/>' +
          '<span class="lw-body"><b>' + esc(a.name) + '</b><div class="meta">+' + durLabel(a.duration_minutes) + '</div>' +
          (a.description ? '<div class="desc">' + esc(a.description) + '</div>' : '') + '</span>' +
          '<span class="lw-price">+' + money(a.price) + '</span></label>';
      }).join('') + '</div>' +
      '<div class="lw-actions"><button class="lw-btn" id="lwAddonsNext">Continue</button></div></div>'
    );
    function sync() {
      var n = 0;
      w.host.querySelectorAll('input[data-a]').forEach(function (x) { x.closest('.lw-opt').classList.toggle('sel', x.checked); if (x.checked) n++; });
      w.host.querySelector('#lwAddonsNext').textContent = n ? 'Continue with ' + n + ' add-on' + (n > 1 ? 's' : '') : 'Continue without';
    }
    w.host.querySelectorAll('input[data-a]').forEach(function (x) { x.addEventListener('change', sync); });
    sync();
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
    var staff = w.heldStaff || w.staff;
    var items = [w.service].concat(w.addons || []);
    var total = items.reduce(function (s, x) { return s + Number(x.price || 0); }, 0);
    w.render(
      progressHtml('details') +
      '<div class="lw-step on" data-step="details" role="region" aria-label="Your details">' + backHtml() +
      '<h2 class="lw-h">Your details</h2>' +
      '<div class="lw-summary"><div class="lw-sum-row"><span><b>' + items.map(function (x) { return esc(x.name); }).join(' + ') + '</b>' + (staff ? '<br>with ' + esc(staff.name) : '') + '</span>' +
      (total ? '<span class="lw-sum-total">' + money(total) + '</span>' : '') + '</div>' +
      '<div class="lw-sum-when">' + esc(whenLabel(w.time)) + '</div>' +
      '<div class="deposit-line" id="lwDep"></div>' + policyHtml(c, '') + '</div>' +
      '<div class="lw-hold" aria-live="polite"></div>' +
      '<div id="lwWelcome"></div>' +
      '<div class="lw-fld"><label for="lwPhone">Mobile phone</label><input class="lw-inp" id="lwPhone" type="tel" inputmode="tel" placeholder="(555) 555-5555 or +44…" autocomplete="tel"/></div>' +
      '<div class="lw-fld"><label for="lwName">Name</label><input class="lw-inp" id="lwName" placeholder="Your name" autocomplete="name"/></div>' +
      '<div class="lw-fld"><label for="lwEmail">Email' + (c.require_email ? '' : ' <em>(optional)</em>') + '</label><input class="lw-inp" id="lwEmail" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com"' + (c.require_email ? ' required' : '') + '/></div>' +
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
    if (!phoneValid(phone)) { err.textContent = 'Please enter a valid mobile number (with country code if outside the US).'; w.host.querySelector('#lwPhone').focus(); return; }
    if (!name) { err.textContent = 'Please add your name.'; w.host.querySelector('#lwName').focus(); return; }
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
      forgetNext(w);
      renderDone(w, c, result, phone, items);
    }).catch(function (e) {
      err.textContent = e.message || 'Something went wrong.';
      btn.disabled = false; btn.textContent = 'Confirm booking';
    });
  }

  // Google Calendar "add event" link (no account data leaves the page).
  function gcalHref(title, startIso, endIso, details, where) {
    var f = function (iso) { return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); };
    var p = new URLSearchParams({ action: 'TEMPLATE', text: title, dates: f(startIso) + '/' + f(endIso) });
    if (details) p.set('details', details);
    if (where) p.set('location', where);
    return 'https://calendar.google.com/calendar/render?' + p.toString();
  }
  function endOf(startIso, endIso, items) {
    var mins = (items || []).reduce(function (s, x) { return s + Number(x.duration_minutes || 0); }, 0) || 60;
    var calc = Date.parse(startIso) + mins * 60000, given = Date.parse(endIso || '');
    return new Date(Math.max(calc, given || 0)).toISOString();
  }
  function calButtons(icsHref, gHref) {
    return '<div class="lw-row2">' +
      (icsHref ? '<a class="lw-btn ghost" href="' + esc(icsHref) + '" download="appointment.ics">Apple / Outlook</a>' : '') +
      '<a class="lw-btn ghost" href="' + esc(gHref) + '" target="_blank" rel="noopener">Google Calendar</a></div>';
  }

  function renderDone(w, c, result, phone, items) {
    var b = result.booking || {};
    var code = b.confirmation_code;
    var staffName = b.staff_name || (w.heldStaff && w.heldStaff.name) || '';
    var calHref = result.calendar_path ? ORIGIN + result.calendar_path : '';
    var pay = result.payment_link && /^https:\/\//.test(result.payment_link) ? result.payment_link : '';
    var start = b.start_time || w.time;
    var what = items.map(function (x) { return x.name; }).join(' + ');
    var sub = '<b>' + esc(what) + '</b>' + (staffName ? ' with ' + esc(staffName) : '') + '<br>' + esc(whenLabel(start)) + '.';
    sub += result.texted ? '<br>We’ve texted your confirmation.' : '<br>Keep the code below — you’ll need it to change or cancel online.';
    var payHtml = '';
    if (pay) {
      var amt = cents(result.deposit && result.deposit.amount_cents);
      // No surprise redirect: one clear button, the client decides.
      payHtml = '<div class="lw-pay"><div class="lw-pay-t">One last step: your deposit</div>' +
        '<div class="lw-pay-s">A ' + amt + ' deposit confirms this appointment and goes toward your service. Secure checkout by Stripe.' +
        (result.texted ? ' We also texted you the link.' : '') + '</div>' +
        '<a class="lw-btn" href="' + esc(pay) + '" id="lwPay" target="_top" rel="noopener">Pay ' + amt + ' deposit to confirm</a></div>';
    }
    var g = gcalHref(what + (c.tenant_name ? ' · ' + c.tenant_name : ''), start, endOf(start, b.end_time, items),
      (staffName ? 'With ' + staffName + '. ' : '') + (code ? 'Confirmation code: ' + code + '.' : ''), c.location || c.tenant_name || '');
    w.render(
      '<div class="lw-step on" data-step="done" role="status" aria-live="polite"><div class="lw-orb">' + ICON_CHECK + '</div>' +
      '<div class="lw-done-title">' + (pay ? 'Your time is held' : 'You’re booked') + '</div>' +
      '<div class="lw-done-sub">' + sub + '</div>' +
      (code ? '<div class="lw-code">Your code <b>' + esc(code) + '</b></div>' : '') +
      payHtml +
      '<div class="lw-actions"><div class="lw-label" style="margin:6px 0 0;text-align:center">Add to calendar</div>' + calButtons(calHref, g) + '</div>' +
      policyHtml(c, '') +
      '<button class="lw-link" data-cancel>Manage or cancel this appointment</button></div>'
    );
    w.host.querySelector('[data-cancel]').addEventListener('click', function () { stepManage(w, { code: code, phone: phone }); });
  }

  // ── self-service: look up by code + phone, then reschedule/cancel ──
  function stepManage(w, prefill) {
    releaseHold(w);
    prefill = prefill || {};
    var code = (prefill.code || (w.managing && w.managing.code) || '').trim();
    var phone = prefill.phone || (w.managing && w.managing.phone) || '';
    w.render(
      '<div class="lw-step on" data-step="manage">' + backHtml() +
      '<h2 class="lw-h">Manage an appointment</h2>' +
      '<p class="lw-note">Find your booking with the code from your confirmation.</p>' +
      '<div class="lw-fld"><label for="lwMCode">Confirmation code</label><input class="lw-inp" id="lwMCode" value="' + esc(code) + '" placeholder="e.g. AB3X7Q" autocomplete="off" autocapitalize="characters"/></div>' +
      '<div class="lw-fld"><label for="lwMPhone">Phone used to book</label><input class="lw-inp" id="lwMPhone" type="tel" inputmode="tel" value="' + esc(phone) + '" placeholder="(555) 555-5555"/></div>' +
      '<button class="lw-btn" id="lwLookup">Find my appointment</button><div class="lw-err" role="alert"></div></div>'
    );
    w.host.querySelector('[data-back]').addEventListener('click', function () { w.managing = null; if (w.catalog) stepService(w, w.catalog); });
    w.host.querySelector('#lwLookup').addEventListener('click', function () { doLookup(w); });
    wirePhone(w.host.querySelector('#lwMPhone'));
    var f = w.host.querySelector(code ? '#lwMPhone' : '#lwMCode');
    try { if (f && KEYBOARD) f.focus({ preventScroll: true }); } catch (e) {}
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
      '<h2 class="lw-h">' + esc((b.service && b.service.name) || 'Appointment') + (staffName ? ' · ' + esc(staffName) : '') + '</h2>' +
      '<div class="lw-card">' +
      '<div class="lw-card-when">' + esc(whenLabel(b.start_time)) + '</div>' +
      (b.service && b.service.price != null ? '<div class="lw-card-meta">' + money(b.service.price) + (b.service.duration_minutes ? ' · ' + durLabel(b.service.duration_minutes) : '') + '</div>' : '') +
      (cancelled ? '<div class="lw-card-meta" style="color:var(--bad)">This appointment is cancelled.</div>' : '') +
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
    w.service = svc; w.date = null;
    // Default: the same stylist (their id, so availability is theirs).
    w.staff = b.staff && b.staff.id ? { id: b.staff.id, name: b.staff.name } : null;
    nextOpen(w, svc.id);
    if (cat.staff && cat.staff.length) stepStaff(w, cat); else stepTime(w, cat);
  }

  function stepRescheduleConfirm(w) {
    w.render(
      '<div class="lw-step on" data-step="rconfirm">' + backHtml() +
      '<h2 class="lw-h">Move your appointment</h2>' +
      '<div class="lw-summary"><b>' + esc(w.service.name) + '</b>' +
      (w.staff ? ' with <b>' + esc(w.staff.name) + '</b>' : '') +
      '<div class="lw-sum-when">New time: ' + esc(whenLabel(w.time)) + '</div>' + policyHtml(w.catalog || {}, '') + '</div>' +
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
      var c = w.catalog || {};
      w.managing = null;
      forgetNext(w);
      var calHref = ORIGIN + '/api/calendar.ics?code=' + encodeURIComponent(code) + '&phone=' + encodeURIComponent(phone);
      var g = gcalHref(w.service.name + (c.tenant_name ? ' · ' + c.tenant_name : ''), w.time, endOf(w.time, null, [w.service]),
        'Confirmation code: ' + code + '.', c.location || c.tenant_name || '');
      w.render(
        '<div class="lw-step on" data-step="rescheduled"><div class="lw-orb">' + ICON_CHECK + '</div>' +
        '<div class="lw-done-title">You’re all set</div>' +
        '<div class="lw-done-sub">Your appointment is now <b>' + esc(when) + '</b>.<br>Your code stays the same: <b>' + esc(code) + '</b>.</div>' +
        '<div class="lw-actions"><div class="lw-label" style="margin:6px 0 0;text-align:center">Add to calendar</div>' + calButtons(calHref, g) + '</div>' +
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
      '<div class="lw-step on" data-step="cancel">' + backHtml() +
      '<h2 class="lw-h">Cancel an appointment</h2>' +
      '<div class="lw-fld"><label for="lwCode">Confirmation code</label><input class="lw-inp" id="lwCode" value="' + esc(prefill.code || '') + '" placeholder="e.g. AB3X7Q" autocomplete="off" autocapitalize="characters"/></div>' +
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
        w._next = {};
        w.render(
          '<div class="lw-step on" data-step="cancelled"><div class="lw-orb bad">' + ICON_X + '</div>' +
          '<div class="lw-done-title">Cancelled</div>' +
          '<div class="lw-done-sub">Your appointment is cancelled.</div>' +
          '<button class="lw-link" data-rebook>Book something else</button></div>'
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

  // ── the salon's look: name, logo (or monogram), rating, accent ──
  function headerHtml(c, compact) {
    var logo = safeUrl(c.logo_url);
    var mark = '<span class="lw-logo">' + (logo ? '<img src="' + esc(logo) + '" alt="" referrerpolicy="no-referrer"/>' : '<span class="lw-mono" aria-hidden="true">' + esc(initials(c.name)) + '</span>') + '</span>';
    if (compact) return '<header class="lw-head compact">' + mark + '<div class="lw-name">' + esc(c.name) + '</div></header>';
    var meta = [];
    if (c.rating) meta.push('<span><span class="lw-star" aria-hidden="true">★ ' + esc(c.rating.value.toFixed(1)) + '</span><span class="sr">Rated ' + esc(c.rating.value.toFixed(1)) + ' out of 5</span> · ' + esc(c.rating.count.toLocaleString()) + ' ' + esc(c.rating.source || 'Google') + ' reviews</span>');
    if (c.location) meta.push('<span>' + esc(c.location) + '</span>');
    var cover = safeUrl(c.cover_url);
    return (cover ? '<div class="lw-cover" style="background-image:' + cssUrl(cover) + '" role="img" aria-label="' + esc(c.name) + '"></div>' : '') +
      '<header class="lw-head">' + mark + '<div><h1 class="lw-name">' + esc(c.name) + '</h1>' +
      (meta.length ? '<div class="lw-meta">' + meta.join('') + '</div>' : '') + '</div></header>';
  }
  function setMeta(name, content, prop) {
    try {
      var sel = prop ? 'meta[property="' + name + '"]' : 'meta[name="' + name + '"]';
      var m = document.head.querySelector(sel);
      if (!m) { m = document.createElement('meta'); m.setAttribute(prop ? 'property' : 'name', name); document.head.appendChild(m); }
      m.setAttribute('content', content);
    } catch (e) {}
  }
  function brandPage(c) {
    // Only the hosted booking page — never a salon's own website.
    if (!cfg.page) return;
    var title = 'Book · ' + c.name;
    var desc = 'Book ' + c.name + ' online' + (c.location ? ' in ' + c.location : '') + ' — see real-time availability and confirm in seconds.';
    try { document.title = title; } catch (e) {}
    setMeta('description', desc); setMeta('og:title', title, true); setMeta('og:description', desc, true);
    setMeta('twitter:title', title);
    if (c.logo_url) setMeta('og:image', c.logo_url, true);
  }

  function boot() {
    if (!cfg.tenant) {
      var missing = document.createElement('div');
      missing.textContent = 'Booking widget: missing data-tenant attribute.';
      (SCRIPT.parentNode || document.body).appendChild(missing);
      return;
    }
    beacon();
    window.addEventListener('keydown', function (e) { if (e.key === 'Tab') KEYBOARD = true; }, true);
    window.addEventListener('pointerdown', function () { KEYBOARD = false; }, true);

    var host = document.createElement('div');
    host.id = 'loladesk-widget';
    var shadow = host.attachShadow({ mode: 'open' });
    var style = document.createElement('style');
    style.textContent = SHEET;
    shadow.appendChild(style);
    var frame = document.createElement('div');
    frame.className = 'lw' + (cfg.theme === 'dark' ? ' t-dark' : (cfg.theme === 'light' ? ' t-light' : '')) + (cfg.page && cfg.mode !== 'modal' ? ' lw-page' : '');
    if (cfg.accent) frame.setAttribute('style', accentVars(cfg.accent));
    shadow.appendChild(frame);

    var open = null;
    if (cfg.mode === 'modal') {
      shadow.removeChild(frame);
      var fab = document.createElement('button');
      fab.className = 'lw-fab';
      fab.textContent = attr('data-label') || 'Book now';
      var fabColor = cfg.accent || '#161616';
      fab.style.background = fabColor; fab.style.color = onColor(fabColor);
      shadow.appendChild(fab);
      var overlay = document.createElement('div');
      overlay.className = 'lw-overlay';
      overlay.style.display = 'none';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-label', 'Book an appointment');
      var box = document.createElement('div');
      box.style.cssText = 'position:relative;width:100%;max-width:520px';
      var close = document.createElement('button');
      close.className = 'lw-close'; close.setAttribute('aria-label', 'Close'); close.textContent = '✕';
      box.appendChild(close); box.appendChild(frame); overlay.appendChild(box);
      shadow.appendChild(overlay);
      var hide = function () { overlay.style.display = 'none'; fab.style.display = ''; try { fab.focus(); } catch (e) {} };
      open = function () { overlay.style.display = 'flex'; fab.style.display = 'none'; try { close.focus(); } catch (e) {} };
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
    w.render('<div aria-busy="true" aria-label="Loading"><div class="lw-head"><span class="lw-logo lw-sk"></span><div style="flex:1"><div class="lw-sk" style="height:20px;width:55%;border-radius:6px"></div><div class="lw-sk" style="height:12px;width:35%;border-radius:6px;margin-top:8px"></div></div></div>' +
      '<div class="lw-opts"><div class="lw-sk" style="height:68px;border-radius:16px"></div><div class="lw-sk" style="height:68px;border-radius:16px"></div><div class="lw-sk" style="height:68px;border-radius:16px"></div></div></div>');
    window.addEventListener('pagehide', function () { if (w.hold) releaseHold(w); });

    apiGet('catalog').then(function (data) {
      var salon = data.salon || {};
      var bk = data.booking || {};
      TZ = salon.timezone || data.timezone || '';
      try { if (TZ) new Date().toLocaleString([], { timeZone: TZ }); } catch (e) { TZ = ''; }
      var dp = data.deposit_policy || null;
      var rating = salon.rating && Number(salon.rating.value) > 0 && Number(salon.rating.count) > 0
        ? { value: Number(salon.rating.value), count: Number(salon.rating.count), source: salon.rating.source || 'Google' } : null;
      var c = {
        name: salon.name || data.name || 'Book an appointment',
        location: salon.location || data.location || '',
        phone: salon.phone || '',
        tenant_name: salon.name || data.name || '',
        logo_url: safeUrl(salon.logo_url),
        cover_url: safeUrl(salon.cover_url),
        accent: /^#[0-9a-f]{6}$/i.test(salon.accent || '') ? salon.accent : '',
        rating: rating,
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
      // An explicit data-accent on the embed wins; else the salon's color; else neutral ink.
      if (!cfg.accent && c.accent) frame.setAttribute('style', accentVars(c.accent));
      brandPage(c);
      w.header = headerHtml(c, false);
      w.headerCompact = headerHtml(c, true);
      if (cfg.page) w.footer = '<div class="lw-foot">Online booking by <a href="' + esc(ORIGIN || '/') + '/" target="_blank" rel="noopener">LolaDesk</a></div>';
      // Deep link: /book?t=slug&code=AB3X7Q opens "manage" with the code filled in.
      if (cfg.code) { if (open) open(); stepManage(w, { code: cfg.code, phone: cfg.phone }); }
      else stepService(w, c);
    }).catch(function (e) {
      var nf = e && e.data && e.data.error === 'tenant_not_found';
      w.render('<div class="lw-step on" style="text-align:center;padding:24px 0"><h1 class="lw-name">' + (nf ? 'Salon not found' : 'Booking is unavailable') + '</h1><p class="lw-note" style="margin-top:8px">' +
        esc(nf ? 'Check the link you were given — it may have a typo.' : (e.message || 'Please try again in a moment.')) + '</p></div>');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
