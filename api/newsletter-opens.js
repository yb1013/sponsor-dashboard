// ─── Newsletter opens cache (persists across warm invocations) ───
let cachedResult = null;
let cacheTimestamp = 0;
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");

  // Return cached result if fresh
  const now = Date.now();
  if (cachedResult && (now - cacheTimestamp) < CACHE_TTL) {
    console.log("[newsletter-opens] Returning cached result");
    return res.status(200).json(cachedResult);
  }

  const apiKey = process.env.BEEHIIV_API_KEY;
  const pubId = process.env.BEEHIIV_PUB_ID;

  if (!apiKey) return res.status(500).json({ error: "BEEHIIV_API_KEY not set" });
  if (!pubId) return res.status(500).json({ error: "BEEHIIV_PUB_ID not set" });

  try {
    const headers = { Authorization: `Bearer ${apiKey}` };

    console.log("[newsletter-opens] Fetching last 8 newsletter posts from Beehiiv");
    const postsRes = await fetch(
      `https://api.beehiiv.com/v2/publications/${pubId}/posts?status=confirmed&content_tags[]=newsletter&limit=8&expand[]=stats&order_by=publish_date&direction=desc`,
      { headers }
    );

    const postsData = await postsRes.json();
    const allPosts = postsData.data || [];

    console.log(`[newsletter-opens] Got ${allPosts.length} posts`);

    // Log raw stats shape of the first post for field verification
    if (allPosts.length > 0) {
      const sample = allPosts[0];
      console.log("[newsletter-opens] First post stats shape:", JSON.stringify({
        title: (sample.title || "").slice(0, 40),
        "stats.email": sample.stats?.email,
        "stats keys": Object.keys(sample.stats || {}),
      }));
    }

    // Discard the 2 most recent (still accumulating opens)
    const qualifyingPosts = allPosts.slice(2);

    const posts = qualifyingPosts.map(post => ({
      title: post.title || post.subtitle || "Untitled",
      publish_date: post.publish_date || post.created_at || null,
      total_opens: post.stats?.email?.opens || 0,
    }));

    console.log("[newsletter-opens] Posts after discarding 2 most recent:", posts.map(p => ({
      title: p.title.slice(0, 40),
      opens: p.total_opens,
    })));

    const totalOpens = posts.reduce((sum, p) => sum + p.total_opens, 0);
    const avgOpensPerSend = posts.length > 0 ? Math.round(totalOpens / posts.length) : 0;

    console.log(`[newsletter-opens] Average opens per send: ${avgOpensPerSend} (from ${posts.length} posts)`);

    // Warn if all opens resolved to 0 — likely means the field path changed
    if (posts.length > 0 && avgOpensPerSend === 0) {
      console.warn("[newsletter-opens] WARNING: All posts returned 0 opens. The Beehiiv stats field path may have changed. Packages page will fall back to engagedMoms × placements.");
    }

    const result = {
      posts,
      avgOpensPerSend,
      postsAnalyzed: posts.length,
      fetchedAt: new Date().toISOString(),
    };

    // Cache the result
    cachedResult = result;
    cacheTimestamp = now;

    return res.status(200).json(result);
  } catch (e) {
    console.error("[newsletter-opens] Error:", e.message);
    return res.status(500).json({ error: e.message });
  }
}
