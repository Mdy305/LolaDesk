// global fetch (Node 18+) — the 'node-fetch' package was never in package.json and crashed cold deploys
import { db } from './lib/db.js';
import { validateLLMOutput } from './lib/llm-validator.js';
import { delegateToAgent } from './lib/router.js';
import { normalizeAgentName, summarizeTopology } from './lib/agent-topology.js';

// Control plane endpoint:
// 1) explicit routing mode (route_to + task)
// 2) LLM planning mode (prompt -> structured action)
export default async function handler(req, res){
  if(req.method !== 'POST') return res.status(405).end();
  const body = req.body || {};
  const prompt = body.prompt || null;
  const routeTo = body.route_to || body.routeTo || null;
  const task = body.task || null;
  const tenant = body.tenant || {};
  const model = process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini';

  const c = db();
  if(!c) return res.status(500).json({ error: 'Supabase not configured' });

  // Explicit routing mode bypasses LLM and delegates directly.
  if(routeTo || task){
    const normalized = normalizeAgentName(routeTo);
    if(!normalized){
      return res.status(200).json({
        ok: false,
        error: 'unknown route_to agent',
        topology: summarizeTopology()
      });
    }
    const routed = await delegateToAgent(normalized, task || 'Run default check-in', tenant, body.context || {});
    return res.status(200).json({
      ok: routed.status === 'delegated',
      mode: 'direct-route',
      route_to: normalized,
      task: task || 'Run default check-in',
      routed
    });
  }
  if(!prompt){
    return res.status(400).json({ error: 'missing prompt (or pass route_to + task)' });
  }

  // Call LLM if key present, otherwise safe mock.
  let llmRaw = null;
  try{
    if(process.env.OPENAI_API_KEY){
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages: [{
            role: 'system',
            content: 'You are the LolaDesk control-plane orchestrator. Respond with ONE JSON object only in this shape: {action, params, speak, route_to?, task?}. action must be one of book,cancel,ask,route,none. Use action=route for specialized agents and set route_to to one of lola,ops,growth,website,reputation,citation,publication.'
          }, { role: 'user', content: prompt }],
          max_tokens: 800
        })
      });
      const j = await resp.json();
      // defensively pull text
      llmRaw = j?.choices?.[0]?.message?.content || JSON.stringify(j);
    } else {
      // Mock safe response when no key present
      llmRaw = JSON.stringify({ action: 'none', params: {}, speak: 'Control plane AI is not configured yet.' });
    }
  }catch(e){
    llmRaw = JSON.stringify({ action: 'none', params: {}, speak: `LLM call failed: ${String(e?.message||e)}` });
  }

  // try to parse JSON output
  let parsed = null;
  try{ parsed = JSON.parse(llmRaw); }catch(e){
    // if it's not pure JSON, try to extract JSON substring
    const m = llmRaw.match(/\{[\s\S]*\}/);
    if(m) try{ parsed = JSON.parse(m[0]); }catch(_){ parsed = null; }
  }

  const validation = validateLLMOutput(parsed || {});

  // record audit
  try{
    await c.from('orchestrator_audit').insert({ prompt, llm_output: parsed || llmRaw, valid: validation.valid, errors: validation.errors, validated_at: new Date() });
  }catch(e){ console.error('audit insert failed', e); }

  if(!validation.valid){
    // safe fallback reply
    const fallback = { action: 'none', params: {}, speak: "I'm sorry — I couldn't prepare that action. Can you please rephrase?" };
    return res.status(200).json({ fallback, validation });
  }

  if(parsed.action === 'route'){
    const normalized = normalizeAgentName(parsed.route_to);
    if(!normalized){
      return res.status(200).json({
        ok: false,
        error: 'route action returned unknown agent',
        output: parsed,
        topology: summarizeTopology()
      });
    }
    const routed = await delegateToAgent(normalized, parsed.task || prompt, tenant, body.context || {});
    return res.status(200).json({
      ok: routed.status === 'delegated',
      mode: 'llm-route',
      output: parsed,
      route_to: normalized,
      routed,
      validation
    });
  }

  return res.status(200).json({ output: parsed, validation });
}
