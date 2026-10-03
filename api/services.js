// GET    /api/services              → list all (active + removed, flagged is_active)
//                                      + setup: { staff:[{id,name,is_active,has_hours,services}], links:[…] }
//                                      so the page can say "no stylist can take this".
// POST   /api/services              → create; with `id` in the body → update that service
// PATCH  /api/services?id=uuid      → update
// DELETE /api/services?id=uuid      → soft-delete (is_active=false — what the engine filters)
//
// Fields: name, category, description, duration_minutes (alias duration_min),
// price, currency, buffer_after_min, is_addon, active_duration_1_min,
// processing_duration_min, active_duration_2_min (processing time), photo_url,
// deposit_override_type, deposit_override_amount, tags, sort_order, is_active (alias active).
// Every read/write is scoped to the caller's tenant.
import { cors, jsonBody } from './lib/cors.js';
import { bearer, getUserFromToken } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { db } from './lib/db.js';
import { ensureBookingSetupSchema } from './lib/migrate.js';
import { tolerantWrite, loadSetup, workingRows } from './lib/setup-store.js';

const FIELDS = [
  'name', 'category', 'description', 'duration_minutes', 'price', 'currency',
  'buffer_after_min', 'photo_url', 'deposit_override_type',
  'deposit_override_amount', 'tags', 'sort_order', 'is_active', 'is_addon',
  'active_duration_1_min', 'processing_duration_min', 'active_duration_2_min'
];
const INTS = ['duration_minutes', 'buffer_after_min', 'sort_order', 'active_duration_1_min', 'processing_duration_min', 'active_duration_2_min'];
const NUMS = ['price', 'deposit_override_amount'];
const PHASES = ['active_duration_1_min', 'processing_duration_min', 'active_duration_2_min'];

export function serviceRow(body){
  const b = { ...body };
  if(!('duration_minutes' in b) && 'duration_min' in b) b.duration_minutes = b.duration_min;
  if(!('is_active' in b) && 'active' in b) b.is_active = b.active;
  const row = {};
  FIELDS.forEach(k => { if(k in b) row[k] = b[k]; });
  if(typeof row.name === 'string') row.name = row.name.trim();
  for(const k of INTS){
    if(!(k in row)) continue;
    if(row[k] === '' || row[k] == null){ row[k] = (k === 'buffer_after_min' || k === 'sort_order') ? null : (PHASES.includes(k) ? 0 : null); continue; }
    const n = Math.round(Number(row[k]));
    if(!Number.isFinite(n) || n < 0) throw Object.assign(new Error(`invalid_${k}`), { status: 400 });
    row[k] = n;
  }
  if(row.duration_minutes === null) delete row.duration_minutes;
  for(const k of NUMS){
    if(!(k in row)) continue;
    if(row[k] === '' || row[k] == null){ row[k] = k === 'price' ? 0 : null; continue; }
    const n = Number(row[k]);
    if(!Number.isFinite(n) || n < 0) throw Object.assign(new Error(`invalid_${k}`), { status: 400 });
    row[k] = n;
  }
  if('is_active' in row) row.is_active = row.is_active !== false && row.is_active !== 'false';
  if('is_addon' in row) row.is_addon = row.is_addon === true || row.is_addon === 'true';
  // Processing time: when the phases are set, the total IS the duration
  // (every other reader — calendar, Lola, POS — uses duration_minutes).
  const total = PHASES.reduce((s, k) => s + (Number(row[k]) || 0), 0);
  if(PHASES.some(k => k in row) && total > 0) row.duration_minutes = total;
  return row;
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  try {
    const user = await getUserFromToken(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: 'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if (!tenant?.id) return res.status(404).json({ ok: false, error: 'no_tenant' });

    const c = db();
    if (!c) return res.status(503).json({ ok: false, error: 'database_not_configured' });
    await ensureBookingSetupSchema();
    const body = (req.method === 'POST' || req.method === 'PATCH') ? jsonBody(req) : {};
    const id = req.query?.id || (req.method === 'POST' ? body.id : null);

    if (req.method === 'GET') {
      const { data, error } = await c.from('services')
        .select('*')
        .eq('tenant_id', tenant.id)
        .order('sort_order', { ascending: true, nullsFirst: false })
        .order('name', { ascending: true });
      if (error) throw error;
      let setup = null;
      try {
        const s = await loadSetup(c, tenant.id);
        setup = {
          staff: s.staff.map(m => ({
            id: m.id, name: m.name, is_active: m.is_active !== false && m.active !== false,
            has_hours: workingRows(s.schedules.filter(r => r.staff_id === m.id)).length > 0,
            services: s.links.filter(l => l.staff_id === m.id).map(l => l.service_id)
          })),
          links: s.links.map(l => ({ staff_id: l.staff_id, service_id: l.service_id, custom_price: l.custom_price ?? null, custom_duration_minutes: l.custom_duration_minutes ?? null }))
        };
      } catch (_) { /* hints are optional */ }
      const services = (data || []).map(s => ({ ...s, is_active: s.is_active !== false && s.active !== false }));
      return res.json({ ok: true, services, setup });
    }

    if (req.method === 'POST' || req.method === 'PATCH') {
      const row = serviceRow(body);
      if (id) {
        if (!Object.keys(row).length) return res.status(400).json({ ok: false, error: 'nothing_to_update' });
        if ('name' in row && !row.name) return res.status(400).json({ ok: false, error: 'missing_name' });
        const { data: existing } = await c.from('services').select('id').eq('id', id).eq('tenant_id', tenant.id).maybeSingle();
        if (!existing) return res.status(404).json({ ok: false, error: 'service_not_found' });
        const { data, error } = await tolerantWrite(p => c.from('services')
          .update(p)
          .eq('id', id)
          .eq('tenant_id', tenant.id)
          .select().single(), { ...row, updated_at: new Date().toISOString() }, { required: ['name', 'duration_minutes', 'price', 'is_active'] });
        if (error) throw error;
        return res.json({ ok: true, service: data, updated: true });
      }
      if (req.method === 'PATCH') return res.status(400).json({ ok: false, error: 'missing_id' });
      if (!row.name) return res.status(400).json({ ok: false, error: 'missing_name' });
      if (!('duration_minutes' in row)) row.duration_minutes = 60;
      if (!('is_active' in row)) row.is_active = true;
      const { data, error } = await tolerantWrite(p => c.from('services').insert({ tenant_id: tenant.id, ...p }).select().single(), row,
        { required: ['name', 'duration_minutes', 'price', 'is_active'] });
      if (error) throw error;
      return res.json({ ok: true, service: data, created: true });
    }

    if (req.method === 'DELETE') {
      if (!id) return res.status(400).json({ ok: false, error: 'missing_id' });
      const { error } = await c.from('services')
        .update({ is_active: false })
        .eq('id', id)
        .eq('tenant_id', tenant.id);
      if (error) throw error;
      return res.json({ ok: true });
    }

    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  } catch (e) {
    return res.status(e?.status || 500).json({ ok: false, error: String(e?.message || e) });
  }
}
