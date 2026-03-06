import { Redis } from "@upstash/redis";
import { verifyToken } from "./_verify.js";

function indexKey(sponsorId) { return `placements-index:${sponsorId}`; }
function placementKey(sponsorId, placementId) { return `placements:${sponsorId}:${placementId}`; }
function densityKey(date) { return `schedule-density:${date}`; }
function uid() { return "pl-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

// ─── Density helpers ────────────────────────────────────────
async function getDensity(redis, date) {
  if (!date) return { total: 0, sponsors: [] };
  const raw = await redis.get(densityKey(date));
  if (!raw) return { total: 0, sponsors: [] };
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

async function addDensity(redis, date, sponsorName) {
  if (!date || !sponsorName) return;
  const d = await getDensity(redis, date);
  if (!d.sponsors.includes(sponsorName)) {
    d.sponsors.push(sponsorName);
    d.total = d.sponsors.length;
  }
  await redis.set(densityKey(date), JSON.stringify(d));
}

async function removeDensity(redis, date, sponsorName) {
  if (!date || !sponsorName) return;
  const d = await getDensity(redis, date);
  d.sponsors = d.sponsors.filter(s => s !== sponsorName);
  d.total = d.sponsors.length;
  if (d.total === 0) await redis.del(densityKey(date));
  else await redis.set(densityKey(date), JSON.stringify(d));
}

// ─── Schedule generation ────────────────────────────────────
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function generateForwardDates(startDate, preferredWeekday, count) {
  const dayMap = { monday: 1, wednesday: 3, friday: 5 };
  const sendDays = [1, 3, 5];
  let targetDay = dayMap[(preferredWeekday || "monday").toLowerCase()];
  if (targetDay === undefined) {
    const dow = new Date(startDate + "T00:00:00").getDay();
    let best = 1, bestDist = 7;
    for (const sd of sendDays) {
      const dist = Math.min(Math.abs(sd - dow), 7 - Math.abs(sd - dow));
      if (dist < bestDist) { bestDist = dist; best = sd; }
    }
    targetDay = best;
  }

  const fmt = (d) => d.toISOString().slice(0, 10);
  const start = new Date(startDate + "T00:00:00");
  const dates = [];
  let year = start.getFullYear(), month = start.getMonth();

  while (dates.length < count) {
    const occs = [];
    const d = new Date(year, month, 1);
    while (d.getMonth() === month) {
      if (d.getDay() === targetDay) occs.push(new Date(d));
      d.setDate(d.getDate() + 1);
    }
    const picks = [];
    if (occs.length >= 1) picks.push(occs[0]);
    if (occs.length >= 3) picks.push(occs[2]);
    else if (occs.length >= 2) picks.push(occs[occs.length - 1]);

    for (const p of picks) {
      if (p >= start && dates.length < count) dates.push(fmt(p));
    }
    month++;
    if (month > 11) { month = 0; year++; }
    if (year > start.getFullYear() + 3) break;
  }
  return dates;
}

function generateBackwardDates(startDate, count) {
  if (count <= 0) return [];
  const fmt = (d) => d.toISOString().slice(0, 10);
  const start = new Date(startDate + "T00:00:00");
  const dates = [];
  let cur = new Date(start);
  for (let i = 0; i < count; i++) {
    cur.setDate(cur.getDate() - 14);
    dates.push(fmt(new Date(cur)));
  }
  dates.reverse();
  return dates;
}

// Old schedule calculation (kept for initialize-schedule backwards compat)
function calculateScheduleDates(startDate, count, frequency) {
  const dates = [];
  const start = new Date(startDate + "T00:00:00");
  const sendDays = [1, 3, 5];
  const nextSendDay = (d) => { const dt = new Date(d); while (!sendDays.includes(dt.getDay())) dt.setDate(dt.getDate() + 1); return dt; };
  const fmt = (d) => d.toISOString().slice(0, 10);

  if (frequency === "every_send") {
    let cur = nextSendDay(start);
    for (let i = 0; i < count; i++) { dates.push(fmt(cur)); cur.setDate(cur.getDate() + 1); cur = nextSendDay(cur); }
  } else if (frequency === "2x_week") {
    let cur = new Date(start); while (cur.getDay() !== 1 && cur.getDay() !== 5) cur.setDate(cur.getDate() + 1);
    for (let i = 0; i < count; i++) { dates.push(fmt(cur)); if (cur.getDay() === 1) cur.setDate(cur.getDate() + 4); else cur.setDate(cur.getDate() + 3); }
  } else if (frequency === "1x_week") {
    let cur = new Date(start); while (cur.getDay() !== 1) cur.setDate(cur.getDate() + 1);
    for (let i = 0; i < count; i++) { dates.push(fmt(cur)); cur.setDate(cur.getDate() + 7); }
  } else if (frequency === "every_other_week") {
    let cur = new Date(start); while (cur.getDay() !== 1) cur.setDate(cur.getDate() + 1);
    for (let i = 0; i < count; i++) { dates.push(fmt(cur)); cur.setDate(cur.getDate() + 14); }
  } else if (frequency === "1x_month") {
    const firstMondayOfMonth = (y, m) => { const d = new Date(y, m, 1); while (d.getDay() !== 1) d.setDate(d.getDate() + 1); return d; };
    let cur = new Date(start), m = cur.getMonth(), y = cur.getFullYear();
    let fm = firstMondayOfMonth(y, m);
    if (fm < cur) { m++; if (m > 11) { m = 0; y++; } fm = firstMondayOfMonth(y, m); }
    for (let i = 0; i < count; i++) { dates.push(fmt(fm)); m++; if (m > 11) { m = 0; y++; } fm = firstMondayOfMonth(y, m); }
  }
  return dates;
}

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

  // ─── Generate schedule (preview — no records created) ─
  if (action === "generate-schedule" && req.method === "POST") {
    const { startDate, preferredWeekday, totalPlacements, completedRuns = 0 } = req.body;
    if (!startDate || !totalPlacements) return res.status(400).json({ error: "startDate and totalPlacements required" });

    const tp = parseInt(totalPlacements) || 0;
    const cr = parseInt(completedRuns) || 0;
    const forwardCount = tp - cr;

    const backDates = generateBackwardDates(startDate, cr);
    const forwardDates = generateForwardDates(startDate, preferredWeekday || "monday", forwardCount);

    // Build schedule with density
    const schedule = [];
    for (let i = 0; i < cr; i++) {
      const date = backDates[i] || null;
      const density = date ? await getDensity(redis, date) : { total: 0, sponsors: [] };
      schedule.push({
        runNumber: i + 1, date, weekday: date ? WEEKDAY_NAMES[new Date(date + "T00:00:00").getDay()] : "",
        density, preCompleted: true,
      });
    }
    for (let i = 0; i < forwardCount; i++) {
      const date = forwardDates[i] || null;
      const density = date ? await getDensity(redis, date) : { total: 0, sponsors: [] };
      const runNum = cr + i + 1;
      schedule.push({
        runNumber: runNum, date, weekday: date ? WEEKDAY_NAMES[new Date(date + "T00:00:00").getDay()] : "",
        density, preCompleted: false,
      });
    }

    return res.status(200).json({ schedule });
  }

  // ─── Confirm schedule (create placement records) ──────
  if (action === "confirm-schedule" && req.method === "POST") {
    const { sponsorId: sid, contractId, campaignName, totalRuns: tr, schedule: sched, sponsorName, shareToken: sToken } = req.body;
    if (!sid || !contractId || !sched || !sched.length) {
      return res.status(400).json({ error: "sponsorId, contractId, and schedule required" });
    }
    if (sToken) await redis.set(`placements-map:${sToken}`, sid);

    const now = new Date().toISOString();
    const totalR = parseInt(tr) || sched.length;
    const created = [];

    for (const entry of sched) {
      const id = uid();
      const isCompleted = !!entry.preCompleted;
      const placement = {
        placementId: id, sponsorId: sid, contractId,
        campaignName: campaignName || null,
        runNumber: entry.runNumber || null,
        totalRuns: totalR,
        scheduledDate: entry.date || null, headline: "",
        notes: "", contentType: "placeholder",
        imageData: null, htmlContent: null, previewUrl: null,
        status: isCompleted ? "completed" : "placeholder",
        version: 1, createdAt: now,
        submittedAt: null, reviewedAt: null, approvedAt: null,
        completedAt: isCompleted ? (entry.date ? entry.date + "T00:00:00.000Z" : now) : null,
        changeHistory: [],
      };
      await redis.set(placementKey(sid, id), JSON.stringify(placement));
      await updateIndex(redis, sid, placement);
      // Update density
      if (entry.date && sponsorName) await addDensity(redis, entry.date, sponsorName);
      created.push({ placementId: id, runNumber: entry.runNumber, date: entry.date, status: placement.status });
    }

    return res.status(200).json({ ok: true, count: created.length, placements: created });
  }

  // ─── Fetch density for a single date ──────────────────
  if (action === "get-density" && req.method === "GET") {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: "date required" });
    const density = await getDensity(redis, date);
    return res.status(200).json(density);
  }

  // ─── Create new placement ─────────────────────────────
  if (action === "create" && req.method === "POST") {
    const { sponsorId: sid, shareToken: sToken, contractId, scheduledDate, headline, notes, imageData, sendForReview, contentType, htmlContent, previewUrl, campaignName, runNumber, totalRuns, sponsorName } = req.body;
    if (!sid) return res.status(400).json({ error: "sponsorId required" });

    if (sToken) await redis.set(`placements-map:${sToken}`, sid);

    const isPlaceholder = contentType === "placeholder";
    const ct = isPlaceholder ? "placeholder" : (contentType === "html" ? "html" : "image");

    if (!isPlaceholder) {
      if (ct === "html" && !htmlContent) return res.status(400).json({ error: "htmlContent required for HTML placements" });
      if (ct === "image" && !imageData) return res.status(400).json({ error: "imageData required for image placements" });
    }
    if (previewUrl && !/^https?:\/\//.test(previewUrl)) return res.status(400).json({ error: "previewUrl must start with http:// or https://" });
    if (runNumber !== undefined && runNumber !== null && (typeof runNumber !== "number" || runNumber < 1)) return res.status(400).json({ error: "runNumber must be a positive integer" });
    if (totalRuns !== undefined && totalRuns !== null && (typeof totalRuns !== "number" || totalRuns < 1)) return res.status(400).json({ error: "totalRuns must be a positive integer" });

    const id = uid();
    const now = new Date().toISOString();
    const status = isPlaceholder ? "placeholder" : (sendForReview ? "pending_review" : "draft");
    const placement = {
      placementId: id, sponsorId: sid, contractId: contractId || null,
      campaignName: campaignName || null,
      runNumber: runNumber || null,
      totalRuns: totalRuns || null,
      scheduledDate: scheduledDate || null, headline: headline || "",
      notes: notes || "", contentType: ct,
      imageData: ct === "image" ? imageData : null,
      htmlContent: ct === "html" ? htmlContent : null,
      previewUrl: (ct === "image" && previewUrl) ? previewUrl : null,
      status, version: 1, createdAt: now,
      submittedAt: (status === "pending_review") ? now : null,
      reviewedAt: null, approvedAt: null, completedAt: null,
      changeHistory: [],
    };

    await redis.set(placementKey(sid, id), JSON.stringify(placement));
    await updateIndex(redis, sid, placement);

    // Update density
    if (scheduledDate && sponsorName) await addDensity(redis, scheduledDate, sponsorName);

    return res.status(200).json({ ok: true, placement: { ...placement, imageData: undefined, htmlContent: undefined } });
  }

  // ─── Initialize schedule (bulk create placeholders — legacy) ───
  if (action === "initialize-schedule" && req.method === "POST") {
    const { sponsorId: sid, shareToken: sToken, contractId, campaignName, totalRuns: tr, startDate, frequency, sponsorName } = req.body;
    if (!sid || !contractId || !tr || !startDate || !frequency) {
      return res.status(400).json({ error: "sponsorId, contractId, totalRuns, startDate, and frequency required" });
    }
    if (sToken) await redis.set(`placements-map:${sToken}`, sid);

    const dates = calculateScheduleDates(startDate, tr, frequency);
    const now = new Date().toISOString();
    const created = [];

    for (let i = 0; i < tr; i++) {
      const id = uid();
      const placement = {
        placementId: id, sponsorId: sid, contractId,
        campaignName: campaignName || null,
        runNumber: i + 1,
        totalRuns: tr,
        scheduledDate: dates[i] || null, headline: "",
        notes: "", contentType: "placeholder",
        imageData: null, htmlContent: null, previewUrl: null,
        status: "placeholder", version: 1, createdAt: now,
        submittedAt: null, reviewedAt: null, approvedAt: null, completedAt: null,
        changeHistory: [],
      };
      await redis.set(placementKey(sid, id), JSON.stringify(placement));
      await updateIndex(redis, sid, placement);
      if (dates[i] && sponsorName) await addDensity(redis, dates[i], sponsorName);
      created.push({ ...placement, imageData: undefined, htmlContent: undefined });
    }

    return res.status(200).json({ ok: true, placements: created });
  }

  // ─── Update placement (edit details / replace image) ──
  if (action === "update" && req.method === "POST") {
    if (!sponsorId || !placementId) return res.status(400).json({ error: "sponsorId and placementId required" });
    const existing = await redis.get(placementKey(sponsorId, placementId));
    if (!existing) return res.status(404).json({ error: "Placement not found" });
    const pl = typeof existing === "string" ? JSON.parse(existing) : existing;

    const { scheduledDate, headline, notes, imageData, contentType, htmlContent, previewUrl, campaignName, runNumber, totalRuns, sponsorName } = req.body;

    // Track date change for density
    const oldDate = pl.scheduledDate;
    if (scheduledDate !== undefined) pl.scheduledDate = scheduledDate;
    if (headline !== undefined) pl.headline = headline;
    if (notes !== undefined) pl.notes = notes;
    if (imageData !== undefined) pl.imageData = imageData;
    if (htmlContent !== undefined) pl.htmlContent = htmlContent;
    if (previewUrl !== undefined) pl.previewUrl = previewUrl;
    if (campaignName !== undefined) pl.campaignName = campaignName;
    if (runNumber !== undefined) pl.runNumber = runNumber;
    if (totalRuns !== undefined) pl.totalRuns = totalRuns;

    // If adding content to a placeholder, transition to draft
    if (pl.status === "placeholder" && contentType && contentType !== "placeholder") {
      pl.contentType = contentType;
      pl.status = "draft";
    } else if (contentType !== undefined) {
      pl.contentType = contentType;
    }

    await redis.set(placementKey(sponsorId, placementId), JSON.stringify(pl));
    await updateIndex(redis, sponsorId, pl);

    // Update density if date changed
    if (scheduledDate !== undefined && scheduledDate !== oldDate && sponsorName) {
      if (oldDate) await removeDensity(redis, oldDate, sponsorName);
      if (scheduledDate) await addDensity(redis, scheduledDate, sponsorName);
    }

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

  // ─── Delete placement (draft or placeholder) ──────────
  if (action === "delete" && req.method === "POST") {
    if (!sponsorId || !placementId) return res.status(400).json({ error: "sponsorId and placementId required" });
    const existing = await redis.get(placementKey(sponsorId, placementId));
    if (!existing) return res.status(404).json({ error: "Placement not found" });
    const pl = typeof existing === "string" ? JSON.parse(existing) : existing;

    if (pl.status !== "draft" && pl.status !== "placeholder") return res.status(400).json({ error: "Only drafts and placeholders can be deleted" });

    // Update density before deleting
    const { sponsorName } = req.body || {};
    if (pl.scheduledDate && sponsorName) await removeDensity(redis, pl.scheduledDate, sponsorName);

    await redis.del(placementKey(sponsorId, placementId));
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
    campaignName: placement.campaignName || null,
    runNumber: placement.runNumber || null,
    totalRuns: placement.totalRuns || null,
  };
  if (idx >= 0) items[idx] = entry;
  else items.push(entry);
  await redis.set(key, JSON.stringify(items));
}
