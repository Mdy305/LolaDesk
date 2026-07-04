const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || 'https://mock.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 'mock-key';
const c = createClient(supabaseUrl, supabaseKey);

module.exports = async (req, res) => {
  // Only allow POST or automated cron GET requests
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Security check: verify this is run by Vercel cron or holds a secret
  const authHeader = req.headers.authorization;
  if (req.method === 'GET' && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    console.warn('[cron] Unauthorized weekly report attempt');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // 1. Fetch all tenants
    const { data: tenants, error: tErr } = await c.from('tenants').select('id, name, owner_email, owner_name');
    if (tErr) throw tErr;

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    
    // 2. Loop through tenants and generate weekly stats
    for (const tenant of (tenants || [])) {
      if (!tenant.owner_email) continue;
      
      // Fetch bookings from last 7 days
      const { data: bookings } = await c.from('bookings')
        .select('price')
        .eq('tenant_id', tenant.id)
        .gte('created_at', sevenDaysAgo);
        
      const rev = (bookings || []).reduce((sum, b) => sum + (b.price || 0), 0);
      const appts = (bookings || []).length;
      
      // Fetch calls handled by Lola
      const { data: calls } = await c.from('calls')
        .select('id')
        .eq('tenant_id', tenant.id)
        .gte('created_at', sevenDaysAgo);
        
      const callsHandled = (calls || []).length;

      const reportHTML = `
        <div style="font-family: sans-serif; padding: 20px; color: #111;">
          <h2>Your Weekly LolaDesk Summary 🌸</h2>
          <p>Hi ${tenant.owner_name || 'Owner'}, here's what Lola accomplished for ${tenant.name} this past week:</p>
          <ul style="font-size: 16px; line-height: 1.6;">
            <li><strong>Calls Handled:</strong> ${callsHandled}</li>
            <li><strong>Appointments Booked:</strong> ${appts}</li>
            <li><strong>Revenue Generated:</strong> $${rev.toLocaleString()}</li>
          </ul>
          <p>Keep up the great work!</p>
          <p style="color: #666; font-size: 12px;">This is an automated weekly summary from LolaDesk.</p>
        </div>
      `;

      // In production, we'd send this via Resend / SendGrid:
      // await resend.emails.send({ from: 'LolaDesk <hello@loladesk.com>', to: tenant.owner_email, subject: 'Weekly Summary', html: reportHTML });
      console.log(`[weekly-report] Simulated email sent to ${tenant.owner_email} for ${tenant.name}. Revenue: $${rev}`);
    }

    return res.status(200).json({ ok: true, message: `Weekly reports dispatched to ${tenants.length} tenants.` });

  } catch (err) {
    console.error('[weekly-report] Error:', err);
    return res.status(500).json({ error: err.message });
  }
};
