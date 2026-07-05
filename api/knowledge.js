/**
 * /api/knowledge  (Authorization: Bearer <access_token>)
 * Per-tenant knowledge ingestion for Lola. Always scoped to the authenticated
 * owner's own tenant — never accepts a tenant id from the client.
 *
 *   POST  { kind:'document'|'reviews', filename, text }
 *           → distills the text into facts Lola can use, stores it, and folds a
 *             capped digest into tenant.knowledge.documents_digest so it flows
 *             through tenantKnowledgePrompt() on every call/text.
 *   POST  { kind:'contacts', filename, contacts:[{name,phone,email}] }
 *           → imports contacts into the clients (CRM) table. Not put in prompts.
 *   GET   → lists this tenant's uploaded documents.
 *   DELETE ?id=<uuid> → removes a document and rebuilds the digest.
 */
import { getUserFromToken, bearer } from './lib/auth.js';
import { db, updateTenantFields, upsertClient } from './lib/db.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { chat } from './lib/llm.js';

const RAW_CAP = 20000;     // chars of extracted text stored per document
const DIGEST_CAP = 4000;   // chars of combined digest injected into Lola's prompt
const MAX_CONTACTS = 1000;

function parseKnowledge(k){
  if(!k) return {};
  if(typeof k === 'object') return k;
  try{ return JSON.parse(k); }catch{ return String(k).trim() ? { summary: String(k) } : {}; }
}

// Rebuild the compact digest from all of a tenant's documents and save it into
// tenant.knowledge.documents_digest (capped), leaving other knowledge intact.
async function rebuildDigest(c, tenant){
  const { data=[] } = await c.from('tenant_documents')
    .select('kind,filename,summary').eq('tenant_id', tenant.id)
    .order('created_at', { ascending:true });
  const digest = (data||[])
    .map(d => `• [${d.kind}${d.filename?`: ${d.filename}`:''}] ${d.summary||''}`.trim())
    .join('\n')
    .slice(0, DIGEST_CAP);
  const knowledge = parseKnowledge(tenant.knowledge);
  if(digest) knowledge.documents_digest = digest; else delete knowledge.documents_digest;
  await updateTenantFields(tenant.id, { knowledge });
  return digest;
}

async function distill(text){
  const clean = String(text||'').replace(/\s+/g,' ').trim().slice(0, 12000);
  if(!clean) return '';
  try{
    const r = await chat({
      system: 'You distill a business document into concise factual notes an AI receptionist can rely on. Output plain sentences (no markdown, no preamble), 800 characters max, capturing services, prices, hours, policies, and common questions/answers only.',
      messages: [{ role:'user', content: clean }],
      maxTokens: 400,
      temperature: 0.2,
      source: 'knowledge'
    });
    if(r?.ok && r.text) return r.text.trim().slice(0, 900);
  }catch{}
  return clean.slice(0, 800);
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(200).end();

  try{
    const user = await getUserFromToken(bearer(req));
    if(!user) return res.status(401).json({ error:'not authenticated' });
    const c = db();
    if(!c) return res.status(503).json({ error:'database not configured' });
    const tenant = await resolveTenantForUser(user);
    if(!tenant?.id) return res.status(404).json({ error:'no tenant found for this account' });

    // ── LIST ──
    if(req.method === 'GET'){
      const { data=[] } = await c.from('tenant_documents')
        .select('id,kind,filename,char_count,summary,created_at')
        .eq('tenant_id', tenant.id).order('created_at', { ascending:false });
      return res.status(200).json({ documents: data||[] });
    }

    // ── DELETE ──
    if(req.method === 'DELETE'){
      let id=''; try{ id = new URL(req.url,'http://x').searchParams.get('id')||''; }catch{}
      if(!id) return res.status(400).json({ error:'missing id' });
      await c.from('tenant_documents').delete().eq('tenant_id', tenant.id).eq('id', id);
      const digest = await rebuildDigest(c, tenant);
      return res.status(200).json({ ok:true, digestChars: digest.length });
    }

    if(req.method !== 'POST') return res.status(405).json({ error:'method not allowed' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body||'{}') : (req.body||{});
    const kind = String(body.kind||'document');

    // ── CONTACTS → import into the clients (CRM) table ──
    if(kind === 'contacts'){
      const rows = Array.isArray(body.contacts) ? body.contacts.slice(0, MAX_CONTACTS) : [];
      let imported = 0, skipped = 0;
      for(const ct of rows){
        const phone = String(ct.phone||'').trim();
        if(!phone){ skipped++; continue; }          // upsert keys on phone; skip phone-less rows
        try{
          await upsertClient(tenant.id, { phone, name:String(ct.name||'').trim(), email:String(ct.email||'').trim() });
          imported++;
        }catch{ skipped++; }
      }
      return res.status(200).json({ ok:true, kind:'contacts', imported, skipped });
    }

    // ── DOCUMENT / REVIEWS → distill + store + refresh digest ──
    const text = String(body.text||'').slice(0, RAW_CAP);
    if(!text.trim()) return res.status(400).json({ error:'no text extracted from file' });
    const docKind = kind === 'reviews' ? 'reviews' : 'document';
    const summary = await distill(text);

    const { data: inserted } = await c.from('tenant_documents').insert({
      tenant_id: tenant.id,
      kind: docKind,
      filename: String(body.filename||'').slice(0, 200),
      char_count: text.length,
      summary,
      raw_text: text
    }).select('id,kind,filename,char_count,summary,created_at').maybeSingle();

    const digest = await rebuildDigest(c, tenant);
    return res.status(200).json({ ok:true, document: inserted, digestChars: digest.length });
  }catch(e){
    return res.status(500).json({ error:String(e&&e.message||e) });
  }
}

