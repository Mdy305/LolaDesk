import { createClient } from '@supabase/supabase-js';
export const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export const getTenantConfig = async (tenantId) => {
  const { data } = await supabase.from('tenants').select('*').eq('id', tenantId).single();
  return data;
};
