export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");

  const apiKey = process.env.BEEHIIV_API_KEY;
  const pubId = process.env.BEEHIIV_PUB_ID;

  if (!apiKey || !pubId) {
    return res.status(500).json({ error: "API not configured" });
  }

  try {
    const headers = { Authorization: `Bearer ${apiKey}` };

    // Fetch publication stats
    const pubRes = await fetch(`https://api.beehiiv.com/v2/publications/${pubId}`, { headers });
    const pubData = await pubRes.json();

    // Fetch recent posts for average metrics
    const postsUrl = `https://api.beehiiv.com/v2/publications/${pubId}/posts?status=confirmed&content_tags[]=newsletter&limit=20&expand[]=stats&order_by=publish_date&direction=desc`;
    const postsRes = await fetch(postsUrl, { headers });
    const postsData = await postsRes.json();
    const posts = postsData.data || [];

    let totalOpens = 0;
    let totalClicks = 0;
    let postCount = 0;

    for (const post of posts) {
      if (post.stats) {
        const opens = post.stats.email?.unique_opens || post.stats.email?.opens || 0;
        totalOpens += opens;
        const clicks = (post.stats.clicks || []).reduce((sum, c) => sum + (c.total_clicks || 0), 0);
        totalClicks += clicks;
        postCount++;
      }
    }

    const avgOpens = postCount > 0 ? Math.round(totalOpens / postCount) : 0;
    const avgClicks = postCount > 0 ? Math.round(totalClicks / postCount) : 0;
    const avgCtr = avgOpens > 0 ? parseFloat(((avgClicks / avgOpens) * 100).toFixed(2)) : 0;

    const activeSubscribers =
      pubData.data?.stats?.active_subscriptions ||
      pubData.data?.stats?.total_active_subscribers ||
      pubData.data?.total_subscribers ||
      0;

    return res.status(200).json({
      activeSubscribers,
      avgOpensPerSend: avgOpens,
      avgClicksPerSend: avgClicks,
      avgCtr,
      postsAnalyzed: postCount,
      fetchedAt: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
