#!/usr/bin/env bash
set -euo pipefail

# Config - change if you want a different branch or PR base
BRANCH="feature/tenant-skills"
PR_BASE="staging"
PR_TITLE="feat(skills): add voice, memory and tenant skills (supabase-js)"
PR_BODY="Adds memory module (JSON embedding), voice skill, tenant conversation, maintenance_request and visitor_management skills, plus migrations and a worker template.\n\nPost-merge: run migrations in Supabase (migrations/) and start the worker on a host with SUPABASE_SERVICE_ROLE_KEY and embedding/TTS/API keys."

echo "Creating branch $BRANCH and writing files..."

git fetch origin
git checkout -b "$BRANCH"

mkdir -p migrations api/lib api/lib/skills jobs

cat > migrations/20260624_tenant_skills.sql <<'SQL'
-- migrations/20260624_tenant_skills.sql

-- conversation history for tenant chats (short-term + audit)
CREATE TABLE IF NOT EXISTS tenant_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT,
  session_id TEXT,
  role TEXT, -- user|assistant|system
  message TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

-- maintenance requests
CREATE TABLE IF NOT EXISTS maintenance_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT,
  unit TEXT,
  category TEXT,
  description TEXT,
  status TEXT DEFAULT 'open',
  assigned_to TEXT,
  scheduled_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- visitors / pre-registered guests
CREATE TABLE IF NOT EXISTS visitors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT,
  guest_name TEXT,
  phone TEXT,
  expected_at timestamptz,
  checked_in BOOLEAN DEFAULT FALSE,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

-- payments intents (minimal)
CREATE TABLE IF NOT EXISTS payment_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT,
  amount_cents integer,
  currency text DEFAULT 'usd',
  status text DEFAULT 'pending',
  provider_ref text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);
SQL

cat > migrations/20260624_memory_json.sql <<'SQL'
-- migrations/20260624_memory_json.sql
-- memory table that stores embeddings as JSONB (works without pgvector)

CREATE TABLE IF NOT EXISTS memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text,
  subject text,
  content text,
  metadata jsonb DEFAULT '{}'::jsonb,
  embedding jsonb, -- store embedding as JSON array
  created_at timestamptz DEFAULT now()
);

-- Optional index on tenant_id + created_at for faster retrieval
CREATE INDEX IF NOT EXISTS memories_tenant_created_idx ON memories (tenant_id, created_at DESC);
SQL

cat > api/lib/memory.js <<'JS'
/**
 * api/lib/memory.js
 * Supabase-js based memory module that stores embeddings as JSON and performs
 * local cosine similarity search in Node. No pgvector required.
 *
 * Requires env: EMBEDDING_API_KEY and EMBEDDING_API_URL (if using OpenAI)
 * Uses SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY for server-side DB access.
 */
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  // don't throw here to allow non-worker usage, but warn
  console.warn('Warning: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set. Memory module DB calls will fail until configured.');
}
const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) : null;

const EMBEDDING_API_KEY = process.env.EMBEDDING_API_KEY;
const EMBEDDING_API_URL = process.env.EMBEDDING_API_URL || 'https://api.openai.com/v1/embeddings';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]*b[i];
    na += a[i]*a[i];
    nb += b[i]*b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-12);
}

async function embedText(text) {
  if (!EMBEDDING_API_KEY) throw new Error('EMBEDDING_API_KEY not set');
  const res = await fetch(EMBEDDING_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${EMBEDDING_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ input: text, model: EMBEDDING_MODEL })
  });
  const j = await res.json();
  if (!j.data || !j.data[0] || !j.data[0].embedding) throw new Error('embedding failed: ' + JSON.stringify(j));
  return j.data[0].embedding;
}

