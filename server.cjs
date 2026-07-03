/**
 * Local voice-stream host (optional)
 * ----------------------------------
 * This file intentionally contains only a safe, runnable placeholder server.
 * Vercel serverless handles production APIs; this script is for local testing only.
 */
const http = require('http');

const PORT = Number(process.env.PORT || 8080);

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    service: 'loladesk-local-server',
    note: 'Use Vercel deployment for production webhooks.'
  }));
});

server.listen(PORT, () => {
  console.log(`[local] LolaDesk helper server listening on ${PORT}`);
});
