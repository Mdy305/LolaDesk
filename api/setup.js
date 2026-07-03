/**
 * /api/setup — One-time database bootstrap (idempotent, safe to re-run)
 * ════════════════════════════════════════════════════════════════
 * Visiting this URL in a browser seeds the real MMΛ Salon tenant row
 * if it doesn't already exist, so the app stops silently falling back
 * to demo data. This exists because schema.sql's seed INSERT only
 * runs if you actually execute schema.sql against your Supabase
 * database via the SQL editor — if that step was skipped, the tenants
 * table is empty and every unauthenticated request (and any request
 * resolving by phone number, like real incoming calls/texts) finds
 * nothing and falls back to hardcoded demo numbers.
 *
 * Safe to call repeatedly — upserts by slug, never duplicates.
 * Does NOT touch anything if a tenant with this slug already exists
 * with real data; only fills in the seed values as defaults.
 */
import { db } from './lib/db.js';

const SEED_TENANT = {
  slug: 'mma',
  name: 'MMΛ Salon',
  owner_name: 'Meddy',
  owner_email: 'meddy@mmasalon.com',
  location: '1500 Alton Road, 2nd Floor, Miami Beach FL 33139',
  hours: 'Tuesday to Saturday, noon to 8pm',
  booking_url: 'https://www.mmasalon.com/book',
  phone_number: '+19294568227',
  plan: 'pro',
  persona: 'warm',
  services: [
    { name:'Balayage', price:395, duration:'2h30' },
    { name:'Extensions', price:800, duration:'consult' },
    { name:'Hair Botox', price:325, duration:'2h' },
    { name:'Keratin', price:450, duration:'2h30' },
    { name:'Cut & Gloss', price:225, duration:'1h15' },
    { name:'Blowout', price:95, duration:'1h' }
  ],
  team: [
    { name:'Meddy', role:'Owner · Master Colorist' },
    { name:'Michelle', role:'Senior Stylist' },
    { name:'Alice', role:'Senior Stylist' },
    { name:'Samantha', role:'Stylist' }
  ]
};

export default async function handler(req, res){
  const c = db();
  if(!c){
    return res.status(500).json({
      ok:false,
      error: 'Database not configured — check SUPABASE_URL and SUPABASE_SERVICE_KEY are both set in Vercel and you redeployed after setting them.'
    });
  }

  try{
    // Does a tenant with this slug already exist?
    const { data: existing } = await c.from('tenants').select('*').eq('slug', SEED_TENANT.slug).maybeSingle();

    if(existing){
      return res.status(200).json({
        ok:true,
        action:'already_exists',
        tenant: { id: existing.id, slug: existing.slug, name: existing.name, phone_number: existing.phone_number },
        message: 'Tenant already exists — nothing changed. The "demo data" you were seeing was NOT from a missing tenant; look elsewhere (env vars, or the route returning a different resource).'
      });
    }

    const { data, error } = await c.from('tenants').insert(SEED_TENANT).select().maybeSingle();
    if(error) throw new Error(error.message);

    return res.status(200).json({
      ok:true,
      action:'created',
      tenant: { id: data.id, slug: data.slug, name: data.name, phone_number: data.phone_number },
      message: 'Real tenant created. Reload /api/data?resource=overview&tenant=mma — it should now show different numbers (or zeros, if there are no real calls/bookings yet, which is correct for a brand-new tenant, not a bug).'
    });
  }catch(e){
    return res.status(500).json({ ok:false, error: String(e&&e.message||e) });
  }
}
