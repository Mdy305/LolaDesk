import { db } from './lib/db.js';
import { getUserFromToken, bearer } from './lib/auth.js';
import { chat } from './lib/llm.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const c = db();
    const { data: tenantRow } = await c.from('tenants').select('id, name').eq('owner_email', user.email).single();
    if (!tenantRow) return res.status(404).json({ error: 'Tenant not found' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { prompt } = body;
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

    // RAG: Fetch all knowledge base items for this tenant
    const { data: knowledgeRows } = await c.from('knowledge_base').select('filename, content').eq('tenant_id', tenantRow.id);
    let contextStr = "";
    if (knowledgeRows && knowledgeRows.length > 0) {
      contextStr = "KNOWLEDGE BASE CONTEXT:\n";
      for (const row of knowledgeRows) {
        contextStr += `--- Source: ${row.filename} ---\n${row.content}\n\n`;
      }
    }

    const systemPrompt = `You are a premium AI marketing manager for a high-end salon named ${tenantRow.name}. Write a short, highly-converting SMS/Email draft based on the user's prompt. Use the following Knowledge Base context to ensure prices and services are perfectly accurate:\n${contextStr}`;

    const result = await chat({
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 600,
      temperature: 0.7
    });
    if (!result.ok) return res.status(502).json({ error: result.error || 'Telnyx inference failed' });
    const draft = result.text;

    return res.status(200).json({ ok: true, draft });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
