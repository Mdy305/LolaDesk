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
import { bookingGateResponse } from './lib/billing-gate.js';

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
    const when=new Date(b.start_time).toLocaleString('en-US',{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
    await sendSMS({from:t.phone_number,to:cl.phone,tenantId,
      text:'Confirmed at '+(t.name||'the salon')+': '+(sv?.name||'Appointment')+' on '+when+'. Reply STOP to opt out.'});
  }catch(e){}
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
    const slug=req.query?.t||body.slug;
    let tenant=null;
    if(slug){ tenant=await getTenantBySlug(slug); }
    else{
      const user=await getUserFromToken(bearer(req));
      if(!user)return res.status(401).json({ok:false,error:'Not authenticated'});
      tenant=await resolveTenantForUser(user);
    }
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
        const low=(data||[]).filter(p=>p.stock<=p.low_stock_alert);
        return res.json({ok:true,products:data||[],low_stock:low});
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
        let bq=c.from('bookings').select('start_time,end_time,staff_id').eq('tenant_id',T)
          .gte('start_time',date+'T00:00:00').lte('start_time',date+'T23:59:59').neq('status','cancelled');
        if(staffId)bq=bq.eq('staff_id',staffId);
        const [{data:busy},{data:blocks}]=await Promise.all([bq,
          c.from('blocked_slots').select('*').eq('tenant_id',T).eq('blocked_date',date)]);
        const bR=(busy||[]).map(b=>({s:toMin(new Date(b.start_time).toTimeString().slice(0,5)),e:toMin(new Date(b.end_time).toTimeString().slice(0,5))}));
        const kR=(blocks||[]).filter(b=>!staffId||!b.staff_id||b.staff_id===staffId)
          .map(b=>({s:b.start_time?toMin(b.start_time):DAY_START*60,e:b.end_time?toMin(b.end_time):DAY_END*60}));
        const slots=[];
        for(let m=DAY_START*60;m+dur<=DAY_END*60;m+=30){
          if(!bR.some(r=>overlaps(m,m+dur,r.s,r.e))&&!kR.some(r=>overlaps(m,m+dur,r.s,r.e))){
            const hh=String(Math.floor(m/60)).padStart(2,'0'),mm=String(m%60).padStart(2,'0');
            slots.push({time:hh+':'+mm,starts_at:new Date(date+'T'+hh+':'+mm+':00').toISOString()});
          }
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
          c.from('products').select('stock,low_stock_alert').eq('tenant_id',T).eq('is_active',true)]);
        return res.json({ok:true,
          total_appointments:(all.data||[]).length,
          today_appointments:(td.data||[]).length,
          revenue:(all.data||[]).filter(b=>b.status!=='cancelled').reduce((s,b)=>s+Number(b.total_amount||0),0),
          clients:(cli.data||[]).length,
          low_stock:(pr.data||[]).filter(p=>p.stock<=p.low_stock_alert).length});
      }

      return res.status(400).json({ok:false,error:'Unknown resource: '+resource});
    }

    // ═══ POST ═══
    if(resource==='client'){
      if(action==='delete'){
        await c.from('clients').delete().eq('id',body.id).eq('tenant_id',T);
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
        await c.from('services').update({is_active:false}).eq('id',body.id).eq('tenant_id',T);
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
        await c.from('staff').update({is_active:false}).eq('id',body.id).eq('tenant_id',T);
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
        await c.from('products').update({is_active:false}).eq('id',body.id).eq('tenant_id',T);
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
        await c.from('bookings').update({status:'cancelled',updated_at:new Date().toISOString()})
          .eq('id',body.id).eq('tenant_id',T);
        return res.json({ok:true});
      }
      if(action==='update'||action==='reschedule'){
        const patch={updated_at:new Date().toISOString()};
        if(body.status)patch.status=body.status;
        if(body.staff_id)patch.staff_id=body.staff_id;
        if(body.notes!=null)patch.notes=body.notes;
        if(body.starts_at){
          const {data:ex}=await c.from('bookings').select('start_time,end_time').eq('id',body.id).maybeSingle();
          const dur=ex?(new Date(ex.end_time)-new Date(ex.start_time))/60000:60;
          const ns=new Date(body.starts_at);
          patch.start_time=ns.toISOString();
          patch.end_time=new Date(ns.getTime()+dur*60000).toISOString();
        }
        const {data,error}=await c.from('bookings').update(patch).eq('id',body.id).eq('tenant_id',T).select().single();
        if(error)throw error;
        return res.json({ok:true,appointment:data});
      }
      // create
      const ids=body.service_ids?.length?body.service_ids:[body.service_id];
      if(!ids[0])return res.status(400).json({ok:false,error:'service required'});
      let clientId=body.client_id||null;
      if(!clientId&&(body.client_phone||body.client_name)){
        const cl=await upsertClient(T,{phone:body.client_phone,name:body.client_name});
        clientId=cl?.id||null;
      }
      const {data:svcs}=await c.from('services').select('id,duration_minutes,price').in('id',ids);
      const dur=(svcs||[]).reduce((s,x)=>s+Number(x.duration_minutes||60),0)||60;
      const price=(svcs||[]).reduce((s,x)=>s+Number(x.price||0),0);
      const startDt=body.starts_at?new Date(body.starts_at):new Date(body.date+'T'+(body.start_time||'09:00')+':00');
      const endDt=new Date(startDt.getTime()+dur*60000);
      if(body.staff_id){
        const {data:cf}=await c.from('bookings').select('id').eq('tenant_id',T).eq('staff_id',body.staff_id)
          .neq('status','cancelled').lt('start_time',endDt.toISOString()).gt('end_time',startDt.toISOString());
        if(cf?.length)return res.json({ok:false,conflict:true,error:'That time is already booked'});
        const ds=startDt.toISOString().slice(0,10);
        const {data:bk}=await c.from('blocked_slots').select('*').eq('tenant_id',T).eq('blocked_date',ds);
        const rs=startDt.getHours()*60+startDt.getMinutes();
        if((bk||[]).some(b=>(!b.staff_id||b.staff_id===body.staff_id)&&
          overlaps(rs,rs+dur,b.start_time?toMin(b.start_time):DAY_START*60,b.end_time?toMin(b.end_time):DAY_END*60)))
          return res.json({ok:false,conflict:true,error:'Staff unavailable at that time'});
      }
      const {data:booking,error}=await c.from('bookings').insert({
        tenant_id:T,client_id:clientId,service_id:ids[0],staff_id:body.staff_id||null,
        start_time:startDt.toISOString(),end_time:endDt.toISOString(),
        status:'confirmed',total_amount:price,notes:body.notes||null,
        source:body.channel||body.source||'dashboard'}).select().single();
      if(error)throw error;
      for(const sid of ids){
        const sv=(svcs||[]).find(x=>x.id===sid);
        if(sv)await c.from('appointment_services').insert({booking_id:booking.id,service_id:sid,
          price:Number(sv.price||0),duration:Number(sv.duration_minutes||60)}).catch(()=>{});
      }
      confirmSMS(c,T,booking.id).catch(()=>{});
      return res.json({ok:true,appointment:booking,booking});
    }

    if(resource==='block'){
      if(action==='delete'){
        await c.from('blocked_slots').delete().eq('id',body.id).eq('tenant_id',T);
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
