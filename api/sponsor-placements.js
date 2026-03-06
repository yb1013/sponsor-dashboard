import { Redis } from "@upstash/redis";

function indexKey(sponsorId) { return `placements-index:${sponsorId}`; }
function placementKey(sponsorId, placementId) { return `placements:${sponsorId}:${placementId}`; }

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });

  const { action, token: shareToken, placementId } = req.query;
  if (!shareToken) return res.status(400).json({ error: "token required" });

  // Look up sponsor from share token
  const readRedis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_READ_ONLY_TOKEN || process.env.KV_REST_API_TOKEN,
  });
  const sponsorData = await readRedis.get(`sponsor:${shareToken}`);
  if (!sponsorData) return res.status(404).json({ error: "Sponsor not found" });
  const data = typeof sponsorData === "string" ? JSON.parse(sponsorData) : sponsorData;

  // Resolve sponsor ID: from published data, or from reverse mapping
  let sponsorId = data.id;
  if (!sponsorId) {
    const mapped = await redis.get(`placements-map:${shareToken}`);
    sponsorId = mapped || null;
  }
  if (!sponsorId) return res.status(200).json([]);

  // ─── List placements (index only, no image data) ──────
  if (action === "list" && req.method === "GET") {
    const index = await redis.get(indexKey(sponsorId));
    const items = index ? (typeof index === "string" ? JSON.parse(index) : index) : [];
    // Exclude drafts; include placeholders and all other statuses
    const visible = items.filter(i => i.status !== "draft");
    // Order by scheduledDate ascending
    visible.sort((a, b) => {
      const da = a.scheduledDate || "9999";
      const db = b.scheduledDate || "9999";
      return da.localeCompare(db);
    });
    return res.status(200).json(visible);
  }

  // ─── Get single placement with image ──────────────────
  if (action === "get" && req.method === "GET") {
    if (!placementId) return res.status(400).json({ error: "placementId required" });
    const pl = await redis.get(placementKey(sponsorId, placementId));
    if (!pl) return res.status(404).json({ error: "Placement not found" });
    const placement = typeof pl === "string" ? JSON.parse(pl) : pl;
    // Don't expose admin notes to sponsor
    const { notes, ...safe } = placement;
    // For placeholders, strip content fields
    if (safe.status === "placeholder") {
      safe.imageData = null;
      safe.htmlContent = null;
    }
    return res.status(200).json(safe);
  }

  // ─── Approve placement ────────────────────────────────
  if (action === "approve" && req.method === "POST") {
    if (!placementId) return res.status(400).json({ error: "placementId required" });
    const existing = await redis.get(placementKey(sponsorId, placementId));
    if (!existing) return res.status(404).json({ error: "Placement not found" });
    const pl = typeof existing === "string" ? JSON.parse(existing) : existing;

    if (pl.status !== "pending_review") return res.status(400).json({ error: "Placement is not pending review" });

    const now = new Date().toISOString();
    pl.status = "approved";
    pl.reviewedAt = now;
    pl.approvedAt = now;

    await redis.set(placementKey(sponsorId, placementId), JSON.stringify(pl));
    await updateIndex(redis, sponsorId, pl);
    return res.status(200).json({ ok: true });
  }

  // ─── Request changes ──────────────────────────────────
  if (action === "request-changes" && req.method === "POST") {
    if (!placementId) return res.status(400).json({ error: "placementId required" });
    const existing = await redis.get(placementKey(sponsorId, placementId));
    if (!existing) return res.status(404).json({ error: "Placement not found" });
    const pl = typeof existing === "string" ? JSON.parse(existing) : existing;

    if (pl.status !== "pending_review") return res.status(400).json({ error: "Placement is not pending review" });

    const { message } = req.body;
    const now = new Date().toISOString();
    pl.status = "changes_requested";
    pl.reviewedAt = now;
    if (!pl.changeHistory) pl.changeHistory = [];
    pl.changeHistory.push({
      version: pl.version,
      requestedAt: now,
      message: message || "",
      resolvedAt: null,
    });

    await redis.set(placementKey(sponsorId, placementId), JSON.stringify(pl));
    await updateIndex(redis, sponsorId, pl);
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: "Unknown action" });
}

async function updateIndex(redis, sponsorId, placement) {
  const key = indexKey(sponsorId);
  const existing = await redis.get(key);
  const items = existing ? (typeof existing === "string" ? JSON.parse(existing) : existing) : [];
  const idx = items.findIndex(i => i.placementId === placement.placementId);
  const entry = {
    placementId: placement.placementId,
    status: placement.status,
    scheduledDate: placement.scheduledDate,
    headline: placement.headline,
    version: placement.version,
    submittedAt: placement.submittedAt,
    reviewedAt: placement.reviewedAt,
    approvedAt: placement.approvedAt,
    completedAt: placement.completedAt,
    contractId: placement.contractId,
    contentType: placement.contentType || "image",
    campaignName: placement.campaignName || null,
    runNumber: placement.runNumber || null,
    totalRuns: placement.totalRuns || null,
  };
  if (idx >= 0) items[idx] = entry;
  else items.push(entry);
  await redis.set(key, JSON.stringify(items));
}
