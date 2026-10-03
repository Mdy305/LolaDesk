// GET  /api/booking-settings → the salon's booking rules (tenant-scoped)
// POST /api/booking-settings → save them (PATCH works too)
//
// Salon hours are real: business_hours {mon..sun:{open:'HH:MM',close,closed}},
// closures ['YYYY-MM-DD'], reminder_lead_hours, rebook_followup_days are
// persisted to their booking_settings columns (self-healed by
// ensureBookingSetupSchema; if a column still can't be added they land in
// metadata instead, and GET flattens them back). Saving hours stamps
// metadata.hours_confirmed_at — the availability engine then closes the
// salon's closed days / closure dates and clamps stylist hours to them.
import { db } from './lib/db.js';
import { authenticatedTenant } from './lib/tenant-context.js';
import { getBookingSettings } from './lib/booking-repository.js';
import { ensureBookingSetupSchema } from './lib/migrate.js';
import { missingColumn, clockToMinutes, minutesToClock } from './lib/setup-store.js';

const WRITABLE=new Set([
  'timezone','slot_interval_minutes','minimum_notice_minutes','booking_horizon_days','cancellation_window_hours',
  'default_buffer_before_min','default_buffer_after_min','allow_staff_choice','allow_any_staff','allow_processing_overlap',
  'public_booking_enabled','voice_booking_enabled','sms_booking_enabled','require_phone','require_email','confirmation_sms',
  'reminder_sms','radar_sms','deposit_policy','cancellation_policy','metadata',
  'business_hours','closures','reminder_lead_hours','rebook_followup_days'
]);
// Columns that may be missing on older databases → stored in metadata instead.
const SETUP_KEYS=['business_hours','closures','reminder_lead_hours','rebook_followup_days'];
const DAYS=['mon','tue','wed','thu','fri','sat','sun'];

export function cleanBusinessHours(input){
  if(!input || typeof input!=='object') return null;
  const out={};
  for(const d of DAYS){
    const h=input[d]; if(!h || typeof h!=='object') continue;
    const closed=h.closed===true || h.closed==='true';
    const o=clockToMinutes(h.open), cl=clockToMinutes(h.close);
    if(!closed && (o==null || cl==null)) throw Object.assign(new Error(`${d}: set opening and closing times`),{status:400});
    if(!closed && cl<=o) throw Object.assign(new Error(`${d}: closing time must be after opening`),{status:400});
    out[d]={open:o==null?'10:00':minutesToClock(o),close:cl==null?'20:00':minutesToClock(cl),closed};
  }
  return out;
}
export function cleanClosures(input){
  if(!Array.isArray(input)) return [];
  return [...new Set(input.map(x=>String(x||'').slice(0,10)).filter(x=>/^\d{4}-\d{2}-\d{2}$/.test(x)))].sort();
}

// What the page reads: columns win, metadata is the fallback store.
export function flattenSettings(s){
  if(!s) return s;
  const md=(s.metadata && typeof s.metadata==='object')?s.metadata:{};
  const out={...s};
  for(const k of SETUP_KEYS) if((out[k]==null) && md[k]!=null) out[k]=md[k];
  return out;
}

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');
  if(req.method==='OPTIONS') return res.status(204).end();
  try{
    const body=typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{});
    const tenant=await authenticatedTenant(req);
    if(!tenant?.id) return res.status(401).json({ok:false,error:'not_authenticated'});
    await ensureBookingSetupSchema();
    if(req.method==='GET') return res.json({ok:true,settings:flattenSettings(await getBookingSettings(tenant.id))});
    if(req.method==='POST' || req.method==='PATCH'){
      const c=db();
      const patch={tenant_id:tenant.id};
      for(const [k,v] of Object.entries(body)) if(WRITABLE.has(k)) patch[k]=v;
      if('business_hours' in patch) patch.business_hours=cleanBusinessHours(patch.business_hours);
      if('closures' in patch) patch.closures=cleanClosures(patch.closures);
      for(const k of ['reminder_lead_hours','rebook_followup_days']){
        if(!(k in patch)) continue;
        const n=Math.round(Number(patch[k]));
        if(!Number.isFinite(n) || n<0) return res.status(400).json({ok:false,error:`invalid_${k}`});
        patch[k]=n;
      }
      // metadata is a shared KV — merge the patch into what's stored so one
      // writer (deposits) never clobbers another's keys.
      const touchesMeta=(patch.metadata && typeof patch.metadata==='object') || SETUP_KEYS.some(k=>k in patch);
      if(touchesMeta){
        const { data: cur } = await c.from('booking_settings').select('metadata').eq('tenant_id',tenant.id).maybeSingle();
        patch.metadata={ ...(cur?.metadata||{}), ...((patch.metadata && typeof patch.metadata==='object')?patch.metadata:{}) };
        if('business_hours' in patch) patch.metadata.hours_confirmed_at=new Date().toISOString();
        // keep a fallback copy in metadata so hours survive a DB without the columns
        for(const k of SETUP_KEYS) if(k in patch) patch.metadata[k]=patch[k];
      }
      let r;
      for(let i=0;i<6;i++){
        r=await c.from('booking_settings').upsert(patch,{onConflict:'tenant_id'}).select().single();
        const col=r?.error && missingColumn(r.error);
        if(!col || !SETUP_KEYS.includes(col) || !(col in patch)) break;
        delete patch[col];   // already mirrored in metadata
      }
      if(r.error) throw r.error;
      return res.json({ok:true,settings:flattenSettings(r.data)});
    }
    return res.status(405).json({ok:false,error:'method_not_allowed'});
  }catch(e){return res.status(e?.status||500).json({ok:false,error:String(e?.message||e)});}
}
