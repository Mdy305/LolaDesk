import handler from './api/lola.js';

// Mock req and res
const req = {
  method: 'POST',
  headers: {
    'x-tenant-id': 'mma'
  },
  body: JSON.stringify({
    messages: [
      { role: 'user', content: 'Can you book a balayage for me tomorrow?' }
    ]
  })
};

const res = {
  setHeader: () => {},
  status: (code) => {
    return {
      json: (data) => console.log(`Status ${code}:`, JSON.stringify(data, null, 2)),
      end: () => console.log(`Status ${code}`)
    };
  }
};

handler(req, res).catch(console.error);
