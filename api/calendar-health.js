/**
 * /api/calendar-health — the schema gate. Delegates to the ONE health
 * gate (api/lib/health-gate.js); this file is transport only. Shape
 * unchanged: { ok, ready, required, passed, missing, checks,
 * required_columns, passed_columns, missing_columns, column_checks }.
 */
import { calendarHealth, healthSend } from './lib/health-gate.js';

export default async function handler(req, res) {
  return healthSend(res, await calendarHealth(), { cors: false });
}
