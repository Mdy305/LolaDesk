import calendarHandler from './calendar.js';

// Public booking uses the exact same calendar core as Lola/Telnyx.
// Only a narrow set of actions is exposed so the website cannot mutate arbitrary state.
// client_lookup returns a returning visitor's FIRST name only (rate limited);
// deposit_quote / open_days / addons are read-only; release_hold frees the
// visitor's own 5-minute hold by its token.
const ALLOWED = new Set(['catalog','availability','hold','release_hold','book','cancel','reschedule','lookup','waitlist_add',
  'client_lookup','deposit_quote','open_days','addons']);

export default async function handler(req,res){
  if(req.method==='OPTIONS') return calendarHandler(req,res);
  const body = typeof req.body==='string' ? (()=>{try{return JSON.parse(req.body||'{}')}catch{return {}}})() : (req.body||{});
  const action = body.action || req.query?.action || (req.method==='GET'?'catalog':'');
  if(!ALLOWED.has(action)) return res.status(405).json({ok:false,error:'action_not_allowed'});
  req.__publicBooking = true;
  req.body = { ...body, action, channel:'public' };
  return calendarHandler(req,res);
}
