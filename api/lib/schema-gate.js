/**
 * api/lib/schema-gate.js — single source of truth for the tables the product
 * depends on.
 * ═══════════════════════════════════════════════════════════════════
 * Both the calendar-health gate (/api/calendar-health) and the migration
 * applier (scripts/apply-migrations.mjs) import THIS list, so a table can
 * never silently drift out of sync:
 *
 *   • Add a table the product needs → register it here AND ship a migration
 *     that creates it. CI's apply-migrations job will apply the pending
 *     migration and then fail if the gate still sees the table missing,
 *     so the health endpoint can never claim 'ready' about a dead feature.
 *
 * Keeping this as the ONE manifest means "future migrations" are wired into
 * both the gate and the applier automatically — no second list to forget.
 */

// ── COLUMN manifest ─────────────────────────────────────────────────────────
// A table can exist while the columns the product WRITES are missing — a
// swallowed migration (e.g. the established-db baseline recording
// 20260831_email_verify.sql without executing it) once left tenants.
// activation_status absent on production while the table gate reported READY
// and real signups 500'd. The health endpoints + the migration applier verify
// this list with the same head-query pattern used for tables, so a future
// activation_status-class incident turns the board and CI red instead of
// green. Each entry names the code path that depends on the column.
// Additive & environment-tolerant: probes use the anon-compatible head query
// and treat anything that is not a clear "column does not exist" (e.g. RLS
// denial on a policy-gated table) as present — never a false red.
export const REQUIRED_COLUMNS = {
  // Signup/tenant writes (api/lib/db.js upsertTenant): a missing one 500s
  // every signup. slug/phone_number/owner_email are the identity contract.
  tenants: ['activation_status', 'website_url', 'business_mode', 'phone_number', 'slug', 'owner_email'],
  // Canonical client shape (api/lib/db.js upsertClient): the old shape class
  // made every client write fail on fresh databases.
  clients: ['first_name', 'last_name', 'phone', 'email', 'whatsapp_enabled'],
  // Telephony ledger (api/lib/db.js logCall) — read by the call center;
  // telnyx_call_control_id is the whisper/live-steering target.
  calls: ['from_number', 'to_number', 'direction', 'duration_seconds', 'status', 'recording_url', 'telnyx_call_control_id'],
  // Booking write path (api/lib/db.js createBooking + booking-repository);
  // confirmation_code is the client-facing SMS confirmation contract.
  bookings: ['service_id', 'staff_id', 'start_time', 'end_time', 'total_amount', 'status', 'confirmation_code'],
  // Bookable menu the booking stack resolves (availability/lola tools).
  services: ['name', 'price', 'duration_minutes'],
  // Bookable roster read by availability.
  staff: ['name', 'role'],
  // Availability-engine contract (20260812_calendar_core.sql).
  booking_settings: ['slot_interval_minutes', 'minimum_notice_minutes', 'default_buffer_before_min']
};

export const REQUIRED_TABLES = [
  // Core multi-tenant + booking OS
  'tenants', 'tenant_config', 'booking_settings', 'clients', 'services', 'staff',
  'staff_services', 'staff_schedules', 'staff_time_off',
  'bookings', 'availability_holds', 'booking_services', 'booking_status_history',
  'resources', 'service_resources',
  // External sync + telephony ledger
  'integrations', 'provider_mappings', 'external_appointments',
  'booking_sync_log', 'telnyx_call_sessions', 'telnyx_messages',
  // 20260901_inventory_ops.sql — inventory + blocked-time + notes features.
  // A missing one silently disables the feature (products read returns empty,
  // blocked slots vanish from availability), so the gate MUST cover them or
  // 'ready' lies.
  'products', 'blocked_slots', 'appointment_notes',
  // 20260901_customer_care.sql — platform_settings KV for the company-level
  // customer-care line (assistant id + number + TeXML app, not tenant-scoped).
  'platform_settings',
  // 20260831_mfa_totp.sql — owner/operator two-factor auth (TOTP). A missing
  // table makes MFA enrollment and verification fail, so the gate must cover it.
  'mfa_registrations'
];