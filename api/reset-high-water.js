import { verifyToken } from "./_verify.js";
import { Redis } from "@upstash/redis";

export default async function handler(req, res) {
  if (req.method !== "DELETE") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");

  const authToken = (req.headers.authorization || "").replace("Bearer ", "");
  if (!await verifyToken(authToken)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const redis = new Redis({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });
    await redis.del("engaged_high_water_mark");
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: `KV error: ${err.message}` });
  }
}
