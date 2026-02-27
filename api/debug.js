export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { apiKey, pubId } = req.body;

  if (!apiKey || !pubId) {
    return res.status(400).json({ error: 'Missing apiKey or pubId' });
  }

  try {
    // Fetch published newsletter posts only
    const url = `https://api.beehiiv.com/v2/publications/${pubId}/posts?expand[]=stats&status=confirmed&platform=all&limit=10&page=1&order_by=publish_date&direction=desc&content_tags[]=newsletter`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const body = await response.text();
      return res.status(response.status).json({ error: body.slice(0, 500) });
    }

    const data = await response.json();

    // Return a summary of each post's click URLs for debugging
    const debug = (data.data || []).map(post => ({
      id: post.id,
      title: post.title,
      status: post.status,
      platform: post.platform,
      publish_date: post.publish_date,
      has_stats: !!post.stats,
      email_opens: post.stats?.email?.opens || 0,
      email_clicks: post.stats?.email?.clicks || 0,
      click_urls: (post.stats?.clicks || []).map(c => ({
        url: c.url,
        base_url: c.base_url,
        total_clicks: c.total_clicks,
      })),
    }));

    return res.status(200).json({
      total_results: data.total_results,
      total_pages: data.total_pages,
      posts: debug,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
