// api/onboarding/step1.js - Business Information
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { businessName, ownerEmail, ownerName, location, phone, industry } = req.body;

  try {
    const { data, error } = await supabase
      .from('tenants')
      .insert({
        business_name: businessName,
        owner_email: ownerEmail,
        owner_name: ownerName,
        location,
        primary_phone: phone,
        industry,
        status: 'onboarding_step1',
      })
      .select()
      .single();

    if (error) throw error;

    res.json({ ok: true, tenantId: data.id });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}
