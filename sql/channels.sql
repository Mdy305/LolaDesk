-- ═══════════════════════════════════════════════════════════════
-- LolaDesk — channels.sql  (Facebook Messenger + WhatsApp per salon)
-- Idempotent. api/lib/migrate.js applies the same DDL automatically.
-- ═══════════════════════════════════════════════════════════════

-- tenant_channels already exists (Instagram). Messenger pages, WhatsApp numbers,
-- pending Facebook page choices and WhatsApp turn-on requests live here too.
alter table public.tenant_channels
  add column if not exists meta jsonb not null default '{}'::jsonb,
  add column if not exists last_error text;

-- The salon-level WhatsApp switch (set when its number is on a WhatsApp Business Account).
alter table public.tenants
  add column if not exists whatsapp_enabled boolean not null default false;

-- WhatsApp message templates LolaDesk submits per WhatsApp Business Account.
create table if not exists public.whatsapp_templates (
  id          uuid primary key default gen_random_uuid(),
  waba_id     text not null,
  name        text not null,
  language    text not null default 'en_US',
  category    text not null default 'UTILITY',
  telnyx_template_id text,
  status      text not null default 'PENDING',
  reason      text,
  tenant_id   uuid references public.tenants(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (waba_id, name, language)
);
create index if not exists idx_whatsapp_templates_waba on public.whatsapp_templates (waba_id);
alter table public.whatsapp_templates enable row level security;
