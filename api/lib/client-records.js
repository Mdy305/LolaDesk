import { randomUUID } from 'node:crypto';
import { db } from './db.js';

function text(value,max=500){ return String(value??'').trim().slice(0,max); }
export function normalizePhone(value){
  const raw=text(value,40); if(!raw) return '';
  const digits=raw.replace(/\D/g,'');
  if(digits.length===10) return '+1'+digits;
  if(digits.length===11&&digits[0]==='1') return '+'+digits;
  return raw.startsWith('+')?('+'+digits):digits;
}
function splitName(value){
  const parts=text(value,180).split(/\s+/).filter(Boolean);
  return {first_name:parts.shift()||'',last_name:parts.join(' ')||null};
}
export function normalizeContact(input={}){
  const named=splitName(input.name||[input.first_name,input.last_name].filter(Boolean).join(' '));
  const first=text(input.first_name||named.first_name,100);
  if(!first) return null;
  return {
    first_name:first,
    last_name:text(input.last_name||named.last_name,100)||null,
    phone:normalizePhone(input.phone||input.phone_number)||null,
    email:text(input.email,180).toLowerCase()||null,
    preferred_service:text(input.preferred_service||input.service,160)||null,
    notes:text(input.notes,2000)||null,
    lifetime_value:Math.max(0,Number(input.lifetime_value||input.ltv||0)||0),
    last_visit:(()=>{ if(!input.last_visit) return null; const d=new Date(input.last_visit); return Number.isNaN(d.getTime())?null:d.toISOString(); })(),
    status:text(input.status,30).toLowerCase()||'active'
  };
}
export function parseContactText(raw=''){
  return String(raw).split(/\r?\n/).map(line=>line.trim()).filter(Boolean).map(line=>{
    const email=(line.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)||[])[0]||'';
    const phoneMatch=line.match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/);
    const phone=phoneMatch?.[0]||'';
    let name=line.replace(email,'').replace(phone,'').replace(/^[,;|\s]+|[,;|\s]+$/g,'').split(/[,;|]/)[0].trim();
    if(!name&&email) name=email.split('@')[0].replace(/[._-]+/g,' ');
    return {name,email,phone};
  }).filter(x=>x.name&&(x.email||x.phone));
}
export async function saveContacts(tenantId,inputs=[]){
  const c=db(); if(!c) throw new Error('Database not configured');
  const normalized=inputs.map(normalizeContact).filter(Boolean).slice(0,2000);
  if(!normalized.length) return {saved:0,created:0,updated:0,skipped:inputs.length,clients:[]};
  const {data:existing=[],error:readError}=await c.from('clients').select('id,phone,email').eq('tenant_id',tenantId);
  if(readError) throw readError;
  const byPhone=new Map(existing.filter(x=>x.phone).map(x=>[normalizePhone(x.phone),x.id]));
  const byEmail=new Map(existing.filter(x=>x.email).map(x=>[String(x.email).toLowerCase(),x.id]));
  let created=0,updated=0;
  const existingIds=new Set(existing.map(x=>x.id)), rowsById=new Map();
  for(const contact of normalized){
    const id=(contact.phone&&byPhone.get(contact.phone))||(contact.email&&byEmail.get(contact.email))||randomUUID();
    const wasKnown=existingIds.has(id)||rowsById.has(id);
    if(existingIds.has(id)) updated++; else if(!rowsById.has(id)) created++;
    if(contact.phone) byPhone.set(contact.phone,id);
    if(contact.email) byEmail.set(contact.email,id);
    rowsById.set(id,{...(rowsById.get(id)||{}),id,tenant_id:tenantId,...contact,updated_at:new Date().toISOString()});
  }
  const rows=[...rowsById.values()];
  const {data,error}=await c.from('clients').upsert(rows,{onConflict:'id'}).select('*');
  if(error) throw error;
  return {saved:(data||[]).length,created,updated,skipped:Math.max(0,inputs.length-normalized.length),clients:data||[]};
}
export async function signClientPhotos(rows=[]){
  const c=db(); if(!c) return rows;
  const paths=[...new Set(rows.map(x=>x.profile_picture_url).filter(Boolean))];
  if(!paths.length) return rows;
  const {data=[]}=await c.storage.from('client-photos').createSignedUrls(paths,3600);
  const urls=new Map(data.map((x,i)=>[paths[i],x.signedUrl||null]));
  return rows.map(x=>({...x,profile_picture_url:x.profile_picture_url?urls.get(x.profile_picture_url)||null:null}));
}
