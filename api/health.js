/**
 * api/health.js — Application health check
 * Used by Docker, monitoring systems, and Vercel for uptime verification
 */

import { db } from './lib/db.js';

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: {
      node_env: process.env.NODE_ENV || 'production',
      vercel_env: process.env.VERCEL_ENV || 'production'
    },
    services: {
      telnyx: { ok: !!process.env.TELNYX_API_KEY },
      supabase: { ok: !!process.env.NEXT_PUBLIC_SUPABASE_URL },
      elevenlabs: { ok: !!process.env.ELEVENLABS_API_KEY && !!process.env.ELEVENLABS_VOICE_ID }
    },
    database: { ok: false, latency_ms: 0 }
  };

  // Test database connection
  try {
    const start = Date.now();
    const supabase = db();
    const { error } = await supabase.from('tenants').select('id').limit(1);
    health.database.latency_ms = Date.now() - start;
    health.database.ok = !error;

    if (error) {
      health.status = 'degraded';
      health.database.error = error.message;
    }
  } catch (e) {
    health.status = 'degraded';
    health.database.ok = false;
    health.database.error = e.message;
  }

  // Overall status
  const criticalOk = health.services.telnyx.ok && health.services.supabase.ok && health.database.ok;
  if (!criticalOk) health.status = 'degraded';

  const statusCode = health.status === 'ok' ? 200 : 503;
  return res.status(statusCode).json(health);
}
