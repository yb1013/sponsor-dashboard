import { Redis } from "@upstash/redis";
import { verifyToken } from "./verify.js";

const KV_KEY = "packages-config";

function getDefaults() {
  return {
    engagedReaders: 31000,
    uniqueOpenRate: 75,
    totalOpenRate: "90-110%",
    instagramFollowers: 6081,
    facebookFollowers: 14000,
    demographics: [
      "100% moms, aged 22-45",
      "94% in the USA, with 6% in Canada, Australia, and the UK",
      "Interests: Baby/toddler gear, health & wellness, family finances, education, food & nutrition, home organization, and self-care",
    ],
    pavedRebookRate: 92,
    pavedPopularRank: 1,
    pavedReviewedRank: 2,
    avgCpcPerformance: 1.53,
    brandPartners: [
      "Netflix", "Instacart", "Canva", "Betterment", "UPPAbaby",
      "BabyBjörn", "Nanit", "Evenflo", "Blinkist", "Mockingbird", "ResortPass",
    ],
    testimonials: [
      { quote: "I love the content and am obsessed with it all. It gives me inspiration for the future.. not only for my marriage, my kids, but my career as well.", name: "Amy Ballou" },
      { quote: "I absolutely love the newsletter. I love all the sections and have them saved in a folder on my email so I can go back and read them.", name: "Sarah Snyder" },
      { quote: "I feel like I'm talking to another Mom who's saying, 'have you heard about this? Isn't it cool?'", name: "Mary Hoerchler" },
    ],
    liveExamples: [
      { title: "ResortPass", url: "https://newsletter.themommy.news/p/ipad-holder-car-organizer-tidy-travel", cpc: "$1.53/click" },
    ],
    baseRatePerPlacement: 750,
    takeoverPremiumPerPlacement: 200,
    tiers: {
      starter: {
        name: "Starter",
        tagline: "For brands testing newsletter sponsorship for the first time.",
        placements: 6,
        price: 3500,
        features: [
          "Standard placement position",
          "Live performance dashboard",
        ],
        includeSocial: false,
        socialDetails: null,
        includeExclusivity: false,
        includeTakeoverOption: false,
        valueStack: [
          { label: "6 Newsletter Placements", value: 4500 },
          { label: "Performance Dashboard", value: 500 },
        ],
      },
      growth: {
        name: "Growth",
        tagline: "For brands ready to own their category.",
        placements: 12,
        price: 7500,
        recommended: true,
        features: [
          "Primary placement (top of email)",
          "Category exclusivity for contract period",
          "2 Instagram stories + 2 Facebook posts",
          "Live performance dashboard + mid-campaign report",
        ],
        includeSocial: true,
        socialDetails: "2 Instagram stories + 2 Facebook posts",
        includeExclusivity: true,
        includeTakeoverOption: true,
        takeoverPrice: 9900,
        valueStack: [
          { label: "12 Newsletter Placements", value: 9000 },
          { label: "Primary Placement", value: 1200 },
          { label: "Category Exclusivity", value: 1500 },
          { label: "2 IG Stories + 2 FB Posts", value: 800 },
          { label: "Dashboard + Mid-Campaign Report", value: 500 },
        ],
      },
      partner: {
        name: "Partner",
        tagline: "For brands that want to become synonymous with The Mommy.",
        placements: 24,
        price: 15000,
        features: [
          "Exclusive placement (sole sponsor per issue)",
          "Primary placement on every send",
          "Category exclusivity for the full year",
          "4 Instagram posts + 4 Instagram stories",
          "Welcome sequence integration",
          "1 dedicated send (entire email is your content)",
          "Live performance dashboard + quarterly reports",
          "Direct access for campaign strategy",
        ],
        includeSocial: true,
        socialDetails: "4 Instagram posts + 4 Instagram stories",
        includeExclusivity: true,
        includeTakeoverOption: true,
        takeoverPrice: 19800,
        valueStack: [
          { label: "24 Newsletter Placements", value: 18000 },
          { label: "Exclusive Placement", value: 2400 },
          { label: "Primary Placement", value: 2400 },
          { label: "Category Exclusivity (full year)", value: 3000 },
          { label: "4 IG Posts + 4 IG Stories", value: 1600 },
          { label: "Welcome Sequence Integration", value: 1500 },
          { label: "1 Dedicated Send", value: 1500 },
          { label: "Dashboard + Quarterly Reports", value: 500 },
          { label: "Campaign Strategy Access", value: 500 },
        ],
      },
    },
    pricingMilestones: [
      { subscribers: 40000, adjustment: 0 },
      { subscribers: 45000, adjustment: 100 },
      { subscribers: 50000, adjustment: 200 },
      { subscribers: 55000, adjustment: 300 },
    ],
    cancellationPolicy: "Cancel with 30 days' notice. Unused placements are refunded on a prorated basis. No penalties, no fine print.",
    guaranteeMultiplier: 0.6,
    contactEmail: "",
    calendlyUrl: "",
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();

  const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });

  if (req.method === "GET") {
    try {
      const data = await redis.get(KV_KEY);
      return res.status(200).json(data || getDefaults());
    } catch {
      return res.status(200).json(getDefaults());
    }
  }

  if (req.method === "POST") {
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    if (!(await verifyToken(token))) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      await redis.set(KV_KEY, JSON.stringify(req.body));
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === "DELETE") {
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    if (!(await verifyToken(token))) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      await redis.del(KV_KEY);
      return res.status(200).json({ ok: true, defaults: getDefaults() });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
