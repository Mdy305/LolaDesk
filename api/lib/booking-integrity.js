/**
 * api/lib/booking-integrity.js — the database side of "no double bookings".
 * ════════════════════════════════════════════════════════════════════════════
 *   • ensureBookingIntegritySchema() — self-applies migrations/20261006_booking_integrity.sql
 *     through exec_sql (same lazy, idempotent pattern as api/lib/migrate.js). The DDL is
 *     inline because Vercel only bundles api/** — tests assert it matches the migration.
 *   • takeHoldRpc()  — calls lola_take_hold (advisory lock + re-check + insert, atomic).
 *     Returns null when the function is unavailable so the caller can fall back.
 *   • sharedHit()    — a rate-limit hit counted in public_rate_hits (shared by every
 *     serverless instance); falls back to per-instance memory when the table is missing.
 */
import { db } from './db.js';

export const BOOKING_INTEGRITY_DDL = `alter table public.bookings add column if not exists cancelled_at timestamptz;
alter table public.availability_holds add column if not exists requester text;

do $$
begin
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'bookings_hold_id_unique') then
    begin
      create unique index bookings_hold_id_unique on public.bookings (hold_id) where hold_id is not null;
    exception when unique_violation then
      raise notice 'bookings_hold_id_unique skipped: existing duplicate hold_id rows — clean them up and re-run';
    end;
  end if;
end $$;

create index if not exists idx_availability_holds_requester
  on public.availability_holds (tenant_id, requester) where status = 'active';

create table if not exists public.public_rate_hits (
  id   bigserial primary key,
  key  text not null,
  at   timestamptz not null default now()
);
create index if not exists idx_public_rate_hits_key_at on public.public_rate_hits (key, at desc);
alter table public.public_rate_hits enable row level security;

create or replace function public.lola_take_hold(
  p_tenant_id          uuid,
  p_staff_id           uuid,
  p_starts_at          timestamptz,
  p_ends_at            timestamptz,
  p_window_start       timestamptz,
  p_window_end         timestamptz,
  p_expires_at         timestamptz,
  p_hold_token         text,
  p_client_id          uuid default null,
  p_service_id         uuid default null,
  p_channel            text default 'voice',
  p_conversation_id    uuid default null,
  p_exclude_booking_id uuid default null,
  p_seen_booking_ids   uuid[] default '{}',
  p_requester          text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hold public.availability_holds;
  v_clash uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || ':' || coalesce(p_staff_id::text, '*'), 0));

  select h.id into v_clash
    from public.availability_holds h
   where h.tenant_id = p_tenant_id
     and h.status = 'active'
     and h.expires_at > now()
     and h.staff_id is not distinct from p_staff_id
     and h.starts_at < p_window_end
     and h.ends_at > p_window_start
   limit 1;
  if v_clash is not null then
    return jsonb_build_object('ok', false, 'conflict', true, 'reason', 'hold', 'id', v_clash);
  end if;

  select b.id into v_clash
    from public.bookings b
   where b.tenant_id = p_tenant_id
     and b.staff_id is not distinct from p_staff_id
     and lower(coalesce(b.status, '')) not in ('cancelled', 'canceled', 'no_show', 'no-show', 'noshow')
     and (p_exclude_booking_id is null or b.id <> p_exclude_booking_id)
     and not (b.id = any (coalesce(p_seen_booking_ids, '{}')))
     and b.start_time < p_window_end
     and coalesce(b.end_time, b.start_time + interval '60 minutes') > p_window_start
   limit 1;
  if v_clash is not null then
    return jsonb_build_object('ok', false, 'conflict', true, 'reason', 'booking', 'id', v_clash);
  end if;

  insert into public.availability_holds
    (tenant_id, client_id, staff_id, service_id, starts_at, ends_at, channel, conversation_id, expires_at, status, hold_token, requester)
  values
    (p_tenant_id, p_client_id, p_staff_id, p_service_id, p_starts_at, p_ends_at, coalesce(p_channel, 'voice'), p_conversation_id, p_expires_at, 'active', p_hold_token, p_requester)
  returning * into v_hold;

  return jsonb_build_object('ok', true, 'hold', to_jsonb(v_hold));
end $$;

revoke all on function public.lola_take_hold(uuid, uuid, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, text, uuid, uuid, text, uuid, uuid, uuid[], text) from public, anon, authenticated;
grant execute on function public.lola_take_hold(uuid, uuid, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, text, uuid, uuid, text, uuid, uuid, uuid[], text) to service_role;

-- PostgREST picks up the new function / table right away.
notify pgrst, 'reload schema';
`;

const MISSING_FN = /could not find the function|function .* does not exist|PGRST202|42883/i;
const MISSING_REL = /relation|does not exist|schema cache|PGRST20[45]|42P01|42703|column/i;

let _ensured = null;
let _rpcDownUntil = 0;          // rpc known-unavailable on this instance until (ms)

export function resetBookingIntegrity(){ _ensured = null; _rpcDownUntil = 0; memHits.clear(); }

