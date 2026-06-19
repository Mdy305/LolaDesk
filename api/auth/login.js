export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    return res.status(200).json({ 
      status: "success", 
      message: "Authenticated",
      tenant_id: "default-tenant" 
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
