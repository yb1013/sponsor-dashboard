import { Redis } from "@upstash/redis";
import { Resend } from "resend";
import { verifyToken } from "./_verify.js";

const KV_KEY = "inquiries";

function buildNotificationEmail({ name, email, company, tier, takeover, message, price, guaranteedOpens, placements }) {
  const tierName = { starter: "Starter", growth: "Growth", partner: "Partner" }[tier] || tier;
  const fmtPrice = price ? `$${Number(price).toLocaleString("en-US")}` : "N/A";
  const fmtOpens = guaranteedOpens ? `${Number(guaranteedOpens).toLocaleString("en-US")}+` : "N/A";

  let body = `New Partnership Inquiry\n\n`;
  body += `Name: ${name || "—"}\n`;
  body += `Email: ${email}\n`;
  body += `Company: ${company || "—"}\n\n`;
  body += `Package: ${tierName} — ${fmtPrice}\n`;
  body += `Placements: ${placements || "—"}\n`;
  body += `Guaranteed Opens: ${fmtOpens}\n`;
  if (takeover) body += `Newsletter Takeover: Yes\n`;
  if (message) body += `\nMessage:\n"${message}"\n`;
  body += `\n—\nSubmitted ${new Date().toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "long", timeStyle: "short" })} ET`;

  const html = body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>")
    .replace(/"([^"]*?)"/g, "&ldquo;$1&rdquo;");

  return {
    subject: `New Sponsor Inquiry — ${company || name || email} (${tierName})`,
    text: body,
    html: `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 15px; line-height: 1.7; color: #1a1a2e;">${html}</div>`,
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();

  const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });

  if (req.method === "POST") {
    const { name, email, company, tier, takeover, message, price, guaranteedOpens, placements } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });

    const inquiry = {
      id: Date.now().toString(),
      name: name || "",
      email,
      company: company || "",
      tier: tier || "",
      takeover: !!takeover,
      message: message || "",
      price: price || null,
      guaranteedOpens: guaranteedOpens || null,
      placements: placements || null,
      createdAt: new Date().toISOString(),
    };

    try {
      const existing = await redis.get(KV_KEY);
      const list = Array.isArray(existing) ? existing : [];
      list.unshift(inquiry);
      await redis.set(KV_KEY, JSON.stringify(list));
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }

    // Send email notification — don't block the response on failure
    if (process.env.RESEND_API_KEY) {
      try {
        const resend = new Resend(process.env.RESEND_API_KEY);
        const { subject, text, html } = buildNotificationEmail(req.body);
        await resend.emails.send({
          from: "The Mommy Newsletter <notifications@themommy.news>",
          to: "matt@themommy.news",
          replyTo: email,
          subject,
          text,
          html,
        });
      } catch (e) {
        console.error("Email notification failed:", e);
      }
    }

    return res.status(200).json({ ok: true });
  }

  if (req.method === "GET") {
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    if (!(await verifyToken(token))) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      const data = await redis.get(KV_KEY);
      return res.status(200).json(Array.isArray(data) ? data : []);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
