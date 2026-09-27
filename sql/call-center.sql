-- Call Center: handled flag + real call-recording audio link. Safe to re-run.
alter table public.calls add column if not exists handled_at          timestamptz;
alter table public.calls add column if not exists recording_audio_url text;
create index if not exists idx_calls_tenant_created on public.calls (tenant_id, created_at desc);
