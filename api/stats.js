export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");

  const apiKey = process.env.BEEHIIV_API_KEY;
  const pubId = process.env.BEEHIIV_PUB_ID;

  if (!apiKey) return res.status(500).json({ error: "BEEHIIV_API_KEY not set" });
  if (!pubId) return res.status(500).json({ error: "BEEHIIV_PUB_ID not set" });

  try {
    const headers = { Authorization: `Bearer ${apiKey}` };

    // Fetch publication stats + subscriber count + recent posts in parallel
    const [pubRes, subsRes, postsRes] = await Promise.all([
      fetch(`https://api.beehiiv.com/v2/publications/${pubId}`, { headers }),
      fetch(`https://api.beehiiv.com/v2/publications/${pubId}/subscriptions?status=active&limit=1`, { headers }),
      fetch(`https://api.beehiiv.com/v2/publications/${pubId}/posts?status=confirmed&limit=20&expand[]=stats&order_by=publish_date&direction=desc`, { headers }),
    ]);

    const pubData = await pubRes.json();
    const subsData = await subsRes.json();
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

    // Try multiple paths for subscriber count
    const activeSubscribers =
      subsData?.total_results ||
      pubData?.data?.stats?.active_subscriptions ||
      pubData?.data?.stats?.total_active_subscribers ||
      pubData?.data?.stats?.active_subscribers ||
      pubData?.data?.active_subscriptions ||
      pubData?.data?.total_subscribers ||
      pubData?.data?.subscriber_count ||
      pubData?.stats?.active_subscriptions ||
      0;

    return res.status(200).json({
      activeSubscribers,
      avgOpensPerSend: avgOpens,
      avgClicksPerSend: avgClicks,
      avgCtr,
      postsAnalyzed: postCount,
      fetchedAt: new Date().toISOString(),
      _debug: {
        pubKeys: pubData?.data ? Object.keys(pubData.data) : [],
        pubStatsKeys: pubData?.data?.stats ? Object.keys(pubData.data.stats) : [],
        subsTotal: subsData?.total_results,
        subsKeys: Object.keys(subsData || {}),
      },
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
