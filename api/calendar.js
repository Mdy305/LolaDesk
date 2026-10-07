import { db, upsertClient } from './lib/db.js';
import { resolvePolicy, requestDeposit } from './lib/deposits.js';
import { tenantForRequest } from './lib/tenant-context.js';
import { resolveBookingRequest } from './lib/booking-resolver.js';
import { getAvailability, holdAvailability } from './lib/availability-engine-v2.js';
import {
  addMinutes, addToWaitlist, createCanonicalBooking, findWaitlistMatches, getHold, getBookingSettings,
  listBookings, listServices, listStaff, listWaitlist, releaseHold, removeFromWaitlist, sendConfirmationSMS, updateCanonicalBooking,
  upsertProviderMapping, bookFromHold, createHoldAtomic, blockedHitTz
} from './lib/booking-repository.js';
import { ensureBookingBaseline } from './lib/booking-seed.js';
import { dayBoundsUtc, localDateKey, zonedLocalToUtc } from './lib/timezone.js';
import { offerFreedSlot } from './lib/booking-reminders.js';
import { gateNewBooking, turnedAway, WIDGET_LINE } from './lib/billing-enforce.js';
import { writeThrough, afterResponse, enqueueUpstream, processOutbox } from './lib/booking-outbox.js';
import { bestStaffAt, rankDay, findSmartSlots } from './lib/smart-slots.js';
import { limitPublicShared, clientIp, holdRequesterKey, PUBLIC_HOLD_TTL_MAX_S, PUBLIC_MAX_ACTIVE_HOLDS, activeHoldsFor, noteHold } from './lib/public-rate-limit.js';
import {
  bookingRules, disabledMessage, validEmail, validPhone, findClientByPhone, publicClient, saveConsent,
  collectsDeposits, serviceDepositCents, depositQuote, policyWindow, addonsAfter, hasBookingServices, publicHold, fitsBackToBack
} from './lib/public-booking-core.js';

function jsonBody(req){
  if(typeof req.body==='string') { try{return JSON.parse(req.body||'{}')}catch{return {}} }
  return req.body || {};
}

// Calendar-date arithmetic on a YYYY-MM-DD key — pure calendar math, no
// timezone math; DST is handled by zonedLocalToUtc at the edges.
function addDaysKey(key,n){const [y,m,d]=key.split('-').map(Number);return new Date(Date.UTC(y,m-1,d+n)).toISOString().slice(0,10);}

// "Any available": the stylist whose day this time packs best (the client's
// usual stylist first, then no unsellable holes — lib/smart-slots.js), not
// simply the first free one.
async function staffFreeAt(tenantId, serviceId, startsAt, clientId=null){
  try{
    const best=await bestStaffAt({tenantId,serviceId,startsAt,clientId});
    if(best?.staff_id) return best.staff_id;
  }catch(e){ console.warn('[calendar] bestStaffAt:',e.message); }
  const av=await getAvailability({tenantId,serviceId,date:startsAt,limit:500});
  const target=new Date(startsAt).toISOString();
  return (av.slots||[]).find(x=>x.starts_at===target)?.staff_id || null;
}

// Tell the salon's Zap (Boulevard timeblocks…) about a move/cancel without
// making anyone wait. Creates go through the durable outbox (writeThrough).
function zapLater(tenant, bookingId, event){
  if(!bookingId) return;
  afterResponse((async()=>{
    const { emitBooking }=await import('./lib/zapier-bridge.js');
    return emitBooking(db(), tenant, bookingId, event);
  })().catch(()=>{}));
}

function serviceIdList(body){
  let ids=body.service_ids;
  if(typeof ids==='string'){ try{ ids=JSON.parse(ids); }catch{ ids=ids.split(','); } }
  ids=Array.isArray(ids)?ids.map(x=>String(x||'').trim()).filter(Boolean):[];
  if(body.service_id && !ids.includes(String(body.service_id))) ids.unshift(String(body.service_id));
  return [...new Set(ids)].slice(0,4);
}

// A moved booking keeps its real length (multi-service bookings run longer
// than their first service's slot): holdAvailability({ minDurationMin }).
function lengthMin(b){
  const m=Math.round((new Date(b?.end_time).getTime()-new Date(b?.start_time).getTime())/60000);
  return Number.isFinite(m) && m>0 ? m : null;
}

