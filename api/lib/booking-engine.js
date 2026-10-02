/**
 * api/lib/booking-engine.js — the Universal Booking Engine (one contract, every salon).
 * ════════════════════════════════════════════════════════════════════════════════
 * Every surface (phone, texts, Instagram, web, the dashboard) books through one
 * contract, whatever the salon's own system is:
 *
 *   const engine = await BookingEngineFactory.forTenant(tenantId)
 *   engine.getAvailableSlots({ date }, serviceId, staffId?)   → Slot[]        (local, never a third-party call)
 *   engine.reserveSlotHold(slot, client)                       → HoldToken     (soft lock, TTL)
 *   engine.commitBooking(holdToken, details)                   → BookingReceipt (local now, upstream via outbox)
 *   engine.releaseHold(holdToken)                              → void
 *   engine.syncDelta()                                         → SyncReport    (pull the salon's platform/calendar links)
 *
 * Read path: LolaDesk's local engine (schedules, services with processing time,
 *   bookings, holds, and the salon platform's appointments cached every minute).
 * Write path: conflict-safe hold → local booking → durable outbox → the salon's
 *   platform (Square, Vagaro, Boulevard, Fresha, Mindbody, Cal.com…), with retries
 *   and an owner alert if it refuses. Calendar links (iCal) are read-only.
 * Tenant fencing: every query is bound to the tenant the factory was built for;
 *   credentials are decrypted in memory only (AES-256-GCM at rest, lib/crypto.js).
 */
import { getAvailability, holdAvailability } from './availability-engine-v2.js';
import { getHold, releaseHold as repoRelease, createCanonicalBooking, listServices } from './booking-repository.js';
import { getTenantIntegrations, db } from './db.js';
import { writeThrough } from './booking-outbox.js';
import { syncTenantAvailability, SYNC_PROVIDERS } from './booking-sync.js';

// ── Domain errors ──
export class BookingError extends Error { constructor(message, code, details) { super(message); this.name = this.constructor.name; this.code = code; this.details = details || null; } }
export class SlotCollisionError extends BookingError { constructor(details) { super('That time was just taken.', 'slot_collision', details); } }
export class HoldExpiredError extends BookingError { constructor(details) { super('The hold on that time expired.', 'hold_expired', details); } }
export class IntegrationAuthExpiredError extends BookingError { constructor(provider) { super(`LolaDesk needs to be reconnected to ${provider}.`, 'integration_auth_expired', { provider }); } }
export class TenantFenceError extends BookingError { constructor() { super('That belongs to another salon.', 'tenant_fence'); } }

/** Small latency profiler → Server-Timing header. */
export function timer() {
  const t0 = performance.now(), marks = [];
  let last = t0;
  return {
    mark(name) { const n = performance.now(); marks.push([name, n - last]); last = n; },
    header() { return [...marks.map(([n, d]) => `${n};dur=${d.toFixed(1)}`), `total;dur=${(performance.now() - t0).toFixed(1)}`].join(', '); },
    total() { return performance.now() - t0; },
  };
}

export class UniversalBookingEngine {
  constructor(tenant, integrations = []) {
    if (!tenant?.id) throw new BookingError('A salon is required.', 'tenant_required');
    this.tenant = tenant;
    this.integrations = integrations;
    this.providers = integrations.map((i) => i.provider);
  }

  async getAvailableSlots(range = {}, serviceId, staffId = null) {
    const r = await getAvailability({ tenantId: this.tenant.id, serviceId, date: range.date || range.from || new Date().toISOString(), staffId, limit: range.limit || 24 });
    if (!r.ok) throw new BookingError(r.error === 'service_not_found' ? 'That service isn’t on the menu.' : 'Couldn’t read the calendar.', r.error || 'availability_failed');
    return r.slots;
  }

