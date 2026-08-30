-- LolaDesk WhatsApp reminder channel
-- Idempotent, non-destructive. Adds a per-client WhatsApp opt-in so the
-- booking reminder engine can prefer WhatsApp when (a) the salon has WhatsApp
-- connected (a connected integrations row for provider 'whatsapp') AND (b) the
-- client has opted in. WhatsApp requires explicit opt-in; a client is only ever
-- WhatsApp-enabled when they've messaged the salon on WhatsApp (an inbound
-- conversations row with channel='whatsapp') or an owner flips the switch.
-- Reminders otherwise fall back to SMS, keeping the exactly-once contract.

alter table public.clients
  add column if not exists whatsapp_enabled boolean not null default false;

-- Auto-set opt-in: a salon that has WhatsApp connected marks every client who
-- has ever WhatsApp-conversed (matched by client_id, then by client_phone).
update public.clients c
  set whatsapp_enabled = true
  from public.integrations i
  where i.tenant_id = c.tenant_id
    and i.provider = 'whatsapp'
    and i.status = 'connected'
    and c.whatsapp_enabled = false
    and exists (
      select 1 from public.conversations conv
      where conv.tenant_id = c.tenant_id
        and conv.channel = 'whatsapp'
        and (
          conv.client_id = c.id
          or (c.phone is not null and conv.client_phone = c.phone)
        )
    );