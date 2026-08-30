-- 20260815_tenant_voice.sql
-- Per-tenant Lola voice. Each salon can pick its own ElevenLabs voice;
-- NULL means "use the platform default" (ELEVENLABS_VOICE_ID), so existing
-- tenants keep their current voice until the owner chooses one.
-- Idempotent: safe to re-run.

alter table tenants add column if not exists voice_id text;

comment on column tenants.voice_id is
  'Per-tenant ElevenLabs voice id. NULL = platform default ELEVENLABS_VOICE_ID.';
