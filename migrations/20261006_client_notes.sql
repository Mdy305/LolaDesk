-- ============================================================================
-- Client notes + color formulas (idempotent).
--
-- The client profile (client.html → /api/crm-notes) keeps a running history
-- per client: free-text notes ("prefers Saturday mornings", "allergic to PPD")
-- and color formulas ({date, formula, developer, processing, notes, stylist}).
-- One table, two kinds, always scoped to the salon (tenant_id).
--
-- Until this runs, /api/crm-notes degrades gracefully: notes and formulas are
-- appended to clients.notes as dated lines, so nothing an owner types is lost.
--
-- RLS: tenants read their own rows; writes are service-role only (the API
-- resolves the salon from the signed-in user, never from the request).
-- ============================================================================

-- The fallback store (and the "On file" card) — present on every install, made sure here.
alter table clients add column if not exists notes text;

create table if not exists client_notes (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  client_id   uuid not null references clients(id) on delete cascade,
  kind        text not null default 'note' check (kind in ('note', 'formula')),
  body        text,                              -- the note, or the formula itself
  data        jsonb not null default '{}'::jsonb, -- formula: {date, formula, developer, processing, notes, stylist}
  author      text,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_client_notes_client on client_notes (tenant_id, client_id, kind, created_at desc);

alter table client_notes enable row level security;
drop policy if exists client_notes_read on client_notes;
create policy client_notes_read on client_notes
  for select using (tenant_id = auth_tenant());
