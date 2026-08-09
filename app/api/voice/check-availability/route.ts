import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { calculateSecondarySlot } from '@/lib/scheduling';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: Request) {
  try {
    const { serviceId, requestedTime } = await req.json();

    const { data: service, error } = await supabase
      .from('services')
      .select('active_duration_1_min, processing_duration_min, active_duration_2_min')
      .eq('id', serviceId)
      .single();

    if (error || !service) throw new Error('Service not found');

    const slotDetails = calculateSecondarySlot(new Date(requestedTime), {
      activeDuration1Min: service.active_duration_1_min,
      processingDurationMin: service.processing_duration_min,
      activeDuration2Min: service.active_duration_2_min,
    });

    return NextResponse.json({
      available: true,
      gapStart: slotDetails.gapAvailableStart,
      gapEnd: slotDetails.gapAvailableEnd,
      maxServiceDurationMinutes: slotDetails.maxGapServiceMinutes,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
