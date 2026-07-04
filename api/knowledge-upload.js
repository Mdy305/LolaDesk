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
    const { data: tenantRow } = await c.from('tenants').select('id').eq('owner_email', user.email).single();
    if (!tenantRow) return res.status(404).json({ error: 'Tenant not found' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { filename, content } = body;
    if (!filename || !content) return res.status(400).json({ error: 'Missing filename or content' });

    const { data, error } = await c.from('knowledge_base').insert({
      tenant_id: tenantRow.id,
      filename,
      content
    }).select().single();

    if (error) throw error;
    
    return res.status(200).json({ ok: true, data });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
