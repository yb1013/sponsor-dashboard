import { createToken } from "./_verify.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: "Password required" });
  }

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    return res.status(500).json({ error: "ADMIN_PASSWORD not configured" });
  }

  if (password !== adminPassword) {
    return res.status(401).json({ error: "Invalid password" });
  }

  const token = await createToken({ role: "admin", iat: Date.now() });
  return res.status(200).json({ token });
}
