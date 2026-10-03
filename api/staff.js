// /api/staff — the Team page's save path (team.html).
//
// GET    /api/staff              → every stylist, active AND inactive (flag: is_active / active),
//                                  each with services[] + service_links[] (staff_services),
//                                  hours[] (staff_schedules, day_of_week 0=Sun), has_hours,
//                                  and upcoming time_off[]. ?active=1 → active only.
// POST   /api/staff              → create, or update when body.id is set. Body:
//          name | first_name+last_name, role, phone, email, color, photo_url,
//          is_active (alias active),
//          services:[service_id] or service_links:[{service_id,custom_price,custom_duration_minutes}]
//            → replaces this stylist's staff_services rows (what the engine reads),
//          hours:[{day_of_week,start_time:'HH:MM',end_time}] → replaces staff_schedules.
// DELETE /api/staff?id=uuid      → deactivate (is_active=false); they can be re-activated.
// Every query is scoped to the caller's tenant.
import { bearer, getUserFromToken } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { db } from './lib/db.js';
import { ensureBookingSetupSchema } from './lib/migrate.js';
import { tolerantWrite, loadSetup, decorateStaff, replaceSchedule, replaceStaffServices, normalizeHours } from './lib/setup-store.js';

const OPTIONAL = ['first_name', 'last_name', 'phone', 'email', 'color', 'photo_url'];

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');
  if(req.method==='OPTIONS')return res.status(204).end();
  try{
    const user=await getUserFromToken(bearer(req));
    if(!user)return res.status(401).json({ok:false,error:'Not authenticated'});
    const tenant=await resolveTenantForUser(user);
    if(!tenant?.id)return res.status(404).json({ok:false,error:'No tenant found'});
    const c=db();if(!c)return res.status(503).json({ok:false,error:'Database not configured'});
    await ensureBookingSetupSchema();

    if(req.method==='GET'){
      const setup=await loadSetup(c,tenant.id);
      let staff=setup.staff.map(s=>decorateStaff(s,setup)).sort((a,b)=>String(a.name||'').localeCompare(String(b.name||'')));
      const q=req.query||{};
      if(q.active==='1'||q.active==='true') staff=staff.filter(s=>s.is_active);
      return res.json({ok:true,staff});
    }

    if(req.method==='POST'){
      const b=typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{});
      const name=String(b.name||[b.first_name,b.last_name].filter(Boolean).join(' ')).trim();
      if(!name)return res.status(400).json({ok:false,error:'Name is required'});
      const active=('is_active' in b)?b.is_active!==false:(('active' in b)?b.active!==false:true);
      const row={name,role:String(b.role||'Stylist').trim()||'Stylist',is_active:active,active};
      OPTIONAL.forEach(k=>{ if(k in b) row[k]=b[k]===''?null:b[k]; });
      if(b.hours!=null){
        try{ normalizeHours(b.hours); }catch(e){ return res.status(400).json({ok:false,error:e.message}); }
      }
      if(b.id){
        const {data:own}=await c.from('staff').select('id').eq('id',b.id).eq('tenant_id',tenant.id).maybeSingle();
        if(!own)return res.status(404).json({ok:false,error:'Staff member not found'});
      }
      const {data,error}=await tolerantWrite(p=>b.id
        ?c.from('staff').update(p).eq('id',b.id).eq('tenant_id',tenant.id).select().single()
        :c.from('staff').insert({tenant_id:tenant.id,...p}).select().single(), row, {required:['name','is_active']});
      if(error)throw error;
      const staffId=data.id;
      const links=Array.isArray(b.service_links)?b.service_links:(Array.isArray(b.services)?b.services:null);
      if(links) await replaceStaffServices(c,tenant.id,staffId,links);
      if(b.hours!=null){
        await replaceSchedule(c,tenant.id,staffId,b.hours);
      }
      const setup=await loadSetup(c,tenant.id);
      const fresh=setup.staff.find(s=>s.id===staffId)||data;
      return res.json({ok:true,staff:decorateStaff(fresh,setup)});
    }

    if(req.method==='DELETE'){
      const id=req.query?.id;if(!id)return res.status(400).json({ok:false,error:'Missing id'});
      const {error}=await tolerantWrite(p=>c.from('staff').update(p).eq('id',id).eq('tenant_id',tenant.id),{is_active:false,active:false},{required:['is_active']});
      if(error)throw error;return res.json({ok:true});
    }
    return res.status(405).json({ok:false,error:'Method not allowed'});
  }catch(e){return res.status(500).json({ok:false,error:String(e?.message||e)});}
}
