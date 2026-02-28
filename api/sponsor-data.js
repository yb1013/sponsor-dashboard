import { Redis } from "@upstash/redis";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { token } = req.query;
  if (!token) {
    return res.status(400).json({ error: "Missing token" });
  }

  try {
    const redis = new Redis({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_READ_ONLY_TOKEN,
    });

    const raw = await redis.get(`sponsor:${token}`);
    if (!raw) {
      return res.status(404).json({ error: "Not found" });
    }

    const data = typeof raw === "string" ? JSON.parse(raw) : raw;
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: `KV error: ${err.message}` });
  }
}
