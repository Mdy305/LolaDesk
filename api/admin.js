/**
 * /api/admin — the platform owner's control plane
 * ════════════════════════════════════════════════════════════════
 * For YOU (the LolaDesk operator), not for salons. Hard-gated:
 * the session's email must appear in the ADMIN_EMAILS env var
 * (comma-separated, case-insensitive). No env var set → nobody is
 * admin → 403 for everyone. Tenant owners can never reach this.
 *
 *   GET  /api/admin            → platform metrics + tenant roster
 *        metrics.by_status   — by subscription_status (what Stripe says: trial / active / past_due …)
 *        metrics.by_billing_status — the admin flags (suspended / active = comped)
 *        metrics.mrr_cents   — MRR from lib/plans.js amounts of paying subscriptions
 *                              (annual counted at its monthly equivalent)
 *        metrics.costs_cents / margin_cents — this month: MRR + booking fees − platform costs
 *        tenants[].mrr_cents / cost_cents / margin_cents / service
 *   POST /api/admin {action:'suspend'|'activate'|'unsuspend'|'uncomp', tenant_id}
 *
 * Suspend flips billing_status only — data is never touched.
 * 'activate' = billing_status 'active': the salon is treated as PAID
 * (comped / paid offline) by the paywall and the service gate, whatever
 * Stripe says. 'unsuspend' / 'uncomp' return it to normal Stripe rules.
 */
import { bearer, getUserFromToken, isAdminEmail } from './lib/auth.js';
import { db } from './lib/db.js';
import { platformSnapshot, setBillingStatus } from './lib/platform-admin.js';

// The numbers and the switches live in lib/platform-admin.js — shared with /api/console.
export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if(req.method === 'OPTIONS') return res.status(200).end();

  const user = await getUserFromToken(bearer(req));
  if(!user) return res.status(401).json({ ok:false, error:'Not signed in' });
  if(!isAdminEmail(user.email)) return res.status(403).json({ ok:false, error:'Not authorized' });

  const c = db();
  if(!c) return res.status(503).json({ ok:false, error:'Database not configured' });

  if(req.method === 'GET'){
    const { metrics, tenants } = await platformSnapshot(c);
    return res.status(200).json({ ok:true, metrics, tenants });
  }

  if(req.method === 'POST'){
    const body = typeof req.body === 'string' ? JSON.parse(req.body||'{}') : (req.body||{});
    const { action, tenant_id } = body;
    const r = await setBillingStatus(c, tenant_id, action);
    return res.status(r.status).json(r.body);
  }

  return res.status(405).json({ ok:false });
}
