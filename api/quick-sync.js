import { verifyToken } from "./_verify.js";

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authToken = (req.headers.authorization || "").replace("Bearer ", "");
  if (!await verifyToken(authToken)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { apiKey, pubId, knownPostIds } = req.body;

  if (!apiKey || !pubId) {
    return res.status(400).json({ error: 'Missing apiKey or pubId' });
  }

  try {
    const headers = {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };

    // 1) Fetch just the latest 10 newsletters to check for new posts
    const latestUrl = `https://api.beehiiv.com/v2/publications/${pubId}/posts?expand[]=stats&status=confirmed&platform=all&limit=10&page=1&order_by=publish_date&direction=desc&content_tags[]=newsletter`;
    const latestRes = await fetch(latestUrl, { headers });

    if (!latestRes.ok) {
      const body = await latestRes.text();
      return res.status(latestRes.status).json({ error: `Beehiiv API error: ${body.slice(0, 300)}` });
    }

    const latestData = await latestRes.json();
    const latestPosts = latestData.data || [];

    // 2) For known posts (existing runs), fetch each individually to update opens/clicks
    //    This is fast — each is a single small API call
    const ids = knownPostIds || [];
    const updatedPosts = [];

    for (const postId of ids) {
      // Skip if already in latest batch
      if (latestPosts.some(p => p.id === postId)) continue;

      try {
        const postUrl = `https://api.beehiiv.com/v2/publications/${pubId}/posts/${postId}?expand[]=stats`;
        const postRes = await fetch(postUrl, { headers });
        if (postRes.ok) {
          const postData = await postRes.json();
          if (postData.data) updatedPosts.push(postData.data);
        }
      } catch {
        // Skip failed individual fetches silently
      }
    }

    // Combine: latest page + individually refreshed known posts
    const allPosts = [...latestPosts, ...updatedPosts];

    return res.status(200).json({
      posts: allPosts,
      totalFetched: allPosts.length,
      newChecked: latestPosts.length,
      existingRefreshed: updatedPosts.length,
    });
  } catch (err) {
    return res.status(500).json({ error: `Server error: ${err.message}` });
  }
}