  async reserveSlotHold(slot, client = {}, { ttlSeconds = 600, channel = 'voice' } = {}) {
    const h = await holdAvailability({ tenantId: this.tenant.id, clientId: client.id || null, serviceId: slot.service_id, staffId: slot.staff_id, startsAt: slot.starts_at, channel, conversationId: client.conversation_id || null, ttlSeconds });
    if (!h.ok) throw new SlotCollisionError({ alternatives: h.slots || [] });
    return { hold_token: h.hold.hold_token, hold_id: h.hold.id, expires_at: h.hold.expires_at, slot: h.slot };
  }

  async commitBooking(holdToken, details = {}) {
    const hold = await getHold(this.tenant.id, holdToken);
    if (!hold) throw new HoldExpiredError({ reason: 'not_found' });
    if (hold.tenant_id && hold.tenant_id !== this.tenant.id) throw new TenantFenceError();
    if (hold.status !== 'active' || new Date(hold.expires_at).getTime() < Date.now()) throw new HoldExpiredError({ status: hold.status });
    const services = await listServices(this.tenant.id).catch(() => []);
    const svc = services.find((s) => s.id === hold.service_id) || null;
    const booking = await createCanonicalBooking({
      tenantId: this.tenant.id, clientId: details.client?.id || hold.client_id || null, serviceId: hold.service_id, staffId: hold.staff_id,
      startTime: hold.starts_at, endTime: hold.ends_at, status: 'confirmed', totalAmount: details.price ?? svc?.price ?? 0,
      notes: details.notes || null, source: details.source || 'lola', conversationId: hold.conversation_id || null, holdId: hold.id,
    });
    await repoRelease(this.tenant.id, holdToken, 'converted').catch(() => {});
    const upstream = await writeThrough(db(), { tenantId: this.tenant.id, booking, ctx: {
      client: { id: booking.client_id, name: details.client?.name || null, phone: details.client?.phone || null },
      service: { id: hold.service_id, name: svc?.name || null }, staff: { id: hold.staff_id },
      startsAt: booking.start_time, endsAt: booking.end_time, durationMin: Math.round((new Date(booking.end_time) - new Date(booking.start_time)) / 60e3),
      price: booking.total_amount, timezone: details.timezone || 'America/New_York', notes: details.notes || 'Booked by Lola (LolaDesk AI front desk)',
    } }).catch(() => ({ ok: false }));
    return { booking_id: booking.id, confirmation_code: booking.confirmation_code || null, starts_at: booking.start_time, ends_at: booking.end_time, upstream: upstream.ok ? 'queued' : (this.providers.length ? 'not_queued' : 'local_only') };
  }

  async releaseHold(holdToken) { await repoRelease(this.tenant.id, holdToken, 'released'); }

  async syncDelta() {
    const targets = this.providers.filter((p) => SYNC_PROVIDERS.includes(p));
    if (!targets.length) return { ok: true, skipped: true, note: 'no connected booking system or calendar link' };
    const r = await syncTenantAvailability(db(), this.tenant.id);
    const auth = (r.provider_errors || []).find((e) => /401|403|unauthori[sz]ed|expired|invalid[_ ]?token/i.test(e.error));
    if (auth) throw new IntegrationAuthExpiredError(auth.provider);
    return r;
  }
}

// ── Factory: resolve the tenant + its integrations once, keep it warm for a minute ──
const warm = new Map();
export const BookingEngineFactory = {
  async forTenant(tenantOrId, { fresh = false } = {}) {
    const id = typeof tenantOrId === 'string' ? tenantOrId : tenantOrId?.id;
    if (!id) throw new BookingError('A salon is required.', 'tenant_required');
    const hit = warm.get(id);
    if (!fresh && hit && Date.now() - hit.at < 60e3) return hit.engine;
    let tenant = typeof tenantOrId === 'object' ? tenantOrId : null;
    if (!tenant) { const { data } = await db().from('tenants').select('*').eq('id', id).maybeSingle(); tenant = data; }
    if (!tenant) throw new BookingError('Unknown salon.', 'tenant_not_found');
    const integrations = await getTenantIntegrations(id).catch(() => []);
    const engine = new UniversalBookingEngine(tenant, integrations);
    warm.set(id, { at: Date.now(), engine });
    return engine;
  },
  clear(id) { if (id) warm.delete(id); else warm.clear(); },
};
