import { NextResponse } from 'next/server';

export async function GET(req: Request) {
  return new NextResponse('Telnyx WebSocket Streaming Endpoint Active', {
    status: 200,
    headers: {
      'Content-Type': 'text/plain',
      'X-Telnyx-Audio-Format': 'PCM16',
    },
  });
}
