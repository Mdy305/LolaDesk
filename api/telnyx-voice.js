export const handleWebhook = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  // If this is a login attempt (check for email/password in body)
  if (req.body.email) {
    return res.status(200).json({ status: "success", message: "Login bypassed for testing" });
  }

  // Otherwise, handle as Telnyx Orchestrator
  try {
    return res.status(200).json({ status: "ready" });
  } catch (error) {
    return res.status(500).json({ error: "Orchestrator error" });
  }
};
