/**
 * api/lib/knowledge-gaps.js — Lola gets smarter from every conversation.
 * ═══════════════════════════════════════════════════════════════════════
 * When a client asks something Lola couldn't answer ("do you do keratin on Sundays?" → "let me have the
 * salon get back to you"), the question is noted — in any language, written down in English. The owner
 * hears about it in Lola's briefing ("Clients asked me 2 things I didn't know…"); one sentence back
 * ("Lola, yes we do keratin on Sundays, $300") and she knows it on every call, text and the website
 * from then on (the salon's FAQ, which every channel reads).
 *
 *   noteGaps(c, tenant, turns, { callId })   → questions noted (usage_events kind 'knowledge_gap')
 *   openGaps(c, tenantId, { days })          → [{ question, at }] not yet answered
 *   teachLola(c, tenant, { question, answer }) → saved to the salon's FAQ; the gap is closed
 *   gapsBriefLine(gaps)                      → one sentence for her briefing
 */
import { logUsage } from './db.js';

// What Lola says when she doesn't know — in the four languages she speaks.
const UNSURE = /(not sure|i don'?t know|i do not know|i don'?t have (?:that|this)|i'?m unable to|i can'?t (?:say|confirm|answer)|let me (?:have|check with) (?:the )?(?:salon|team|owner)|(?:the )?(?:salon|team) will (?:get back|follow up|call you)|get back to you|no estoy segur[ao]|no lo s[ée]|no tengo esa informaci[oó]n|je ne sais pas|je ne suis pas s[uû]re?|je n'ai pas cette information|не знаю|не уверена?|у меня нет (?:этой )?информации)/iu;
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const keyOf = (q) => String(q || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** The client questions Lola couldn't answer in these turns (heuristic; the model only refines). */
export async function findGaps(turns = [], { llm } = {}) {
  const raw = [];
  for (let i = 1; i < turns.length; i++) {
    const t = turns[i];
    if (t?.role !== 'assistant' || !UNSURE.test(String(t.content || ''))) continue;
    const ask = [...turns.slice(0, i)].reverse().find((x) => x.role === 'user');
    if (ask && String(ask.content || '').trim().length > 6) raw.push(String(ask.content).trim());
  }
  if (!raw.length) return [];
  // One short model call turns what they said (any language) into a clean English question.
  try {
    const chat = llm || (await import('./llm.js')).chat;
    const r = await chat({ system: 'For each client message, write the underlying question in plain English, one per line, max 15 words each. Only the questions — no numbering, no extra text.',
      messages: [{ role: 'user', content: raw.slice(0, 3).join('\n') }], maxTokens: 120, temperature: 0, fast: true, deadlineMs: 6000 });
    const lines = String(r?.ok ? r.text : '').split('\n').map((l) => l.replace(/^[-*\d.)\s]+/, '').trim()).filter((l) => l.length > 6);
    if (lines.length) return lines.slice(0, 3).map((q) => clip(q, 160));
  } catch (_) {}
  return raw.slice(0, 3).map((q) => clip(q, 160));
}

async function recentGapRows(c, tenantId, days = 30) {
  try {
    const { data } = await c.from('usage_events').select('kind,metadata,created_at').eq('tenant_id', tenantId).in('kind', ['knowledge_gap', 'knowledge_answer'])
      .gte('created_at', new Date(Date.now() - days * 86400e3).toISOString()).order('created_at', { ascending: false }).limit(300);
    return data || [];
  } catch (_) { return []; }
}

export async function noteGaps(c, tenant, turns = [], { callId = null, llm } = {}) {
  if (!c || !tenant?.id || !turns.length) return [];
  const qs = await findGaps(turns, { llm });
  if (!qs.length) return [];
  const known = new Set((await recentGapRows(c, tenant.id)).map((r) => keyOf(r.metadata?.question)));
  const fresh = qs.filter((q) => !known.has(keyOf(q)));
  for (const question of fresh) { try { await logUsage(tenant.id, 'knowledge_gap', 1, { question, call_id: callId }); } catch (_) {} }
  return fresh;
}

export async function openGaps(c, tenantId, { days = 30 } = {}) {
  const rows = await recentGapRows(c, tenantId, days);
  const answered = new Set(rows.filter((r) => r.kind === 'knowledge_answer').map((r) => keyOf(r.metadata?.question)));
  const seen = new Set(), out = [];
  for (const r of rows) {
    if (r.kind !== 'knowledge_gap') continue;
    const k = keyOf(r.metadata?.question);
    if (!k || answered.has(k) || seen.has(k)) continue;
    seen.add(k); out.push({ question: r.metadata.question, at: r.created_at });
  }
  return out;
}

/** The owner's answer → the salon's FAQ (read by the phone, the website, texts and DMs). */
export async function teachLola(c, tenant, { question = '', answer = '' } = {}) {
  const a = clip(answer, 400);
  if (!c || !tenant?.id || a.length < 2) return { ok: false, say: 'What should I tell clients? Give me the answer in a sentence.' };
  let q = clip(question, 200);
  if (!q) { const open = await openGaps(c, tenant.id); q = open[0]?.question || ''; }
  if (!q) q = a.split(/[.!?]/)[0];
  const { data: row } = await c.from('tenants').select('knowledge').eq('id', tenant.id).maybeSingle().then((x) => x, () => ({ data: null }));
  const rawK = row ? row.knowledge : tenant.knowledge;
  const { parseKnowledge } = await import('./business-learn.js');
  const k = parseKnowledge(rawK);
  const faq = (Array.isArray(k.faq) ? k.faq : []).filter((f) => keyOf(f?.q) !== keyOf(q));
  const next = { ...k, faq: [{ q, a, taught: true, at: new Date().toISOString() }, ...faq].slice(0, 40) };
  const value = (rawK && typeof rawK === 'object') ? next : JSON.stringify(next);
  const { error } = await c.from('tenants').update({ knowledge: value }).eq('id', tenant.id);
  if (error) return { ok: false, say: "I couldn't save that just now — try again in a moment." };
  try { await logUsage(tenant.id, 'knowledge_answer', 1, { question: q, answer: a }); } catch (_) {}
  try { const { forgetTenant } = await import('./owner-awareness.js'); forgetTenant(tenant.id); } catch (_) {}
  return { ok: true, question: q, answer: a, say: `Got it — when someone asks "${clip(q, 80)}", I'll tell them: ${a}` };
}

export function gapsBriefLine(gaps = []) {
  if (!gaps.length) return null;
  const list = gaps.slice(0, 2).map((g) => `“${clip(g.question, 70)}”`).join(' and ');
  return `Clients asked me ${gaps.length === 1 ? 'something' : gaps.length + ' things'} I didn't know: ${list}${gaps.length > 2 ? '…' : ''}. Tell me the answer and I'll know it from now on.`;
}
