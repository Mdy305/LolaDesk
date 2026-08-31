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