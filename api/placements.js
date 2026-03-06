import { Redis } from "@upstash/redis";
import { verifyToken } from "./_verify.js";

function indexKey(sponsorId) { return `placements-index:${sponsorId}`; }
function placementKey(sponsorId, placementId) { return `placements:${sponsorId}:${placementId}`; }
function uid() { return "pl-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

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

  const { action, sponsorId, placementId } = req.query;

  // ─── List placements for a sponsor ────────────────────
  if (action === "list" && req.method === "GET") {
    if (!sponsorId) return res.status(400).json({ error: "sponsorId required" });
    const index = await redis.get(indexKey(sponsorId));
    const items = index ? (typeof index === "string" ? JSON.parse(index) : index) : [];
    return res.status(200).json(items);
  }

  // ─── Get single placement with image ──────────────────
  if (action === "get" && req.method === "GET") {
    if (!sponsorId || !placementId) return res.status(400).json({ error: "sponsorId and placementId required" });
    const data = await redis.get(placementKey(sponsorId, placementId));
    if (!data) return res.status(404).json({ error: "Placement not found" });
    const pl = typeof data === "string" ? JSON.parse(data) : data;
    return res.status(200).json(pl);
  }

  // ─── Create new placement ─────────────────────────────
  if (action === "create" && req.method === "POST") {
    const { sponsorId: sid, shareToken: sToken, contractId, scheduledDate, headline, notes, imageData, sendForReview, contentType, htmlContent, previewUrl } = req.body;
    if (!sid) return res.status(400).json({ error: "sponsorId required" });

    // Store share token → sponsor ID mapping for sponsor-side lookups
    if (sToken) await redis.set(`placements-map:${sToken}`, sid);

    const ct = contentType === "html" ? "html" : "image";
    if (ct === "html" && !htmlContent) return res.status(400).json({ error: "htmlContent required for HTML placements" });
    if (ct === "image" && !imageData) return res.status(400).json({ error: "imageData required for image placements" });
    if (previewUrl && !/^https?:\/\//.test(previewUrl)) return res.status(400).json({ error: "previewUrl must start with http:// or https://" });

    const id = uid();
    const now = new Date().toISOString();
    const status = sendForReview ? "pending_review" : "draft";
    const placement = {
      placementId: id, sponsorId: sid, contractId: contractId || null,
      scheduledDate: scheduledDate || null, headline: headline || "",
      notes: notes || "", contentType: ct,
      imageData: ct === "image" ? imageData : null,
      htmlContent: ct === "html" ? htmlContent : null,
      previewUrl: (ct === "image" && previewUrl) ? previewUrl : null,
      status, version: 1, createdAt: now,
      submittedAt: sendForReview ? now : null,
      reviewedAt: null, approvedAt: null, completedAt: null,
      changeHistory: [],
    };

    await redis.set(placementKey(sid, id), JSON.stringify(placement));
    await updateIndex(redis, sid, placement);
    return res.status(200).json({ ok: true, placement: { ...placement, imageData: undefined, htmlContent: undefined } });
  }

  // ─── Update placement (edit details / replace image) ──
  if (action === "update" && req.method === "POST") {
    if (!sponsorId || !placementId) return res.status(400).json({ error: "sponsorId and placementId required" });
    const existing = await redis.get(placementKey(sponsorId, placementId));
    if (!existing) return res.status(404).json({ error: "Placement not found" });
    const pl = typeof existing === "string" ? JSON.parse(existing) : existing;

    const { scheduledDate, headline, notes, imageData, contentType, htmlContent, previewUrl } = req.body;
    if (scheduledDate !== undefined) pl.scheduledDate = scheduledDate;
    if (headline !== undefined) pl.headline = headline;
    if (notes !== undefined) pl.notes = notes;
    if (imageData !== undefined) pl.imageData = imageData;
    if (contentType !== undefined) pl.contentType = contentType;
    if (htmlContent !== undefined) pl.htmlContent = htmlContent;
    if (previewUrl !== undefined) pl.previewUrl = previewUrl;

    await redis.set(placementKey(sponsorId, placementId), JSON.stringify(pl));
    await updateIndex(redis, sponsorId, pl);
    return res.status(200).json({ ok: true });
  }

  // ─── Submit for review ────────────────────────────────
  if (action === "submit" && req.method === "POST") {
    if (!sponsorId || !placementId) return res.status(400).json({ error: "sponsorId and placementId required" });
    const existing = await redis.get(placementKey(sponsorId, placementId));
    if (!existing) return res.status(404).json({ error: "Placement not found" });
    const pl = typeof existing === "string" ? JSON.parse(existing) : existing;

    pl.status = "pending_review";
    pl.submittedAt = new Date().toISOString();

    await redis.set(placementKey(sponsorId, placementId), JSON.stringify(pl));
    await updateIndex(redis, sponsorId, pl);
    return res.status(200).json({ ok: true });
  }

  // ─── Resubmit after changes requested ─────────────────
  if (action === "resubmit" && req.method === "POST") {
    if (!sponsorId || !placementId) return res.status(400).json({ error: "sponsorId and placementId required" });
    const existing = await redis.get(placementKey(sponsorId, placementId));
    if (!existing) return res.status(404).json({ error: "Placement not found" });
    const pl = typeof existing === "string" ? JSON.parse(existing) : existing;

    const { imageData, headline, notes, htmlContent, previewUrl } = req.body;
    if (imageData !== undefined) pl.imageData = imageData;
    if (htmlContent !== undefined) pl.htmlContent = htmlContent;
    if (previewUrl !== undefined) pl.previewUrl = previewUrl;
    if (headline !== undefined) pl.headline = headline;
    if (notes !== undefined) pl.notes = notes;

    // Resolve the latest change request
    if (pl.changeHistory && pl.changeHistory.length > 0) {
      const last = pl.changeHistory[pl.changeHistory.length - 1];
      if (!last.resolvedAt) last.resolvedAt = new Date().toISOString();
    }

    pl.version = (pl.version || 1) + 1;
    pl.status = "pending_review";
    pl.submittedAt = new Date().toISOString();
    pl.reviewedAt = null;

    await redis.set(placementKey(sponsorId, placementId), JSON.stringify(pl));
    await updateIndex(redis, sponsorId, pl);
    return res.status(200).json({ ok: true });
  }

  // ─── Recall (pending_review → draft) ──────────────────
  if (action === "recall" && req.method === "POST") {
    if (!sponsorId || !placementId) return res.status(400).json({ error: "sponsorId and placementId required" });
    const existing = await redis.get(placementKey(sponsorId, placementId));
    if (!existing) return res.status(404).json({ error: "Placement not found" });
    const pl = typeof existing === "string" ? JSON.parse(existing) : existing;

    if (pl.status !== "pending_review") return res.status(400).json({ error: "Can only recall pending placements" });
    pl.status = "draft";
    pl.submittedAt = null;

    await redis.set(placementKey(sponsorId, placementId), JSON.stringify(pl));
    await updateIndex(redis, sponsorId, pl);
    return res.status(200).json({ ok: true });
  }

  // ─── Mark as completed ────────────────────────────────
  if (action === "complete" && req.method === "POST") {
    if (!sponsorId || !placementId) return res.status(400).json({ error: "sponsorId and placementId required" });
    const existing = await redis.get(placementKey(sponsorId, placementId));
    if (!existing) return res.status(404).json({ error: "Placement not found" });
    const pl = typeof existing === "string" ? JSON.parse(existing) : existing;

    pl.status = "completed";
    pl.completedAt = new Date().toISOString();

    await redis.set(placementKey(sponsorId, placementId), JSON.stringify(pl));
    await updateIndex(redis, sponsorId, pl);
    return res.status(200).json({ ok: true });
  }

  // ─── Batch complete ───────────────────────────────────
  if (action === "batch-complete" && req.method === "POST") {
    if (!sponsorId) return res.status(400).json({ error: "sponsorId required" });
    const { placementIds } = req.body;
    if (!placementIds || !placementIds.length) return res.status(400).json({ error: "placementIds required" });

    const now = new Date().toISOString();
    for (const pid of placementIds) {
      const existing = await redis.get(placementKey(sponsorId, pid));
      if (!existing) continue;
      const pl = typeof existing === "string" ? JSON.parse(existing) : existing;
      if (pl.status === "approved") {
        pl.status = "completed";
        pl.completedAt = now;
        await redis.set(placementKey(sponsorId, pid), JSON.stringify(pl));
      }
    }
    // Rebuild index
    const index = await redis.get(indexKey(sponsorId));
    const items = index ? (typeof index === "string" ? JSON.parse(index) : index) : [];
    const updated = [];
    for (const item of items) {
      if (placementIds.includes(item.placementId) && item.status === "approved") {
        updated.push({ ...item, status: "completed" });
      } else {
        updated.push(item);
      }
    }
    await redis.set(indexKey(sponsorId), JSON.stringify(updated));
    return res.status(200).json({ ok: true });
  }

  // ─── Delete placement (draft only) ────────────────────
  if (action === "delete" && req.method === "POST") {
    if (!sponsorId || !placementId) return res.status(400).json({ error: "sponsorId and placementId required" });
    const existing = await redis.get(placementKey(sponsorId, placementId));
    if (!existing) return res.status(404).json({ error: "Placement not found" });
    const pl = typeof existing === "string" ? JSON.parse(existing) : existing;

    if (pl.status !== "draft") return res.status(400).json({ error: "Only drafts can be deleted" });

    await redis.del(placementKey(sponsorId, placementId));
    // Remove from index
    const index = await redis.get(indexKey(sponsorId));
    const items = index ? (typeof index === "string" ? JSON.parse(index) : index) : [];
    const filtered = items.filter(i => i.placementId !== placementId);
    await redis.set(indexKey(sponsorId), JSON.stringify(filtered));
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
  };
  if (idx >= 0) items[idx] = entry;
  else items.push(entry);
  await redis.set(key, JSON.stringify(items));
}
