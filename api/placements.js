import { Redis } from "@upstash/redis";
import { verifyToken } from "./_verify.js";

function indexKey(sponsorId) { return `placements-index:${sponsorId}`; }
function placementKey(sponsorId, placementId) { return `placements:${sponsorId}:${placementId}`; }
function uid() { return "pl-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

// ─── Schedule generation (biweekly, conflict-aware) ─────────
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function fmtLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function generateForwardDates(startDate, count) {
  const start = new Date(startDate + "T12:00:00");
  const dates = [];
  let cur = new Date(start);
  for (let i = 0; i < count; i++) {
    dates.push(fmtLocal(cur));
    cur.setDate(cur.getDate() + 14);
  }
  return dates;
}

// Conflict-aware: tries Mon then Fri of same week, then skips +14d
function resolveConflicts(dates, takenMap, count) {
  const resolved = [];
  for (const dateStr of dates) {
    if (resolved.length >= count) break;
    const d = new Date(dateStr + "T12:00:00");
    const dow = d.getDay();
    // Try original date
    if (!takenMap[dateStr]) {
      resolved.push({ date: dateStr, movedFrom: null, takenBy: null });
      continue;
    }
    // Try Monday of that week
    const mon = new Date(d);
    mon.setDate(mon.getDate() - ((dow + 6) % 7)); // go to Monday
    const monStr = fmtLocal(mon);
    if (monStr !== dateStr && !takenMap[monStr] && !resolved.some(r => r.date === monStr)) {
      resolved.push({ date: monStr, movedFrom: dateStr, takenBy: takenMap[dateStr] });
      continue;
    }
    // Try Friday of that week
    const fri = new Date(mon);
    fri.setDate(fri.getDate() + 4);
    const friStr = fmtLocal(fri);
    if (friStr !== dateStr && !takenMap[friStr] && !resolved.some(r => r.date === friStr)) {
      resolved.push({ date: friStr, movedFrom: dateStr, takenBy: takenMap[dateStr] });
      continue;
    }
    // Whole week booked — skip, will add extra at end
    resolved.push(null); // placeholder for skipped
  }

  // Remove skipped entries and add extras at the end
  const good = resolved.filter(r => r !== null);
  let lastDate = good.length > 0 ? new Date(good[good.length - 1].date + "T12:00:00") : new Date(dates[dates.length - 1] + "T12:00:00");
  while (good.length < count) {
    lastDate.setDate(lastDate.getDate() + 14);
    const extra = fmtLocal(lastDate);
    if (!takenMap[extra] && !good.some(r => r.date === extra)) {
      good.push({ date: extra, movedFrom: null, takenBy: null });
    }
  }
  return good;
}

function generateBackwardDates(startDate, count) {
  if (count <= 0) return [];
  const start = new Date(startDate + "T12:00:00");
  const dates = [];
  let cur = new Date(start);
  for (let i = 0; i < count; i++) {
    cur.setDate(cur.getDate() - 14);
    dates.push(fmtLocal(cur));
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
    const { startDate, totalPlacements, completedRuns = 0, sponsorIds } = req.body;
    if (!startDate || !totalPlacements) return res.status(400).json({ error: "startDate and totalPlacements required" });

    const tp = parseInt(totalPlacements) || 0;
    const cr = parseInt(completedRuns) || 0;
    const forwardCount = tp - cr;

    // Build map of taken dates from all sponsors' existing placements
    const takenMap = {}; // date -> sponsor name
    const allSponsorIds = sponsorIds || [];
    for (const sid of allSponsorIds) {
      const idx = await redis.get(indexKey(sid));
      const items = idx ? (typeof idx === "string" ? JSON.parse(idx) : idx) : [];
      items.forEach(item => {
        if (item.scheduledDate && item.status !== "completed") {
          // Store the first sponsor that has this date
          if (!takenMap[item.scheduledDate]) takenMap[item.scheduledDate] = sid;
        }
      });
    }

    // Resolve sponsor names for display
    const sponsorNameMap = {};
    if (req.body.sponsorNameMap) {
      Object.assign(sponsorNameMap, req.body.sponsorNameMap);
    }

    console.log(`[generate-schedule] sponsorIds=${allSponsorIds.length}, takenDates=${Object.keys(takenMap).length}, startDate=${startDate}, forward=${forwardCount}`);
    if (Object.keys(takenMap).length > 0) console.log(`[generate-schedule] taken dates:`, Object.keys(takenMap).slice(0, 10));

    const backDates = generateBackwardDates(startDate, cr);
    const rawForwardDates = generateForwardDates(startDate, forwardCount);
    const resolved = resolveConflicts(rawForwardDates, takenMap, forwardCount);

    const schedule = [];
    for (let i = 0; i < cr; i++) {
      const date = backDates[i] || null;
      schedule.push({
        runNumber: i + 1, date, weekday: date ? WEEKDAY_NAMES[new Date(date + "T12:00:00").getDay()] : "",
        preCompleted: true,
      });
    }
    for (let i = 0; i < resolved.length; i++) {
      const r = resolved[i];
      schedule.push({
        runNumber: cr + i + 1, date: r.date,
        weekday: r.date ? WEEKDAY_NAMES[new Date(r.date + "T00:00:00").getDay()] : "",
        preCompleted: false,
        movedFrom: r.movedFrom || null,
        takenBy: r.takenBy ? (sponsorNameMap[r.takenBy] || r.takenBy) : null,
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
      created.push({ placementId: id, runNumber: entry.runNumber, date: entry.date, status: placement.status });
    }

    return res.status(200).json({ ok: true, count: created.length, placements: created });
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

    const { scheduledDate, headline, notes, imageData, contentType, htmlContent, previewUrl, campaignName, runNumber, totalRuns } = req.body;

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

    await redis.del(placementKey(sponsorId, placementId));
    const index = await redis.get(indexKey(sponsorId));
    const items = index ? (typeof index === "string" ? JSON.parse(index) : index) : [];
    const filtered = items.filter(i => i.placementId !== placementId);
    await redis.set(indexKey(sponsorId), JSON.stringify(filtered));
    return res.status(200).json({ ok: true });
  }

  // ─── Skip placement (delete + renumber + add new at end) ─
  if (action === "skip-placement" && req.method === "POST") {
    if (!sponsorId || !placementId) return res.status(400).json({ error: "sponsorId and placementId required" });
    const existing = await redis.get(placementKey(sponsorId, placementId));
    if (!existing) return res.status(404).json({ error: "Placement not found" });
    const pl = typeof existing === "string" ? JSON.parse(existing) : existing;

    if (pl.status !== "placeholder") return res.status(400).json({ error: "Only placeholders can be skipped" });

    const contractId = pl.contractId;
    const skippedRun = pl.runNumber;

    // Delete the skipped placement
    await redis.del(placementKey(sponsorId, placementId));

    // Get all placements for this contract, renumber, and add new one at end
    const index = await redis.get(indexKey(sponsorId));
    const items = index ? (typeof index === "string" ? JSON.parse(index) : index) : [];
    const contractItems = items.filter(i => i.contractId === contractId && i.placementId !== placementId);
    const otherItems = items.filter(i => i.contractId !== contractId);

    // Sort by current run number
    contractItems.sort((a, b) => (a.runNumber || 0) - (b.runNumber || 0));

    // Renumber sequentially
    for (let i = 0; i < contractItems.length; i++) {
      contractItems[i].runNumber = i + 1;
      // Also update the full placement record
      const fullRaw = await redis.get(placementKey(sponsorId, contractItems[i].placementId));
      if (fullRaw) {
        const full = typeof fullRaw === "string" ? JSON.parse(fullRaw) : fullRaw;
        full.runNumber = i + 1;
        await redis.set(placementKey(sponsorId, contractItems[i].placementId), JSON.stringify(full));
      }
    }

    // Find last date and add new placeholder 14 days after
    const lastDate = contractItems.filter(i => i.scheduledDate).map(i => i.scheduledDate).sort().pop();
    const newDate = lastDate ? (() => {
      const d = new Date(lastDate + "T12:00:00");
      d.setDate(d.getDate() + 14);
      return fmtLocal(d);
    })() : null;

    const newId = uid();
    const now = new Date().toISOString();
    const newPlacement = {
      placementId: newId, sponsorId, contractId,
      campaignName: pl.campaignName || null,
      runNumber: contractItems.length + 1,
      totalRuns: pl.totalRuns,
      scheduledDate: newDate, headline: "",
      notes: "", contentType: "placeholder",
      imageData: null, htmlContent: null, previewUrl: null,
      status: "placeholder", version: 1, createdAt: now,
      submittedAt: null, reviewedAt: null, approvedAt: null, completedAt: null,
      changeHistory: [],
    };
    await redis.set(placementKey(sponsorId, newId), JSON.stringify(newPlacement));

    const newEntry = {
      placementId: newId, status: "placeholder", scheduledDate: newDate,
      headline: "", version: 1, submittedAt: null, reviewedAt: null, approvedAt: null, completedAt: null,
      contractId, contentType: "placeholder",
      campaignName: pl.campaignName || null,
      runNumber: contractItems.length + 1, totalRuns: pl.totalRuns,
    };

    await redis.set(indexKey(sponsorId), JSON.stringify([...otherItems, ...contractItems, newEntry]));
    return res.status(200).json({ ok: true, newPlacementId: newId, newDate });
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
