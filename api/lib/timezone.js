export function localDateKey(value, timeZone='UTC'){
  const d=value instanceof Date?value:new Date(value);
  if(Number.isNaN(d.getTime())) throw new Error('invalid date');
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d);
  const get=t=>parts.find(x=>x.type===t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function localWeekday(value,timeZone='UTC'){
  const name=new Intl.DateTimeFormat('en-US',{timeZone,weekday:'short'}).format(value instanceof Date?value:new Date(value));
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(name);
}

function offsetAt(utcDate,timeZone){
  const parts=new Intl.DateTimeFormat('en-US',{
    timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'
  }).formatToParts(utcDate);
  const p=Object.fromEntries(parts.filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
  const asUtc=Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second);
  return asUtc-utcDate.getTime();
}

export function zonedLocalToUtc(dateKey,timeText,timeZone='UTC'){
  const [y,m,d]=dateKey.split('-').map(Number);
  const [hh,mm=0,ss=0]=String(timeText).split(':').map(Number);
  let guess=new Date(Date.UTC(y,m-1,d,hh,mm,ss));
  // Iterate because DST offset can differ around the target instant.
  for(let i=0;i<3;i++){
    const off=offsetAt(guess,timeZone);
    const next=new Date(Date.UTC(y,m-1,d,hh,mm,ss)-off);
    if(Math.abs(next.getTime()-guess.getTime())<1000) return next.toISOString();
    guess=next;
  }
  return guess.toISOString();
}

export function dayBoundsUtc(date,timeZone='UTC'){
  const key=/^\d{4}-\d{2}-\d{2}$/.test(String(date))?String(date):localDateKey(date,timeZone);
  const start=zonedLocalToUtc(key,'00:00:00',timeZone);
  const noon=new Date(zonedLocalToUtc(key,'12:00:00',timeZone));
  const tomorrow=new Date(noon.getTime()+24*3600000);
  const nextKey=localDateKey(tomorrow,timeZone);
  const end=zonedLocalToUtc(nextKey,'00:00:00',timeZone);
  return {key,start,end};
}

export function localTimeLabel(iso,timeZone='UTC'){
  return new Intl.DateTimeFormat('en-US',{timeZone,hour:'numeric',minute:'2-digit'}).format(new Date(iso));
}
