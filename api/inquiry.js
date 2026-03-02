import { Redis } from "@upstash/redis";
import { verifyToken } from "./_verify.js";

const KV_KEY = "inquiries";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();

  const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });

  if (req.method === "POST") {
    const { name, email, company, tier, takeover, message } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });

    const inquiry = {
      id: Date.now().toString(),
      name: name || "",
      email,
      company: company || "",
      tier: tier || "",
      takeover: !!takeover,
      message: message || "",
      createdAt: new Date().toISOString(),
    };

    try {
      const existing = await redis.get(KV_KEY);
      const list = Array.isArray(existing) ? existing : [];
      list.unshift(inquiry);
      await redis.set(KV_KEY, JSON.stringify(list));
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === "GET") {
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    if (!(await verifyToken(token))) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      const data = await redis.get(KV_KEY);
      return res.status(200).json(Array.isArray(data) ? data : []);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