function normPhone(p){
  let d=String(p||'').replace(/\D/g,'');
  if(d.length===11 && d[0]==='1') d=d.slice(1);
  return d;
}

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization,x-lola-number');
  if(req.method==='OPTIONS') return res.status(204).end();

  try{
    // Merge query params into the body so GET requests (public booking,
    // calendar links) carry service_id / staff_id / date like POST does.
    const body={ ...(req.query||{}), ...jsonBody(req) };
    if(req.__publicBooking===true){
      // Anonymous visitors never choose the client record, the price, or a
      // long hold. (These fields used to be trusted from the browser.)
      delete body.client_id; delete body.total_amount; delete body.tenant_id;
      // A public hold blocks a real chair: at most 5 minutes.
      body.ttl_seconds=Math.min(PUBLIC_HOLD_TTL_MAX_S,Math.max(60,Number(body.ttl_seconds)||PUBLIC_HOLD_TTL_MAX_S));
      if(body.limit!=null) body.limit=Math.min(300,Math.max(1,Number(body.limit)||12));
    }
    const tenant=await tenantForRequest(req,body);
    if(!tenant?.id){
      return res.status(req.__publicBooking===true?404:401).json({ ok:false,error:req.__publicBooking===true?'tenant_not_found':'not_authenticated' });
    }
    // Self-heal: any touch of a not-yet-bookable tenant (settings, catalog,
    // availability, Lola voice booking, the widget) seeds its missing booking
    // baseline. ensureBookingBaseline short-circuits on a single PK read when
    // the tenant is already bookable, so a healthy tenant pays one select.
    try{ await ensureBookingBaseline(tenant.id); }catch(e){ console.warn('[calendar] booking-seed', e.message); }
    const action=body.action || req.query?.action || (req.method==='GET'?'day':'');
    const isPublic=req.__publicBooking===true;
    // Public visitors: per-IP limits, and the salon's own booking settings.
    let rules=null, pubSettings=null;
    if(isPublic){
      if(!(await limitPublicShared(req,action,tenant.id))) return res.status(429).json({ ok:false, error:'rate_limited', message:'Too many tries from this device — please wait a few minutes and try again.' });
      pubSettings=(await getBookingSettings(tenant.id).catch(()=>null))||{};
      rules=bookingRules(pubSettings);
      if(!rules.enabled && ['availability','hold','book','reschedule','waitlist_add','open_days','deposit_quote','addons'].includes(action)){
        return res.status(200).json({ ok:false, error:'booking_disabled', booking_disabled:true, message:disabledMessage(tenant), salon_phone:tenant.phone_number||null });
      }
      // The salon decides whether clients may pick a stylist.
      if(!rules.allow_staff_choice && ['availability','hold','book','open_days'].includes(action)) delete body.staff_id;
    }
    // Trial over and unpaid (BILLING_ENFORCE): the website widget stops taking
    // new bookings, offers the waitlist, and the owner is texted once.
    if(req.__publicBooking===true && (action==='availability'||action==='hold'||action==='book') && gateNewBooking(tenant)){
      // availability → no times, so the widget offers its waitlist (a lead the
      // salon keeps); hold/book → the widget shows this sentence as-is.
      if(action==='availability') return res.status(200).json({ ok:true, slots:[], blocked:true, message:WIDGET_LINE });
      await turnedAway(db(), tenant, { channel:'widget', caller: body.client_phone||'' });
      return res.status(200).json({ ok:false, error:WIDGET_LINE, blocked:true });
    }

    if(action==='settings') return res.json({ ok:true, settings:await getBookingSettings(tenant.id) });

    if(action==='catalog'){
      const [services,staff]=await Promise.all([listServices(tenant.id),listStaff(tenant.id)]);
      if(isPublic){
        // Public: only what a client needs — never stylists' phones/emails.
        const settings=pubSettings;
        const dp=resolvePolicy(settings);
        const collects=collectsDeposits(dp);
        return res.json({ ok:true,
          // The salon's configured policy (amount = percent, or dollars when fixed).
          // What a client actually pays is services[].deposit_cents / deposit_quote.
          deposit_policy: dp ? { enabled:true, type:dp.type, amount:dp.type==='fixed'?(dp.fixed_cents||0)/100:dp.percent, min_amount:(dp.min_cents||0)/100,
            premium_threshold:dp.premium_value>0?dp.premium_threshold:null, who:dp.who, collects } : null,
          salon:{ name:tenant.name||'', location:tenant.location||'', phone:tenant.phone_number||'', hours:tenant.hours||'', timezone:rules.timezone,
            cancellation_window_hours:settings?.cancellation_window_hours??null, deposit_required:!!(collects && dp.who==='everyone'), deposit_may_apply:collects },
          booking:{ enabled:rules.enabled, allow_any_staff:rules.allow_any_staff, allow_staff_choice:rules.allow_staff_choice, require_email:rules.require_email,
            cancellation_window_hours:rules.cancellation_window_hours, message:rules.enabled?null:disabledMessage(tenant) },
          services:rules.enabled?services.filter(x=>x.is_active!==false).map(x=>({id:x.id,name:x.name,description:x.description||'',price:x.price,duration_minutes:x.duration_minutes,category:x.category||null,
            deposit_cents:serviceDepositCents(x.price,dp)})):[],
          staff:rules.enabled&&rules.allow_staff_choice?staff.filter(x=>x.is_active!==false).map(x=>({id:x.id,name:x.name,role:x.role||''})):[] });
      }
      return res.json({ ok:true,services,staff });
    }

    if(action==='booking_notes'){
      const bookingId=req.query?.booking_id || body.booking_id;
      if(!bookingId) return res.status(400).json({ ok:false,error:'booking_id required' });
      const { data,error }=await db()
        .from('appointment_notes').select('*').eq('tenant_id',tenant.id)
        .eq('booking_id',bookingId).order('created_at',{ascending:false});
      if(error) return res.status(500).json({ ok:false,error:error.message });
      return res.json({ ok:true,notes:data||[] });
    }

    if(action==='booking_services'){
      const bookingId=req.query?.booking_id || body.booking_id;
      if(!bookingId) return res.status(400).json({ ok:false,error:'booking_id required' });
      // booking_services has no tenant_id column — scope through the booking.
      const client=db();
      const { data:bk }=await client.from('bookings').select('id').eq('id',bookingId).eq('tenant_id',tenant.id).maybeSingle();
      if(!bk) return res.json({ ok:true,items:[] });
      const { data:items,error }=await client.from('booking_services').select('*').eq('booking_id',bookingId).order('sequence_no');
      if(error) return res.status(500).json({ ok:false,error:error.message });
      const svcIds=[...new Set((items||[]).map(i=>i.service_id).filter(Boolean))];
      const { data:svcs }=svcIds.length
        ?await client.from('services').select('id,name,duration_minutes,price').in('id',svcIds)
        :{data:[]};
      const sM=Object.fromEntries((svcs||[]).map(s=>[s.id,s]));
      return res.json({ ok:true,items:(items||[]).map(i=>({ ...i,service:sM[i.service_id]||null })) });
    }

    // Reports (Revenue, retention): every booking in a date range, owner-only.
    // The calendar only ever answered one day or one week, so the Revenue
    // page's trend, services, staff and retention came back empty.
    if(action==='range'){
      if(req.__publicBooking===true) return res.status(404).json({ ok:false, error:'not_found' });
      const settings0=await getBookingSettings(tenant.id);
      const tz=settings0?.timezone||'America/New_York';
      const key=(v,d)=>/^\d{4}-\d{2}-\d{2}$/.test(String(v||''))?String(v):d;
      const today=localDateKey(new Date(),tz);
      let fromKey=key(body.from,today), toKey=key(body.to,today);
      if(fromKey>toKey) [fromKey,toKey]=[toKey,fromKey];
      const span=(Date.parse(toKey)-Date.parse(fromKey))/864e5;
      const clientId=body.client_id?String(body.client_id):null;   // one client's history (client profile)
      const maxSpan=clientId?3700:400;
      if(span>maxSpan) fromKey=addDaysKey(toKey,-maxSpan);
      const start=new Date(zonedLocalToUtc(fromKey,'00:00:00',tz)), end=new Date(zonedLocalToUtc(addDaysKey(toKey,1),'00:00:00',tz));
      const [services,staff,bookings]=await Promise.all([listServices(tenant.id),listStaff(tenant.id),listBookings(tenant.id,start.toISOString(),end.toISOString(),{ clientId })]);
      const sv=new Map((services||[]).map(x=>[x.id,x])), st=new Map((staff||[]).map(x=>[x.id,x]));
      const rows=(bookings||[]).map(b=>({ id:b.id, start_time:b.start_time, end_time:b.end_time, status:b.status, source:b.source||null,
        duration_min:b.duration_min||(sv.get(b.service_id)?.duration_minutes)||null,
        total_amount:Number(b.total_amount ?? b.price ?? sv.get(b.service_id)?.price ?? 0)||0,
        client_id:b.client_id||null, client_name:b.client_name||null,
        service_id:b.service_id||null, service_name:sv.get(b.service_id)?.name || (typeof b.service==='string'?b.service:null),
        staff_id:b.staff_id||null, staff_name:st.get(b.staff_id)?.name || b.stylist || null }));
      return res.json({ ok:true, from:fromKey, to:toKey, timezone:tz, bookings:rows });
    }

    if(action==='day' || action==='week'){
      const [services,staff]=await Promise.all([listServices(tenant.id),listStaff(tenant.id)]);
      const date=req.query?.date || body.date || new Date().toISOString();
      // The client sends SALON-LOCAL calendar dates (its picker renders local
      // dates), so the window must be that local day — not a UTC-midnight
      // window, which bucketed a 20:00-local evening booking onto the next
      // day (a New York 8 PM is 00:00Z the following day). Same convention
      // as the availability engine and autopilot: dayBoundsUtc on the
      // tenant's booking_settings.timezone.
      const settings0=await getBookingSettings(tenant.id);
      const tz=settings0?.timezone||'America/New_York';
      const first=dayBoundsUtc(/^\d{4}-\d{2}-\d{2}$/.test(String(date))?String(date):new Date(date),tz);
      const start=new Date(first.start);
      const days=action==='week' ? Math.max(1,Math.min(14,Number(body.days||7))) : 1;
      const end=new Date(zonedLocalToUtc(addDaysKey(first.key,days),'00:00:00',tz));
      // Blocks (lunch, breaks, days off) ride the same payload so the calendar
      // can shade them on the staff grid. The table landed in
      // 20260829_inventory_ops.sql; pre-migration the query resolves empty.
      const from=start.toISOString().slice(0,10), to=end.toISOString().slice(0,10);
      const [bookings,settings,blocked]=await Promise.all([
        listBookings(tenant.id,start.toISOString(),end.toISOString()),
        action==='day' ? getBookingSettings(tenant.id) : Promise.resolve(null),
        db().from('blocked_slots').select('*').eq('tenant_id',tenant.id)
          .gte('blocked_date',from).lte('blocked_date',to)
      ]);
      const enriched=await enrichBookings(tenant.id,bookings,services,staff);
      const out={ ok:true, services, staff, start:start.toISOString(), days, bookings:enriched, blocked_slots:blocked.data||[], timezone:tz };
      if(action==='day'){ out.date=localDateKey(start,tz); out.settings=settings; }
      return res.json(out);
    }

    // ── public-only helpers for the booking page ──
    if(isPublic && action==='client_lookup'){
      // Returning visitor: their FIRST name only (never last name, email or
      // history), per-IP rate limited above.
      const phone=String(body.client_phone||body.phone||'').trim();
      if(!validPhone(phone)) return res.json({ ok:true, client:null });
      const cl=await findClientByPhone(tenant.id,phone).catch(()=>null);
      const first=cl && cl.first_name && !/^(client|website visitor)$/i.test(cl.first_name) ? String(cl.first_name).split(' ')[0] : null;
      return res.json({ ok:true, client: first ? { first_name:first } : null });
    }

    if(isPublic && action==='deposit_quote'){
      const ids=serviceIdList(body);
      const services=await listServices(tenant.id);
      const picked=ids.map(id=>services.find(x=>x.id===id)).filter(Boolean);
      if(!picked.length) return res.json({ ok:false, error:'service_not_found' });
      const q=await depositQuote(tenant.id,pubSettings,{ services:picked, phone:body.client_phone||null });
      return res.json({ ok:true, ...q });
    }

    if(isPublic && action==='open_days'){
      // Which of the next (up to) 14 salon days have any opening for this service.
      if(!body.service_id) return res.json({ ok:false, error:'service_id_required' });
      const today=localDateKey(new Date(),rules.timezone);
      const from=/^\d{4}-\d{2}-\d{2}$/.test(String(body.from||''))&&String(body.from)>=today?String(body.from):today;
      const n=Math.max(1,Math.min(14,Number(body.days)||14));
      const days=[];
      for(let i=0;i<n;i++){
        const key=addDaysKey(from,i);
        const av=await getAvailability({tenantId:tenant.id,serviceId:body.service_id,date:key,staffId:body.staff_id||null,limit:1}).catch(()=>null);
        if(av && av.ok===false && av.error==='service_not_found') return res.json({ ok:false, error:'service_not_found' });
        days.push({ date:key, open:!!(av?.slots||[]).length });
      }
      return res.json({ ok:true, time_zone:rules.timezone, days });
    }

    if(isPublic && action==='addons'){
      // After a time is held: real menu add-ons the same stylist can do right after.
      const hold=body.hold_token?await getHold(tenant.id,body.hold_token):null;
      if(!hold || hold.status!=='active') return res.json({ ok:true, addons:[] });
      const services=await listServices(tenant.id);
      const addons=await addonsAfter({ tenantId:tenant.id, services, serviceId:hold.service_id, staffId:hold.staff_id, endsAt:hold.ends_at });
      const dp=resolvePolicy(pubSettings);
      return res.json({ ok:true, addons:addons.map(a=>({ ...a, deposit_cents:serviceDepositCents(a.price,dp) })) });
    }

    if(action==='release_hold'){
      if(!body.hold_token) return res.json({ ok:false, error:'hold_token_required' });
      const h=await getHold(tenant.id,body.hold_token);
      if(h && h.status==='active') await releaseHold(tenant.id,body.hold_token,'released');
      return res.json({ ok:true, released:!!(h && h.status==='active') });
    }

    if(action==='waitlist_add'){
      // All channels (voice via booking-brain, widget, dashboard, public web)
      // land here. Public callers identify by phone/name; dashboard passes
      // client_id. Service resolves by id or best-effort name.
      let clientId=body.client_id||null;
      if(!clientId && (body.client_phone||body.client_name)){
        const client=isPublic
          ? await publicClient(tenant.id,{phone:body.client_phone,name:body.client_name,email:body.client_email})
          : await upsertClient(tenant.id,{phone:body.client_phone,name:body.client_name,email:body.client_email});
        clientId=client?.id||null;
      }
      let serviceId=body.service_id||null, serviceName=body.service||body.service_name||null;
      if(!serviceId && serviceName){
        const services=await listServices(tenant.id);
        const match=services.find(s=>s.name?.toLowerCase()===serviceName.toLowerCase());
        if(match) serviceId=match.id;
      }
      const consent=body.sms_consent===true||body.sms_consent==='true';
      const entry=await addToWaitlist({
        tenantId:tenant.id, clientId,
        clientName:body.client_name||null, clientPhone:body.client_phone||null,
        serviceId, serviceName,
        staffId:body.staff_id||null,
        preferredDate:body.preferred_date||body.date||null,
        preferredTime:body.preferred_time||body.time||null,
        notes:body.notes||null,
        source:body.channel||body.source||'public_web',
        smsConsent:consent
      });
      return res.json({ ok:true, waitlisted:true, sms_consent:consent, entry });
    }

    if(action==='waitlist_list'){
      const entries=await listWaitlist(tenant.id,{ status:body.status||'active', limit:Number(body.limit||100) });
      return res.json({ ok:true, entries });
    }

    if(action==='waitlist_remove'){
      if(!body.id) return res.status(400).json({ ok:false, error:'id_required' });
      const removed=await removeFromWaitlist(tenant.id, body.id, body.status||'removed');
      return res.json({ ok:!!removed, removed });
    }

    if(action==='availability'){
      const resolved=body.service_id
        ? { ok:true,service:{id:body.service_id},staff:body.staff_id?{id:body.staff_id}:null }
        : await resolveBookingRequest(tenant.id,{service:body.service,stylist:body.stylist||body.staff});
      if(!resolved.ok) return res.status(200).json({ ok:false,needs:resolved.needs,details:resolved });
      if(isPublic){
        // One row per time (the best-packing stylist for "anyone"), deduped
        // BEFORE the limit, so a busy morning can't push the evening off the list.
        const tz=rules.timezone;
        const raw=body.date||body.starts_at||new Date().toISOString();
        const dateKey=/^\d{4}-\d{2}-\d{2}$/.test(String(raw))?String(raw):(Number.isNaN(new Date(raw).getTime())?null:localDateKey(new Date(raw),tz));
        if(!dateKey) return res.json({ ok:false, error:'invalid_date', slots:[] });
        const staffId=body.staff_id||resolved.staff?.id||null;
        const limit=Math.min(300,Math.max(1,Number(body.limit)||200));
        let slots=[], error=null;
        if(staffId){
          const out=await getAvailability({ tenantId:tenant.id, serviceId:resolved.service.id, date:dateKey, staffId, limit:2000 });
          if(out.ok===false) error=out.error; slots=out.slots||[];
        } else {
          const r=await rankDay({ tenantId:tenant.id, serviceId:resolved.service.id, date:dateKey });
          if(!r.ok) error=r.error; slots=(r.slots||[]).slice().sort((a,b)=>new Date(a.starts_at)-new Date(b.starts_at));
        }
        // The limit counts distinct TIMES, never stylist rows.
        const seen=new Set();
        const best=slots.filter(x=>{ const k=new Date(x.starts_at).toISOString(); if(seen.has(k)) return false; seen.add(k); return true; }).slice(0,limit);
        const onePerTime=staffId || body.one_per_time===true || ['1','true'].includes(String(body.one_per_time||''));
        if(onePerTime || error) slots=best;
        else {
          // Older embeds expect every free stylist per time: the best-packing
          // stylist first, then the others, for the same (limited) set of times.
          const keep=new Map(best.map(x=>[new Date(x.starts_at).toISOString(),x.staff_id]));
          const all=await getAvailability({ tenantId:tenant.id, serviceId:resolved.service.id, date:dateKey, limit:5000 });
          slots=(all.slots||[]).filter(x=>keep.has(new Date(x.starts_at).toISOString()))
            .sort((a,b)=>new Date(a.starts_at)-new Date(b.starts_at) || Number(keep.get(new Date(b.starts_at).toISOString())===b.staff_id)-Number(keep.get(new Date(a.starts_at).toISOString())===a.staff_id));
        }
        let next_open=null;
        if(!error && !slots.length){
          // Full day → the next days that DO have room (up to two weeks out).
          try{
            const nx=await findSmartSlots({ tenantId:tenant.id, serviceId:resolved.service.id, date:addDaysKey(dateKey,1), staffId, days:13, n:3, tz });
            if(nx.ok && nx.date) next_open={ date:nx.date, times:(nx.offers||[]).map(o=>o.starts_at) };
          }catch(e){ console.warn('[calendar] next open:',e.message); }
        }
        // Public: slots only — not the salon's internal settings.
        return res.json({ ok:!error, error:error||undefined, time_zone:tz, date:dateKey, next_open,
          slots:slots.map(x=>({ staff_id:x.staff_id, staff_name:x.staff_name, service_id:x.service_id, starts_at:x.starts_at, ends_at:x.ends_at, duration_minutes:x.duration_minutes, price:x.price, date:x.date })) });
      }
      const out=await getAvailability({
        tenantId:tenant.id,serviceId:resolved.service.id,date:body.date||body.starts_at||new Date().toISOString(),
        staffId:body.staff_id || resolved.staff?.id || null,limit:Number(body.limit||12)
      });
      return res.json(out);
    }

    if(action==='hold'){
      let clientId=body.client_id||null;
      let requester=null;
      if(isPublic){
        // Anyone could hold a whole day: one device (and one phone, when given)
        // keeps at most 2 live holds of at most 5 minutes. The visitor picks a
        // time before typing their mobile, so the hold itself doesn't need one.
        if(body.client_phone && !validPhone(body.client_phone)) delete body.client_phone;
        requester=holdRequesterKey(req);
        const byDevice=await activeHoldsFor(tenant.id,{requester});
        if(byDevice.length>=PUBLIC_MAX_ACTIVE_HOLDS) return res.status(429).json({ok:false,error:'too_many_holds',message:'You already have times on hold — finish booking one or let it expire.'});
      }
      if(!clientId && (body.client_phone||body.client_name)){
        const client=isPublic
          ? (body.client_phone ? await publicClient(tenant.id,{phone:body.client_phone,name:body.client_name,email:body.client_email}) : null)
          : await upsertClient(tenant.id,{phone:body.client_phone,name:body.client_name,email:body.client_email});
        clientId=client?.id||null;
      }
      let resolved=body.service_id && body.staff_id
        ? {ok:true,service:{id:body.service_id},staff:{id:body.staff_id}}
        : await resolveBookingRequest(tenant.id,{service:body.service,stylist:body.stylist||body.staff});
      if(body.service_id && !body.staff_id && body.starts_at){
        if(isPublic && !rules.allow_any_staff) return res.status(200).json({ok:false,needs:'staff',error:'staff_required'});
        const sid=await staffFreeAt(tenant.id,body.service_id,body.starts_at,clientId);
        if(!sid) return res.status(200).json({ok:false,conflict:true,error:'slot_unavailable'});
        resolved={ok:true,service:{id:body.service_id},staff:{id:sid}};
      }
      if(!resolved.ok || !resolved.staff?.id) return res.status(200).json({ok:false,needs:resolved.needs||'staff'});
      if(isPublic && clientId){
        // Same phone, new time (the visitor changed their mind): the oldest of
        // their live holds is let go so they never sit on more than 2.
        const byPhone=await activeHoldsFor(tenant.id,{clientId});
        for(const h of byPhone.slice(0,Math.max(0,byPhone.length-(PUBLIC_MAX_ACTIVE_HOLDS-1)))) await releaseHold(tenant.id,h.hold_token,'released').catch(()=>{});
      }
      const held=await holdAvailability({
        tenantId:tenant.id,clientId,serviceId:resolved.service.id,staffId:resolved.staff.id,
        startsAt:body.starts_at,channel:body.channel||'dashboard',conversationId:body.conversation_id||null,
        ttlSeconds:Number(body.ttl_seconds||300),requester
      });
      if(isPublic){
        // The visitor gets the time for 5 minutes while they finish — and only
        // the hold token/time/stylist back, never internal rows.
        if(!held.ok) return res.status(200).json({ok:false,conflict:!!held.conflict,error:held.error||'slot_unavailable'});
        noteHold(requester,held.hold);
        return res.json({ok:true,hold:publicHold(held.hold,held.slot)});
      }
      return res.json(held);
    }

    if(action==='book'){
      const tz=rules?.timezone || (await getBookingSettings(tenant.id).catch(()=>null))?.timezone || 'America/New_York';
      if(isPublic){
        if(!validPhone(body.client_phone)) return res.status(200).json({ok:false,error:'phone_invalid',message:'Please enter a valid mobile number (with country code if outside the US).'});
        if(!String(body.client_name||'').trim()) return res.status(200).json({ok:false,error:'name_required',message:'Please add your name.'});
        if(rules.require_email && !validEmail(body.client_email)) return res.status(200).json({ok:false,error:'email_required',message:'Please add your email — this salon asks for it to book online.'});
      }
      let clientId=body.client_id||null, client=null;
      if(!clientId){
        // Public visitors never overwrite an existing client's name/email.
        client=isPublic
          ? await publicClient(tenant.id,{phone:body.client_phone,name:body.client_name,email:body.client_email})
          : await upsertClient(tenant.id,{phone:body.client_phone,name:body.client_name,email:body.client_email});
        clientId=client?.id||null;
      }
      if(!clientId) return res.status(200).json({ok:false,needs:'client'});
      if(isPublic && client) await saveConsent(tenant.id,client,{consent:body.sms_consent,version:body.consent_text_version});

      const ids=serviceIdList(body);
      let serviceId=ids[0]||null, staffId=body.staff_id||null;
      let hold=null;
      if(body.hold_token){
        hold=await getHold(tenant.id,body.hold_token);
        if(!hold || hold.status!=='active' || new Date(hold.expires_at)<=new Date()) return res.status(200).json({ok:false,conflict:true,error:'hold_expired'});
        if((serviceId && hold.service_id!==serviceId) || (staffId && hold.staff_id!==staffId)) return res.status(200).json({ok:false,error:'hold_mismatch'});
        serviceId=hold.service_id; staffId=hold.staff_id;
      }
      if(serviceId && !staffId && body.starts_at){
        if(isPublic && !rules.allow_any_staff) return res.status(200).json({ok:false,needs:'staff',error:'staff_required'});
        // "Any available": the stylist this time packs best (usual stylist first).
        staffId=await staffFreeAt(tenant.id,serviceId,body.starts_at,clientId);
        if(!staffId) return res.status(200).json({ok:false,conflict:true,error:'slot_unavailable'});
      }
      if(!serviceId || !staffId){
        const resolved=await resolveBookingRequest(tenant.id,{service:body.service,stylist:body.stylist||body.staff});
        if(!resolved.ok || !resolved.staff?.id) return res.status(200).json({ok:false,needs:resolved.needs||'staff'});
        serviceId=resolved.service.id; staffId=resolved.staff.id;
      }
      let ownHold=false;
      if(!hold){
        const held=await holdAvailability({tenantId:tenant.id,clientId,serviceId,staffId,startsAt:body.starts_at,channel:body.channel||'dashboard',conversationId:body.conversation_id||null,ttlSeconds:120});
        if(!held.ok) return res.status(200).json(isPublic?{ok:false,conflict:!!held.conflict,error:held.error||'slot_unavailable'}:held);
        hold=held.hold; ownHold=true;
      }

      const services=await listServices(tenant.id);
      const service=services.find(x=>x.id===serviceId);
      const start=hold.starts_at;
      const end=hold.ends_at || addMinutes(start,service?.duration_minutes||60);
      // Add-ons (service_ids[1..]): same stylist, back to back, each checked
      // against the stylist's real day AND held atomically before anything is written.
      const extras=ids.slice(1).map(id=>services.find(x=>x.id===id)).filter(Boolean);
      const segs=[]; const segHolds=[]; let cursor=end;
      const letGo=async()=>{ for(const h of segHolds) await releaseHold(tenant.id,h.hold_token,'released').catch(()=>{}); if(ownHold) await releaseHold(tenant.id,hold.hold_token,'released').catch(()=>{}); };
      for(const ad of extras){
        const fit=await fitsBackToBack({tenantId:tenant.id,service:ad,staffId,startIso:cursor});
        const sh=fit ? await createHoldAtomic({tenantId:tenant.id,clientId,staffId,serviceId:ad.id,startsAt:fit.starts_at,endsAt:fit.ends_at,channel:body.channel||'dashboard',ttlSeconds:120,seenBookingIds:[]}) : null;
        if(!fit || !sh?.ok){
          await letGo();
          return res.status(200).json({ok:false,conflict:true,error:'addon_unavailable',service_name:ad.name});
        }
        segHolds.push(sh.hold);
        segs.push({service:ad,...fit}); cursor=fit.ends_at;
      }
      const mainPrice=isPublic ? (service?.price ?? 0) : (body.total_amount ?? service?.price ?? 0);
      const grandTotal=Number(mainPrice||0)+segs.reduce((a,x)=>a+Number(x.service.price||0),0);
      const multi=segs.length ? ((await hasBookingServices()) ? 'one' : 'split') : null;
      const source=body.channel||body.source||'dashboard';
      // Claim the hold FIRST (active → converted, conditional), then write: a
      // retried / double-submitted request can never turn one hold into two bookings.
      const made=await bookFromHold(tenant.id,hold,{
        clientId,serviceId,staffId,locationId:body.location_id||null,
        startTime:start,endTime:multi==='one'?cursor:end,status:'confirmed',totalAmount:multi==='one'?grandTotal:mainPrice,
        notes:body.notes||null,source,conversationId:body.conversation_id||null,
        // Public: the confirmation text and deposit request are sent below,
        // awaited, so the page can say truthfully what happened (and never
        // request a deposit twice).
        sendConfirmation:!isPublic
      });
      if(!made.ok){
        for(const h of segHolds) await releaseHold(tenant.id,h.hold_token,'released').catch(()=>{});
        return res.status(200).json({ok:false,conflict:true,error:made.error||'hold_expired'});
      }
      const booking=made.booking;
      const extraBookings=[];
      if(multi==='one'){
        const rows=[service,...segs.map(x=>x.service)].map((sv,i)=>({ booking_id:booking.id, service_id:sv?.id||null, staff_id:staffId, sequence_no:i+1,
          active_duration_1_min:Number(sv?.duration_minutes||60), price:Number(sv?.price||0) }));
        const { error:bsErr }=await db().from('booking_services').insert(rows);
        if(bsErr) console.warn('[calendar] booking_services:',bsErr.message||bsErr);
        for(const h of segHolds) await releaseHold(tenant.id,h.hold_token,'converted').catch(()=>{});
      } else if(multi==='split'){
        for(const [i,sg] of segs.entries()){
          const r=await bookFromHold(tenant.id,segHolds[i],{ clientId,serviceId:sg.service.id,staffId,startTime:sg.starts_at,endTime:sg.ends_at,
            status:'confirmed',totalAmount:sg.service.price||0,notes:`Add-on (with ${booking.confirmation_code||'main booking'})`,source,sendConfirmation:false });
          if(r.ok) extraBookings.push(r.booking);
        }
      }
      // The salon's own booking platform (Square/Boulevard/Zapier…): a durable
      // outbox row, committed right after this reply and retried by cron —
      // same write-through Lola's voice bookings use.
      let upstream='local_only', externalRef=null;
      for(const b of [booking,...extraBookings]){
        try{
          const sv=services.find(x=>x.id===b.service_id);
          const ctx={
            client:{ id:clientId, name:body.client_name||null, phone:body.client_phone||null, email:body.client_email||null },
            service:{ id:b.service_id||null, name:sv?.name||null }, staff:{ id:staffId },
            startsAt:b.start_time, endsAt:b.end_time, durationMin:Math.round((new Date(b.end_time)-new Date(b.start_time))/60e3),
            price:b.total_amount??0, timezone:tz, notes:body.notes||(isPublic?'Booked online (LolaDesk booking page)':'Booked from the LolaDesk calendar')
          };
          if(isPublic){
            const q=await writeThrough(db(),{ tenantId:tenant.id, booking:b, ctx });
            if(q?.ok) upstream='queued';
          } else {
            // Dashboard: same durable outbox, but wait briefly (≈4s) so the
            // owner sees the upstream result when the platform answers in time;
            // otherwise the commit keeps running after the reply (and the cron retries).
            const q=await enqueueUpstream(db(),{ tenantId:tenant.id, bookingId:b.id, ctx });
            if(q?.ok){
              upstream='queued';
              const run=processOutbox(db(),{ bookingId:b.id });
              afterResponse(run);
              const out=await Promise.race([run.catch(()=>null), new Promise(r=>setTimeout(()=>r(null),4000))]);
              const done=(out?.results||[]).find(x=>x.done);
              if(done){
                upstream='committed';
                if(b.id===booking.id && done.external?.provider && done.external?.id){
                  externalRef=done.external;
                  booking.external_id=done.external.id; booking.external_provider=done.external.provider;
                }
              } else if((out?.results||[]).some(x=>x.failed)) upstream='failed';
              else if((out?.results||[]).some(x=>x.skipped)) upstream='local_only';
            }
          }
        }catch(e){ console.warn('[calendar] outbox:',String(e?.message||e).slice(0,160)); }
      }
      if(!isPublic) return res.json({ok:true,status:'confirmed',booking_id:booking.id,booking,bookings:extraBookings.length?[booking,...extraBookings]:undefined,external:externalRef,upstream});

      let texted=false, payment_link=null, deposit=null;
      try{ const t=await sendConfirmationSMS({tenantId:tenant.id,clientId,serviceId,startTime:start,confirmationCode:booking.confirmation_code}); texted=!!t?.sent; }
      catch(e){ console.warn('[calendar] confirm text:',e.message); }
      try{
        const { data:pending }=await db().from('deposits').select('id').eq('tenant_id',tenant.id).eq('booking_id',booking.id).eq('status','pending').limit(1);
        if(!(pending||[]).length){
          const d=await requestDeposit({ tenantId:tenant.id, booking:{ ...booking, total_amount:grandTotal } });
          if(d?.ok && !d.skipped && d.amount_cents){ deposit={ amount_cents:d.amount_cents }; payment_link=d.link_url||null; }
        }
      }catch(e){ console.warn('[calendar] deposit:',e.message); }
      const staffRow=(await listStaff(tenant.id).catch(()=>[])).find(x=>x.id===staffId);
      const phoneForLink=client?.phone||body.client_phone||'';
      return res.json({ ok:true, status:'confirmed', booking_id:booking.id,
        booking:{ ...booking, staff_name:staffRow?.name||null, service_name:service?.name||null },
        services:[service,...segs.map(x=>x.service)].filter(Boolean).map(x=>({ id:x.id, name:x.name, price:x.price, duration_minutes:x.duration_minutes })),
        add_on_bookings:extraBookings.map(b=>({ confirmation_code:b.confirmation_code, start_time:b.start_time, service_id:b.service_id })),
        total_amount:grandTotal, texted, payment_link, deposit, upstream,
        calendar_path:booking.confirmation_code?`/api/calendar.ics?code=${encodeURIComponent(booking.confirmation_code)}&phone=${encodeURIComponent(phoneForLink)}`:null });
    }

    if(action==='lookup'){
      // Public self-service: confirmation code + phone → the client's own
      // booking (never by booking_id, which would leak other people's rows).
      const code=String(body.code||'').trim().toUpperCase();
      const phone=String(body.client_phone||'').trim();
      if(!code || !phone) return res.status(200).json({ok:false,error:'code_and_phone_required'});
      const c=db();
      const { data: booking }=await c.from('bookings').select('*')
        .eq('tenant_id',tenant.id).eq('confirmation_code',code).maybeSingle();
      if(!booking) return res.status(200).json({ok:false,error:'code_not_found'});
      const { data: client }=await c.from('clients').select('phone').eq('id',booking.client_id).maybeSingle();
      if(!client || normPhone(client.phone)!==normPhone(phone)){
        return res.status(200).json({ok:false,error:'code_phone_mismatch'});
      }
      const [services,staff]=await Promise.all([listServices(tenant.id),listStaff(tenant.id)]);
      const enriched=await enrichBookings(tenant.id,[booking],services,staff);
      const b=enriched[0]||booking;
      const win=policyWindow(b.start_time,rules);
      return res.json({ ok:true, booking:{
        confirmation_code:b.confirmation_code,
        start_time:b.start_time, end_time:b.end_time, status:b.status,
        service:b.service ? { id:b.service.id, name:b.service.name, price:b.service.price, duration_minutes:b.service.duration_minutes } : null,
        staff:b.staff ? { id:b.staff.id, name:b.staff.name } : null
      }, policy:{ cancellation_window_hours:win.hours, can_change_online:!win.inside, salon_phone:tenant.phone_number||null } });
    }

    if(action==='reschedule'){
      // Public self-service: code + phone + new time (never booking_id).
      if(req.__publicBooking){
        const code=String(body.code||'').trim().toUpperCase();
        const phone=String(body.client_phone||'').trim();
        const startsAt=body.starts_at;
        if(!code || !phone || !startsAt) return res.status(200).json({ok:false,error:'code_phone_and_starts_at_required'});
        const c=db();
        const { data: current }=await c.from('bookings').select('*')
          .eq('tenant_id',tenant.id).eq('confirmation_code',code).maybeSingle();
        if(!current) return res.status(200).json({ok:false,error:'code_not_found'});
        if(current.status!=='confirmed') return res.status(200).json({ok:false,error:'not_reschedulable'});
        if(new Date(current.start_time)<=new Date()) return res.status(200).json({ok:false,error:'appointment_passed'});
        const { data: client }=await c.from('clients').select('phone').eq('id',current.client_id).maybeSingle();
        if(!client || normPhone(client.phone)!==normPhone(phone)){
          return res.status(200).json({ok:false,error:'code_phone_mismatch'});
        }
        // Inside the salon's cancellation window → call the salon instead.
        const win=policyWindow(current.start_time,rules);
        if(win.inside) return res.status(200).json({ok:false,error:'within_policy_window',code:'within_policy_window',window_hours:win.hours,salon_phone:tenant.phone_number||null});
        if(new Date(startsAt)<=new Date()) return res.status(200).json({ok:false,error:'time_in_past'});
        // Keep the current stylist unless the client picked another (and the salon lets them).
        const newStaff=(rules.allow_staff_choice && body.staff_id) ? body.staff_id : current.staff_id;
        // The booking keeps its real length; the extra time is checked by the engine.
        const held=await holdAvailability({tenantId:tenant.id,clientId:current.client_id,serviceId:current.service_id,staffId:newStaff,startsAt,channel:'public_widget',ttlSeconds:120,excludeBookingId:current.id,minDurationMin:lengthMin(current)});
        if(!held.ok) return res.status(200).json({ok:false,conflict:!!held.conflict,error:held.error||'slot_unavailable'});
      const updated=await updateCanonicalBooking(tenant.id,current.id,{staff_id:newStaff,start_time:held.slot.starts_at,end_time:held.slot.ends_at,status:'confirmed'},{source:'public_widget',reason:'client_self_service_reschedule'});
      await releaseHold(tenant.id,held.hold.hold_token,'converted');
      if(updated) zapLater(tenant,current.id,'booking.rescheduled');
      let publicOffer=null;
      if(updated){
        try{ publicOffer=await offerFreedSlot({tenantId:tenant.id,serviceId:current.service_id||null,serviceName:current.service||current.service_name||null,freedAt:current.start_time||current.starts_at}); }
        catch(e){ console.warn('[calendar] waitlist offer failed:',e.message); }
      }
      return res.json({ok:!!updated,rescheduled:!!updated,booking:updated,waitlist_offer:publicOffer});
    }
    if(!body.booking_id || !body.starts_at) return res.status(400).json({ok:false,error:'booking_id_and_starts_at_required'});
    const c=db();
    const { data: current }=await c.from('bookings').select('*').eq('tenant_id',tenant.id).eq('id',body.booking_id).maybeSingle();
    if(!current) return res.status(404).json({ok:false,error:'booking_not_found'});
    // Scoped series reschedule: series_scope 'following' moves this + every
    // later occurrence by the same delta (cadence preserved between them);
    // 'this' (default) moves only this occurrence. ALL occurrences are
    // validated BEFORE anything is written — the target through the full
    // availability engine (atomic hold), every later one for stylist overlap
    // and blocked time in the SALON's timezone (salon.js rules) — against
    // everything except the moving set (they shift together). Any collision →
    // 409 {conflict, moved_count:0, failed_at_occurrence} and nothing moved.
    const seriesScope=String(body.series_scope||'this').toLowerCase();
    const newStaffId=body.staff_id||current.staff_id;
    const held=await holdAvailability({tenantId:tenant.id,clientId:current.client_id,serviceId:current.service_id,staffId:newStaffId,startsAt:body.starts_at,channel:body.channel||'dashboard',ttlSeconds:120,excludeBookingId:current.id,minDurationMin:lengthMin(current)});
    if(!held.ok){
      if(seriesScope==='following'&&current.series_id){
        return res.status(409).json({ok:false,conflict:true,moved_count:0,failed_at_occurrence:current.series_pos||1,
          error:'The new time for occurrence '+(current.series_pos||1)+' collides — nothing was moved.'});
      }
      return res.status(200).json(held);
    }
    const plan=[];   // later occurrences: { occ, start, end }
    if(seriesScope==='following'&&current.series_id){
      const { data: later, error: laterErr }=await c.from('bookings').select('id,start_time,end_time,staff_id,series_pos,status')
        .eq('series_id',current.series_id).eq('tenant_id',tenant.id).neq('status','cancelled')
        .gt('start_time',current.start_time).order('start_time');
      if(laterErr){ await releaseHold(tenant.id,held.hold.hold_token,'released'); return res.status(500).json({ok:false,error:'series_read_failed',detail:laterErr.message||JSON.stringify(laterErr)}); }
      const moving=new Set([current.id,...(later||[]).map(o=>o.id)]);
      const delta=new Date(held.slot.starts_at).getTime()-new Date(current.start_time).getTime();
      const tz=(await getBookingSettings(tenant.id).catch(()=>null))?.timezone||'America/New_York';
      for(const occ of (later||[])){
        const st=new Date(new Date(occ.start_time).getTime()+delta).toISOString();
        const en=new Date(new Date(occ.end_time).getTime()+delta).toISOString();
        const staffId=occ.staff_id===current.staff_id ? newStaffId : occ.staff_id;
        if(staffId){
          const { data: cf }=await c.from('bookings').select('id,status').eq('tenant_id',tenant.id).eq('staff_id',staffId)
            .neq('status','cancelled').lt('start_time',en).gt('end_time',st);
          const clash=(cf||[]).some(x=>!moving.has(x.id) && !/^(cancel|no[-_ ]?show)/i.test(String(x.status||'')));
          const { data: hl }=await c.from('availability_holds').select('id,expires_at').eq('tenant_id',tenant.id).eq('staff_id',staffId).eq('status','active')
            .lt('starts_at',en).gt('ends_at',st);
          const holdClash=(hl||[]).some(h=>h.id!==held.hold.id && new Date(h.expires_at)>new Date());
          if(clash||holdClash){
            await releaseHold(tenant.id,held.hold.hold_token,'released');
            return res.status(409).json({ok:false,conflict:true,moved_count:0,failed_at_occurrence:occ.series_pos||null,
              error:'Occurrence '+localDateKey(new Date(st),tz)+' is already booked — nothing was moved.'});
          }
          const blocked=await blockedHitTz(c,tenant.id,staffId,st,en,tz);
          if(blocked){
            await releaseHold(tenant.id,held.hold.hold_token,'released');
            return res.status(409).json({ok:false,conflict:true,moved_count:0,failed_at_occurrence:occ.series_pos||null,
              error:'Occurrence '+blocked+' falls in blocked time — nothing was moved.'});
          }
        }
        plan.push({occ,start:st,end:en,staffId});
      }
    }
    // Everything fits → write: target first, then each later occurrence (one
    // "Rescheduled" text for the target; occurrences move quietly).
    const updated=await updateCanonicalBooking(tenant.id,current.id,{staff_id:newStaffId,start_time:held.slot.starts_at,end_time:held.slot.ends_at,status:'confirmed'},{source:body.channel||'dashboard',reason:'rescheduled'});
    await releaseHold(tenant.id,held.hold.hold_token,'converted');
    if(updated) zapLater(tenant,current.id,'booking.rescheduled');
    let seriesMoved=0;
    for(const p of plan){
      const u=await updateCanonicalBooking(tenant.id,p.occ.id,{start_time:p.start,end_time:p.end,...(p.staffId&&p.staffId!==p.occ.staff_id?{staff_id:p.staffId}:{})},{source:body.channel||'dashboard',reason:'series_rescheduled',sendReschedule:false});
      if(u){ seriesMoved++; zapLater(tenant,p.occ.id,'booking.rescheduled'); }
    }
    let dashOffer=null;
    if(updated){
      try{ dashOffer=await offerFreedSlot({tenantId:tenant.id,serviceId:current.service_id||null,serviceName:current.service||current.service_name||null,freedAt:current.start_time||current.starts_at}); }
      catch(e){ console.warn('[calendar] waitlist offer failed:',e.message); }
    }
    return res.json({ok:true,rescheduled:true,booking:updated,series_moved:seriesMoved,waitlist_offer:dashOffer});
  }

    if(action==='cancel'){
      // Public self-cancel: confirmation code + phone (never booking_id, which
      // would let anyone cancel by guessing a UUID). The code alone can't
      // cancel — the client's phone must match the booking.
      if(req.__publicBooking){
        const code=String(body.code||'').trim().toUpperCase();
        const phone=String(body.client_phone||'').trim();
        if(!code || !phone) return res.status(200).json({ok:false,error:'code_and_phone_required'});
        const c=db();
        const { data: booking }=await c.from('bookings').select('*')
          .eq('tenant_id',tenant.id).eq('confirmation_code',code).maybeSingle();
        if(!booking) return res.status(200).json({ok:false,error:'code_not_found'});
        if(booking.status!=='confirmed') return res.status(200).json({ok:false,error:'not_cancellable'});
        if(new Date(booking.start_time)<=new Date()) return res.status(200).json({ok:false,error:'appointment_passed'});
        const { data: client }=await c.from('clients').select('phone').eq('id',booking.client_id).maybeSingle();
        if(!client || normPhone(client.phone)!==normPhone(phone)){
          return res.status(200).json({ok:false,error:'code_phone_mismatch'});
        }
        const win=policyWindow(booking.start_time,rules);
        if(win.inside) return res.status(200).json({ok:false,error:'within_policy_window',code:'within_policy_window',window_hours:win.hours,salon_phone:tenant.phone_number||null});
        const updated=await updateCanonicalBooking(tenant.id,booking.id,{status:'cancelled'},{source:'public_widget',reason:'client_self_service'});
        if(updated) zapLater(tenant,booking.id,'booking.cancelled');
        let publicOffer=null;
        if(updated){
          try{ publicOffer=await offerFreedSlot({tenantId:tenant.id,serviceId:booking.service_id||null,serviceName:booking.service||booking.service_name||null,freedAt:booking.start_time||booking.starts_at}); }
          catch(e){ console.warn('[calendar] waitlist offer failed:',e.message); }
        }
        return res.json({ok:!!updated,cancelled:!!updated,booking:updated,waitlist_offer:publicOffer});
      }
      if(!body.booking_id) return res.status(400).json({ok:false,error:'booking_id_required'});
      // Scoped series cancel: series_scope 'this' (default) | 'following' | 'all'.
      // 'this' keeps the single-booking path below (waitlist fires for the one
      // freed slot); 'following'/'all' cancel every affected occurrence, then
      // run ONE waitlist pass for the earliest freed slot.
      const seriesScope=String(body.series_scope||'this').toLowerCase();
      if(seriesScope!=='this'){
        const c=db();
        const { data: target }=await c.from('bookings').select('id,series_id,start_time')
          .eq('tenant_id',tenant.id).eq('id',body.booking_id).maybeSingle();
        if(!target) return res.status(404).json({ok:false,error:'booking_not_found'});
        if(!target.series_id) return res.status(400).json({ok:false,error:'not_a_series'});
        let sq=c.from('bookings').select('id,start_time,service_id,client_id')
          .eq('series_id',target.series_id).eq('tenant_id',tenant.id);
        if(seriesScope==='following') sq=sq.gte('start_time',target.start_time);
        const { data: affected, error: seriesErr }=await sq.neq('status','cancelled');
        if(seriesErr) return res.status(500).json({ok:false,error:'series_cancel_failed',detail:seriesErr.message||JSON.stringify(seriesErr)});
        let lastUpdated=null;
        for(const occ of (affected||[])){
          const u=await updateCanonicalBooking(tenant.id,occ.id,{status:'cancelled'},{source:body.channel||'dashboard',reason:body.reason||'client_request',sendCancellation:false});
          if(u){ lastUpdated=u; zapLater(tenant,occ.id,'booking.cancelled'); }
        }
        // Exactly ONE cancellation text for the whole series (same contract as
        // series creation's one confirmation): the earliest affected occurrence
        // represents it; per-occurrence texts are suppressed via sendCancellation:false.
        const firstOcc=(affected||[]).slice().sort((a,b)=>new Date(a.start_time)-new Date(b.start_time))[0];
        if(firstOcc && firstOcc.client_id){
          try{
            await sendConfirmationSMS({tenantId:tenant.id,clientId:firstOcc.client_id,serviceId:firstOcc.service_id,startTime:firstOcc.start_time,verb:'Cancelled'});
          }catch(e){ /* a failed cancel text must never fail the cancellation */ }
        }
        let waitlist_matches={count:0,entries:[]};
        let waitlist_offer=null;
        if(lastUpdated){
          try{
            waitlist_matches=await findWaitlistMatches(tenant.id,{serviceId:lastUpdated.service_id||null,serviceName:lastUpdated.service||lastUpdated.service_name||null});
            waitlist_offer=await offerFreedSlot({tenantId:tenant.id,serviceId:lastUpdated.service_id||null,serviceName:lastUpdated.service||lastUpdated.service_name||null,freedAt:lastUpdated.start_time||lastUpdated.starts_at});
          }catch(e){ console.warn('[calendar] waitlist match failed:',e.message); }
        }
        return res.json({ok:true,cancelled:true,cancelled_count:(affected||[]).length,scope:seriesScope,booking:lastUpdated,waitlist_matches,waitlist_offer});
      }
      const updated=await updateCanonicalBooking(tenant.id,body.booking_id,{status:'cancelled'},{source:body.channel||'dashboard',reason:body.reason||'client_request'});
      if(updated) zapLater(tenant,updated.id||body.booking_id,'booking.cancelled');
      let waitlist_matches={count:0,entries:[]};
      let waitlist_offer=null;
      if(updated){
        try{
          let freedName=updated.service||updated.service_name||null;
          if(!freedName && updated.service_id){
            const services=await listServices(tenant.id);
            freedName=services.find(s=>s.id===updated.service_id)?.name||null;
          }
          waitlist_matches=await findWaitlistMatches(tenant.id,{
            serviceId:updated.service_id||null,
            serviceName:freedName
          });
          waitlist_offer=await offerFreedSlot({tenantId:tenant.id,serviceId:updated.service_id||null,serviceName:freedName,freedAt:updated.start_time||updated.starts_at});
        }catch(e){ console.warn('[calendar] waitlist match failed:',e.message); }
      }
      return res.json({ok:!!updated,cancelled:!!updated,booking:updated,waitlist_matches,waitlist_offer});
    }

    return res.status(400).json({ok:false,error:'unknown_action'});
  }catch(e){
    console.error('[calendar]',e);
    return res.status(500).json({ok:false,error:'calendar_error',detail:String(e?.message||e)});
  }
}

// Attach service / staff / client objects to raw booking rows so the calendar
// UI renders real names instead of "Appointment"/"Client" fallbacks.
async function enrichBookings(tenantId, bookings, services, staff){
  if(!Array.isArray(bookings) || !bookings.length) return bookings || [];
  const clientIds=[...new Set(bookings.map(b=>b.client_id).filter(Boolean))];
  let clients=[];
  if(clientIds.length){
    const c=db();
    const { data }=await c.from('clients').select('id,first_name,last_name,name,phone,email,is_vip,profile_picture_url').in('id',clientIds);
    clients=data||[];
  }
  return bookings.map(b=>({
    ...b,
    service:(services||[]).find(s=>s.id===b.service_id)||null,
    staff:(staff||[]).find(s=>s.id===b.staff_id)||null,
    client:clients.find(cl=>cl.id===b.client_id)||null
  }));
}
