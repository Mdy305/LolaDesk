/* Tenant-safe facade for /api/data. Never exposes demo records after a configured DB query fails. */
import dataHandler from './data.js';

function empty(resource){
  const base={ tenant:'Your business', empty:true };
  const map={
    overview:{...base,kpis:{clients:0,calls30:0,bookings30:0,revenue30:0,revenue30Money:'$0',upsellRevenue:0,upsellRate:'0%'},usage:null},
    clients:{...base,clients:[]}, calls:{...base,calls:[]}, inbox:{...base,threads:[]}, bookings:{...base,bookings:[]},
    revenue:{...base,total:0,money:'$0',months:[],services:[],bookingCount:0}, team:{...base,team:[]},
    marketing:{...base,segments:[],roi:{campaignRuns30:0,campaignRevenue30:0}}, agents:{...base,agents:[],orchestrator:null},
    integrations:{...base,tenantSlug:null,providers:[]}
  };
  return map[resource]||map.overview;
}

export default async function handler(req,res){
  let resource='overview';
  try{resource=new URL(req.url,'http://x').searchParams.get('resource')||'overview';}catch{}
  let statusCode=200, payload=null, ended=false;
  const proxy={
    setHeader:(...args)=>res.setHeader(...args),
    status(code){statusCode=code;return this;},
    json(body){payload=body;ended=true;return body;},
    end(body){payload=body;ended=true;return body;}
  };
  try{await dataHandler(req,proxy);}catch(error){payload={_error:String(error?.message||error)};statusCode=500;}
  if(statusCode===401||statusCode===403) return res.status(statusCode).json(payload||{error:'Not authorized'});
  if(payload && payload._error){
    console.error('[data-safe] tenant query failed:',payload._error);
    return res.status(200).json({...empty(resource),dataUnavailable:true});
  }
  if(!ended||payload==null) return res.status(200).json({...empty(resource),dataUnavailable:true});
  return res.status(statusCode).json(payload);
}