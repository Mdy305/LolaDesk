/**
 * api/salon.js — Complete Salon OS
 * Ported from Open Salon (github.com/clawnify/open-salon)
 * Multi-tenant: Supabase + Vercel
 *
 * CRM + Bookings + Services + Staff + Products + Notes
 *
 * GET  ?resource=clients|services|staff|products|appointments|stats
 * GET  ?resource=client&id=X          full client profile + history
 * GET  ?resource=calendar&start=&end=
 * GET  ?resource=availability&date=&service_id=&staff_id=
 * POST {resource:'...', action:'create|update|delete', ...}
 */
import { bearer, getUserFromToken } from './lib/auth.js';
import { resolveTenantForUser } from './lib/tenant-access.js';
import { db, upsertClient, getTenantBySlug } from './lib/db.js';
import { sendSMS } from './telnyx-sms.js';
import { confirmText } from './lib/lola-persona.js';
import { bookingGateResponse } from './lib/billing-gate.js';
import { createCanonicalBooking, sendConfirmationSMS, updateCanonicalBooking } from './lib/booking-repository.js';
import { offerRebooking } from './lib/rebooking.js';
import { randomUUID } from 'node:crypto';
import { whenForTenant, salonTz } from './lib/salon-time.js';
import { zonedLocalToUtc, localDateKey, dayBoundsUtc } from './lib/timezone.js';
import { requestDeposit } from './lib/deposits.js';
import { writeThrough } from './lib/booking-outbox.js';
import { stylistClashes, serviceMinutes as serviceMin } from './calendar-owner.js';

const DAY_START=8, DAY_END=21;
const toMin=t=>{const[h,m]=String(t).split(':').map(Number);return h*60+(m||0);};
const overlaps=(a1,a2,b1,b2)=>a1<b2&&b1<a2;

async function confirmSMS(c,tenantId,bookingId){
  try{
    const {data:b}=await c.from('bookings').select('*').eq('id',bookingId).maybeSingle();
    if(!b)return;
    const [{data:t},{data:cl},{data:sv}]=await Promise.all([
      c.from('tenants').select('name,phone_number').eq('id',tenantId).maybeSingle(),
      c.from('clients').select('name,phone').eq('id',b.client_id).maybeSingle(),
      c.from('services').select('name').eq('id',b.service_id).maybeSingle()]);
    if(!cl?.phone||!t?.phone_number)return;
    const when=await whenForTenant(tenantId,b.start_time);
    await sendSMS({from:t.phone_number,to:cl.phone,tenantId,
      text:confirmText({ verb:'Confirmed', salon:t.name, serviceName:sv?.name, when })});
  }catch(e){}
}

