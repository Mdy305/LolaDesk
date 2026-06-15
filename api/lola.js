/**
 * /api/lola — Vercel Serverless Function
 * ════════════════════════════════════════════════════════════════
 * Keeps the Anthropic API key server-side. The browser calls this,
 * this calls Anthropic. The key NEVER reaches the client.
 *
 * Set the key in Vercel:
 *   Project → Settings → Environment Variables → ANTHROPIC_API_KEY
 *
 * Then in the dashboard, before app.js loads:
 *   <script>window.__LOLADESK_API__ = '/api/lola';</script>
 */

export default async function handler(req, res) {
  // CORS (same-origin in production, but explicit for safety)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-tenant-id');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'Server not configured: missing ANTHROPIC_API_KEY' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: body.model || 'claude-sonnet-4-6',
        max_tokens: Math.min(body.max_tokens || 500, 1000),
        system: body.system,
        messages: body.messages
      })
    });

    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: 'Proxy error', detail: String(e) });
  }
}
