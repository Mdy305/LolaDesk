// api/onboarding/step4-deploy.js - DEPLOY & ASSIGN PHONE NUMBER
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { tenantId } = req.body;

  try {
    let phoneNumber = null;

    // 1. CREATE TELNYX VOICE APP
    try {
      const appResponse = await axios.post(
        'https://api.telnyx.com/v2/voice/conference_applications',
        {
          application_name: `lola-${tenantId.slice(0, 8)}`,
        },
        {
          headers: {
            'Authorization': `Bearer ${process.env.TELNYX_API_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      );
      console.log('[DEPLOY] Telnyx app created');
    } catch (e) {
      console.error('[DEPLOY] App creation error:', e.message);
    }

    // 2. ASSIGN OR CREATE PHONE NUMBER
    // For MVP: use a demo number
    phoneNumber = process.env.LOLA_PHONE_NUMBER || '+1-786-449-7058';

    // 3. UPDATE TENANT
    const { data, error } = await supabase
      .from('tenants')
      .update({
        phone_number: phoneNumber,
        status: 'live',
        onboarded_at: new Date().toISOString(),
      })
      .eq('id', tenantId)
      .select()
      .single();

    if (error) throw error;

    res.json({
      ok: true,
      phoneNumber,
      dashboardUrl: `/dashboard?tenant=${tenantId}`,
      tenantId,
    });
  } catch (error) {
    console.error('[DEPLOY]', error);
    res.status(500).json({ error: error.message });
  }
}