const sameInstant=(a,b)=>new Date(a).getTime()===new Date(b).getTime();
// n-th (0-based) occurrence start for a series cadence: UTC-day math; monthly
// clamps to the month's last day (Jan 31 -> Feb 28) instead of spilling into March.
function utcOccurrence(startISO,rule,n){
  const d=new Date(startISO);
  if(rule==='biweekly')d.setUTCDate(d.getUTCDate()+14*n);
  else if(rule==='monthly'){const day=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+n);const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();d.setUTCDate(Math.min(day,last));}
  else d.setUTCDate(d.getUTCDate()+7*n);
  return d.toISOString();
}
// Blocked time (lunch, breaks, days off) for one stylist in [start,end), keyed
// on the SALON-local date with the block's local times converted to instants —
// the same convention as the availability engine (was UTC hours before).
async function blockedHit(c,T,staffId,startIso,endIso,tz){
  const s=new Date(startIso).getTime(),e=new Date(endIso).getTime();
  const keys=[...new Set([localDateKey(startIso,tz),localDateKey(new Date(e-1),tz)])];
  for(const key of keys){
    const {data:bk}=await c.from('blocked_slots').select('*').eq('tenant_id',T).eq('blocked_date',key);
    const day=dayBoundsUtc(key,tz);
    if((bk||[]).some(b=>(!b.staff_id||b.staff_id===staffId)&&
      overlaps(s,e,new Date(b.start_time?zonedLocalToUtc(key,b.start_time,tz):day.start).getTime(),
        new Date(b.end_time?zonedLocalToUtc(key,b.end_time,tz):day.end).getTime())))return key;
  }
  return null;
}

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');
  if(req.method==='OPTIONS')return res.status(204).end();

  const c=db();
  if(!c)return res.status(503).json({ok:false,error:'Database not configured'});

  try{
    const body=typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{});
    // Owner data is only reachable with the owner's own login. (A ?t=<slug>
    // shortcut used to skip auth entirely and expose any salon's clients.)
    const user=await getUserFromToken(bearer(req));
    if(!user)return res.status(401).json({ok:false,error:'Not authenticated'});
    const tenant=await resolveTenantForUser(user);
    if(!tenant?.id)return res.status(404).json({ok:false,error:'Salon not found'});
    const T=tenant.id;

    const resource=body.resource||req.query?.resource||'calendar';
    const action=body.action||req.query?.action;

    // ═══ GET ═══
    if(req.method==='GET'){

      if(resource==='clients'){
        const q=req.query?.q||'';
        let query=c.from('clients').select('*').eq('tenant_id',T).order('name');
        if(q)query=query.or('name.ilike.%'+q+'%,phone.ilike.%'+q+'%,email.ilike.%'+q+'%');
        const {data}=await query.limit(500);
        return res.json({ok:true,clients:data||[]});
      }

      if(resource==='client'){
        const id=req.query?.id;
        if(!id)return res.status(400).json({ok:false,error:'id required'});
        const [{data:client},{data:history},{data:notes}]=await Promise.all([
          c.from('clients').select('*').eq('id',id).eq('tenant_id',T).maybeSingle(),
          c.from('bookings').select('*').eq('client_id',id).eq('tenant_id',T).order('start_time',{ascending:false}).limit(50),
          c.from('appointment_notes').select('*').eq('tenant_id',T).order('created_at',{ascending:false}).limit(50)
        ]);
        if(!client)return res.status(404).json({ok:false,error:'Client not found'});
        const [{data:svcs},{data:stff}]=await Promise.all([
          c.from('services').select('id,name').eq('tenant_id',T),
          c.from('staff').select('id,name').eq('tenant_id',T)]);
        const sM=Object.fromEntries((svcs||[]).map(s=>[s.id,s.name]));
        const tM=Object.fromEntries((stff||[]).map(s=>[s.id,s.name]));
        const bookingIds=new Set((history||[]).map(h=>h.id));
        return res.json({ok:true,client,
          history:(history||[]).map(h=>({...h,service_name:sM[h.service_id]||'',staff_name:tM[h.staff_id]||''})),
          notes:(notes||[]).filter(n=>bookingIds.has(n.booking_id)),
          lifetime_value:(history||[]).filter(h=>h.status!=='cancelled').reduce((s,h)=>s+Number(h.total_amount||0),0),
          visit_count:(history||[]).filter(h=>h.status==='completed'||h.status==='confirmed').length});
      }

      if(resource==='services'){
        const {data}=await c.from('services').select('*').eq('tenant_id',T).order('name');
        return res.json({ok:true,services:data||[]});
      }

      if(resource==='staff'){
        const {data}=await c.from('staff').select('*').eq('tenant_id',T).order('name');
        return res.json({ok:true,staff:data||[]});
      }

      if(resource==='products'){
        const {data}=await c.from('products').select('*').eq('tenant_id',T).eq('is_active',true).order('name');
        // Inventory tracking: low_stock is derived from the real stock vs
        // low_stock_alert columns (20260901_inventory_ops.sql). Guard for
        // pre-migration rows that predate the columns.
        const products=(data||[]).map(p=>({
          ...p,
          stock:Number(p.stock??0),
          low_stock_alert:Number(p.low_stock_alert??5)
        }));
        const low_stock=products.filter(p=>p.stock<=p.low_stock_alert);
        return res.json({ok:true,products,low_stock});
      }

      if(resource==='catalog'){
        const [svcs,stff]=await Promise.all([
          c.from('services').select('id,name,description,duration_minutes,price').eq('tenant_id',T).eq('is_active',true).order('name'),
          c.from('staff').select('id,name,role').eq('tenant_id',T).eq('is_active',true).order('name')]);
        return res.json({ok:true,name:tenant.name,location:tenant.location,hours:tenant.hours,
          services:svcs.data||[],staff:stff.data||[]});
      }

      if(resource==='calendar'||resource==='appointments'){
        const start=req.query?.start||new Date().toISOString().slice(0,10);
        const end=req.query?.end||start;
        const [ap,bl,sv,st,cl]=await Promise.all([
          c.from('bookings').select('*').eq('tenant_id',T)
            .gte('start_time',start+'T00:00:00').lte('start_time',end+'T23:59:59')
            .neq('status','cancelled').order('start_time'),
          c.from('blocked_slots').select('*').eq('tenant_id',T).gte('blocked_date',start).lte('blocked_date',end),
          c.from('services').select('id,name,duration_minutes,price').eq('tenant_id',T).eq('is_active',true),
          c.from('staff').select('id,name,role').eq('tenant_id',T).eq('is_active',true),
          c.from('clients').select('id,name,phone').eq('tenant_id',T)]);
        const sM=Object.fromEntries((sv.data||[]).map(s=>[s.id,s]));
        const tM=Object.fromEntries((st.data||[]).map(s=>[s.id,s]));
        const cM=Object.fromEntries((cl.data||[]).map(s=>[s.id,s]));
        const appts=(ap.data||[]).map(a=>({...a,service:sM[a.service_id]||null,staff:tM[a.staff_id]||null,client:cM[a.client_id]||null}));
        return res.json({ok:true,appointments:appts,blocked_slots:bl.data||[],
          services:sv.data||[],staff:st.data||[],
          stats:{count:appts.length,revenue:appts.reduce((s,a)=>s+Number(a.total_amount||0),0),staff_count:(st.data||[]).length}});
      }

      if(resource==='availability'){
        const date=req.query?.date;
        const serviceId=req.query?.service_id;
        const staffId=req.query?.staff_id||null;
        if(!date)return res.status(400).json({ok:false,error:'date required'});
        const {data:svc}=serviceId?await c.from('services').select('duration_minutes').eq('id',serviceId).maybeSingle():{data:null};
        const dur=Number(svc?.duration_minutes||60);
        // Salon-local day and salon-local block times (Vercel runs in UTC — reading
        // hours off a Date here used to shift every window by the UTC offset).
        const tz=await salonTz(T);
        const day=dayBoundsUtc(date,tz);
        let bq=c.from('bookings').select('start_time,end_time,staff_id,status').eq('tenant_id',T)
          .lt('start_time',day.end).gt('end_time',day.start).neq('status','cancelled');
        if(staffId)bq=bq.eq('staff_id',staffId);
        const [{data:busy},{data:blocks}]=await Promise.all([bq,
          c.from('blocked_slots').select('*').eq('tenant_id',T).eq('blocked_date',day.key)]);
        const ms=v=>new Date(v).getTime();
        const bR=(busy||[]).map(b=>({s:ms(b.start_time),e:ms(b.end_time)}));
        const kR=(blocks||[]).filter(b=>!staffId||!b.staff_id||b.staff_id===staffId)
          .map(b=>({s:ms(b.start_time?zonedLocalToUtc(day.key,b.start_time,tz):day.start),e:ms(b.end_time?zonedLocalToUtc(day.key,b.end_time,tz):day.end)}));
        const slots=[];
        for(let m=DAY_START*60;m+dur<=DAY_END*60;m+=30){
          const hh=String(Math.floor(m/60)).padStart(2,'0'),mm=String(m%60).padStart(2,'0');
          const at=zonedLocalToUtc(day.key,hh+':'+mm+':00',tz),s0=ms(at),e0=s0+dur*60000;
          if(!bR.some(r=>overlaps(s0,e0,r.s,r.e))&&!kR.some(r=>overlaps(s0,e0,r.s,r.e)))
            slots.push({time:hh+':'+mm,starts_at:at});
          if(slots.length>=12)break;
        }
        return res.json({ok:true,slots,duration:dur});
      }

      if(resource==='stats'){
        const today=new Date().toISOString().slice(0,10);
        const [all,td,cli,pr]=await Promise.all([
          c.from('bookings').select('total_amount,status').eq('tenant_id',T),
          c.from('bookings').select('id').eq('tenant_id',T).gte('start_time',today+'T00:00:00').lte('start_time',today+'T23:59:59').neq('status','cancelled'),
          c.from('clients').select('id').eq('tenant_id',T),
          c.from('products').select('id').eq('tenant_id',T).eq('is_active',true)]);
        return res.json({ok:true,
          total_appointments:(all.data||[]).length,
          today_appointments:(td.data||[]).length,
          revenue:(all.data||[]).filter(b=>b.status!=='cancelled').reduce((s,b)=>s+Number(b.total_amount||0),0),
          clients:(cli.data||[]).length,
          low_stock:0});
      }

      return res.status(400).json({ok:false,error:'Unknown resource: '+resource});
    }

    // ═══ POST ═══
    if(resource==='client'){
      if(action==='delete'){
        const { error }=await c.from('clients').delete().eq('id',body.id).eq('tenant_id',T);
        if(error)return res.status(409).json({ok:false,error:'Could not delete client: '+(error.message||JSON.stringify(error))+'. Cancel or reassign their appointments first.'});
        return res.json({ok:true});
      }
      // `name` is a GENERATED column (derived from first_name/last_name), so
      // write the canonical columns instead of the legacy name field.
      const nameParts=String(body.name||'').trim().split(/\s+/).filter(Boolean);
      const row={tenant_id:T,
        first_name:body.first_name||nameParts.shift()||'',
        last_name:body.last_name||nameParts.join(' ')||null,
        phone:body.phone||null,email:body.email||'',
        notes:body.notes||'',allergies:body.allergies||'',formula:body.formula||'',
        birthday:body.birthday||null,tags:body.tags||[],preferred_staff_id:body.preferred_staff_id||null};
      const {data,error}=body.id
        ?await c.from('clients').update(row).eq('id',body.id).eq('tenant_id',T).select().single()
        :await c.from('clients').insert(row).select().single();
      if(error)throw error;
      return res.json({ok:true,client:data});
    }

    if(resource==='service'){
      if(action==='delete'){
        const { error }=await c.from('services').update({is_active:false}).eq('id',body.id).eq('tenant_id',T);
        if(error)return res.status(500).json({ok:false,error:'Could not archive service: '+(error.message||JSON.stringify(error))});
        return res.json({ok:true});
      }
      const row={tenant_id:T,name:body.name,description:body.description||'',
        duration_minutes:Number(body.duration_minutes||60),price:Number(body.price||0),is_active:body.is_active!==false};
      const {data,error}=body.id
        ?await c.from('services').update(row).eq('id',body.id).eq('tenant_id',T).select().single()
        :await c.from('services').insert(row).select().single();
      if(error)throw error;
      return res.json({ok:true,service:data});
    }

    if(resource==='staff'){
      if(action==='delete'){
        const { error }=await c.from('staff').update({is_active:false}).eq('id',body.id).eq('tenant_id',T);
        if(error)return res.status(500).json({ok:false,error:'Could not archive staff member: '+(error.message||JSON.stringify(error))});
        return res.json({ok:true});
      }
      const row={tenant_id:T,name:body.name,role:body.role||'Stylist',is_active:body.is_active!==false};
      const {data,error}=body.id
        ?await c.from('staff').update(row).eq('id',body.id).eq('tenant_id',T).select().single()
        :await c.from('staff').insert(row).select().single();
      if(error)throw error;
      return res.json({ok:true,staff:data});
    }

    if(resource==='product'){
      if(action==='delete'){
        const { error }=await c.from('products').update({is_active:false}).eq('id',body.id).eq('tenant_id',T);
        if(error)return res.status(500).json({ok:false,error:'Could not archive product: '+(error.message||JSON.stringify(error))});
        return res.json({ok:true});
      }
      const row={tenant_id:T,name:body.name,brand:body.brand||'',category:body.category||'',
        sku:body.sku||'',price:Number(body.price||0),cost:Number(body.cost||0),
        stock:Number(body.stock||0),low_stock_alert:Number(body.low_stock_alert||5),updated_at:new Date().toISOString()};
      const {data,error}=body.id
        ?await c.from('products').update(row).eq('id',body.id).eq('tenant_id',T).select().single()
        :await c.from('products').insert(row).select().single();
      if(error)throw error;
      return res.json({ok:true,product:data});
    }

    if(resource==='note'){
      const {data,error}=await c.from('appointment_notes').insert({
        tenant_id:T,booking_id:body.booking_id,content:body.content,author:body.author||''}).select().single();
      if(error)throw error;
      return res.json({ok:true,note:data});
    }

    if(resource==='appointment'||resource==='booking'){
      // Trial-to-paid gate: an expired/suspended tenant cannot CREATE new
      // bookings from the dashboard either. Cancels/reschedules stay open so
      // existing clients are never stranded. Owner-facing -> conversion copy.
      if(action!=='cancel'&&action!=='update'&&action!=='reschedule'){
        const gate=bookingGateResponse(tenant,'operator');
        if(gate)return res.status(402).json({ok:false,...gate,error:gate.speak});
      }
      if(action==='cancel'){
        // Scoped series cancel: series_scope 'this' (default) | 'following' | 'all'.
        // Requires series_id on the target row; a plain booking ignores scope.
        const scope=String(body.series_scope||'this').toLowerCase();
        const {data:target}=await c.from('bookings').select('id,series_id,start_time,status').eq('id',body.id).eq('tenant_id',T).maybeSingle();
        if(!target)return res.status(404).json({ok:false,error:'Booking not found'});
        let q=c.from('bookings').update({status:'cancelled',updated_at:new Date().toISOString()}).eq('tenant_id',T);
        if(scope!=='this'&&target.series_id){
          q=q.eq('series_id',target.series_id);
          if(scope==='following') q=q.gte('start_time',target.start_time);
        } else q=q.eq('id',body.id);
        const {data:cancelled,error:cancelErr}=await q.neq('status','cancelled').order('start_time').select('id,client_id,service_id,start_time');
        if(cancelErr)return res.status(500).json({ok:false,error:'Could not cancel booking: '+(cancelErr.message||JSON.stringify(cancelErr))});
        // Telnyx wire: the client always hears about a cancellation — exactly
        // ONE text per cancel action (the earliest affected occurrence
        // represents a series), mirroring calendar.js's series contract.
        const firstCancelled=(cancelled||[])[0];
        if(firstCancelled && firstCancelled.client_id){
          try{
            await sendConfirmationSMS({tenantId:T,clientId:firstCancelled.client_id,serviceId:firstCancelled.service_id,startTime:firstCancelled.start_time,verb:'Cancelled'});
          }catch(e){ /* a failed cancel text must never fail the cancellation */ }
        }
        return res.json({ok:true,cancelled:cancelled?.length||0,scope:target.series_id&&scope!=='this'?scope:'this'});
      }
      if(action==='update'||action==='reschedule'){
        const patch={updated_at:new Date().toISOString()};
        if(body.status&&!['pending','confirmed','checked_in','in_progress','completed','no_show','cancelled'].includes(String(body.status)))
          return res.status(400).json({ok:false,error:'Invalid status: '+body.status});
        if(body.status)patch.status=body.status;
        if(body.staff_id)patch.staff_id=body.staff_id;
        if(body.notes!=null)patch.notes=body.notes;
        if(body.starts_at){
          const {data:ex}=await c.from('bookings').select('start_time,end_time,series_id,staff_id').eq('id',body.id).maybeSingle();
          const dur=ex?(new Date(ex.end_time)-new Date(ex.start_time))/60000:60;
          const ns=new Date(body.starts_at);
          patch.start_time=ns.toISOString();
          patch.end_time=new Date(ns.getTime()+dur*60000).toISOString();
          // Reschedule on a series row: 'this' (default) moves only this
          // occurrence; 'following' moves this + every later occurrence by
          // the same delta, preserving the cadence between them. EVERY moved
          // occurrence is checked first — staff overlap and blocked time,
          // the same checks creation runs — against everything EXCEPT the
          // moving set (they shift together, so mutual overlaps are
          // preserved by construction). Target first, then later ones in
          // chronological order; a collision stops the move with 409
          // {conflict, moved_count, failed_at_occurrence} and the already-
          // moved occurrences persist (same partial-apply contract as
          // series creation).
          const scope=String(body.series_scope||'this').toLowerCase();
          if(scope==='following'&&ex?.series_id){
            const delta=new Date(patch.start_time).getTime()-new Date(ex.start_time).getTime();
            const {data:later,error:laterErr}=await c.from('bookings').select('id,start_time,end_time,staff_id,series_pos')
              .eq('series_id',ex.series_id).eq('tenant_id',T).neq('status','cancelled')
              .gt('start_time',ex.start_time).order('start_time');
            if(laterErr)return res.status(500).json({ok:false,error:'Could not read the series: '+(laterErr.message||JSON.stringify(laterErr))});
            const moving=new Set([body.id,...(later||[]).map(o=>o.id)]);
            const tz=await salonTz(T);
            const checkOcc=async(occ)=>{
              if(!occ.staff_id)return null;
              const st=new Date(occ.start_time),en=new Date(occ.end_time);
              const {data:cf}=await c.from('bookings').select('id').eq('tenant_id',T).eq('staff_id',occ.staff_id)
                .neq('status','cancelled').lt('start_time',en.toISOString()).gt('end_time',st.toISOString());
              if(cf&&cf.some(x=>!moving.has(x.id)))
                return 'Occurrence '+st.toISOString().slice(0,10)+' is already booked — the first '+occ.moved+' were moved.';
              const ds=await blockedHit(c,T,occ.staff_id,st.toISOString(),en.toISOString(),tz);
              if(ds)
                return 'Occurrence '+ds+' falls in blocked time — the first '+occ.moved+' were moved.';
              return null;
            };
            // target first (same window the tail patch below applies)
            const targetOcc={start_time:patch.start_time,end_time:patch.end_time,
              staff_id:body.staff_id||ex.staff_id||null,series_pos:ex.series_pos||1,moved:0};
            const targetConflict=await checkOcc(targetOcc);
            if(targetConflict)return res.status(409).json({ok:false,conflict:true,moved_count:0,failed_at_occurrence:targetOcc.series_pos,
              error:'The new time for occurrence '+targetOcc.series_pos+' collides — nothing was moved. '+(targetConflict.match(/falls in blocked time/)?'Blocked time in the way.':'Another booking is in the way.')});
            const {data:movedTarget,error:movedErr}=await c.from('bookings').update(patch).eq('id',body.id).eq('tenant_id',T).select().single();
            if(movedErr)throw movedErr;
            let moved=0;
            for(const occ of (later||[])){
              const ns=new Date(new Date(occ.start_time).getTime()+delta).toISOString();
              const ne=new Date(new Date(occ.end_time).getTime()+delta).toISOString();
              const conflict=await checkOcc({start_time:ns,end_time:ne,staff_id:occ.staff_id,series_pos:occ.series_pos,moved});
              if(conflict)return res.status(409).json({ok:false,conflict:true,moved_count:moved,failed_at_occurrence:occ.series_pos||null,error:conflict});
              const {error:occErr}=await c.from('bookings').update({
                start_time:ns,end_time:ne,updated_at:new Date().toISOString()}).eq('id',occ.id).eq('tenant_id',T);
              if(occErr)return res.status(500).json({ok:false,error:'Could not move occurrence: '+(occErr.message||JSON.stringify(occErr))});
              moved++;
            }
            // series_moved is RESPONSE metadata, not a bookings column —
            // writing it into the patch once made every series move fail on
            // real Postgres (unknown column) while the fake tolerated it.
            return res.json({ok:true,appointment:movedTarget,series_moved:moved});
          }
        }
        // Status changes go through the canonical update (status history, fee
        // void on no-show/cancel, cancellation text) — never a bare row write.
        const {updated_at:_u,...canon}=patch;
        const data=await updateCanonicalBooking(T,body.id,canon,{source:'dashboard',reason:body.status?'owner_'+body.status:'owner_edit'});
        if(!data)return res.status(404).json({ok:false,error:'Booking not found'});
        // Auto-rebooking loop: a visit reaching `completed` fires ONE offer
        // for the same service at the service's refresh interval (Loop #3).
        // Fire-and-forget — a failed offer never fails the completion.
        // bookings has no completed_at column, so the in-flight object
        // carries updated_at as the completion moment; the sweep's advance
        // path falls back to the offer's created_at (the same instant).
        if(data && patch.status==='completed' && String(data.status||'').toLowerCase()==='completed'){
          offerRebooking({ tenantId:T, booking:{ ...data, completed_at: data.updated_at || new Date().toISOString() } })
            .catch(()=>{}); // never rejects, but belt-and-braces
        }
        return res.json({ok:true,appointment:data});
      }
      // create — every occurrence (and every service segment of a multi-service
      // visit) is validated by the availability engine in the SALON's timezone
      // (staff hours, lunch/blocked time, time off, holds, the salon platform's
      // own appointments). Nothing is written until ALL occurrences fit. The
      // first occurrence confirms by SMS and requests the deposit; every
      // occurrence is written through to the salon's external platform.
      // (Owner overrides — walk-ins, off-grid, past — live in api/calendar-owner.js.)
      const ids=body.service_ids?.length?body.service_ids:[body.service_id];
      if(!ids[0])return res.status(400).json({ok:false,error:'service required'});
      const tz=await salonTz(T);
      const {data:svcRows}=await c.from('services').select('*').eq('tenant_id',T).in('id',ids);
      const seq=ids.map(id=>(svcRows||[]).find(x=>x.id===id)).filter(Boolean);
      if(!seq.length)return res.status(400).json({ok:false,error:'service not found'});
      const price=seq.reduce((s,x)=>s+Number(x.price||0),0);
      const startDt=body.starts_at?new Date(body.starts_at)
        :new Date(zonedLocalToUtc(String(body.date||localDateKey(new Date(),tz)),String(body.start_time||'09:00').slice(0,5)+':00',tz));
      if(Number.isNaN(startDt.getTime()))return res.status(400).json({ok:false,error:'invalid start time'});
      const rule=String(body.repeat?.rule||'').toLowerCase();
      const count=['weekly','biweekly','monthly'].includes(rule)?Math.min(52,Math.max(1,parseInt(body.repeat?.count,10)||1)):1;
      const occStarts=[];
      // Legacy contract: occurrences are exact UTC-day multiples of the first
      // (api/calendar-owner.js — what the owner calendar uses — keeps salon wall time).
      for(let n=0;n<count;n++)occStarts.push(n===0?startDt.toISOString():utcOccurrence(startDt.toISOString(),rule,n));
      // Owner rules (same as api/calendar-owner.js): walk-ins, past, off-grid and
      // off-schedule times are the owner's call. Only a real same-stylist overlap
      // (LolaDesk or the salon platform) or a blocked window in SALON time refuses
      // — and `force` books it anyway. Conflicts answer 200 {ok:false, conflict}.
      const staffId=body.staff_id||null;
      const force=body.force===true;
      const lenMs=seq.reduce((t,x)=>t+serviceMin(x),0)*60000;
      const occ=[];
      for(const [i,st] of occStarts.entries()){
        const en=new Date(new Date(st).getTime()+lenMs).toISOString();
        if(staffId&&!force){
          const ds=localDateKey(st,tz);
          const where=count>1?'Occurrence '+(i+1)+' ('+ds+')':'That time';
          const clash=await stylistClashes(c,T,staffId,st,en);
          if(clash.length)return res.json({ok:false,conflict:true,needs_confirmation:true,created_count:0,failed_at_occurrence:i+1,
            error:where+' is already booked for this stylist'+(clash[0].kind==='external'?' on '+(clash[0].provider||'the salon platform'):'')+' — nothing was booked.'});
          const blk=await blockedHit(c,T,staffId,st,en,tz);
          if(blk)return res.json({ok:false,conflict:true,needs_confirmation:true,created_count:0,failed_at_occurrence:i+1,
            error:where+' falls in blocked time — staff unavailable. Nothing was booked.'});
        }
        occ.push({start:st,end:en});
      }
      let clientId=body.client_id||null;
      if(clientId){const {data:own}=await c.from('clients').select('id').eq('id',clientId).eq('tenant_id',T).maybeSingle();if(!own)clientId=null;}
      if(!clientId&&(body.client_phone||body.client_name)){
        const cl=await upsertClient(T,{phone:body.client_phone,name:body.client_name});
        clientId=cl?.id||null;
      }
      const seriesId=count>1?randomUUID():null;
      const created=[];
      for(const [i,o] of occ.entries()){
        const row=await createCanonicalBooking({
          tenantId:T,clientId,serviceId:seq[0].id,staffId,startTime:o.start,endTime:o.end,
          status:'confirmed',totalAmount:price,notes:seriesId?((body.notes||'')+' [recurring series '+(i+1)+'/'+count+']').trim():(body.notes||null),
          source:body.channel||body.source||'dashboard',sendConfirmation:false,
          series:seriesId?{id:seriesId,pos:i+1,total:count,rule}:null});
        created.push(row);
        for(const [k,sv] of seq.entries()){
          const phased=Number(sv.active_duration_1_min||0)||Number(sv.processing_duration_min||0);
          const {error:svcErr}=await c.from('booking_services').insert({
            booking_id:row.id,service_id:sv.id,staff_id:staffId,sequence_no:k+1,
            active_duration_1_min:phased?Number(sv.active_duration_1_min||0):Number(sv.duration_minutes||60),
            processing_duration_min:phased?Number(sv.processing_duration_min||0):0,
            active_duration_2_min:phased?Number(sv.active_duration_2_min||0):0,
            price:Number(sv.price||0)});
          if(svcErr)throw new Error('booking_services write failed (sequence '+(k+1)+'): '+(svcErr.message||JSON.stringify(svcErr)));
        }
        try{
          await writeThrough(c,{tenantId:T,booking:row,ctx:{
            client:{id:clientId,name:body.client_name||null,phone:body.client_phone||null},
            service:{id:seq[0].id,name:seq.map(x=>x.name).join(' + ')},staff:{id:staffId},
            startsAt:o.start,endsAt:o.end,durationMin:Math.round((new Date(o.end)-new Date(o.start))/60000),
            price,timezone:tz,notes:body.notes||'Booked from the LolaDesk calendar'}});
        }catch(e){ /* the outbox never fails a booking */ }
      }
      const booking=created[0];
      // ONE confirmation text and ONE deposit request for the whole visit/series.
      await confirmSMS(c,T,booking.id);
      requestDeposit({tenantId:T,booking,policy:null}).catch(()=>{});
      if(seriesId)return res.json({ok:true,appointment:booking,booking,series:{id:seriesId,total:count,rule,sms_sent:1}});
      return res.json({ok:true,appointment:booking,booking});
    }

    if(resource==='block'){
      if(action==='delete'){
        const { error }=await c.from('blocked_slots').delete().eq('id',body.id).eq('tenant_id',T);
        if(error)return res.status(500).json({ok:false,error:'Could not remove block: '+(error.message||JSON.stringify(error))});
        return res.json({ok:true});
      }
      const {data,error}=await c.from('blocked_slots').insert({tenant_id:T,staff_id:body.staff_id||null,
        blocked_date:body.date,start_time:body.start_time||null,end_time:body.end_time||null,
        reason:body.reason||''}).select().single();
      if(error)throw error;
      return res.json({ok:true,blocked_slot:data});
    }

    return res.status(400).json({ok:false,error:'Unknown resource: '+resource});
  }catch(e){
    console.error('[salon]',e.message);
    return res.status(500).json({ok:false,error:String(e?.message||e)});
  }
}
