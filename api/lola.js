/**
 * /api/lola — proxy used by dashboard front-end
 * ════════════════════════════════════════════════════════════════
 * Browser POSTs here; we route via the shared LLM client (Telnyx by
 * default, Anthropic if LLM_PROVIDER=anthropic). The API key NEVER
 * reaches the client.
 *
 * Backwards-compatible: still returns Anthropic-shape `content` array
 * so existing dashboard code (which expects data.content[0].text) keeps
 * working without changes.
 */

import { chat } from './lib/llm.js';

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-tenant-id');

  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try{
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const result = await chat({
      system: body.system,
      messages: body.messages || [],
      maxTokens: Math.min(body.max_tokens || 500, 1000),
      temperature: body.temperature ?? 0.7,
      model: body.model
    });

    if(!result.ok){
      return res.status(502).json({
        type: 'error',
        error: { type: 'upstream_error', message: result.error, provider: result.provider }
      });
    }

    // Return in the shape the dashboard expects: { content: [{ type:'text', text }] }
    return res.status(200).json({
      id: `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: result.text }],
      model: result.model,
      provider: result.provider
    });
  }catch(e){
    return res.status(500).json({ type:'error', error:{ type:'server_error', message: String(e) } });
  }
}
