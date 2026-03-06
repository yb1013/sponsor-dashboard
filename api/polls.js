import { Redis } from "@upstash/redis";
import { verifyToken } from "./_verify.js";

const SCHEDULE_PREFIX = "polls:schedule:";
const CONFIG_KEY = "polls:config";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!(await verifyToken(token))) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });

  const { action } = req.query;

  // ─── Config (send days) ───────────────────────────────
  if (action === "config") {
    if (req.method === "GET") {
      const data = await redis.get(CONFIG_KEY);
      return res.status(200).json(data || { sendDays: [1, 3, 5] }); // Mon, Wed, Fri
    }
    if (req.method === "POST") {
      await redis.set(CONFIG_KEY, JSON.stringify(req.body));
      return res.status(200).json({ ok: true });
    }
  }

  // ─── Schedule: get month ──────────────────────────────
  if (action === "schedule" && req.method === "GET") {
    const { month, date } = req.query; // month=2025-04 or date=2025-04-07
    if (date) {
      const data = await redis.get(SCHEDULE_PREFIX + date);
      return res.status(200).json(data || null);
    }
    if (month) {
      // Get all keys for the month by scanning individual dates
      const [year, mon] = month.split("-").map(Number);
      const daysInMonth = new Date(year, mon, 0).getDate();
      const keys = [];
      for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${year}-${String(mon).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        keys.push(SCHEDULE_PREFIX + dateStr);
      }
      const pipeline = redis.pipeline();
      keys.forEach(k => pipeline.get(k));
      const results = await pipeline.exec();
      const schedules = {};
      results.forEach((val, i) => {
        if (val) {
          const dateStr = keys[i].replace(SCHEDULE_PREFIX, "");
          schedules[dateStr] = typeof val === "string" ? JSON.parse(val) : val;
        }
      });
      return res.status(200).json(schedules);
    }
    return res.status(400).json({ error: "Provide month or date param" });
  }

  // ─── Schedule: create/update ──────────────────────────
  if (action === "schedule" && req.method === "POST") {
    const { date, ...data } = req.body;
    if (!date) return res.status(400).json({ error: "date required" });
    const existing = await redis.get(SCHEDULE_PREFIX + date);
    const merged = { ...(typeof existing === "string" ? JSON.parse(existing) : (existing || {})), ...data, date };
    await redis.set(SCHEDULE_PREFIX + date, JSON.stringify(merged));
    return res.status(200).json({ ok: true, data: merged });
  }

  // ─── Assign sponsor to slot ───────────────────────────
  if (action === "assign" && req.method === "POST") {
    const { date, slotIndex, sponsorId, sponsorName, contractId, pollQuestion, pollOptions } = req.body;
    if (!date) return res.status(400).json({ error: "date required" });
    const existing = await redis.get(SCHEDULE_PREFIX + date);
    const schedule = typeof existing === "string" ? JSON.parse(existing) : (existing || { date, sponsorSlots: [] });
    if (!schedule.sponsorSlots) schedule.sponsorSlots = [];
    // Ensure slot exists
    while (schedule.sponsorSlots.length <= (slotIndex || 0)) {
      schedule.sponsorSlots.push({ slotId: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 8), status: "open" });
    }
    const slot = schedule.sponsorSlots[slotIndex || 0];
    slot.sponsorId = sponsorId || null;
    slot.sponsorName = sponsorName || null;
    slot.contractId = contractId || null;
    slot.pollQuestion = pollQuestion || null;
    slot.pollOptions = pollOptions || null;
    slot.status = sponsorId ? "pending" : "open";
    slot.claimedAt = sponsorId ? new Date().toISOString() : null;
    schedule.date = date;
    await redis.set(SCHEDULE_PREFIX + date, JSON.stringify(schedule));
    return res.status(200).json({ ok: true, data: schedule });
  }

  // ─── Lock/unlock slot ─────────────────────────────────
  if ((action === "lock" || action === "unlock") && req.method === "POST") {
    const { date, slotIndex } = req.body;
    if (!date) return res.status(400).json({ error: "date required" });
    const existing = await redis.get(SCHEDULE_PREFIX + date);
    const schedule = typeof existing === "string" ? JSON.parse(existing) : (existing || { date, sponsorSlots: [] });
    if (!schedule.sponsorSlots || !schedule.sponsorSlots[slotIndex || 0]) {
      return res.status(400).json({ error: "Slot not found" });
    }
    const slot = schedule.sponsorSlots[slotIndex || 0];
    if (action === "lock") {
      slot.status = "locked";
      slot.lockedAt = new Date().toISOString();
    } else {
      slot.status = slot.sponsorId ? "pending" : "open";
      slot.lockedAt = null;
    }
    await redis.set(SCHEDULE_PREFIX + date, JSON.stringify(schedule));
    return res.status(200).json({ ok: true, data: schedule });
  }

  // ─── Clear slot ───────────────────────────────────────
  if (action === "clear" && req.method === "POST") {
    const { date, slotIndex } = req.body;
    if (!date) return res.status(400).json({ error: "date required" });
    const existing = await redis.get(SCHEDULE_PREFIX + date);
    const schedule = typeof existing === "string" ? JSON.parse(existing) : (existing || { date, sponsorSlots: [] });
    if (schedule.sponsorSlots && schedule.sponsorSlots[slotIndex || 0]) {
      schedule.sponsorSlots[slotIndex || 0] = {
        slotId: schedule.sponsorSlots[slotIndex || 0].slotId || Date.now().toString(36),
        status: "open",
      };
    }
    await redis.set(SCHEDULE_PREFIX + date, JSON.stringify(schedule));
    return res.status(200).json({ ok: true, data: schedule });
  }

  return res.status(400).json({ error: "Unknown action" });
}
