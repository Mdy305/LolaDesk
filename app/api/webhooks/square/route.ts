import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: Request) {
  try {
    const event = await req.json();

    if (event.type === 'booking.created') {
      const booking = event.data.object.booking;

      const { error } = await supabase.from('appointments').upsert(
        {
          salon_id: event.merchant_id,
          external_appointment_id: booking.id,
          external_provider: 'square',
          start_time: booking.start_at,
          end_time: booking.end_at,
          status: 'booked',
        },
        { onConflict: 'external_appointment_id' }
      );

      if (error) throw error;
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
