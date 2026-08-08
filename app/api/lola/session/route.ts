import { NextResponse } from 'next/server';

export async function POST() {
  const ASSISTANT_ID = process.env.TELNYX_ASSISTANT_ID;
  const TELNYX_API_KEY = process.env.TELNYX_API_KEY;

  if (!ASSISTANT_ID || !TELNYX_API_KEY) {
    return NextResponse.json({ error: 'Missing Telnyx environment variables' }, { status: 500 });
  }

  const wsUrl = `wss://api.telnyx.com/v2/ai/assistants/${ASSISTANT_ID}/conversation?input_sample_rate=16000&output_sample_rate=24000`;

  return NextResponse.json({
    wsUrl,
    token: TELNYX_API_KEY,
  });
}
