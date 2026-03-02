import { verifyToken } from "./_verify.js";
import { Redis } from "@upstash/redis";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const authToken = (req.headers.authorization || "").replace("Bearer ", "");
  if (!await verifyToken(authToken)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { shareToken, data } = req.body;
  if (!shareToken || !data) {
    return res.status(400).json({ error: "Missing shareToken or data" });
  }

  try {
    const redis = new Redis({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });

    await redis.set(`sponsor:${shareToken}`, JSON.stringify(data));
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: `KV error: ${err.message}` });
  }
}
