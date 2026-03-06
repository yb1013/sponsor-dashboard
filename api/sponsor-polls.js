import { Redis } from "@upstash/redis";
import { verifyToken } from "./_verify.js";

const SCHEDULE_PREFIX = "polls:schedule:";
const CONFIG_KEY = "polls:config";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });

  const { action, token: shareToken } = req.query;

  // Authenticate via share token — look up sponsor data
  if (!shareToken) return res.status(400).json({ error: "token required" });

  const readRedis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_READ_ONLY_TOKEN || process.env.KV_REST_API_TOKEN,
  });
  const sponsorData = await readRedis.get(`sponsor:${shareToken}`);
  if (!sponsorData) return res.status(404).json({ error: "Sponsor not found" });

  const data = typeof sponsorData === "string" ? JSON.parse(sponsorData) : sponsorData;
  // Find contract with polls
  const allContracts = data.contracts || [];
  const activeContract = allContracts.find(c => c.isActive);

  // ─── Entitlements ─────────────────────────────────────
  if (action === "entitlements" && req.method === "GET") {
    if (!activeContract) return res.status(200).json({ pollsIncluded: 0, used: 0, remaining: 0, tier: null });

    const pollsIncluded = activeContract.pollsIncluded || 0;
    if (pollsIncluded === 0) return res.status(200).json({ pollsIncluded: 0, used: 0, remaining: 0, tier: activeContract.packageTier || "custom" });

    // Count used polls by scanning schedule data for this sponsor
    const usedSlots = await countSponsorPollSlots(redis, activeContract, data.sponsorName);
    return res.status(200).json({
      pollsIncluded,
      used: usedSlots.length,
      remaining: Math.max(0, pollsIncluded - usedSlots.length),
      tier: activeContract.packageTier || "custom",
      contractName: activeContract.name,
      startDate: activeContract.startDate,
      endDate: activeContract.endDate,
      slots: usedSlots,
    });
  }

  // ─── Available dates ──────────────────────────────────
  if (action === "available-dates" && req.method === "GET") {
    if (!activeContract || !(activeContract.pollsIncluded > 0)) {
      return res.status(200).json({ dates: [], quarterlyUsage: {} });
    }

    const pollConfig = await redis.get(CONFIG_KEY) || { sendDays: [1, 3, 5] };
    const config = typeof pollConfig === "string" ? JSON.parse(pollConfig) : pollConfig;
    const sendDays = config.sendDays || [1, 3, 5];

    const start = new Date(activeContract.startDate || Date.now());
    const end = new Date(activeContract.endDate || Date.now());
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Get quarterly usage for this sponsor
    const usedSlots = await countSponsorPollSlots(redis, activeContract, data.sponsorName);
    const quarterlyUsage = {};
    for (const slot of usedSlots) {
      const q = getQuarter(slot.date);
      quarterlyUsage[q] = (quarterlyUsage[q] || 0) + 1;
    }

    // Generate available dates
    const availableDates = [];
    const cursor = new Date(start);
    while (cursor <= end) {
      if (cursor >= today) {
        const dow = cursor.getDay();
        const jsDow = dow === 0 ? 7 : dow;
        if (sendDays.includes(jsDow)) {
          const dateStr = cursor.toISOString().split("T")[0];
          const q = getQuarter(dateStr);
          const quarterUsed = quarterlyUsage[q] || 0;
          // Check if slot is available on this date
          const schedKey = SCHEDULE_PREFIX + dateStr;
          const sched = await redis.get(schedKey);
          const schedData = sched ? (typeof sched === "string" ? JSON.parse(sched) : sched) : null;
          const slots = schedData?.sponsorSlots || [];
          const hasOpenSlot = slots.length < 2 || slots.some(s => s.status === "open");

          availableDates.push({
            date: dateStr,
            quarter: q,
            quarterUsed,
            available: quarterUsed < 1 && hasOpenSlot, // 1 per quarter limit
          });
        }
      }
      cursor.setDate(cursor.getDate() + 1);
    }

    return res.status(200).json({ dates: availableDates, quarterlyUsage });
  }

  // ─── Claim a date ─────────────────────────────────────
  if (action === "claim" && req.method === "POST") {
    if (!activeContract || !(activeContract.pollsIncluded > 0)) {
      return res.status(400).json({ error: "No poll entitlements" });
    }

    const { date, pollQuestion, pollOptions, isCustomQuestion } = req.body;
    if (!date) return res.status(400).json({ error: "date required" });

    // Server-side enforcement
    const usedSlots = await countSponsorPollSlots(redis, activeContract, data.sponsorName);
    if (usedSlots.length >= activeContract.pollsIncluded) {
      return res.status(400).json({ error: "All poll entitlements used" });
    }

    const q = getQuarter(date);
    const quarterUsed = usedSlots.filter(s => getQuarter(s.date) === q).length;
    if (quarterUsed >= 1) {
      return res.status(400).json({ error: "Already used poll slot for this quarter" });
    }

    // Check open slot on date
    const existing = await redis.get(SCHEDULE_PREFIX + date);
    const schedule = existing ? (typeof existing === "string" ? JSON.parse(existing) : existing) : { date, sponsorSlots: [] };
    if (!schedule.sponsorSlots) schedule.sponsorSlots = [];

    let slotIndex = schedule.sponsorSlots.findIndex(s => s.status === "open");
    if (slotIndex === -1 && schedule.sponsorSlots.length < 2) {
      slotIndex = schedule.sponsorSlots.length;
      schedule.sponsorSlots.push({ slotId: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), status: "open" });
    }
    if (slotIndex === -1) return res.status(400).json({ error: "No open slots on this date" });

    schedule.sponsorSlots[slotIndex] = {
      ...schedule.sponsorSlots[slotIndex],
      sponsorId: shareToken,
      sponsorName: data.sponsorName,
      contractId: activeContract.id,
      pollQuestion: pollQuestion || null,
      pollOptions: pollOptions || null,
      status: "pending",
      claimedAt: new Date().toISOString(),
      isCustomQuestion: !!isCustomQuestion,
      customQuestionApproved: isCustomQuestion ? null : undefined,
    };

    await redis.set(SCHEDULE_PREFIX + date, JSON.stringify(schedule));
    return res.status(200).json({ ok: true });
  }

  // ─── Lock a claimed date ──────────────────────────────
  if (action === "lock" && req.method === "POST") {
    const { date } = req.body;
    if (!date) return res.status(400).json({ error: "date required" });

    const existing = await redis.get(SCHEDULE_PREFIX + date);
    if (!existing) return res.status(400).json({ error: "No schedule for this date" });
    const schedule = typeof existing === "string" ? JSON.parse(existing) : existing;

    const slotIndex = (schedule.sponsorSlots || []).findIndex(s => s.sponsorId === shareToken && s.status === "pending");
    if (slotIndex === -1) return res.status(400).json({ error: "No pending slot found for this sponsor" });

    schedule.sponsorSlots[slotIndex].status = "locked";
    schedule.sponsorSlots[slotIndex].lockedAt = new Date().toISOString();

    await redis.set(SCHEDULE_PREFIX + date, JSON.stringify(schedule));
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: "Unknown action" });
}

