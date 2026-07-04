import { db } from './lib/db.js';
import { getUserFromToken, bearer } from './lib/auth.js';

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

    const openAiKey = process.env.OPENAI_API_KEY;
    if (!openAiKey) {
      // Stub if missing key
      return res.status(200).json({ ok: true, draft: `(Simulated) Hey! We are running a special this weekend at ${tenantRow.name}. Book now to get 20% off!` });
    }

    const systemPrompt = `You are a premium AI marketing manager for a high-end salon named ${tenantRow.name}. Write a short, highly-converting SMS/Email draft based on the user's prompt. Use the following Knowledge Base context to ensure prices and services are perfectly accurate:\n${contextStr}`;

    const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${openAiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt }
        ]
      })
    });

    const aiData = await aiRes.json();
    const draft = aiData.choices?.[0]?.message?.content || "Failed to generate.";

    return res.status(200).json({ ok: true, draft });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
