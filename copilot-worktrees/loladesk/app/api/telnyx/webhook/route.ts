import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const STREAMING_SOCKET_URL =
  process.env.LOLABRAIN_STREAMING_SOCKET_URL || 'wss://loladesk.com/api/telnyx/stream';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const event = body.data;

    if (!event || event.event_type !== 'call.initiated') {
      return NextResponse.json({ status: 'ignored' }, { status: 200 });
    }

    const callControlId = event.payload?.call_control_id;
    const calledNumber = event.payload?.to;

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    const { data: tenantConfig } = await supabase
      .from('tenant_config')
      .select('tenant_id, business_name, lola_system_prompt')
      .eq('phone_number', calledNumber)
      .single();

    const tenantId = tenantConfig?.tenant_id || 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

    await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/answer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TELNYX_API_KEY}`,
      },
    });

    const streamUrl = `${STREAMING_SOCKET_URL}?tenant_id=${tenantId}`;

    await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/streaming_start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TELNYX_API_KEY}`,
      },
      body: JSON.stringify({
        stream_url: streamUrl,
        stream_track: 'both_tracks',
        stream_bidirectional_mode: 'mp3',
      }),
    });

    return NextResponse.json({ status: 'success' }, { status: 200 });
  } catch (error) {
    console.error('[Orchestrator Error]:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