/** Memoized per cold start; never throws. → 'no-db' | 'up-to-date' | 'applied' | 'unavailable' */
export function ensureBookingIntegritySchema({ force = false } = {}){
  if(_ensured && !force) return _ensured;
  _ensured = (async () => {
    const c = db(); if(!c) return 'no-db';
    const probes = await Promise.all([
      c.from('public_rate_hits').select('id').limit(1),
      c.from('bookings').select('cancelled_at').limit(1),
      c.from('availability_holds').select('requester').limit(1)
    ]).catch(() => [{ error: true }]);
    if(!force && probes.every(p => !p?.error)) return 'up-to-date';
    try{
      const r = await c.rpc('exec_sql', { p_sql: BOOKING_INTEGRITY_DDL });
      if(r?.error) throw new Error(r.error.message || 'exec_sql error');
      console.log('[booking-integrity] applied 20261006_booking_integrity');
      return 'applied';
    }catch(e){
      console.warn('[booking-integrity] schema self-heal unavailable:', String(e?.message || e).slice(0, 160));
      return 'unavailable';
    }
  })().catch(() => 'unavailable');
  return _ensured;
}

/**
 * Atomic hold through lola_take_hold. → { ok:true, hold } | { ok:false, conflict:true, reason }
 * | null (function unavailable — caller uses its fallback path).
 */
export async function takeHoldRpc(c, args){
  if(!c || typeof c.rpc !== 'function' || Date.now() < _rpcDownUntil) return null;
  const params = {
    p_tenant_id: args.tenantId, p_staff_id: args.staffId || null,
    p_starts_at: args.startsAt, p_ends_at: args.endsAt,
    p_window_start: args.windowStart || args.startsAt, p_window_end: args.windowEnd || args.endsAt,
    p_expires_at: args.expiresAt, p_hold_token: args.holdToken,
    p_client_id: args.clientId || null, p_service_id: args.serviceId || null,
    p_channel: args.channel || 'voice', p_conversation_id: args.conversationId || null,
    p_exclude_booking_id: args.excludeBookingId || null,
    p_seen_booking_ids: (args.seenBookingIds || []).filter(Boolean),
    p_requester: args.requester || null
  };
  const call = async () => { try{ return await c.rpc('lola_take_hold', params); }catch(e){ return { data: null, error: { message: String(e?.message || e) } }; } };
  let r = await call();
  if(r?.error && MISSING_FN.test(String(r.error.message || r.error.code || ''))){
    // Cold DB: self-apply the migration once, then retry.
    const st = await ensureBookingIntegritySchema({ force: true });
    if(st === 'applied') r = await call();
  }
  if(r?.error || !r?.data || typeof r.data !== 'object'){
    _rpcDownUntil = Date.now() + 5 * 60e3;
    if(r?.error) console.warn('[booking-integrity] lola_take_hold unavailable — using re-check fallback:', String(r.error.message || '').slice(0, 120));
    return null;
  }
  const out = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
  if(out.ok && out.hold) return { ok: true, hold: out.hold, atomic: true };
  return { ok: false, conflict: true, reason: out.reason || 'conflict', atomic: true };
}

// ── shared rate limiting ─────────────────────────────────────────────────
const memHits = new Map(); // key -> [ms...]
function memHit(key, limit, windowMs, now, record){
  const list = (memHits.get(key) || []).filter(t => now - t < windowMs);
  if(record) list.push(now);
  memHits.set(key, list);
  if(memHits.size > 20000){ for(const [k, v] of memHits) if(!v.some(t => now - t < windowMs)) memHits.delete(k); }
  return list.length;
}

/**
 * Count (and optionally record) a hit for `key` within `windowMs`. Shared across
 * instances via public_rate_hits; per-instance memory when the table is missing.
 * → { count, shared }
 */
export async function sharedCount(key, windowMs, { record = true, now = Date.now(), c = db() } = {}){
  if(c){
    try{
      if(record){
        const ins = await c.from('public_rate_hits').insert({ key, at: new Date(now).toISOString() });
        if(ins?.error) throw new Error(ins.error.message || 'insert failed');
      }
      const { data, error } = await c.from('public_rate_hits').select('id,at').eq('key', key).gt('at', new Date(now - windowMs).toISOString()).limit(1000);
      if(error) throw new Error(error.message || 'select failed');
      // Housekeeping, ~1% of hits: drop day-old rows.
      if(Math.random() < 0.01){ c.from('public_rate_hits').delete().lt('at', new Date(now - 864e5).toISOString()).then(() => {}, () => {}); }
      return { count: (data || []).length, shared: true };
    }catch(e){
      if(!MISSING_REL.test(String(e?.message || e))) console.warn('[booking-integrity] shared limiter:', String(e?.message || e).slice(0, 120));
      ensureBookingIntegritySchema();
    }
  }
  return { count: memHit(key, 0, windowMs, now, record), shared: false };
}

/** true when allowed (this hit is within `limit` per `windowMs`). */
export async function sharedHit(key, limit, windowMs, opts = {}){
  const { count } = await sharedCount(key, windowMs, { ...opts, record: true });
  return count <= limit;
}
