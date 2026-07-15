import http from 'http';
import handleWebhook from './api/telnyx-voice.js';
import { initVoiceStream } from './api/voice-stream.js';

const PORT = Number(process.env.PORT || 3000);

const server = http.createServer(async (req, res) => {
  if(req.method === 'POST' && req.url === '/api/telnyx-voice'){
    return handleWebhook(req, res);
  }

  res.writeHead(200, { 'content-type':'application/json' });
  res.end(JSON.stringify({
    ok: true,
    service: 'loladesk-dev-server',
    note: 'POST /api/telnyx-voice for webhook testing.'
  }));
});

initVoiceStream(server);

server.listen(PORT, () => {
  console.log(`LolaDesk dev server listening on ${PORT}`);
});
