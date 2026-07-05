-- Per-tenant knowledge documents (menus, policies, FAQs, reviews) that Lola
-- uses on calls and texts. Contact lists are NOT stored here — they import
-- straight into the clients table. Run in the Supabase SQL editor.

create table if not exists tenant_documents (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  kind        text not null default 'document',   -- 'document' | 'reviews'
  filename    text,
  char_count  int  default 0,
  summary     text,                                -- distilled facts Lola should know
  raw_text    text,                                -- extracted text (capped server-side)
  created_at  timestamptz default now()
);

create index if not exists tenant_documents_tenant_idx
  on tenant_documents (tenant_id, created_at desc);

-- The server reads/writes with the Supabase service key (bypasses RLS). Enabling
-- RLS with no public policies means these rows are reachable ONLY through the
-- authenticated /api/knowledge endpoint — never directly from the browser.
alter table tenant_documents enable row level security;

