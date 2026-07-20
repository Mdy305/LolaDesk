import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const event = body.data;

    if (event?.event_type === 'message.received') {
      const fromPhone = event.payload.from.phone_number;
      const toPhone = event.payload.to[0].phone_number;
      const textContent = event.payload.text || '';
      const media = event.payload.media || [];

      // 1. Resolve Tenant ID by Phone Number
      const { data: tenant } = await supabase
        .from('tenant_config')
        .select('tenant_id')
        .eq('assigned_phone_number', toPhone)
        .maybeSingle();

      if (!tenant) {
        return NextResponse.json({ status: 'ignored_unassigned_number' });
      }

      // 2. Resolve or Create Client Profile
      let { data: client } = await supabase
        .from('clients')
        .select('id')
        .eq('tenant_id', tenant.tenant_id)
        .eq('phone', fromPhone)
        .maybeSingle();

      if (!client) {
        const { data: newClient, error: createError } = await supabase
          .from('clients')
          .insert({
            tenant_id: tenant.tenant_id,
            phone: fromPhone,
            first_name: 'New SMS Client',
            status: 'active',
          })
          .select('id')
          .single();

        if (createError) throw createError;
        client = newClient;
      }

      // 3. Detect Hair Analysis Image or Keyword
      const photoUrl = media.length > 0 ? media[0].url : null;
      const isHairAnalysis =
        textContent.toLowerCase().includes('hair') ||
        textContent.toLowerCase().includes('analysis') ||
        Boolean(photoUrl);

      // 4. Log Interaction Trace
      await supabase.from('client_interactions').insert({
        tenant_id: tenant.tenant_id,
        client_id: client.id,
        interaction_type: isHairAnalysis ? 'hair_analysis' : 'sms',
        content: textContent,
        attachment_url: photoUrl,
      });

      // 5. Store Long-Term Context in Memory Engine
      if (isHairAnalysis) {
        await supabase.from('client_memories').insert({
          tenant_id: tenant.tenant_id,
          client_id: client.id,
          key: 'hair_analysis_trace',
          value: {
            message: textContent,
            photo: photoUrl,
            logged_at: new Date().toISOString(),
          },
        });
      }
    }

    return NextResponse.json({ status: 'success' });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
