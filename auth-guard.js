/* ═══════════════════════════════════════════════════════════════
   LolaDesk — auth guard
   ════════════════════════════════════════════════════════════════
   Include BEFORE lola-data.js on any page that shows a salon's real
   data. Without this, /api/data silently falls back to the seeded
   MMΛ Salon tenant for anyone with no token — i.e. every interior
   page was showing real salon data to unauthenticated visitors.

   What this does:
   1. Reads loladesk_token from localStorage (set by login.html / onboarding.html)
   2. If missing, redirects to login.html immediately — nothing renders
   3. If present, validates it against /api/auth/session (catches
      expired/revoked tokens, not just "is there a string present")
   4. On success, stores the resolved user+tenant on window.LolaAuth
      so pages/lola-data.js don't need a second round-trip
   5. On failure, clears the stale token and redirects to login.html

   This is synchronous-feeling but actually async — pages should wait
   on window.LolaAuth.ready (a Promise) before rendering anything
   sensitive, the same way they already await LolaData.load().
   ═══════════════════════════════════════════════════════════════ */
(function(){
  function getToken(){ try{ return localStorage.getItem('loladesk_token')||''; }catch(e){ return ''; } }
  function clearToken(){ try{ localStorage.removeItem('loladesk_token'); localStorage.removeItem('loladesk_refresh'); }catch(e){} }
  function redirectToLogin(){
    const here = encodeURIComponent(location.pathname + location.search);
    location.replace('login.html?next=' + here);
  }
  function redirectToOnboarding(){
    const here = encodeURIComponent(location.pathname + location.search);
    location.replace('onboarding.html?next=' + here);
  }

  const token = getToken();
  if(!token){
    redirectToLogin();
    // Throwing stops any inline page script below this guard from
    // running and racing the redirect with a fetch using no token.
    throw new Error('LolaDesk auth-guard: no token, redirecting to login');
  }

  const ready = fetch('/api/auth/session', {
    headers: { 'Authorization': 'Bearer ' + token }
  }).then(r => {
    if(!r.ok) throw new Error('session invalid: ' + r.status);
    return r.json();
  }).then(data => {
    if(!data?.tenant){
      redirectToOnboarding();
      throw new Error('session valid but tenant not provisioned yet');
    }
    // Keep `ready` available after resolution. Several independently loaded
    // dashboard modules use it as their single session/tenant gate.
    window.LolaAuth = { user: data.user, tenant: data.tenant, token, ready };
    return window.LolaAuth;
  }).catch(err => {
    if(String(err?.message || '').includes('tenant not provisioned')){
      return Promise.reject(err);
    }
    console.warn('[auth-guard] session check failed, redirecting to login:', err);
    clearToken();
    redirectToLogin();
    // Re-throw so anything chained on window.LolaAuth.ready also stops
    // rather than rendering with no user/tenant.
    throw err;
  });

  window.LolaAuth = { ready };
})();
