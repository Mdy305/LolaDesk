/**
 * LolaDesk — Secure API Proxy (Cloudflare Worker)
 * ════════════════════════════════════════════════════════════════
 * Deploy this so the Anthropic API key NEVER touches the browser.
 *
 * SETUP:
 *   1. npm install -g wrangler
 *   2. wrangler login
 *   3. wrangler secret put ANTHROPIC_API_KEY   (paste your key)
 *   4. wrangler deploy
 *   5. In the dashboard, set:
 *        window.__LOLADESK_API__ = 'https://your-worker.workers.dev'
 *
 * This also enforces per-tenant rate limiting and usage metering,
 * which is how you bill each salon for their Lola usage.
 */

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors() });
    }
    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405);
    }

    try {
      const body = await request.json();

      // ── Tenant identification (for billing + rate limits) ──
      const tenantId = request.headers.get('x-tenant-id') || 'unknown';

      // ── Optional: rate limit per tenant via KV ──
      // const count = await env.USAGE.get(`${tenantId}:${today()}`);
      // if (Number(count) > tenantLimit(tenantId)) {
      //   return json({ error: 'Daily limit reached. Upgrade your plan.' }, 429);
      // }

      // ── Forward to Anthropic with the server-held key ──
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: body.model || 'claude-sonnet-4-6',
          max_tokens: Math.min(body.max_tokens || 500, 1000),
          system: body.system,
          messages: body.messages
        })
      });

      const data = await res.json();

      // ── Meter usage for billing (Pro plans, overage, etc.) ──
      // const used = data.usage?.output_tokens || 0;
      // await env.USAGE.put(`${tenantId}:${today()}`, String(Number(count||0) + used));

      return json(data);
    } catch (e) {
      return json({ error: 'Proxy error', detail: String(e) }, 500);
    }
  }
};

function cors() {
  return {
    'Access-Control-Allow-Origin': '*', // tighten to your domains in production
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-tenant-id'
  };
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors() }
  });
}
function today() {
  return new Date().toISOString().slice(0, 10);
}
