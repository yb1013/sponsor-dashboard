import { verifyToken } from "./_verify.js";

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authToken = (req.headers.authorization || "").replace("Bearer ", "");
  if (!await verifyToken(authToken)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { apiKey, pubId, maxPages = 5 } = req.body;

  if (!apiKey || !pubId) {
    return res.status(400).json({ error: 'Missing apiKey or pubId' });
  }

  // Cap at 50 pages (500 posts) to avoid mega-timeouts
  const pageLimit = Math.min(Math.max(1, maxPages), 50);

  try {
    let allPosts = [];
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages && page <= pageLimit) {
      const url = `https://api.beehiiv.com/v2/publications/${pubId}/posts?expand[]=stats&status=confirmed&platform=all&limit=10&page=${page}&order_by=publish_date&direction=desc&content_tags[]=newsletter`;

      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const body = await response.text();
        // Return what we have so far instead of failing completely
        if (allPosts.length > 0) {
          return res.status(200).json({
            posts: allPosts,
            totalFetched: allPosts.length,
            totalAvailable: totalPages * 10,
            warning: `Stopped at page ${page - 1} due to API error: ${body.slice(0, 100)}`,
          });
        }
        return res.status(response.status).json({
          error: `Beehiiv API error ${response.status}: ${body.slice(0, 300)}`,
        });
      }

      const data = await response.json();
      allPosts = allPosts.concat(data.data || []);
      totalPages = data.total_pages || 1;
      page++;
    }

    return res.status(200).json({
      posts: allPosts,
      totalFetched: allPosts.length,
      totalAvailable: totalPages * 10,
      pagesScanned: page - 1,
      totalPages,
    });
  } catch (err) {
    return res.status(500).json({ error: `Server error: ${err.message}` });
  }
}
