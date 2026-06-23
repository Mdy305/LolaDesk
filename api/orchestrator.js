import fetch from 'node-fetch';
import { db } from './lib/db.js';
import { validateLLMOutput } from './lib/llm-validator.js';

// Lightweight orchestrator endpoint — call LLM, validate structured JSON output, record audit
export default async function handler(req, res){
  if(req.method !== 'POST') return res.status(405).end();
  const body = req.body || {};
  const prompt = body.prompt || null;
  const model = process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini';
  if(!prompt) return res.status(400).json({ error: 'missing prompt' });

  const c = db();
  if(!c) return res.status(500).json({ error: 'Supabase not configured' });

  // call LLM if key present, otherwise create a safe mock
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
          messages: [{ role: 'system', content: 'Respond with a single JSON object describing {action, params, speak}. Do not include any extra text.' }, { role: 'user', content: prompt }],
          max_tokens: 800
        })
      });
      const j = await resp.json();
      // defensively pull text
      llmRaw = j?.choices?.[0]?.message?.content || JSON.stringify(j);
    } else {
      // Mock safe response when no key present
      llmRaw = JSON.stringify({ action: 'none', params: {}, speak: "Sorry — AI service not configured in staging." });
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

  return res.status(200).json({ output: parsed, validation });
}
