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
    base: (SCRIPT && SCRIPT.getAttribute('data-base')) || '/api/public-booking'
  };

  // Fall back to the classic ?t= / ?slug= query params when data-tenant is absent.
  if (!cfg.tenant) {
    var q = new URLSearchParams(location.search);
    cfg.tenant = q.get('t') || q.get('slug') || '';
  }

  var API = cfg.base.replace(/\/$/, '');
  var state = { catalog: null, service: null, staff: null, time: null, date: null };

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
    '.lw-overlay .lw{width:100%;max-width:520px;max-height:92vh;overflow:auto;border-radius:22px}',
    '.lw-close{position:absolute;top:14px;right:16px;background:none;border:none;color:var(--muted);font-size:22px;cursor:pointer;font-family:inherit;line-height:1}'
  ].join('\n');

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) { return '$' + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 }); }
  function timeLabel(iso) {
    return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  function whenLabel(iso) {
    return new Date(iso).toLocaleString([], { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function apiGet(action, extra) {
    var p = new URLSearchParams(Object.assign({ action: action, tenant: cfg.tenant }, extra));
    return fetch(API + '?' + p.toString()).then(function (r) { return r.json(); })
      .then(function (j) { if (!j.ok) throw new Error(j.error || 'Request failed'); return j; });
  }
  function apiPost(body) {
    return fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ tenant: cfg.tenant }, body)) })
      .then(function (r) { return r.json(); });
  }

  function el(html) {
    var t = document.createElement('template');
    t.innerHTML = html;
    return t.content.firstElementChild;
  }

  function Widget(root) {
    this.root = root; // shadow root
    this.host = root.querySelector('.lw');
  }

  Widget.prototype.render = function (html) {
    this.host.innerHTML = html;
  };
  Widget.prototype.go = function (step) {
    var self = this;
    this.host.querySelectorAll('.lw-step').forEach(function (s) {
      s.classList.toggle('on', s.getAttribute('data-step') === step);
    });
    this.host.scrollTop = 0;
    if (typeof self.onStep === 'function') self.onStep(step);
  };
  Widget.prototype.msg = function (kind, text) {
    var e = this.host.querySelector('.lw-err');
    if (e) e.textContent = text || '';
  };

  function stepService(w, catalog) {
    if (!catalog.services || !catalog.services.length) {
      w.render('<div class="lw-empty">No services listed yet.</div>');
      return;
    }
    w.render(
      '<div class="lw-step on" data-step="service">' +
      '<div class="lw-label">1 · Choose a service</div>' +
      '<div class="lw-opts">' + catalog.services.map(function (s, i) {
        return '<button class="lw-opt" data-i="' + i + '"><span><b>' + esc(s.name) + '</b>' +
          (s.duration_minutes ? '<div class="meta">' + s.duration_minutes + ' min</div>' : '') +
          '</span>' + (s.price != null ? '<span class="lw-price">' + money(s.price) + '</span>' : '') + '</button>';
      }).join('') + '</div>' +
      '<button class="lw-link" data-cancel>Manage or cancel an appointment</button></div>'
    );
    w.host.querySelectorAll('.lw-opt').forEach(function (b) {
      b.addEventListener('click', function () {
        w.service = catalog.services[Number(b.getAttribute('data-i'))];
        if (catalog.staff && catalog.staff.length) { stepStaff(w, catalog); }
        else { w.staff = null; stepTime(w, catalog); }
      });
    });
    w.host.querySelector('[data-cancel]').addEventListener('click', function () { stepManage(w); });
  }

  function stepStaff(w, catalog) {
    var anyLabel = (w.managing && w.staff) ? 'Keep my current team member' : 'Any available';
    var opts = ['<button class="lw-opt" data-i="-1"><span><b>' + anyLabel + '</b></span></button>'];
    catalog.staff.forEach(function (s, i) {
      var sel = w.staff && w.staff.id === s.id ? ' sel' : '';
      opts.push('<button class="lw-opt' + sel + '" data-i="' + i + '"><span><b>' + esc(s.name) + '</b>' +
        (s.role ? '<div class="meta">' + esc(s.role) + '</div>' : '') + '</span></button>');
    });
    w.render(
      '<div class="lw-step on" data-step="staff"><button class="lw-back" data-back="service">← Back</button>' +
      '<div class="lw-label">2 · Choose a team member</div><div class="lw-opts">' + opts.join('') + '</div></div>'
    );
    w.host.querySelector('[data-back]').addEventListener('click', function () {
      if (w.managing) { renderManageCard(w, w.managing.booking); return; }
      stepService(w, catalog);
    });
    w.host.querySelectorAll('.lw-opt').forEach(function (b) {
      b.addEventListener('click', function () {
        var i = Number(b.getAttribute('data-i'));
        w.staff = i === -1 ? null : catalog.staff[i];
        stepTime(w, catalog);
      });
    });
  }

  function stepTime(w, catalog) {
    var today = new Date().toISOString().slice(0, 10);
    var date = w.date || today;
    w.render(
      '<div class="lw-step on" data-step="time"><button class="lw-back" data-back="staff">← Back</button>' +
      '<div class="lw-label">3 · Pick a time</div>' +
      '<input type="date" class="lw-date" id="lwDate" value="' + date + '" min="' + today + '"/>' +
      '<div class="lw-slots" id="lwSlots"><div class="lw-empty">Pick a date above.</div></div></div>'
    );
    var input = w.host.querySelector('#lwDate');
    input.addEventListener('change', function () { w.date = input.value; loadSlots(w, catalog, input.value); });
    w.host.querySelector('[data-back]').addEventListener('click', function () {
      if (w.managing) { stepStaff(w, catalog); return; }
      if (catalog.staff && catalog.staff.length) { stepStaff(w, catalog); }
      else { stepService(w, catalog); }
    });
    loadSlots(w, catalog, date);
  }

  function loadSlots(w, catalog, date) {
    var host = w.host.querySelector('#lwSlots');
    host.innerHTML = '<div class="lw-empty">Checking availability…</div>';
    var p = { service_id: w.service.id, date: date };
    if (w.staff) p.staff_id = w.staff.id;
    apiGet('availability', p).then(function (data) {
      var slots = data.slots || [];
      if (!slots.length) { renderWaitlist(w, catalog, host, date); return; }
      host.innerHTML = slots.map(function (s) {
        var iso = s.starts_at || s;
        return '<button class="lw-slot" data-iso="' + esc(iso) + '">' + timeLabel(iso) + '</button>';
      }).join('');
      host.querySelectorAll('.lw-slot').forEach(function (b) {
        b.addEventListener('click', function () {
          host.querySelectorAll('.lw-slot').forEach(function (x) { x.classList.remove('sel'); });
          b.classList.add('sel');
          w.time = b.getAttribute('data-iso');
          if (w.managing) { stepRescheduleConfirm(w); return; }
          stepDetails(w, catalog);
        });
      });
    }).catch(function (e) { host.innerHTML = '<div class="lw-empty">' + esc(e.message) + '</div>'; });
  }

  function renderWaitlist(w, catalog, host, date) {
    host.innerHTML = '<div class="lw-empty">No open times on ' + esc(new Date(date + 'T12:00:00').toLocaleDateString([], { weekday:'long', month:'short', day:'numeric' })) + '.</div>' +
      '<div class="lw-wl"><div class="lw-wl-t">Get first dibs when a slot opens</div>' +
      '<div class="lw-wl-s">Leave your name and phone — ' + esc(catalog.tenant_name || 'we') + ' will text you the moment ' + esc(w.service.name) + ' has an opening.</div>' +
      '<div class="lw-wl-fld"><input id="lwWlName" placeholder="Your name"/></div>' +
      '<div class="lw-wl-fld"><input id="lwWlPhone" type="tel" placeholder="(555) 555-5555"/></div>' +
      '<label class="lw-wl-consent"><input type="checkbox" id="lwWlConsent"/><span>Yes — text me at this number the moment a slot opens.</span></label>' +
      '<button class="lw-wl-btn" id="lwWlGo">Join the waitlist</button><div class="lw-wl-ok" id="lwWlOk"></div></div>';
    host.querySelector('#lwWlGo').addEventListener('click', function () {
      var name = host.querySelector('#lwWlName').value.trim();
      var phone = host.querySelector('#lwWlPhone').value.trim();
      var ok = host.querySelector('#lwWlOk');
      var consent = host.querySelector('#lwWlConsent').checked;
      if (!name || !phone) { ok.textContent = 'Please add your name and phone.'; return; }
      if (!consent) { ok.textContent = 'Please check the box so we can text you when a slot opens.'; return; }
      var btn = host.querySelector('#lwWlGo');
      btn.disabled = true; btn.textContent = 'Adding…';
      apiPost({ action:'waitlist_add', channel:'public_widget', service_id: w.service.id, service_name: w.service.name, date: date, client_name: name, client_phone: phone, sms_consent: true })
        .then(function (result) {
          if (!result.ok) { ok.textContent = result.error || 'Could not join the waitlist.'; btn.disabled = false; btn.textContent = 'Join the waitlist'; return; }
          ok.textContent = 'You are on the waitlist — we will text you the moment a slot opens.';
          btn.style.display = 'none';
        })
        .catch(function (e) { ok.textContent = e.message || 'Something went wrong.'; btn.disabled = false; btn.textContent = 'Join the waitlist'; });
    });
  }

  function stepDetails(w, catalog) {
    var staffLine = w.staff ? ' with <b>' + esc(w.staff.name) + '</b>' : '';
    w.render(
      '<div class="lw-step on" data-step="details"><button class="lw-back" data-back="time">← Back</button>' +
      '<div class="lw-label">4 · Your details</div>' +
      '<div class="lw-summary"><b>' + esc(w.service.name) + '</b>' + staffLine + '<br>' + whenLabel(w.time) + '</div>' +
      '<div class="lw-fld"><label>Name</label><input class="lw-inp" id="lwName" placeholder="Your name"/></div>' +
      '<div class="lw-fld"><label>Phone</label><input class="lw-inp" id="lwPhone" type="tel" placeholder="(555) 555-5555"/></div>' +
      '<div class="lw-fld"><label>Email (optional)</label><input class="lw-inp" id="lwEmail" type="email"/></div>' +
      '<button class="lw-btn" id="lwBook">Confirm booking</button><div class="lw-err"></div></div>'
    );
    w.host.querySelector('[data-back]').addEventListener('click', function () { w.go('time'); });
    w.host.querySelector('#lwBook').addEventListener('click', function () { confirmBook(w); });
  }

  function confirmBook(w) {
    var name = w.host.querySelector('#lwName').value.trim();
    var phone = w.host.querySelector('#lwPhone').value.trim();
    var email = w.host.querySelector('#lwEmail').value.trim();
    var err = w.host.querySelector('.lw-err');
    var btn = w.host.querySelector('#lwBook');
    if (!name || !phone) { err.textContent = 'Please add your name and phone.'; return; }
    err.textContent = '';
    btn.disabled = true; btn.textContent = 'Booking…';
    apiPost({
      action: 'book', channel: 'public_web',
      service_id: w.service.id, staff_id: w.staff ? w.staff.id : null,
      starts_at: w.time, client_name: name, client_phone: phone, client_email: email || null,
      total_amount: w.service.price || 0
    }).then(function (result) {
      if (!result.ok) {
        err.textContent = result.conflict ? 'That time was just taken — go back and pick another.' : (result.error || 'Could not complete booking.');
        btn.disabled = false; btn.textContent = 'Confirm booking';
        return;
      }
      var code = result.booking && result.booking.confirmation_code;
      w.render(
        '<div class="lw-step on" data-step="done"><div class="lw-orb"></div>' +
        '<div class="lw-done-title">You are all set!</div>' +
        '<div class="lw-done-sub">' + esc(w.service.name) + ' on ' + whenLabel(w.time) +
        '.<br>We texted your confirmation — keep the code below to cancel or change online.</div>' +
        (code ? '<div class="lw-code">Your code: <b>' + esc(code) + '</b></div>' : '') +
        '<button class="lw-link" data-cancel>Manage or cancel this appointment</button></div>'
      );
      w.host.querySelector('[data-cancel]').addEventListener('click', function () { stepManage(w, { code: code }); });
    }).catch(function (e) {
      err.textContent = e.message || 'Something went wrong.';
      btn.disabled = false; btn.textContent = 'Confirm booking';
    });
  }

  // ── self-service manage: look up by code + phone, then reschedule/cancel ──
  function stepManage(w, prefill) {
    prefill = prefill || {};
    var code = (prefill.code || (w.managing && w.managing.code) || '').trim();
    var phone = prefill.phone || (w.managing && w.managing.phone) || '';
    w.render(
      '<div class="lw-step on" data-step="manage"><button class="lw-back" data-back>← Back</button>' +
      '<div class="lw-label">Manage an appointment</div>' +
      '<p class="lw-note">Find your booking with the code from your confirmation text.</p>' +
      '<div class="lw-fld"><label>Confirmation code</label><input class="lw-inp" id="lwMCode" value="' + esc(code) + '" placeholder="e.g. AB3X7Q" autocomplete="off"/></div>' +
      '<div class="lw-fld"><label>Phone used to book</label><input class="lw-inp" id="lwMPhone" type="tel" value="' + esc(phone) + '" placeholder="(555) 555-5555"/></div>' +
      '<button class="lw-btn" id="lwLookup">Find my appointment</button><div class="lw-err"></div></div>'
    );
    w.host.querySelector('[data-back]').addEventListener('click', function () {
      if (w.catalog) stepService(w, w.catalog);
    });
    w.host.querySelector('#lwLookup').addEventListener('click', function () { doLookup(w); });
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
          var msg = result.error === 'code_not_found' ? 'No booking matches that code.' :
            result.error === 'code_phone_mismatch' ? 'That code and phone don\'t match a booking.' :
            (result.error || 'Could not find that booking.');
          err.textContent = msg;
          btn.disabled = false; btn.textContent = 'Find my appointment';
          return;
        }
        w.managing = { code: code, phone: phone, booking: result.booking };
        renderManageCard(w, result.booking);
      })
      .catch(function (e) {
        err.textContent = e.message || 'Something went wrong.';
        btn.disabled = false; btn.textContent = 'Find my appointment';
      });
  }

  function renderManageCard(w, b) {
    var cancelled = b.status === 'cancelled' || b.status === 'canceled';
    var staffName = (b.staff && b.staff.name) || '';
    w.render(
      '<div class="lw-step on" data-step="manage-card">' +
      '<div class="lw-label">' + esc((b.service && b.service.name) || 'Appointment') + (staffName ? ' · ' + esc(staffName) : '') + '</div>' +
      '<div class="lw-card">' +
      '<div class="lw-card-when">' + esc(whenLabel(b.start_time)) + '</div>' +
      (b.service && b.service.price != null ? '<div class="lw-card-meta">' + money(b.service.price) + (b.service.duration_minutes ? ' · ' + b.service.duration_minutes + ' min' : '') + '</div>' : '') +
      (cancelled ? '<div class="lw-card-meta" style="color:#ff7a7a">This appointment is cancelled.</div>' : '') +
      '</div>' +
      (cancelled ? '<button class="lw-btn" id="lwNewBook">Book a new appointment</button>' :
        '<button class="lw-btn" id="lwResched">Pick a new time</button>' +
        '<button class="lw-link" data-cancel>Cancel this appointment instead</button>') +
      '<div class="lw-err"></div></div>'
    );
    if (cancelled) {
      w.host.querySelector('#lwNewBook').addEventListener('click', function () {
        w.managing = null;
        if (w.catalog) stepService(w, w.catalog);
      });
      return;
    }
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
    if (!svc) {
      w.msg('warn', 'That service is no longer offered — please book a new appointment instead.');
      return;
    }
    w.service = svc;
    w.staff = null;
    if (b.staff && b.staff.id) {
      var cur = (cat.staff || []).filter(function (s) { return s.id === b.staff.id; })[0];
      if (cur) w.staff = cur;
    }
    if (cat.staff && cat.staff.length) { stepStaff(w, cat); }
    else { stepTime(w, cat); }
  }

  function stepRescheduleConfirm(w) {
    w.render(
      '<div class="lw-step on" data-step="rconfirm"><button class="lw-back" data-back>← Back</button>' +
      '<div class="lw-label">Move your appointment</div>' +
      '<div class="lw-summary"><b>' + esc(w.service.name) + '</b>' +
      (w.staff ? ' with <b>' + esc(w.staff.name) + '</b>' : '') +
      '<br>New time: <b>' + esc(whenLabel(w.time)) + '</b></div>' +
      '<button class="lw-btn" id="lwReschedBtn">Confirm new time</button><div class="lw-err"></div></div>'
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
        var msg = result.conflict ? 'That time was just taken — pick another.' :
          result.error === 'code_not_found' ? 'No booking matches that code.' :
          result.error === 'code_phone_mismatch' ? 'That code and phone don\'t match a booking.' :
          result.error === 'appointment_passed' ? 'That appointment has already passed.' :
          result.error === 'not_reschedulable' ? 'That booking can no longer be changed.' :
          (result.error || 'Could not reschedule.');
        err.textContent = msg;
        btn.disabled = false; btn.textContent = 'Confirm new time';
        return;
      }
      var when = whenLabel(w.time);
      w.managing = null;
      w.render(
        '<div class="lw-step on" data-step="rescheduled"><div class="lw-orb"></div>' +
        '<div class="lw-done-title">You\'re all set</div>' +
        '<div class="lw-done-sub">Your appointment is now <b>' + esc(when) + '</b>.<br>We texted your confirmation.<br>' +
        '<button class="lw-link" data-more>Manage another appointment</button></div></div>'
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
      '<div class="lw-fld"><label>Confirmation code</label><input class="lw-inp" id="lwCode" value="' + esc(prefill.code || '') + '" placeholder="e.g. AB3X7Q" autocomplete="off"/></div>' +
      '<div class="lw-fld"><label>Phone used to book</label><input class="lw-inp" id="lwCancelPhone" type="tel" value="' + esc(prefill.phone || '') + '" placeholder="(555) 555-5555"/></div>' +
      '<button class="lw-btn" id="lwCancelBtn">Cancel appointment</button><div class="lw-err"></div></div>'
    );
    w.host.querySelector('[data-back]').addEventListener('click', function () {
      if (w.catalog) stepService(w, w.catalog);
    });
    w.host.querySelector('#lwCancelBtn').addEventListener('click', function () { doCancel(w); });
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
          var msg = result.error === 'code_not_found' ? 'No booking matches that code.' :
            result.error === 'code_phone_mismatch' ? 'That code and phone don\'t match a booking.' :
            result.error === 'appointment_passed' ? 'That appointment has already passed.' :
            result.error === 'not_cancellable' ? 'That booking is no longer cancellable.' :
            (result.error || 'Could not cancel.');
          err.textContent = msg;
          btn.disabled = false; btn.textContent = 'Cancel appointment';
          return;
        }
        w.render(
          '<div class="lw-step on" data-step="cancelled"><div class="lw-orb" style="background:radial-gradient(circle at 35% 30%,#ffd9c0,#ff7a7a 55%,#7a1e00)"></div>' +
          '<div class="lw-done-title">Cancelled</div>' +
          '<div class="lw-done-sub">Your appointment is cancelled. We\'ll text you to confirm.<br>' +
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

    if (cfg.mode === 'modal') {
      var fab = document.createElement('button');
      fab.className = 'lw-fab';
      fab.textContent = 'Book now';
      document.body.appendChild(fab);
      fab.addEventListener('click', function () {
        if (!shadow.querySelector('.lw-overlay')) {
          var overlay = document.createElement('div');
          overlay.className = 'lw-overlay';
          overlay.innerHTML = '<button class="lw-close" aria-label="Close">✕</button>';
          overlay.appendChild(frame);
          shadow.appendChild(overlay);
          overlay.querySelector('.lw-close').addEventListener('click', function () { overlay.remove(); });
        }
      });
    } else {
      (SCRIPT.parentNode || document.body).appendChild(host);
    }

    var w = new Widget(shadow);
    w.render('<div class="lw-name">Loading…</div>');

    apiGet('catalog').then(function (data) {
      var c = { name: data.name || 'Book an appointment', location: data.location || '', services: data.services || [], staff: data.staff || [] };
      state.catalog = c;
      w.catalog = c;
      w.render('<div class="lw-name">' + esc(c.name) + '</div>' +
        (c.location ? '<div class="lw-meta">' + esc(c.location) + '</div>' : '') +
        '<div class="lw-step on" data-step="service"><div class="lw-label">1 · Choose a service</div><div class="lw-opts"></div></div>');
      w.go('service');
      stepService(w, c);
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
