-- ═══════════════════════════════════════════════════════════════════════════
--  FILE: 20260821_route_owner_numbers.sql   ═  APPLIED ON PRODUCTION 2026-08-21  ═
-- ═══════════════════════════════════════════════════════════════════════════
-- Route +14104298256 and +14153419934 (owner lines that existed on Telnyx but
-- had NO routing row) to the platform's own tenant LolaDesk Primary
-- (slug 'loladesk', id a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11) so every owned
-- number answers with Lola. Connection id is the working Call Control app
-- (TELNYX_VOICE_APP_ID = 2982432232334951429), matching every other row —
-- routing keys off tenant_id + status; connection_id is the health record.
-- +14104298256 becomes the tenant's canonical tenants.phone_number.
-- Idempotent: on conflict the row is re-pointed at LolaDesk Primary.
-- ═══════════════════════════════════════════════════════════════════════════

insert into tenant_numbers (tenant_id, phone_number, kind, connection_id, status, notes, created_at, updated_at)
values
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '+14104298256', 'primary', '2982432232334951429', 'active', 'owner line — Lola voice + brain', now(), now()),
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '+14153419934', 'primary', '2982432232334951429', 'active', 'owner line — Lola voice + brain', now(), now())
on conflict (phone_number) do update
  set tenant_id     = excluded.tenant_id,
      kind          = excluded.kind,
      connection_id = excluded.connection_id,
      status        = excluded.status,
      notes         = excluded.notes,
      updated_at    = now();

-- Canonical number for the platform tenant (only if not already claimed).
update tenants
set phone_number = '+14104298256', updated_at = now()
where id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'
  and (phone_number is null or phone_number <> '+14104298256');
