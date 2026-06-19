import express from 'express';
import { handleWebhook } from './api/telnyx-voice.js';

const app = express();
app.use(express.json());
app.post('/api/telnyx-voice', handleWebhook);
app.listen(3000, () => console.log('Lola is listening on port 3000'));
