import calendarHandler from './calendar.js';

// Public booking uses the exact same calendar core as Lola/Telnyx.
// Only a narrow set of actions is exposed so the website cannot mutate arbitrary state.
const ALLOWED = new Set(['catalog','availability','hold','book','cancel','reschedule','lookup']);

export default async function handler(req,res){
  if(req.method==='OPTIONS') return calendarHandler(req,res);
  const body = typeof req.body==='string' ? (()=>{try{return JSON.parse(req.body||'{}')}catch{return {}}})() : (req.body||{});
  const action = body.action || req.query?.action || (req.method==='GET'?'catalog':'');
  if(!ALLOWED.has(action)) return res.status(405).json({ok:false,error:'action_not_allowed'});
  req.__publicBooking = true;
  req.body = { ...body, action, channel:'public' };
  return calendarHandler(req,res);
}
