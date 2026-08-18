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
    '.lw-orb{width:52px;height:52px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#f1ffc0,var(--accent) 55%,#7a9e00);margin:0 auto 18px}',
    '.lw-done-title{font-size:22px;font-weight:600;text-align:center;margin-bottom:8px}',
    '.lw-done-sub{color:var(--muted);font-size:14px;text-align:center;line-height:1.7}',
    '.lw-code{background:var(--surface2);border-radius:12px;padding:12px 16px;margin:18px 0 4px;font-size:14px;color:var(--muted);text-align:center}',
    '.lw-code b{color:var(--accent2);font-weight:600;letter-spacing:.08em}',
    '.lw-link{display:block;margin:16px auto 0;background:none;border:none;color:var(--muted);font-size:13px;cursor:pointer;text-decoration:underline;font-family:inherit;padding:0}',
    '.lw-link:hover{color:var(--accent2)}',
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
      '<button class="lw-link" data-cancel>Cancel an appointment</button></div>'
    );
    w.host.querySelectorAll('.lw-opt').forEach(function (b) {
      b.addEventListener('click', function () {
        w.service = catalog.services[Number(b.getAttribute('data-i'))];
        if (catalog.staff && catalog.staff.length) { stepStaff(w, catalog); }
        else { w.staff = null; stepTime(w, catalog); }
      });
    });
    w.host.querySelector('[data-cancel]').addEventListener('click', function () { stepCancel(w); });
  }

  function stepStaff(w, catalog) {
    var opts = ['<button class="lw-opt" data-i="-1"><span><b>Any available</b></span></button>'];
    catalog.staff.forEach(function (s, i) {
      opts.push('<button class="lw-opt" data-i="' + i + '"><span><b>' + esc(s.name) + '</b>' +
        (s.role ? '<div class="meta">' + esc(s.role) + '</div>' : '') + '</span></button>');
    });
    w.render(
      '<div class="lw-step on" data-step="staff"><button class="lw-back" data-back="service">← Back</button>' +
      '<div class="lw-label">2 · Choose a team member</div><div class="lw-opts">' + opts.join('') + '</div></div>'
    );
    w.host.querySelector('[data-back]').addEventListener('click', function () { w.go('service'); });
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
      w.go(catalog.staff && catalog.staff.length ? 'staff' : 'service');
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
      if (!slots.length) { host.innerHTML = '<div class="lw-empty">No open times that day — try another date.</div>'; return; }
      host.innerHTML = slots.map(function (s) {
        var iso = s.starts_at || s;
        return '<button class="lw-slot" data-iso="' + esc(iso) + '">' + timeLabel(iso) + '</button>';
      }).join('');
      host.querySelectorAll('.lw-slot').forEach(function (b) {
        b.addEventListener('click', function () {
          host.querySelectorAll('.lw-slot').forEach(function (x) { x.classList.remove('sel'); });
          b.classList.add('sel');
          w.time = b.getAttribute('data-iso');
          stepDetails(w, catalog);
        });
      });
    }).catch(function (e) { host.innerHTML = '<div class="lw-empty">' + esc(e.message) + '</div>'; });
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
        '<button class="lw-link" data-cancel>Cancel this appointment</button></div>'
      );
      w.host.querySelector('[data-cancel]').addEventListener('click', function () { stepCancel(w); });
    }).catch(function (e) {
      err.textContent = e.message || 'Something went wrong.';
      btn.disabled = false; btn.textContent = 'Confirm booking';
    });
  }

  function stepCancel(w) {
    w.render(
      '<div class="lw-step on" data-step="cancel"><button class="lw-back" data-back>← Back</button>' +
      '<div class="lw-label">Cancel an appointment</div>' +
      '<div class="lw-fld"><label>Confirmation code</label><input class="lw-inp" id="lwCode" placeholder="e.g. AB3X7Q" autocomplete="off"/></div>' +
      '<div class="lw-fld"><label>Phone used to book</label><input class="lw-inp" id="lwCancelPhone" type="tel" placeholder="(555) 555-5555"/></div>' +
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

  function boot() {
    if (!cfg.tenant) {
      var missing = document.createElement('div');
      missing.textContent = 'Booking widget: missing data-tenant attribute.';
      (SCRIPT.parentNode || document.body).appendChild(missing);
      return;
    }

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
