import { Redis } from "@upstash/redis";
import { verifyToken } from "./_verify.js";

const KV_KEY = "pricing_assumptions";

function getDefaults() {
  return {
    // === CORE ===
    anchorCPM: 40,

    // === TIER DISCOUNTS (% off anchor CPM) ===
    starterDiscountPct: 0.50,
    growthDiscountPct: 0.55,
    partnerDiscountPct: 0.60,

    // === TIER PLACEMENTS ===
    starterPlacements: 6,
    growthPlacements: 12,
    partnerPlacements: 24,

    // === CATEGORY EXCLUSIVITY ===
    exclusivityPremiumPct: 0.25,

    // === SOCIAL — INSTAGRAM ===
    igFollowers: 6500,
    igBaseRatePer1K: 30,
    igReelFloor: 200,
    growthIGReels: 2,
    partnerIGReels: 4,

    // === SOCIAL — FACEBOOK ===
    fbFollowers: 15000,
    fbDiscountVsIG: 0.65,
    fbReelFloor: 150,
    growthFBReels: 2,
    partnerFBReels: 4,

    // === DEDICATED SEND ===
    dedicatedSendMultiplier: 1.5,

    // === WELCOME SEQUENCE ===
    monthlyNewSubscribers: 10000,
    welcomeCPMMultiplier: 2.0,
    welcomeMonthlyFloor: 750,
    partnerWelcomeMonths: 2,

    // === STAGE-BASED SEQUENCE ===
    stageMonthlyFlat: 500,
    partnerStageMonths: 1,

    // === NEWSLETTER TAKEOVER ===
    takeoverPremiumPct: 0.20,
    takeoverPerEmail: null,

    // === PRICE ROUNDING ===
    roundToNearest: 500,

    // === DISPLAY OVERRIDES ===
    starterPriceOverride: null,
    growthPriceOverride: null,
    partnerPriceOverride: null,

    // === IMPRESSION ADJUSTMENT (per-tier) ===
    starterAdjustmentFactor: 1.0,
    growthAdjustmentFactor: 1.0,
    partnerAdjustmentFactor: 1.0,

    // === PAGE DISPLAY NUMBERS ===
    subscriberOffset: 3000,
    displayOpenRate: 75,
    displayRebookRate: 92,
    displayTotalSubscribers: 120000,

    // === MILESTONE ===
    nextMilestone: 40000,
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();

  const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });

  if (req.method === "GET") {
    try {
      const data = await redis.get(KV_KEY);
      return res.status(200).json(data || getDefaults());
    } catch {
      return res.status(200).json(getDefaults());
    }
  }

  if (req.method === "POST") {
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    if (!(await verifyToken(token))) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      await redis.set(KV_KEY, JSON.stringify(req.body));
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === "DELETE") {
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    if (!(await verifyToken(token))) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      await redis.del(KV_KEY);
      return res.status(200).json({ ok: true, defaults: getDefaults() });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
