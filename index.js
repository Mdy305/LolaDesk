import express from 'express';
import http from 'http';
import { handleWebhook } from './api/telnyx-voice.js';
import { initVoiceStream } from './api/voice-stream.js';

const app = express();
app.use(express.json());
app.post('/api/telnyx-voice', handleWebhook);

const server = http.createServer(app);
initVoiceStream(server);

server.listen(3000, () => console.log('Lola is listening on port 3000'));
