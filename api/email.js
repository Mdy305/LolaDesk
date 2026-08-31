/**
 * /api/email — LolaDesk's REAL app-email path (confirmation, follow-up,
 *              review request), provider-agnostic.
 * ═══════════════════════════════════════════════════════════════════════
 * The product already handled email through an unexposed stub (SendEmail has
 * a SendGrid → SES → Mailgun → "queued" fallback, but there was no endpoint,
 * so nothing could send). This is the missing send surface it reuses.
 *
 *   GET /api/email                        → provider config status (never the key)
 *   GET /api/email?email=…&tenant=…       → unsubscribe (flips the client's opt-out)
 *   POST /api/email  (Bearer authed)      → send one templated email
 *       { kind: 'confirmation'|'follow_up'|'review_request',
 *         to? | client_id?, ...context }
 *
 * Tenant-scoped and safe: a `to` that isn't one of the tenant's own client
 * emails (or the owner) is refused, and opted-out clients are skipped for
 * non-transactional kinds. Never logs or returns the provider key.
 */
import { getUserFromToken, bearer } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { SendEmail } from './lib/lola-integrations.js';
import { renderEmail } from './lib/email-templates.js';

function providerConfig(){
  return {
    sendgrid: Boolean(process.env.SENDGRID_API_KEY),
    mailgun: Boolean(process.env.MAILGUN_API_KEY && process.env.MAILGUN_DOMAIN),
    ses: Boolean(process.env.AWS_SES_REGION && process.env.AWS_ACCESS_KEY_ID)
  };
}

function configured(){ const c = providerConfig(); return c.sendgrid || c.mailgun || c.ses; }

function resolvableKind(k){ return ['confirmation', 'follow_up', 'review_request'].includes(k) ? k : null; }

export function createHandler({ send = SendEmail, db = null } = {}){
  return async function handler(req, res){
    res.setHeader('Cache-Control', 'no-store');
    if(req.method === 'OPTIONS') return res.status(204).end();

    // ── GET: config, or unsubscribe ────────────────────────────────────
    if(req.method === 'GET'){
      const email = String(req.query?.email || '');
      const tenantId = String(req.query?.tenant || '');
      if(email && tenantId){
        try{
          const c = db || (await import('./lib/db.js')).db();
          if(!c) return res.status(503).json({ ok:false, error:'database not configured' });
          const { data } = await c.from('clients')
            .select('id')
            .eq('tenant_id', tenantId)
            .eq('email', email.toLowerCase());
          if(!data || !data.length) return res.status(404).json({ ok:false, error:'No matching client' });
          await c.from('clients').update({ opted_out:true }).eq('id', data[0].id);
          res.setHeader('Content-Type','text/html; charset=utf-8');
          return res.status(200).send('<h2>You\u2019re unsubscribed</h2><p>You\u2019ll stop receiving these emails. You can still book by phone or in the app.</p>');
        }catch(e){
          return res.status(500).json({ ok:false, error:'Unsubscribe failed' });
        }
      }
      const prov = providerConfig();
      return res.json({ ok:true, configured: configured(), providers: prov, note: 'Add a provider key (SENDGRID_API_KEY, MAILGUN_API_KEY+MAILGUN_DOMAIN, or AWS SES) to enable sends.' });
    }

    if(req.method !== 'POST') return res.status(405).json({ ok:false, error:'Method not allowed' });

    // ── POST: send ─────────────────────────────────────────────────────
    try{
      const user = await getUserFromToken(bearer(req));
      const tenant = user ? await resolveTenantForUser(user) : null;
      if(!tenant?.id) return res.status(401).json({ ok:false, error:'Not authenticated' });

      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const kind = resolvableKind(body.kind);
      if(!kind) return res.status(400).json({ ok:false, error:'kind must be confirmation, follow_up, or review_request' });

      const c = db || (await import('./lib/db.js')).db();
      if(!c) return res.status(503).json({ ok:false, error:'database not configured' });

      let to = null; let client = null;
      if(body.client_id){
        const { data } = await c.from('clients').select('id,first_name,last_name,name,email,opted_out').eq('id', body.client_id).eq('tenant_id', tenant.id).limit(1);
        client = data?.[0] || null;
        to = client?.email || null;
        if(!to) return res.status(400).json({ ok:false, error:'That client has no email' });
      } else if(body.to){
        const email = String(body.to).toLowerCase();
        const { data } = await c.from('clients').select('id,first_name,last_name,name,email,opted_out').eq('tenant_id', tenant.id).eq('email', email);
        client = data?.[0] || null;
        const isOwner = email === String(tenant.owner_email || '').toLowerCase();
        if(!client && !isOwner) return res.status(400).json({ ok:false, error:'Recipient must be one of your clients (or your own address)' });
        to = email;
      } else {
        return res.status(400).json({ ok:false, error:'client_id or to is required' });
      }

      // Non-transactional kinds respect the client's opt-out.
      if(kind !== 'confirmation' && client?.opted_out){
        return res.json({ ok:true, skipped:true, reason:'opted_out', to });
      }

      if(!configured()){
        return res.status(503).json({
          ok:false, error:'No email provider configured — add SENDGRID_API_KEY (or MAILGUN_API_KEY+MAILGUN_DOMAIN, or AWS SES credentials) in Vercel.',
          providers: providerConfig()
        });
      }

      const rendered = renderEmail(kind, {
        to, tenantId: tenant.id, tenantName: tenant.name,
        name: body.name || client?.first_name || client?.name,
        service: body.service, date: body.date, link: body.link, offer: body.offer
      });

      const result = await send({
        to,
        subject: rendered.subject,
        html: rendered.html,
        textContent: rendered.text,
        from: `LOLA at ${tenant.name || 'the salon'} <${process.env.EMAIL_FROM || 'lola@' + (new URL(APP_URL())).host}>`
      });

      if(!result?.success){
        if(result?.queued || result?.reason === 'no_email_provider'){
          return res.status(503).json({ ok:false, error:'No email provider configured (queued for manual) — add a provider key in Vercel.', providers: providerConfig() });
        }
        return res.status(502).json({ ok:false, error: result?.error || result?.reason || 'Send failed' });
      }
      return res.json({ ok:true, provider: result.provider, messageId: result.messageId, to, kind });
    }catch(e){
      console.error('[EMAIL]', String(e?.message || e).slice(0, 300));
      return res.status(500).json({ ok:false, error:'Send failed' });
    }
  };
}

function APP_URL(){ return process.env.APP_URL || 'https://www.loladesk.com'; }

export default createHandler();