async function addMemory({ tenantId, subject, content, metadata = {} }) {
  if (!supabase) throw new Error('supabase client not configured');
  const embedding = await embedText(content);
  const { data, error } = await supabase
    .from('memories')
    .insert([{ tenant_id: tenantId || null, subject, content, metadata, embedding }])
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function searchMemories({ tenantId, query, topK = 5 }) {
  if (!supabase) throw new Error('supabase client not configured');
  const { data, error } = await supabase
    .from('memories')
    .select('id, tenant_id, subject, content, metadata, embedding, created_at')
    .or(tenantId ? \`tenant_id.eq.\${tenantId}\` : 'tenant_id.is.null')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  const qEmbedding = await embedText(query);
  const scored = (data || []).map(row => {
    const emb = Array.isArray(row.embedding) ? row.embedding : (row.embedding ? JSON.parse(row.embedding) : null);
    const sim = emb ? cosine(emb, qEmbedding) : 0;
    return { ...row, similarity: sim };
  });
  scored.sort((a,b)=> b.similarity - a.similarity);
  return scored.slice(0, topK);
}

module.exports = { embedText, addMemory, searchMemories };
JS

cat > api/lib/skills/voice_skill.js <<'JS'
/**
 * api/lib/skills/voice_skill.js
 * Voice skill that enqueues demo_call jobs and stores transcripts via Supabase
 * Uses supabase-js server client.
 */
const { createClient } = require('@supabase/supabase-js');
const { addMemory } = require('../memory');

const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

const VoiceSkill = {
  id: 'voice_skill.v1',
  name: 'LOLA Voice Skill',
  description: 'Handle call-related flows: enqueue demo calls, store transcripts and summarize to memory.',
  async execute(payload, ctx) {
    try {
      if (!supabase) return { ok: false, error: 'supabase_unavailable' };
      // Enqueue an outbound demo call (worker will handle Telnyx integration)
      if (payload.type === 'outbound_demo') {
        await supabase.from('jobs').insert([{
          type: 'demo_call',
          payload: payload,
          status: 'queued',
          created_at: new Date().toISOString()
        }]);
        return { ok: true, output: { queued: true } };
      }

      // Handle transcript received (webhook or worker can call this)
      if (payload.type === 'on_transcript') {
        const { tenantId, session_id, transcript } = payload;
        await supabase.from('tenant_conversations').insert([{
          tenant_id: tenantId || null,
          session_id: session_id || null,
          role: 'assistant',
          message: transcript,
          metadata: { source: 'voice' },
          created_at: new Date().toISOString()
        }]);
        // summarize/store to memory
        try {
          await addMemory({ tenantId, subject: 'call_note', content: transcript, metadata: { source: 'voice' } });
        } catch (e) {
          console.warn('memory add failed', e);
        }
        return { ok: true };
      }

      return { ok: false, error: 'unknown_payload_type' };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  }
};

module.exports = VoiceSkill;
JS

cat > api/lib/skills/tenant_conversation.js <<'JS'
/**
 * api/lib/skills/tenant_conversation.js
 * Uses supabase-js and memory module to handle multi-turn conversation, intent routing.
 */
const { createClient } = require('@supabase/supabase-js');
const { searchMemories, addMemory } = require('../memory');

const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

const TenantConversationSkill = {
  id: 'tenant_conversation.v1',
  name: 'Tenant Conversation',
  description: 'Handles multi-turn conversations, logs messages, uses memory to personalize replies, and routes intents.',
  async execute(payload, ctx) {
    try {
      if (!supabase) return { ok: false, error: 'supabase_unavailable' };
      const { message, session_id, tenantId } = payload;

      // store user message
      await supabase.from('tenant_conversations').insert([{
        tenant_id: tenantId || null,
        session_id: session_id || null,
        role: 'user',
        message,
        metadata: {},
        created_at: new Date().toISOString()
      }]);

      // fetch relevant memories to include in prompt (if using LLM)
      let memories = [];
      try {
        memories = await searchMemories({ tenantId, query: message, topK: 5 });
      } catch (e) {
        console.warn('memory search failed', e);
      }

      // If ctx.llm helper exists, use it to identify intent and generate reply
      let reply = null;
      let intent = null;
      let confidence = 0;
      if (ctx && ctx.llm) {
        try {
          const intentResult = await ctx.llm.identifyIntent({ message, session_id, tenantId, memories });
          intent = intentResult.intent;
          confidence = intentResult.confidence || 0;
        } catch (e) {
          console.warn('llm identifyIntent failed', e);
        }
      }

      // simple rule routing example
      if ((intent === 'maintenance_create') || /leak|broken|heat|heater|air conditioning/i.test(message)) {
        // call the maintenance skill (if registered via orchestrator)
        if (ctx && typeof ctx.callSkill === 'function') {
          const res = await ctx.callSkill('maintenance_request.v1', { tenantId, description: message }, ctx);
          const assistantMessage = res.ok ? \`Created maintenance request \${res.output.request_id}\` : \`Unable to create request: \${res.error}\`;
          await supabase.from('tenant_conversations').insert([{
            tenant_id: tenantId || null,
            session_id: session_id || null,
            role: 'assistant',
            message: assistantMessage,
            created_at: new Date().toISOString()
          }]);
          return { ok: res.ok, output: { intent, result: res } };
        }
      }

      // fallback generate reply with ctx.llm.generateReply if available
      if (ctx && ctx.llm && typeof ctx.llm.generateReply === 'function') {
        try {
          reply = await ctx.llm.generateReply({ message, memories, session_id, tenantId });
        } catch (e) {
          console.warn('llm generateReply failed', e);
        }
      }

      // default canned reply
      if (!reply) reply = "Thanks — I've noted your message. Can you tell me a preferred time or more details?";

      // store assistant reply
      await supabase.from('tenant_conversations').insert([{
        tenant_id: tenantId || null,
        session_id: session_id || null,
        role: 'assistant',
        message: reply,
        created_at: new Date().toISOString()
      }]);

      // optionally add user message to memory as a short fact
      try {
        await addMemory({ tenantId, subject: 'conversation_fact', content: message, metadata: { session_id } });
      } catch (e) {
        console.warn('addMemory failed', e);
      }

      return { ok: true, output: { reply, intent, confidence } };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  }
};

module.exports = TenantConversationSkill;
JS

cat > api/lib/skills/maintenance_request.js <<'JS'
/**
 * api/lib/skills/maintenance_request.js
 * Create maintenance_requests row and enqueue a job (supabase jobs table)
 */
const { createClient } = require('@supabase/supabase-js');
const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

const MaintenanceSkill = {
  id: 'maintenance_request.v1',
  name: 'Maintenance Request',
  description: 'Create and manage maintenance tickets',
  async execute(payload, ctx) {
    try {
      if (!supabase) return { ok: false, error: 'supabase_unavailable' };
      const { tenantId, unit, category, description, preferred_time } = payload;
      const { data: inserted, error } = await supabase.from('maintenance_requests').insert([{
        tenant_id: tenantId || null,
        unit: unit || null,
        category: category || 'general',
        description: description || '',
        scheduled_at: preferred_time || null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }]).select().single();
      if (error) return { ok: false, error: error.message || error };

      // enqueue a job
      await supabase.from('jobs').insert([{
        type: 'maintenance_notify',
        payload: { request_id: inserted.id },
        status: 'queued',
        created_at: new Date().toISOString()
      }]);

      return { ok: true, output: { request_id: inserted.id, status: inserted.status } };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  }
};

module.exports = MaintenanceSkill;
JS

cat > api/lib/skills/visitor_management.js <<'JS'
/**
 * api/lib/skills/visitor_management.js
 * Pre-register guests and enqueue notification job
 */
const { createClient } = require('@supabase/supabase-js');
const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

const VisitorSkill = {
  id: 'visitor_management.v1',
  name: 'Visitor Management',
  description: 'Pre-register guests and manage check-in',
  async execute(payload, ctx) {
    try {
      if (!supabase) return { ok: false, error: 'supabase_unavailable' };
      const { tenantId, guest_name, phone, expected_at } = payload;
      const { data: visitor, error } = await supabase.from('visitors').insert([{
        tenant_id: tenantId || null,
        guest_name,
        phone,
        expected_at: expected_at || null,
        checked_in: false,
        metadata: {},
        created_at: new Date().toISOString()
      }]).select().single();
      if (error) return { ok: false, error: error.message || error };

      await supabase.from('jobs').insert([{
        type: 'visitor_notify',
        payload: { visitor_id: visitor.id },
        status: 'queued',
        created_at: new Date().toISOString()
      }]);

      return { ok: true, output: { visitor_id: visitor.id } };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  }
};

module.exports = VisitorSkill;
JS

cat > api/lib/skills/index.js <<'JS'
const TenantConversationSkill = require('./tenant_conversation');
const MaintenanceSkill = require('./maintenance_request');
const VisitorSkill = require('./visitor_management');
const VoiceSkill = require('./voice_skill');

const SKILL_REGISTRY = new Map();
[ TenantConversationSkill, MaintenanceSkill, VisitorSkill, VoiceSkill ].forEach(s => {
  if (s && s.id) SKILL_REGISTRY.set(s.id, s);
});

function getSkillById(id) {
  return SKILL_REGISTRY.get(id);
}

function listSkills() {
  return Array.from(SKILL_REGISTRY.values()).map(s => ({ id: s.id, name: s.name, description: s.description }));
}

module.exports = { SKILL_REGISTRY, getSkillById, listSkills };
JS

cat > api/lib/orchestrator-skill-runner.js <<'JS'
/**
 * Minimal helper for orchestrator to call skills.
 * In your orchestrator flow, pass a ctx object that includes:
 *  - db (supabase client or similar)
 *  - logger
 *  - llm helpers (optional)
 *  - callSkill function (this function) so skills may call others
 */
const { getSkillById } = require('./skills/index');

async function callSkill(skillId, payload, ctx) {
  const skill = getSkillById(skillId);
  if (!skill) return { ok: false, error: 'skill_not_found' };
  try {
    // add helper so skills can call other skills if needed
    ctx = ctx || {};
    ctx.callSkill = async (id, p) => callSkill(id, p, ctx);

    const res = await skill.execute(payload, ctx);
    // optional: write skill_invocations audit row if supabase client provided
    if (ctx && ctx.db && typeof ctx.db.from === 'function') {
      try {
        await ctx.db.from('skill_invocations').insert([{
          skill_id: skillId,
          request: payload,
          response: res.output || null,
          valid: res.ok,
          errors: res.error ? { error: res.error } : null,
          created_at: new Date().toISOString()
        }]);
      } catch (e) {
        console.warn('skill invocation audit failed', e);
      }
    }
    return res;
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

module.exports = { callSkill };
JS

cat > jobs/worker.js <<'JS'
/**
 * jobs/worker.js - worker that polls the jobs table and handles demo_call, maintenance_notify, visitor_notify.
 * Uses supabase-js server client. Run this on a host with SUPABASE_SERVICE_ROLE_KEY.
 */
const { createClient } = require('@supabase/supabase-js');

const POLL_INTERVAL_MS = process.env.WORKER_POLL_INTERVAL_MS ? parseInt(process.env.WORKER_POLL_INTERVAL_MS) : 5000;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in worker environment');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function claimJob() {
  // Use Postgres function or simple select/update pattern. Supabase doesn't support UPDATE...RETURNING via REST easily,
  // so we use a transaction-like approach with RPC if you have one, otherwise a simplistic approach:
  const { data } = await supabase
    .from('jobs')
    .select('*')
    .eq('status', 'queued')
    .order('created_at', { ascending: true })
    .limit(1);
  if (!data || data.length === 0) return null;
  const job = data[0];
  // attempt to set status to processing by id
  const { error } = await supabase.from('jobs').update({ status: 'processing', updated_at: new Date().toISOString() }).eq('id', job.id);
  if (error) {
    console.warn('Failed to claim job', job.id, error);
    return null;
  }
  // refresh job row
  const { data: refreshed } = await supabase.from('jobs').select('*').eq('id', job.id).single();
  return refreshed;
}

async function handleDemoCall(job) {
  // For production: integrate Telnyx or your telephony provider here.
  // For now: create demo_requests row and mark done to verify end-to-end.
  const payload = job.payload || {};
  try {
    await supabase.from('demo_requests').insert([{
      phone: payload.phone || null,
      tenant_id: payload.tenantId || null,
      status: 'queued',
      metadata: payload,
      created_at: new Date().toISOString()
    }]);
    await supabase.from('jobs').update({ status: 'done', updated_at: new Date().toISOString() }).eq('id', job.id);
  } catch (err) {
    console.error('demo_call handler error', err);
    await supabase.from('jobs').update({
      attempts: (job.attempts || 0) + 1,
      last_error: String(err.message || err),
      status: 'queued',
      updated_at: new Date().toISOString()
    }).eq('id', job.id);
  }
}

async function handleMaintenanceNotify(job) {
  try {
    const payload = job.payload || {};
    // For real deploy: call vendor notify APIs (email/SMS) here.
    console.log('maintenance_notify for', payload.request_id);
    await supabase.from('jobs').update({ status: 'done', updated_at: new Date().toISOString() }).eq('id', job.id);
  } catch (err) {
    console.error('maintenance_notify error', err);
    await supabase.from('jobs').update({
      attempts: (job.attempts || 0) + 1,
      last_error: String(err.message || err),
      status: 'queued',
      updated_at: new Date().toISOString()
    }).eq('id', job.id);
  }
}

async function handleVisitorNotify(job) {
  try {
    const payload = job.payload || {};
    console.log('visitor_notify for', payload.visitor_id);
    await supabase.from('jobs').update({ status: 'done', updated_at: new Date().toISOString() }).eq('id', job.id);
  } catch (err) {
    console.error('visitor_notify error', err);
    await supabase.from('jobs').update({
      attempts: (job.attempts || 0) + 1,
      last_error: String(err.message || err),
      status: 'queued',
      updated_at: new Date().toISOString()
    }).eq('id', job.id);
  }
}

async function handleJob(job) {
  if (!job) return;
  const type = job.type;
  if (type === 'demo_call') return handleDemoCall(job);
  if (type === 'maintenance_notify') return handleMaintenanceNotify(job);
  if (type === 'visitor_notify') return handleVisitorNotify(job);
  console.warn('Unhandled job type', type);
  await supabase.from('jobs').update({ status: 'failed', last_error: 'unhandled_job_type', updated_at: new Date().toISOString() }).eq('id', job.id);
}

async function pollLoop() {
  console.log('Worker started, polling every', POLL_INTERVAL_MS, 'ms');
  while (true) {
    try {
      const job = await claimJob();
      if (job) {
        console.log('Claimed job', job.id, job.type);
        await handleJob(job);
      } else {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      }
    } catch (err) {
      console.error('Worker error', err);
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
  }
}

pollLoop().catch(err => {
  console.error('Worker failed to start', err);
  process.exit(1);
});
JS

# Add files to git
git add migrations/20260624_tenant_skills.sql migrations/20260624_memory_json.sql \
  api/lib/memory.js \
  api/lib/skills/voice_skill.js \
  api/lib/skills/tenant_conversation.js \
  api/lib/skills/maintenance_request.js \
  api/lib/skills/visitor_management.js \
  api/lib/skills/index.js \
  api/lib/orchestrator-skill-runner.js \
  jobs/worker.js

git commit -m "feat(skills): add voice, memory (json embeddings) and tenant skills + migrations and worker template"

git push -u origin "$BRANCH"

# Create PR
if command -v gh >/dev/null 2>&1; then
  gh pr create --base "$PR_BASE" --head "$BRANCH" --title "$PR_TITLE" --body "$PR_BODY"
  echo "PR created. Please review the PR on GitHub and run migrations in Supabase (migrations/*.sql) on staging before merging to production."
else
  echo "gh CLI not found — branch pushed. Create a PR manually at:"
  echo "https://github.com/Mdy305/LolaDesk/pull/new/$BRANCH"
fi

echo "Done. Review files and run migrations in Supabase SQL editor (staging) before enabling worker in production."