function getQuarter(dateStr) {
  const month = new Date(dateStr + "T00:00:00").getMonth(); // 0-11
  const year = new Date(dateStr + "T00:00:00").getFullYear();
  const q = Math.floor(month / 3) + 1;
  return `Q${q} ${year}`;
}

async function countSponsorPollSlots(redis, contract, sponsorName) {
  if (!contract.startDate || !contract.endDate) return [];

  const start = new Date(contract.startDate);
  const end = new Date(contract.endDate);
  const slots = [];

  // Scan months in contract range
  const cursor = new Date(start);
  cursor.setDate(1);
  while (cursor <= end) {
    const year = cursor.getFullYear();
    const mon = cursor.getMonth() + 1;
    const daysInMonth = new Date(year, mon, 0).getDate();

    const keys = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(mon).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      keys.push(SCHEDULE_PREFIX + dateStr);
    }

    const pipeline = redis.pipeline();
    keys.forEach(k => pipeline.get(k));
    const results = await pipeline.exec();

    results.forEach((val, i) => {
      if (val) {
        const sched = typeof val === "string" ? JSON.parse(val) : val;
        const dateStr = keys[i].replace(SCHEDULE_PREFIX, "");
        for (const slot of (sched.sponsorSlots || [])) {
          if (slot.sponsorName === sponsorName && (slot.status === "pending" || slot.status === "locked")) {
            slots.push({ date: dateStr, ...slot });
          }
        }
      }
    });

    cursor.setMonth(cursor.getMonth() + 1);
  }

  return slots;
}
