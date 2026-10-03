// /api/staff-hours — one stylist's weekly hours and time off (team.html).
//
// GET    /api/staff-hours?staff_id=uuid
//          → { hours:[{day_of_week 0=Sun..6, start_time:'HH:MM', end_time}], time_off:[{id,starts_at,ends_at,reason}] }
// POST   /api/staff-hours  { staff_id, hours:[…] }                 → replaces staff_schedules for that stylist
// POST   /api/staff-hours  { staff_id, action:'time_off',
//                            start_date:'YYYY-MM-DD', end_date?, start_time?, end_time?, reason? }
//          (salon-local; whole days when no times) or { starts_at, ends_at } ISO → staff_time_off row
// DELETE /api/staff-hours?time_off_id=uuid                         → removes that time off
// Tenant-scoped: the stylist / time-off row must belong to the caller's salon.
import { cors, jsonBody } from './lib/cors.js';
import { bearer, getUserFromToken } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { db } from './lib/db.js';
import { ensureBookingSetupSchema } from './lib/migrate.js';
import { getBookingSettings } from './lib/booking-repository.js';
import { loadSetup, decorateStaff, replaceSchedule, normalizeHours, addTimeOff, timeOffWindow, staffBelongsToTenant } from './lib/setup-store.js';

export default async function handler(req, res){
  if(cors(req, res)) return;
  try{
    const user = await getUserFromToken(bearer(req));
    if(!user) return res.status(401).json({ ok:false, error:'not_authenticated' });
    const tenant = await resolveTenantForUser(user);
    if(!tenant?.id) return res.status(404).json({ ok:false, error:'no_tenant' });
    const c = db();
    if(!c) return res.status(503).json({ ok:false, error:'database_not_configured' });
    await ensureBookingSetupSchema();
    const q = req.query || {};

    if(req.method === 'GET'){
      if(!(await staffBelongsToTenant(c, tenant.id, q.staff_id))) return res.status(404).json({ ok:false, error:'staff_not_found' });
      const setup = await loadSetup(c, tenant.id);
      const s = decorateStaff(setup.staff.find(x => x.id === q.staff_id), setup);
      return res.json({ ok:true, staff_id: s.id, hours: s.hours, time_off: s.time_off });
    }

    if(req.method === 'POST'){
      const b = jsonBody(req);
      if(!(await staffBelongsToTenant(c, tenant.id, b.staff_id))) return res.status(404).json({ ok:false, error:'staff_not_found' });
      if(b.action === 'time_off'){
        const settings = await getBookingSettings(tenant.id);
        let win;
        try{ win = timeOffWindow(b, settings?.timezone || 'America/New_York'); }
        catch(e){ return res.status(400).json({ ok:false, error:e.message }); }
        const row = await addTimeOff(c, tenant.id, b.staff_id, { ...win, reason: b.reason });
        return res.json({ ok:true, time_off: row });
      }
      if(b.hours == null) return res.status(400).json({ ok:false, error:'missing_hours' });
      try{ normalizeHours(b.hours); }catch(e){ return res.status(400).json({ ok:false, error:e.message }); }
      const hours = await replaceSchedule(c, tenant.id, b.staff_id, b.hours);
      return res.json({ ok:true, staff_id: b.staff_id, hours });
    }

    if(req.method === 'DELETE'){
      const id = q.time_off_id || q.id;
      if(!id) return res.status(400).json({ ok:false, error:'missing_id' });
      const { error } = await c.from('staff_time_off').delete().eq('id', id).eq('tenant_id', tenant.id);
      if(error) throw error;
      return res.json({ ok:true });
    }
    return res.status(405).json({ ok:false, error:'method_not_allowed' });
  }catch(e){
    return res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
}
