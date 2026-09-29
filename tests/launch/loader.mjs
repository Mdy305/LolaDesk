import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next){
  if(spec==='@supabase/supabase-js') return { url: ${JSON.stringify(new URL('./fake-supabase.mjs', import.meta.url).href)}, shortCircuit:true };
  return next(spec, ctx);
}`));
