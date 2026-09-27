/* LolaDesk — auth for same-origin API calls.
 *
 * The app's session lives in localStorage as `loladesk_token` (written by
 * login + auth-guard.js) and the API authenticates with
 * `Authorization: Bearer <token>`. Some pages call fetch('/api/...') with
 * cookies only, which the API ignores — so those calls returned 401.
 *
 * Load this FIRST in <head> (plain <script>, not defer). It wraps fetch so
 * every request to /api/* carries the Bearer token when the caller didn't
 * set a real one, and transparently refreshes an expired token once
 * (using `loladesk_refresh`, the same way auth-guard.js does).
 */
(function () {
  if (window.__lolaAuthFetch) return;
  window.__lolaAuthFetch = true;

  const nativeFetch = window.fetch.bind(window);
  const get = (k) => { try { return localStorage.getItem(k) || ''; } catch (_) { return ''; } };
  const set = (k, v) => { try { if (v) localStorage.setItem(k, v); } catch (_) {} };

  function isApi(url) {
    try {
      const u = new URL(url, location.href);
      return u.origin === location.origin && u.pathname.startsWith('/api/');
    } catch (_) { return false; }
  }
  function hasRealAuth(headers) {
    const v = headers.get('Authorization') || '';
    return /^Bearer\s+\S{10,}/.test(v) && !/^Bearer\s+(null|undefined)$/i.test(v);
  }

  let refreshing = null;
  async function refreshToken() {
    const rt = get('loladesk_refresh');
    if (!rt) return null;
    if (!refreshing) {
      refreshing = nativeFetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: rt }),
      })
        .then((r) => r.json().catch(() => ({})).then((d) => ({ ok: r.ok, d })))
        .then(({ ok, d }) => {
          const s = d && d.session;
          if (!ok || !s || !s.access_token) return null;
          set('loladesk_token', s.access_token);
          set('loladesk_refresh', s.refresh_token);
          return s.access_token;
        })
        .catch(() => null)
        .finally(() => { setTimeout(() => { refreshing = null; }, 0); });
    }
    return refreshing;
  }

  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!isApi(url) || url.indexOf('/api/auth/') !== -1) return nativeFetch(input, init);

    const opts = Object.assign({}, init || {});
    const headers = new Headers(opts.headers || (input instanceof Request ? input.headers : undefined));
    const callerSetAuth = hasRealAuth(headers);
    if (!callerSetAuth) {
      const t = get('loladesk_token');
      if (t) headers.set('Authorization', 'Bearer ' + t);
    }
    opts.headers = headers;

    const res = await nativeFetch(input, opts);
    if (res.status !== 401 || callerSetAuth) return res;

    // One transparent retry with a refreshed token.
    const fresh = await refreshToken();
    if (!fresh) return res;
    const h2 = new Headers(opts.headers);
    h2.set('Authorization', 'Bearer ' + fresh);
    return nativeFetch(input, Object.assign({}, opts, { headers: h2 }));
  };
})();
