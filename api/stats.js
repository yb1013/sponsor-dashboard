// ─── Dormant count cache (persists across warm invocations) ───
let cachedDormantCount = null;
let dormantCacheTimestamp = 0;
const DORMANT_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

async function getDormantCount(pubId, apiKey) {
  const now = Date.now();
  if (cachedDormantCount !== null && (now - dormantCacheTimestamp) < DORMANT_CACHE_TTL) {
    console.log('[stats] Using cached dormant count:', cachedDormantCount);
    return cachedDormantCount;
  }

  const headers = { Authorization: `Bearer ${apiKey}` };

  // Approach A: custom_fields bracket notation
  try {
    console.log('[stats] Trying Approach A: custom_fields[dormant]=true');
    const res = await fetch(
      `https://api.beehiiv.com/v2/publications/${pubId}/subscriptions?status=active&custom_fields[dormant]=true&limit=1`,
      { headers }
    );
    const data = await res.json();
    console.log('[stats] Approach A response:', JSON.stringify(data).slice(0, 500));
    if (data.total_results !== undefined) {
      cachedDormantCount = data.total_results;
      dormantCacheTimestamp = now;
      console.log('[stats] Approach A worked! dormantCount:', cachedDormantCount);
      return cachedDormantCount;
    }
    console.log('[stats] Approach A: no total_results field');
  } catch (e) {
    console.log('[stats] Approach A failed:', e.message);
  }

  // Approach B: flat query param syntax
  try {
    console.log('[stats] Trying Approach B: custom_field_dormant=true');
    const res = await fetch(
      `https://api.beehiiv.com/v2/publications/${pubId}/subscriptions?status=active&custom_field_dormant=true&limit=1`,
      { headers }
    );
    const data = await res.json();
    console.log('[stats] Approach B response:', JSON.stringify(data).slice(0, 500));
    if (data.total_results !== undefined) {
      cachedDormantCount = data.total_results;
      dormantCacheTimestamp = now;
      console.log('[stats] Approach B worked! dormantCount:', cachedDormantCount);
      return cachedDormantCount;
    }
    console.log('[stats] Approach B: no total_results field');
  } catch (e) {
    console.log('[stats] Approach B failed:', e.message);
  }

  // Approach C: segments endpoint
  try {
    console.log('[stats] Trying Approach C: segments endpoint');
    const res = await fetch(
      `https://api.beehiiv.com/v2/publications/${pubId}/segments`,
      { headers }
    );
    const data = await res.json();
    console.log('[stats] Approach C response:', JSON.stringify(data).slice(0, 500));
    const segments = data.data || [];
    const dormantSegment = segments.find(s =>
      (s.name || '').toLowerCase().includes('dormant')
    );
    if (dormantSegment) {
      const count = dormantSegment.total_results || dormantSegment.subscriber_count || dormantSegment.count || 0;
      cachedDormantCount = count;
      dormantCacheTimestamp = now;
      console.log('[stats] Approach C worked! Segment:', dormantSegment.name, 'dormantCount:', count);
      return cachedDormantCount;
    }
    console.log('[stats] Approach C: no dormant segment found. Segments:', segments.map(s => s.name));
  } catch (e) {
    console.log('[stats] Approach C failed:', e.message);
  }

  // Approach D: pagination is too slow for 37K+ subs — skip
  console.warn('[stats] All approaches failed. Could not calculate dormant count.');
  return null;
}

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

    // Fetch publication stats and recent newsletter posts in parallel
    const [pubRes, postsRes] = await Promise.all([
      fetch(`https://api.beehiiv.com/v2/publications/${pubId}?expand[]=stats`, { headers }),
      fetch(`https://api.beehiiv.com/v2/publications/${pubId}/posts?status=confirmed&content_tags[]=newsletter&limit=20&expand[]=stats&order_by=publish_date&direction=desc`, { headers }),
    ]);

    const pubData = await pubRes.json();
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

    const activeSubscribers = pubData?.data?.stats?.active_subscriptions || 0;

    // Calculate engaged moms (total active minus dormant)
    const dormantCount = await getDormantCount(pubId, apiKey);
    const engagedMoms = dormantCount !== null ? activeSubscribers - dormantCount : null;

    console.log('[stats] activeSubscribers:', activeSubscribers);
    console.log('[stats] dormantCount:', dormantCount);
    console.log('[stats] engagedMoms:', engagedMoms);

    return res.status(200).json({
      activeSubscribers,
      dormantCount,
      engagedMoms,
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
