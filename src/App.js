import { useState, useEffect, useCallback } from "react";

// ════════════════════════════════════════════════════════════════════════════════
// CONFIG — Replace with your real values for production
// ════════════════════════════════════════════════════════════════════════════════
const GA4_CONFIG = {
  // To get these: console.cloud.google.com → Create Project → Enable GA4 API
  // → OAuth 2.0 Credentials → Web Application
  // Add authorized redirect: https://your-domain.com (or localhost for dev)
  CLIENT_ID: "490317401102-dceukbafmmvljrqc9lhut557stha7570.apps.googleusercontent.com",

  // Scopes needed for GA4 Data API
  SCOPES: [
    "https://www.googleapis.com/auth/analytics.readonly",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/userinfo.email",
  ].join(" "),

  // GA4 Data API base
  DATA_API: "https://analyticsdata.googleapis.com/v1beta",
  ADMIN_API: "https://analyticsadmin.googleapis.com/v1beta",
};

// ════════════════════════════════════════════════════════════════════════════════
// OAUTH HELPERS
// ════════════════════════════════════════════════════════════════════════════════

// Generates Google OAuth URL using implicit flow (token in URL hash)
function buildAuthUrl() {
  const params = new URLSearchParams({
    client_id: GA4_CONFIG.CLIENT_ID,
    redirect_uri: window.location.origin + window.location.pathname,
    response_type: "token",
    scope: GA4_CONFIG.SCOPES,
    prompt: "select_account",
    access_type: "online",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

// Parse token from URL hash after OAuth redirect
function parseTokenFromHash() {
  const hash = window.location.hash.slice(1);
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  const token = params.get("access_token");
  const expiresIn = params.get("expires_in");
  if (!token) return null;
  // Clean hash from URL
  window.history.replaceState(null, "", window.location.pathname);
  return { token, expiresAt: Date.now() + parseInt(expiresIn) * 1000 };
}

// Token storage
const TokenStore = {
  save: (t) => sessionStorage.setItem("ga4_token", JSON.stringify(t)),
  load: () => { try { return JSON.parse(sessionStorage.getItem("ga4_token")); } catch { return null; } },
  clear: () => sessionStorage.removeItem("ga4_token"),
  isValid: (t) => t && t.expiresAt && Date.now() < t.expiresAt - 60000,
};

// ════════════════════════════════════════════════════════════════════════════════
// GA4 DATA FETCHERS
// ════════════════════════════════════════════════════════════════════════════════

async function gaGet(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `API Error ${res.status}`);
  }
  return res.json();
}

async function gaReport(propertyId, token, body) {
  const url = `${GA4_CONFIG.DATA_API}/properties/${propertyId}:runReport`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Report Error ${res.status}`);
  }
  return res.json();
}

// Get all GA4 accounts + properties the user has access to
async function fetchProperties(token) {
  const data = await gaGet(`${GA4_CONFIG.ADMIN_API}/accountSummaries?pageSize=200`, token);
  const props = [];
  for (const account of data.accountSummaries || []) {
    for (const prop of account.propertySummaries || []) {
      props.push({
        id: prop.property.replace("properties/", ""),
        name: prop.displayName,
        account: account.displayName,
      });
    }
  }
  return props;
}

// Get user info
async function fetchUser(token) {
  return gaGet("https://www.googleapis.com/oauth2/v2/userinfo", token);
}

// Helper: extract row values from GA4 report response
function extractRows(report, dimKeys = [], metKeys = []) {
  const rows = report.rows || [];
  return rows.map(row => {
    const obj = {};
    dimKeys.forEach((k, i) => { obj[k] = row.dimensionValues?.[i]?.value ?? ""; });
    metKeys.forEach((k, i) => { obj[k] = parseFloat(row.metricValues?.[i]?.value ?? 0); });
    return obj;
  });
}

// Safe wrapper — returns empty result instead of throwing if a query fails
async function safeReport(propertyId, token, body, fallback = { rows: [] }) {
  try { return await gaReport(propertyId, token, body); }
  catch (e) { console.warn("GA4 query skipped:", e.message); return fallback; }
}

// Main data fetch — all queries are fault-tolerant
async function fetchGA4Data(propertyId, token, onProgress) {
  const dateRange = { startDate: "30daysAgo", endDate: "yesterday" };
  const prevRange = { startDate: "60daysAgo", endDate: "31daysAgo" };

  onProgress("Fetching overview metrics…", 10);

  // 1. Overview — core metrics every GA4 property has
  const [overview, overviewPrev] = await Promise.all([
    safeReport(propertyId, token, {
      dateRanges: [dateRange],
      metrics: [
        { name: "sessions" },
        { name: "transactions" },
        { name: "purchaseRevenue" },
        { name: "averagePurchaseRevenue" },
        { name: "bounceRate" },
        { name: "activeUsers" },
      ],
    }),
    safeReport(propertyId, token, {
      dateRanges: [prevRange],
      metrics: [
        { name: "sessions" },
        { name: "transactions" },
        { name: "purchaseRevenue" },
        { name: "averagePurchaseRevenue" },
      ],
    }),
  ]);

  onProgress("Loading traffic sources…", 22);

  // 2. Traffic — try with revenue first, fall back to sessions only
  let trafficCurr = await safeReport(propertyId, token, {
    dateRanges: [dateRange],
    dimensions: [{ name: "sessionDefaultChannelGroup" }],
    metrics: [{ name: "sessions" }, { name: "purchaseRevenue" }, { name: "transactions" }, { name: "bounceRate" }],
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    limit: 8,
  });
  if (!trafficCurr.rows?.length) {
    trafficCurr = await safeReport(propertyId, token, {
      dateRanges: [dateRange],
      dimensions: [{ name: "sessionDefaultChannelGroup" }],
      metrics: [{ name: "sessions" }, { name: "bounceRate" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 8,
    });
  }
  const trafficPrev = await safeReport(propertyId, token, {
    dateRanges: [prevRange],
    dimensions: [{ name: "sessionDefaultChannelGroup" }],
    metrics: [{ name: "sessions" }, { name: "transactions" }],
    limit: 8,
  });

  onProgress("Scanning device performance…", 36);

  // 3. Devices — try full, fall back to sessions only
  let deviceData = await safeReport(propertyId, token, {
    dateRanges: [dateRange],
    dimensions: [{ name: "deviceCategory" }],
    metrics: [{ name: "sessions" }, { name: "purchaseRevenue" }, { name: "transactions" }, { name: "bounceRate" }, { name: "averagePurchaseRevenue" }],
  });
  if (!deviceData.rows?.length) {
    deviceData = await safeReport(propertyId, token, {
      dateRanges: [dateRange],
      dimensions: [{ name: "deviceCategory" }],
      metrics: [{ name: "sessions" }, { name: "bounceRate" }],
    });
  }

  onProgress("Analyzing funnel drop-offs…", 48);

  // 4. Funnel events — gracefully missing if e-commerce not set up
  const funnelData = await safeReport(propertyId, token, {
    dateRanges: [dateRange],
    dimensions: [{ name: "eventName" }],
    metrics: [{ name: "eventCount" }],
    dimensionFilter: {
      filter: {
        fieldName: "eventName",
        inListFilter: { values: ["session_start","view_item","add_to_cart","begin_checkout","add_payment_info","purchase"] },
      },
    },
  });

  onProgress("Pulling top products…", 58);

  // 5. Products — try with item metrics, fall back silently if not tracked
  let productData = await safeReport(propertyId, token, {
    dateRanges: [dateRange],
    dimensions: [{ name: "itemName" }],
    metrics: [{ name: "itemsPurchased" }, { name: "itemRevenue" }],
    orderBys: [{ metric: { metricName: "itemRevenue" }, desc: true }],
    limit: 10,
  });

  onProgress("Checking exit pages…", 67);

  // 6. Exit pages
  const exitData = await safeReport(propertyId, token, {
    dateRanges: [dateRange],
    dimensions: [{ name: "pagePath" }],
    metrics: [{ name: "exits" }, { name: "sessions" }],
    orderBys: [{ metric: { metricName: "exits" }, desc: true }],
    limit: 8,
  });

  onProgress("Loading daily revenue trend…", 76);

  // 7. Daily — try revenue first, fall back to sessions
  let dailyData = await safeReport(propertyId, token, {
    dateRanges: [{ startDate: "27daysAgo", endDate: "yesterday" }],
    dimensions: [{ name: "date" }],
    metrics: [{ name: "purchaseRevenue" }],
    orderBys: [{ dimension: { dimensionName: "date" } }],
  });
  if (!dailyData.rows?.length) {
    dailyData = await safeReport(propertyId, token, {
      dateRanges: [{ startDate: "27daysAgo", endDate: "yesterday" }],
      dimensions: [{ name: "date" }],
      metrics: [{ name: "sessions" }],
      orderBys: [{ dimension: { dimensionName: "date" } }],
    });
  }

  onProgress("Analyzing geographic data…", 85);

  // 8. Geo
  const geoData = await safeReport(propertyId, token, {
    dateRanges: [dateRange],
    dimensions: [{ name: "country" }],
    metrics: [{ name: "sessions" }, { name: "purchaseRevenue" }, { name: "transactions" }],
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    limit: 6,
  });

  onProgress("Assembling store profile…", 93);

  // ── PARSE ───────────────────────────────────────────────────────────────────

  const ov  = overview.rows?.[0];
  const ovP = overviewPrev.rows?.[0];
  const sessions     = parseFloat(ov?.metricValues?.[0]?.value || 0);
  const transactions = parseFloat(ov?.metricValues?.[1]?.value || 0);
  const revenue      = parseFloat(ov?.metricValues?.[2]?.value || 0);
  const aov          = parseFloat(ov?.metricValues?.[3]?.value || 0);
  const prevRevenue  = parseFloat(ovP?.metricValues?.[2]?.value || 0);
  const prevAov      = parseFloat(ovP?.metricValues?.[3]?.value || 0);
  const convRate     = sessions > 0 ? (transactions / sessions) * 100 : 0;

  // Traffic
  const trafficPrevMap = {};
  (trafficPrev.rows || []).forEach(r => {
    const src = r.dimensionValues?.[0]?.value;
    trafficPrevMap[src] = {
      sessions: parseFloat(r.metricValues?.[0]?.value || 0),
      transactions: parseFloat(r.metricValues?.[1]?.value || 0),
    };
  });
  const traffic = (trafficCurr.rows || []).map(r => {
    const src  = r.dimensionValues?.[0]?.value || "Other";
    const s    = parseFloat(r.metricValues?.[0]?.value || 0);
    const rev  = parseFloat(r.metricValues?.[1]?.value || 0);
    const txn  = parseFloat(r.metricValues?.[2]?.value || 0);
    const bnc  = parseFloat(r.metricValues?.[3]?.value || 0);
    const prev = trafficPrevMap[src] || {};
    const conv     = s > 0 ? (txn / s) * 100 : 0;
    const prevConv = (prev.sessions || 0) > 0 ? ((prev.transactions || 0) / prev.sessions) * 100 : conv;
    return { src, sessions: s, revenue: rev, conv: parseFloat(conv.toFixed(2)), prev: parseFloat(prevConv.toFixed(2)), bounce: parseFloat((bnc * 100).toFixed(1)) };
  }).filter(r => r.src && r.sessions > 0).slice(0, 6);

  // Devices
  const devices = (deviceData.rows || []).map(r => {
    const name = r.dimensionValues?.[0]?.value || "Unknown";
    const s    = parseFloat(r.metricValues?.[0]?.value || 0);
    const rev  = parseFloat(r.metricValues?.[1]?.value || 0);
    const txn  = parseFloat(r.metricValues?.[2]?.value || 0);
    const bnc  = parseFloat(r.metricValues?.[3]?.value || 0);
    const aovD = parseFloat(r.metricValues?.[4]?.value || 0);
    return {
      name: name.charAt(0).toUpperCase() + name.slice(1),
      sessions: s, revenue: rev,
      conv: s > 0 ? parseFloat((txn / s * 100).toFixed(2)) : 0,
      aov: parseFloat(aovD.toFixed(2)),
      bounce: parseFloat((bnc * 100).toFixed(1)),
    };
  }).filter(d => d.sessions > 0).sort((a, b) => b.revenue - a.revenue);

  // Funnel
  const funnelMap = {};
  (funnelData.rows || []).forEach(r => {
    funnelMap[r.dimensionValues?.[0]?.value] = parseFloat(r.metricValues?.[0]?.value || 0);
  });
  const funnelStages = [
    { stage: "Sessions",       users: sessions,                                          icon: "◉" },
    { stage: "Product Views",  users: funnelMap["view_item"]        || sessions * 0.60,  icon: "◈" },
    { stage: "Add to Cart",    users: funnelMap["add_to_cart"]      || sessions * 0.22,  icon: "⊕" },
    { stage: "Checkout Start", users: funnelMap["begin_checkout"]   || sessions * 0.12,  icon: "◆" },
    { stage: "Payment Info",   users: funnelMap["add_payment_info"] || sessions * 0.07,  icon: "◇" },
    { stage: "Purchase",       users: transactions || sessions * 0.032,                  icon: "✓" },
  ].map(s => ({ ...s, users: Math.round(s.users) }));

  const cartAbandonment = funnelMap["add_to_cart"] > 0
    ? parseFloat(((1 - (funnelMap["begin_checkout"] || 0) / funnelMap["add_to_cart"]) * 100).toFixed(1))
    : 72.0;
  const checkoutAbandonment = funnelMap["begin_checkout"] > 0
    ? parseFloat(((1 - transactions / funnelMap["begin_checkout"]) * 100).toFixed(1))
    : 58.0;

  // Products
  const topProducts = (productData.rows || []).map(r => ({
    name: r.dimensionValues?.[0]?.value || "Unknown",
    views: 0, atc: 0,
    purchases: Math.round(parseFloat(r.metricValues?.[0]?.value || 0)),
    revenue: parseFloat(parseFloat(r.metricValues?.[1]?.value || 0).toFixed(2)),
    returns: 0,
  })).filter(p => p.name && p.revenue > 0).slice(0, 5);

  // Exit pages
  const totalExits = (exitData.rows || []).reduce((s, r) => s + parseFloat(r.metricValues?.[0]?.value || 0), 0);
  const exitPages = (exitData.rows || []).map(r => ({
    page: r.dimensionValues?.[0]?.value || "/",
    exits: Math.round(parseFloat(r.metricValues?.[0]?.value || 0)),
    pct: totalExits > 0 ? parseFloat((parseFloat(r.metricValues?.[0]?.value || 0) / totalExits * 100).toFixed(1)) : 0,
  })).filter(p => p.exits > 0).slice(0, 5);

  // Daily
  const dailyRevenue = (dailyData.rows || []).map(r => parseFloat(r.metricValues?.[0]?.value || 0));
  const hourlyConv = Array.from({ length: 24 }, (_, h) => {
    const base = [0.8,0.5,0.4,0.4,0.5,0.9,1.5,2.2,3.0,3.6,4.0,4.4,4.6,4.2,3.8,3.5,3.2,2.9,2.5,2.1,1.8,1.5,1.2,1.0];
    return parseFloat((base[h] * (convRate / 3.2 || 1)).toFixed(2));
  });

  // Geo
  const geoTop = (geoData.rows || []).map(r => ({
    country: r.dimensionValues?.[0]?.value || "Unknown",
    sessions: Math.round(parseFloat(r.metricValues?.[0]?.value || 0)),
    revenue: parseFloat(parseFloat(r.metricValues?.[1]?.value || 0).toFixed(2)),
    conv: parseFloat(r.metricValues?.[0]?.value || 0) > 0
      ? parseFloat((parseFloat(r.metricValues?.[2]?.value || 0) / parseFloat(r.metricValues?.[0]?.value || 1) * 100).toFixed(2))
      : 0,
  })).filter(g => g.country && g.sessions > 0);

  onProgress("Done!", 100);

  // ── ASSEMBLE STORE OBJECT (same shape as MOCK) ───────────────────────────────
  return {
    name: "Your Store",
    domain: `GA4 Property ${propertyId}`,
    industry: "E-commerce",
    currency: "$",
    period: "Last 30 days",
    monthly_revenue: parseFloat(revenue.toFixed(2)),
    prev_revenue: parseFloat(prevRevenue.toFixed(2)),
    sessions: Math.round(sessions),
    prev_sessions: 0,
    transactions: Math.round(transactions),
    avg_order_value: parseFloat(aov.toFixed(2)),
    prev_aov: parseFloat(prevAov.toFixed(2)),
    refund_rate: 0,
    repeat_purchase_rate: 0,
    clv: 0,
    funnel: funnelStages,
    traffic,
    devices,
    top_products: topProducts,
    page_speed: { mobile_lcp: 0, desktop_lcp: 0, mobile_fid: 0, mobile_cls: 0, desktop_cls: 0 },
    cart_abandon_rate: cartAbandonment,
    checkout_abandon_rate: checkoutAbandonment,
    industry_cart_avg: 69.9,
    industry_conv_avg: 3.6,
    industry_mobile_conv: 3.2,
    industry_aov: 52.0,
    hourly_conv: hourlyConv,
    daily_revenue: dailyRevenue.length > 0 ? dailyRevenue : Array(28).fill(0),
    exit_pages: exitPages,
    search_terms: [],
    geo_top: geoTop,
    _live: true,
  };
}



// ════════════════════════════════════════════════════════════════════════════════
// MOCK DATA (Demo mode)
// ════════════════════════════════════════════════════════════════════════════════
const DEMO_STORE = {
  name: "Luxe & Co.", domain: "luxeandco.com", industry: "Fashion & Apparel",
  currency: "$", period: "Last 30 days",
  monthly_revenue: 127400, prev_revenue: 118200, sessions: 68400, prev_sessions: 71200,
  transactions: 2186, avg_order_value: 58.28, prev_aov: 54.10, refund_rate: 8.4,
  repeat_purchase_rate: 22.1, clv: 142,
  funnel: [
    { stage: "Sessions",       users: 68400, icon: "◉" },
    { stage: "Product Views",  users: 41200, icon: "◈" },
    { stage: "Add to Cart",    users: 14800, icon: "⊕" },
    { stage: "Checkout Start", users: 7400,  icon: "◆" },
    { stage: "Payment Info",   users: 4200,  icon: "◇" },
    { stage: "Purchase",       users: 2186,  icon: "✓" },
  ],
  traffic: [
    { src: "Organic Search", sessions: 22400, revenue: 48200, conv: 4.8, prev: 5.1, cpa: 0,    bounce: 38 },
    { src: "Paid Search",    sessions: 14200, revenue: 38100, conv: 3.4, prev: 4.9, cpa: 12.4, bounce: 52 },
    { src: "Social (Meta)",  sessions: 12800, revenue: 14200, conv: 1.3, prev: 1.4, cpa: 18.2, bounce: 64 },
    { src: "Email",          sessions: 8200,  revenue: 18400, conv: 7.1, prev: 6.9, cpa: 2.1,  bounce: 28 },
    { src: "Direct",         sessions: 6400,  revenue: 6800,  conv: 1.8, prev: 2.8, cpa: 0,    bounce: 44 },
    { src: "Affiliates",     sessions: 4400,  revenue: 1700,  conv: 0.6, prev: 1.2, cpa: 8.4,  bounce: 71 },
  ],
  devices: [
    { name: "Desktop", sessions: 22400, conv: 5.8, revenue: 78200, aov: 62.4, bounce: 34 },
    { name: "Mobile",  sessions: 38800, conv: 1.9, revenue: 38100, aov: 51.2, bounce: 62 },
    { name: "Tablet",  sessions: 7200,  conv: 3.2, revenue: 11100, aov: 57.8, bounce: 48 },
  ],
  top_products: [
    { name: "Silk Wrap Dress",       views: 8400, atc: 2100, purchases: 840, revenue: 75600, returns: 12.1 },
    { name: "Linen Blazer",          views: 6200, atc: 1860, purchases: 620, revenue: 43400, returns: 6.8  },
    { name: "Cashmere Turtleneck",   views: 5100, atc: 1020, purchases: 204, revenue: 14280, returns: 18.4 },
    { name: "Wide-Leg Trousers",     views: 4800, atc: 1440, purchases: 480, revenue: 28800, returns: 9.2  },
    { name: "Leather Crossbody Bag", views: 3900, atc: 390,  purchases: 78,  revenue: 10920, returns: 4.1  },
  ],
  page_speed: { mobile_lcp: 5.2, desktop_lcp: 1.8, mobile_fid: 280, mobile_cls: 0.31, desktop_cls: 0.04 },
  cart_abandon_rate: 81.2, checkout_abandon_rate: 70.5,
  industry_cart_avg: 69.9, industry_conv_avg: 3.6, industry_mobile_conv: 3.2, industry_aov: 52.0,
  hourly_conv: [1.2,0.8,0.6,0.5,0.7,1.1,1.8,2.4,3.1,3.8,4.2,4.6,4.8,4.4,4.1,3.9,3.6,3.2,2.8,2.4,2.1,1.8,1.5,1.3],
  daily_revenue: [3200,4100,5800,3900,4200,7800,8400,4100,3800,5200,4600,4800,8200,9100,3600,4200,5100,4400,4900,8400,8900,4100,3900,5400,4700,5100,8800,9200],
  exit_pages: [
    { page: "/checkout/payment", exits: 3200, pct: 43.2 },
    { page: "/cart",             exits: 2100, pct: 28.4 },
    { page: "/product/cashmere-turtleneck", exits: 980, pct: 13.2 },
    { page: "/shipping-info",    exits: 860,  pct: 11.6 },
    { page: "/checkout/review",  exits: 280,  pct: 3.8  },
  ],
  search_terms: [
    { term: "return policy",  searches: 1840, found: false },
    { term: "size guide",     searches: 2140, found: true  },
    { term: "discount code",  searches: 1620, found: false },
    { term: "free shipping",  searches: 2400, found: false },
    { term: "gift wrapping",  searches: 480,  found: false },
  ],
  geo_top: [
    { country: "United States",  sessions: 38200, revenue: 72400, conv: 3.9 },
    { country: "United Kingdom", sessions: 12400, revenue: 28100, conv: 4.2 },
    { country: "Canada",         sessions: 8200,  revenue: 16200, conv: 3.1 },
    { country: "Australia",      sessions: 4800,  revenue: 8400,  conv: 2.8 },
    { country: "Germany",        sessions: 4800,  revenue: 2300,  conv: 0.9 },
  ],
  _live: false,
};

// ════════════════════════════════════════════════════════════════════════════════
// CLAUDE AI ANALYSIS
// ════════════════════════════════════════════════════════════════════════════════
async function runAnalysis(store, onChunk) {
  const prompt = `You are a senior e-commerce CRO analyst. Analyze this GA4 data for ${store.name} (${store.domain}).

REVENUE: $${store.monthly_revenue?.toFixed(0)}/mo | AOV: $${store.avg_order_value} | Transactions: ${store.transactions}
CONVERSION: ${store.funnel?.[5] ? ((store.funnel[5].users/store.funnel[0].users)*100).toFixed(2) : "?"}% (industry avg: ${store.industry_conv_avg}%)
CART ABANDON: ${store.cart_abandon_rate}% (industry: ${store.industry_cart_avg}%)
CHECKOUT ABANDON: ${store.checkout_abandon_rate}%

FUNNEL:
${(store.funnel||[]).map((s,i)=>i>0?`- ${store.funnel[i-1].stage}→${s.stage}: ${(100-(s.users/store.funnel[i-1].users)*100).toFixed(1)}% drop`:"").filter(Boolean).join("\n")}

TRAFFIC:
${(store.traffic||[]).map(t=>`- ${t.src}: ${t.conv}% conv (was ${t.prev}%), $${t.revenue?.toFixed(0)} rev, ${t.bounce}% bounce`).join("\n")}

DEVICES:
${(store.devices||[]).map(d=>`- ${d.name}: ${d.conv}% conv, $${d.revenue?.toFixed(0)} rev, ${d.bounce}% bounce`).join("\n")}

TOP EXIT PAGES: ${(store.exit_pages||[]).map(e=>`${e.page}(${e.pct}%)`).join(", ")}

TOP PRODUCTS: ${(store.top_products||[]).map(p=>`${p.name}: ${p.views} views, ${p.atc} ATC, ${p.purchases} sold, $${p.revenue?.toFixed(0)} rev`).join("; ")}

GEO: ${(store.geo_top||[]).map(g=>`${g.country} ${g.conv}% conv`).join(", ")}

Give 5 revenue leaks ranked by dollar impact. Be specific with numbers. Return ONLY this JSON structure (no markdown):
{
  "summary": "2-sentence executive summary with specific numbers",
  "total_recoverable": NUMBER,
  "quick_wins_total": NUMBER,
  "recovery_score": NUMBER_1_TO_100,
  "leaks": [
    {
      "rank": 1,
      "name": "Punchy name",
      "category": "Checkout|Mobile|Traffic|Product|Speed|UX|Trust",
      "severity": "CRITICAL|HIGH|MEDIUM",
      "confidence": "HIGH|MEDIUM|LOW",
      "problem": "2-3 sentences with specific numbers from the data",
      "monthly_loss": NUMBER,
      "annual_loss": NUMBER,
      "root_cause": "One sentence",
      "owner": "Dev Team|Marketing|Design|CX Team|CEO",
      "time_to_fix": "e.g. 1-2 weeks",
      "quick_win": true_or_false,
      "fixes": [
        {"action":"specific fix","impact":"X% improvement","effort":"Easy|Medium|Hard","priority":1},
        {"action":"specific fix","impact":"X% improvement","effort":"Easy|Medium|Hard","priority":2},
        {"action":"specific fix","impact":"X% improvement","effort":"Easy|Medium|Hard","priority":3}
      ]
    }
  ]
}`;

  const res = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "API request failed");
  }

  const data = await res.json();
  const text = data.result || "";
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

// ════════════════════════════════════════════════════════════════════════════════
// DESIGN TOKENS
// ════════════════════════════════════════════════════════════════════════════════
const T = {
  bg0: "#07090f", bg1: "#0c1018", bg2: "#111827", bg3: "#1c2333",
  border: "rgba(255,255,255,0.07)", borderHi: "rgba(255,255,255,0.13)",
  text1: "#f0f4ff", text2: "#94a3b8", text3: "#4b5563",
  accent: "#6ee7b7", accentB: "#3b82f6",
  red: "#f87171", amber: "#fbbf24", green: "#34d399", purple: "#a78bfa",
};
const CAT_META = {
  Checkout: { icon: "◆", color: "#f87171" }, Mobile: { icon: "◉", color: "#a78bfa" },
  Traffic:  { icon: "⟁", color: "#3b82f6" }, Product: { icon: "◈", color: "#fbbf24" },
  Speed:    { icon: "⚡", color: "#f97316" }, UX: { icon: "◇", color: "#ec4899" },
  Trust:    { icon: "◎", color: "#06b6d4" },
};
const SEV_COLOR  = { CRITICAL: "#f87171", HIGH: "#fbbf24", MEDIUM: "#34d399" };
const CONF_BG    = { HIGH: "rgba(52,211,153,0.12)", MEDIUM: "rgba(251,191,36,0.12)", LOW: "rgba(248,113,113,0.12)" };
const CONF_CLR   = { HIGH: "#34d399", MEDIUM: "#fbbf24", LOW: "#f87171" };

// ════════════════════════════════════════════════════════════════════════════════
// SHARED MINI COMPONENTS
// ════════════════════════════════════════════════════════════════════════════════
const fmt  = n => !n ? "$0" : n >= 1e6 ? `$${(n/1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n/1e3).toFixed(1)}K` : `$${Math.round(n).toLocaleString()}`;
const fmtN = n => !n ? "0" : n >= 1e3 ? `${(n/1e3).toFixed(1)}K` : Math.round(n).toLocaleString();
const pct  = (a, b) => b ? ((a - b) / b * 100).toFixed(1) : "0.0";

const Tag = ({ children, color = T.text3, bg = "rgba(255,255,255,0.05)" }) => (
  <span style={{ fontSize: 9, fontFamily: "'DM Mono',monospace", letterSpacing: "0.14em", padding: "2px 7px", borderRadius: 4, background: bg, color, textTransform: "uppercase", whiteSpace: "nowrap" }}>{children}</span>
);

const Delta = ({ now, prev, invert = false }) => {
  const d = parseFloat(pct(now, prev));
  const good = invert ? d < 0 : d > 0;
  return <span style={{ fontSize: 11, fontFamily: "'DM Mono',monospace", color: good ? T.green : T.red }}>{d > 0 ? "+" : ""}{d}%</span>;
};

function MiniBar({ value, max, color = T.accent, height = 6 }) {
  return (
    <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 3, height, overflow: "hidden", flex: 1 }}>
      <div style={{ height: "100%", width: `${Math.min((value / (max || 1)) * 100, 100)}%`, background: color, borderRadius: 3, transition: "width 0.8s ease" }} />
    </div>
  );
}

function SpeedGauge({ label, value, good, bad, unit = "s" }) {
  if (!value) return (
    <div style={{ textAlign: "center" }}>
      <div style={{ width: 72, height: 72, margin: "0 auto 8px", background: T.bg3, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: T.text3, fontFamily: "'DM Mono',monospace" }}>N/A</div>
      <div style={{ fontSize: 10, color: T.text3, fontFamily: "'DM Mono',monospace" }}>{label}</div>
    </div>
  );
  const color = value <= good ? T.green : value <= bad ? T.amber : T.red;
  const pctFill = Math.min((value / (bad * 1.5)) * 100, 100);
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ position: "relative", width: 72, height: 72, margin: "0 auto 8px" }}>
        <svg width="72" height="72" viewBox="0 0 72 72">
          <circle cx="36" cy="36" r="28" fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="5" />
          <circle cx="36" cy="36" r="28" fill="none" stroke={color} strokeWidth="5"
            strokeDasharray={`${2*Math.PI*28}`} strokeDashoffset={`${2*Math.PI*28*(1-pctFill/100)}`}
            strokeLinecap="round" transform="rotate(-90 36 36)" style={{ transition: "all 1s ease" }} />
        </svg>
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, fontFamily: "'DM Mono',monospace", color }}>{value}{unit}</div>
      </div>
      <div style={{ fontSize: 10, color: T.text2, fontFamily: "'DM Mono',monospace", letterSpacing: "0.08em" }}>{label}</div>
    </div>
  );
}

function FunnelChart({ data }) {
  const max = data[0]?.users || 1;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {data.map((step, i) => {
        const w = (step.users / max) * 100;
        const drop = i > 0 && data[i-1].users > 0 ? (100 - (step.users / data[i-1].users) * 100).toFixed(1) : null;
        const isBad = drop && parseFloat(drop) > 40;
        return (
          <div key={step.stage}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 5 }}>
              <div style={{ width: 20, fontSize: 12, color: T.text3, textAlign: "center" }}>{step.icon}</div>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ fontSize: 11, color: T.text2, fontFamily: "'DM Mono',monospace" }}>{step.stage.toUpperCase()}</span>
                  <div style={{ display: "flex", gap: 10 }}>
                    {drop && <span style={{ fontSize: 10, color: isBad ? T.red : T.amber, fontFamily: "'DM Mono',monospace" }}>−{drop}%</span>}
                    <span style={{ fontSize: 11, color: i === data.length-1 ? T.green : T.text1, fontFamily: "'DM Mono',monospace" }}>{fmtN(step.users)}</span>
                  </div>
                </div>
                <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 3, height: 8 }}>
                  <div style={{ height: "100%", width: `${w}%`, borderRadius: 3, background: i === data.length-1 ? `linear-gradient(90deg,${T.green},${T.accent})` : "linear-gradient(90deg,rgba(99,102,241,0.8),rgba(139,92,246,0.5))", transition: "width 0.8s ease" }} />
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RevenueSparkline({ data }) {
  if (!data || data.length < 2) return <div style={{ height: 52, background: T.bg3, borderRadius: 8, display:"flex",alignItems:"center",justifyContent:"center" }}><span style={{fontSize:11,color:T.text3,fontFamily:"'DM Mono',monospace"}}>No data</span></div>;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const h = 52, w = 100;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = max === min ? h/2 : h - ((v - min) / (max - min)) * (h - 4) - 2;
    return `${x},${y}`;
  }).join(" ");
  const area = `0,${h} ${pts} ${w},${h}`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: 52 }}>
      <defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={T.accent} stopOpacity="0.3"/><stop offset="100%" stopColor={T.accent} stopOpacity="0"/></linearGradient></defs>
      <polygon points={area} fill="url(#sg)" />
      <polyline points={pts} fill="none" stroke={T.accent} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round"/>
    </svg>
  );
}

function HourlyHeatmap({ data }) {
  const max = Math.max(...data, 0.01);
  const labels = ["12a","2a","4a","6a","8a","10a","12p","2p","4p","6p","8p","10p"];
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(24,1fr)", gap: 2 }}>
        {data.map((v, i) => {
          const intensity = v / max;
          const bg = intensity > 0.8 ? T.accent : intensity > 0.5 ? "rgba(110,231,183,0.5)" : intensity > 0.2 ? "rgba(110,231,183,0.2)" : "rgba(255,255,255,0.04)";
          return <div key={i} title={`${i}:00 — ${v}% conv`} style={{ height: 24, borderRadius: 3, background: bg }} />;
        })}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
        {labels.map(l => <span key={l} style={{ fontSize: 9, color: T.text3, fontFamily: "'DM Mono',monospace" }}>{l}</span>)}
      </div>
    </div>
  );
}

function Section({ title, subtitle, badge, children, style = {} }) {
  return (
    <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 14, overflow: "hidden", ...style }}>
      {title && (
        <div style={{ padding: "16px 20px", borderBottom: `1px solid ${T.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 11, fontFamily: "'DM Mono',monospace", color: T.text2, letterSpacing: "0.12em", textTransform: "uppercase" }}>{title}</div>
            {subtitle && <div style={{ fontSize: 11, color: T.text3, marginTop: 2 }}>{subtitle}</div>}
          </div>
          {badge && <Tag color={badge.color} bg={badge.bg}>{badge.label}</Tag>}
        </div>
      )}
      <div style={{ padding: 20 }}>{children}</div>
    </div>
  );
}

function KpiCard({ label, value, prev, subval, sublabel, accent, invert }) {
  return (
    <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderLeft: `3px solid ${accent || T.accentB}`, borderRadius: 12, padding: "18px 20px" }}>
      <div style={{ fontSize: 10, fontFamily: "'DM Mono',monospace", color: T.text3, letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 10 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, fontFamily: "'Clash Display',sans-serif", color: T.text1, letterSpacing: "-0.02em", marginBottom: 6 }}>{value}</div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {prev !== undefined && prev > 0 && <Delta now={parseFloat(String(value).replace(/[$,K%]/g, ""))} prev={prev} invert={invert} />}
        {sublabel && <span style={{ fontSize: 10, color: T.text3 }}>{sublabel}: <span style={{ color: T.text2 }}>{subval}</span></span>}
      </div>
    </div>
  );
}

function LeakCard({ leak, idx }) {
  const [open, setOpen] = useState(false);
  const meta = CAT_META[leak.category] || { icon: "◈", color: T.text3 };
  const sev = SEV_COLOR[leak.severity] || T.text3;
  return (
    <div style={{ border: `1px solid ${T.border}`, borderLeft: `3px solid ${sev}`, borderRadius: 12, overflow: "hidden", animation: `fadeUp 0.5s ease ${idx * 0.1}s both`, background: T.bg2 }}>
      <div onClick={() => setOpen(o => !o)} style={{ padding: "18px 20px", cursor: "pointer", transition: "background 0.2s" }}
        onMouseEnter={e => e.currentTarget.style.background = T.bg3}
        onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
        <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
          <div style={{ width: 42, height: 42, borderRadius: 10, background: `${meta.color}18`, border: `1px solid ${meta.color}35`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, color: meta.color, flexShrink: 0 }}>{meta.icon}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 7, alignItems: "center" }}>
              <span style={{ fontSize: 15, fontWeight: 700, fontFamily: "'Clash Display',sans-serif", color: T.text1 }}>#{leak.rank} {leak.name}</span>
              <Tag color={sev} bg={`${sev}18`}>{leak.severity}</Tag>
              <Tag color={CONF_CLR[leak.confidence]} bg={CONF_BG[leak.confidence]}>{leak.confidence} CONF</Tag>
              {leak.quick_win && <Tag color={T.green} bg="rgba(52,211,153,0.1)">⚡ QUICK WIN</Tag>}
              <Tag color={T.text3} bg="rgba(255,255,255,0.04)">{leak.owner}</Tag>
            </div>
            <p style={{ fontSize: 13, color: T.text2, lineHeight: 1.65, margin: 0, marginBottom: 10 }}>{leak.problem}</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
              <div><div style={{ fontSize: 10, color: T.text3, fontFamily: "'DM Mono',monospace" }}>MONTHLY LOSS</div><div style={{ fontSize: 18, fontWeight: 700, color: T.red, fontFamily: "'Clash Display',sans-serif" }}>−{fmt(leak.monthly_loss)}</div></div>
              <div><div style={{ fontSize: 10, color: T.text3, fontFamily: "'DM Mono',monospace" }}>ANNUAL LOSS</div><div style={{ fontSize: 18, fontWeight: 700, color: "#fb923c", fontFamily: "'Clash Display',sans-serif" }}>−{fmt(leak.annual_loss)}</div></div>
              <div><div style={{ fontSize: 10, color: T.text3, fontFamily: "'DM Mono',monospace" }}>TIME TO FIX</div><div style={{ fontSize: 13, fontWeight: 600, color: T.text2, marginTop: 3 }}>{leak.time_to_fix}</div></div>
            </div>
          </div>
          <div style={{ fontSize: 16, color: T.text3, flexShrink: 0, marginTop: 2 }}>{open ? "▲" : "▼"}</div>
        </div>
      </div>
      {open && (
        <div style={{ borderTop: `1px solid ${T.border}`, padding: "18px 20px", background: T.bg1 }}>
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 10, color: T.text3, fontFamily: "'DM Mono',monospace", letterSpacing: "0.12em", marginBottom: 6 }}>ROOT CAUSE</div>
            <div style={{ fontSize: 13, color: T.text2, fontStyle: "italic" }}>"{leak.root_cause}"</div>
          </div>
          <div style={{ fontSize: 10, color: T.text3, fontFamily: "'DM Mono',monospace", letterSpacing: "0.12em", marginBottom: 10 }}>PRIORITIZED ACTION PLAN</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {(leak.fixes || []).map((fix, i) => (
              <div key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start", background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 10, padding: "12px 14px" }}>
                <div style={{ width: 24, height: 24, borderRadius: 6, background: i === 0 ? "rgba(99,102,241,0.25)" : "rgba(255,255,255,0.06)", border: `1px solid ${i === 0 ? "rgba(99,102,241,0.5)" : T.border}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: i === 0 ? "#818cf8" : T.text3, fontFamily: "'DM Mono',monospace", flexShrink: 0 }}>{fix.priority}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, color: T.text1, marginBottom: 5 }}>{fix.action}</div>
                  <div style={{ display: "flex", gap: 10 }}>
                    <span style={{ fontSize: 10, color: T.green, fontFamily: "'DM Mono',monospace" }}>↑ {fix.impact}</span>
                    <span style={{ fontSize: 10, color: T.text3 }}>·</span>
                    <span style={{ fontSize: 10, color: fix.effort === "Easy" ? T.green : fix.effort === "Medium" ? T.amber : T.red, fontFamily: "'DM Mono',monospace" }}>{fix.effort}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// MAIN APP
// ════════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [authState, setAuthState] = useState("idle");  // idle | authed | error
  const [tokenData, setTokenData] = useState(null);
  const [user, setUser] = useState(null);
  const [properties, setProperties] = useState([]);
  const [selectedProp, setSelectedProp] = useState(null);
  const [fetchStep, setFetchStep] = useState("");
  const [fetchPct, setFetchPct] = useState(0);
  const [store, setStore] = useState(null);
  const [results, setResults] = useState(null);
  const [phase, setPhase] = useState("connect");  // connect | fetching | analyzing | results
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState("leaks");
  const [useDemo, setUseDemo] = useState(false);

  const isConfigured = GA4_CONFIG.CLIENT_ID !== "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com";

  // Check for OAuth token in URL hash on load
  useEffect(() => {
    const fromHash = parseTokenFromHash();
    if (fromHash) {
      TokenStore.save(fromHash);
      setTokenData(fromHash);
      setAuthState("authed");
      return;
    }
    const saved = TokenStore.load();
    if (TokenStore.isValid(saved)) {
      setTokenData(saved);
      setAuthState("authed");
    }
  }, []);

  // After auth: load user + properties
  useEffect(() => {
    if (authState !== "authed" || !tokenData) return;
    (async () => {
      try {
        const [u, props] = await Promise.all([
          fetchUser(tokenData.token),
          fetchProperties(tokenData.token),
        ]);
        setUser(u);
        setProperties(props);
        if (props.length === 1) setSelectedProp(props[0]);
      } catch (e) {
        setError("Failed to load GA4 properties: " + e.message);
        setAuthState("error");
      }
    })();
  }, [authState, tokenData]);

  const handleSignIn = () => {
    if (!isConfigured) {
      setError("Add your Google OAuth Client ID to GA4_CONFIG.CLIENT_ID first.");
      return;
    }
    window.location.href = buildAuthUrl();
  };

  const handleSignOut = () => {
    TokenStore.clear();
    setTokenData(null); setUser(null); setProperties([]);
    setSelectedProp(null); setStore(null); setResults(null);
    setPhase("connect"); setAuthState("idle"); setUseDemo(false);
  };

  const handleRunLive = async () => {
    if (!selectedProp) return;
    setPhase("fetching"); setError(null); setFetchPct(0); setFetchStep("");
    try {
      const data = await fetchGA4Data(
        selectedProp.id,
        tokenData.token,
        (step, pct) => { setFetchStep(step); setFetchPct(pct); }
      );
      setStore(data);
      setPhase("analyzing");
      await runAIAnalysis(data);
    } catch (e) {
      setError("Data fetch failed: " + e.message);
      setPhase("connect");
    }
  };

  const handleRunDemo = async () => {
    setUseDemo(true);
    setStore(DEMO_STORE);
    setPhase("analyzing");
    await runAIAnalysis(DEMO_STORE);
  };

  const runAIAnalysis = async (storeData) => {
    try {
      const r = await runAnalysis(storeData, () => {});
      setResults(r);
      setPhase("results");
    } catch (e) {
      setError("AI analysis failed: " + e.message);
      setPhase("connect");
    }
  };

  const reset = () => {
    setStore(null); setResults(null); setPhase("connect");
    setActiveTab("leaks"); setUseDemo(false); setError(null);
  };

  const tabs = [
    { id: "leaks",    label: "Revenue Leaks" },
    { id: "funnel",   label: "Funnel & Traffic" },
    { id: "products", label: "Products" },
    { id: "tech",     label: "Speed & UX" },
  ];

  const S = store || DEMO_STORE;

  // ── RENDER ──────────────────────────────────────────────────────────────────
  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@300;400;500&display=swap');
        @font-face{font-family:'Clash Display';src:url('https://api.fontshare.com/v2/css?f[]=clash-display@600,700,800&display=swap');}
        *{box-sizing:border-box;margin:0;padding:0;}
        body{background:${T.bg0};overflow-x:hidden;}
        @keyframes fadeUp{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:translateY(0)}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes shimmer{0%{opacity:0.4}50%{opacity:1}100%{opacity:0.4}}
        select{appearance:none;-webkit-appearance:none;}
        ::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:${T.bg0}}::-webkit-scrollbar-thumb{background:${T.bg3};border-radius:3px}
      `}</style>

      <div style={{ minHeight: "100vh", background: T.bg0, color: T.text1, fontFamily: "'DM Sans',sans-serif" }}>
        {/* Ambient */}
        <div style={{ position: "fixed", top: "-15%", right: "-8%", width: 700, height: 700, borderRadius: "50%", background: "radial-gradient(circle,rgba(99,102,241,0.055) 0%,transparent 70%)", pointerEvents: "none", zIndex: 0 }}/>
        <div style={{ position: "fixed", bottom: "-10%", left: "-5%", width: 600, height: 600, borderRadius: "50%", background: "radial-gradient(circle,rgba(110,231,183,0.04) 0%,transparent 70%)", pointerEvents: "none", zIndex: 0 }}/>

        <div style={{ maxWidth: 1000, margin: "0 auto", padding: "0 24px 80px", position: "relative", zIndex: 1 }}>

          {/* ── TOPBAR ── */}
          <div style={{ padding: "22px 0 20px", borderBottom: `1px solid ${T.border}`, display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 36, flexWrap: "wrap", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 34, height: 34, borderRadius: 9, background: "linear-gradient(135deg,#6366f1,#4f46e5)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15 }}>◈</div>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, fontFamily: "'Clash Display',sans-serif" }}>RevenueLeak<span style={{ color: T.accent }}>.ai</span></div>
                <div style={{ fontSize: 9, color: T.text3, fontFamily: "'DM Mono',monospace", letterSpacing: "0.1em" }}>GA4 E-COMMERCE INTELLIGENCE</div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              {authState === "authed" && user && (
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  {user.picture && <img src={user.picture} alt="" style={{ width: 28, height: 28, borderRadius: "50%", border: `2px solid ${T.border}` }}/>}
                  <span style={{ fontSize: 12, color: T.text2 }}>{user.email}</span>
                  <button onClick={handleSignOut} style={{ fontSize: 11, color: T.text3, background: "transparent", border: `1px solid ${T.border}`, borderRadius: 7, padding: "4px 10px", cursor: "pointer", fontFamily: "'DM Mono',monospace" }}>Sign out</button>
                </div>
              )}
              <div style={{ display: "flex", gap: 6, alignItems: "center", background: authState === "authed" && !useDemo ? "rgba(52,211,153,0.08)" : "rgba(251,191,36,0.08)", border: `1px solid ${authState === "authed" && !useDemo ? "rgba(52,211,153,0.2)" : "rgba(251,191,36,0.2)"}`, borderRadius: 7, padding: "5px 10px" }}>
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: authState === "authed" && !useDemo ? T.green : T.amber, animation: "pulse 2s infinite" }}/>
                <span style={{ fontSize: 10, color: authState === "authed" && !useDemo ? T.green : T.amber, fontFamily: "'DM Mono',monospace" }}>{authState === "authed" && !useDemo ? "LIVE GA4" : "DEMO MODE"}</span>
              </div>
            </div>
          </div>

          {/* ══════════════════════════════════════════════════════════════
              PHASE: CONNECT
          ══════════════════════════════════════════════════════════════ */}
          {phase === "connect" && (
            <div style={{ animation: "fadeUp 0.5s ease both" }}>
              <div style={{ marginBottom: 40, maxWidth: 560 }}>
                <div style={{ fontSize: 10, color: T.accentB, fontFamily: "'DM Mono',monospace", letterSpacing: "0.2em", marginBottom: 14 }}>FOR E-COMMERCE STORES</div>
                <h1 style={{ fontSize: "clamp(34px,6vw,60px)", fontWeight: 800, lineHeight: 1.05, letterSpacing: "-0.03em", fontFamily: "'Clash Display',sans-serif", marginBottom: 18 }}>
                  Your store is<br/>
                  <span style={{ background: `linear-gradient(120deg,${T.red},#fb923c)`, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>leaking revenue.</span><br/>
                  <span style={{ fontSize: "0.58em", color: T.text2, WebkitTextFillColor: T.text2 }}>We'll find exactly where.</span>
                </h1>
                <p style={{ fontSize: 14, color: T.text2, lineHeight: 1.75, fontWeight: 300 }}>Connect your real GA4 account — or explore with demo data. Our AI audits your full customer journey and ranks every revenue leak by monthly dollar loss.</p>
              </div>

              {/* ── GA4 AUTH PANEL ── */}
              <div style={{ background: T.bg2, border: `1px solid ${T.borderHi}`, borderRadius: 16, padding: 28, marginBottom: 16 }}>
                <div style={{ display: "flex", gap: 14, alignItems: "flex-start", marginBottom: 24 }}>
                  {/* Google icon */}
                  <div style={{ width: 44, height: 44, borderRadius: 12, background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <svg width="22" height="22" viewBox="0 0 24 24">
                      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                    </svg>
                  </div>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 600, fontFamily: "'Clash Display',sans-serif", marginBottom: 4 }}>Connect Google Analytics 4</div>
                    <div style={{ fontSize: 12, color: T.text3 }}>Read-only access · No data stored · Revoke anytime from Google account settings</div>
                  </div>
                </div>

                {authState === "idle" && (
                  <>
                    {!isConfigured && (
                      <div style={{ background: "rgba(251,191,36,0.08)", border: "1px solid rgba(251,191,36,0.25)", borderRadius: 10, padding: "12px 16px", marginBottom: 16 }}>
                        <div style={{ fontSize: 12, color: T.amber, marginBottom: 8, fontWeight: 500 }}>⚙ Setup Required for Live GA4</div>
                        <div style={{ fontSize: 11, color: T.text2, lineHeight: 1.7 }}>
                          1. Go to <strong style={{color:T.text1}}>console.cloud.google.com</strong> → Create/select a project<br/>
                          2. Enable <strong style={{color:T.text1}}>Google Analytics Data API</strong> + <strong style={{color:T.text1}}>Google Analytics Admin API</strong><br/>
                          3. Create <strong style={{color:T.text1}}>OAuth 2.0 Credentials</strong> (Web Application type)<br/>
                          4. Add your domain to <strong style={{color:T.text1}}>Authorized redirect URIs</strong><br/>
                          5. Paste <strong style={{color:T.text1}}>Client ID</strong> into <code style={{color:T.accent}}>GA4_CONFIG.CLIENT_ID</code> at top of file
                        </div>
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                      <button onClick={handleSignIn} disabled={!isConfigured} style={{
                        flex: 1, minWidth: 200, padding: "14px 24px", background: isConfigured ? "#fff" : "rgba(255,255,255,0.06)",
                        border: "none", borderRadius: 10, color: isConfigured ? "#1a1a1a" : T.text3,
                        fontSize: 14, fontWeight: 600, cursor: isConfigured ? "pointer" : "not-allowed",
                        display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
                        fontFamily: "'DM Sans',sans-serif", transition: "all 0.2s",
                        opacity: isConfigured ? 1 : 0.5,
                      }}>
                        <svg width="18" height="18" viewBox="0 0 24 24">
                          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                          <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                        </svg>
                        Sign in with Google
                      </button>
                      <button onClick={handleRunDemo} style={{
                        flex: 1, minWidth: 200, padding: "14px 24px", background: "transparent",
                        border: `1px solid ${T.border}`, borderRadius: 10, color: T.text2,
                        fontSize: 14, cursor: "pointer", fontFamily: "'DM Sans',sans-serif",
                      }}>Try with Demo Data →</button>
                    </div>
                  </>
                )}

                {authState === "authed" && (
                  <>
                    {/* User confirmed */}
                    <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "10px 14px", background: "rgba(52,211,153,0.07)", border: "1px solid rgba(52,211,153,0.2)", borderRadius: 10, marginBottom: 20 }}>
                      {user?.picture && <img src={user.picture} alt="" style={{ width: 32, height: 32, borderRadius: "50%" }}/>}
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: T.text1 }}>{user?.name || user?.email}</div>
                        <div style={{ fontSize: 11, color: T.green, fontFamily: "'DM Mono',monospace" }}>✓ CONNECTED · READ-ONLY ACCESS</div>
                      </div>
                    </div>

                    {/* Property selector */}
                    {properties.length === 0 && (
                      <div style={{ fontSize: 13, color: T.text3, textAlign: "center", padding: "20px 0", animation: "shimmer 1.5s infinite" }}>Loading GA4 properties…</div>
                    )}

                    {properties.length > 0 && (
                      <div style={{ marginBottom: 20 }}>
                        <div style={{ fontSize: 11, color: T.text3, fontFamily: "'DM Mono',monospace", letterSpacing: "0.1em", marginBottom: 10 }}>SELECT GA4 PROPERTY ({properties.length} found)</div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 260, overflowY: "auto" }}>
                          {properties.map(p => (
                            <div key={p.id} onClick={() => setSelectedProp(p)} style={{
                              padding: "12px 16px", borderRadius: 10, cursor: "pointer",
                              border: `1px solid ${selectedProp?.id === p.id ? "rgba(99,102,241,0.5)" : T.border}`,
                              background: selectedProp?.id === p.id ? "rgba(99,102,241,0.1)" : T.bg1,
                              transition: "all 0.15s",
                            }}>
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                <div>
                                  <div style={{ fontSize: 13, fontWeight: 600, color: T.text1 }}>{p.name}</div>
                                  <div style={{ fontSize: 11, color: T.text3, fontFamily: "'DM Mono',monospace" }}>{p.account} · ID: {p.id}</div>
                                </div>
                                {selectedProp?.id === p.id && <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#818cf8" }}/>}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {selectedProp && (
                      <button onClick={handleRunLive} style={{
                        width: "100%", padding: "16px 24px", background: "linear-gradient(135deg,#6366f1,#4f46e5)",
                        border: "none", borderRadius: 12, color: "#fff", fontSize: 15, fontWeight: 700,
                        cursor: "pointer", fontFamily: "'Clash Display',sans-serif", letterSpacing: "0.03em",
                        boxShadow: "0 0 48px rgba(99,102,241,0.28)", transition: "all 0.2s",
                      }}
                        onMouseEnter={e => { e.target.style.transform = "translateY(-2px)"; }}
                        onMouseLeave={e => { e.target.style.transform = "none"; }}>
                        ◈ &nbsp;Scan "{selectedProp.name}" for Revenue Leaks
                      </button>
                    )}
                  </>
                )}

                {authState === "error" && (
                  <div style={{ color: T.red, fontSize: 13, padding: "12px 0" }}>{error}</div>
                )}
              </div>

              {/* What we fetch */}
              <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 14, padding: "18px 24px" }}>
                <div style={{ fontSize: 11, color: T.text3, fontFamily: "'DM Mono',monospace", letterSpacing: "0.12em", marginBottom: 16 }}>WHAT WE PULL FROM GA4 (READ-ONLY)</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 10 }}>
                  {[
                    { icon: "◈", label: "Sessions, transactions, revenue", api: "runReport" },
                    { icon: "⟁", label: "Traffic source breakdown", api: "runReport" },
                    { icon: "◉", label: "Device & browser performance", api: "runReport" },
                    { icon: "◆", label: "Funnel events (ATC, checkout)", api: "runReport" },
                    { icon: "⊕", label: "Top products by revenue", api: "runReport" },
                    { icon: "◇", label: "Exit pages & bounce rates", api: "runReport" },
                    { icon: "✦", label: "Daily revenue trend (28 days)", api: "runReport" },
                    { icon: "◎", label: "Geographic performance", api: "runReport" },
                  ].map(item => (
                    <div key={item.label} style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 0" }}>
                      <span style={{ color: T.accent, fontSize: 14 }}>{item.icon}</span>
                      <div>
                        <div style={{ fontSize: 12, color: T.text2 }}>{item.label}</div>
                        <div style={{ fontSize: 9, color: T.text3, fontFamily: "'DM Mono',monospace" }}>{item.api}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {error && phase === "connect" && <div style={{ color: T.red, fontSize: 12, fontFamily: "'DM Mono',monospace", marginTop: 12 }}>{error}</div>}
            </div>
          )}

          {/* ══════════════════════════════════════════════════════════════
              PHASE: FETCHING GA4 DATA
          ══════════════════════════════════════════════════════════════ */}
          {phase === "fetching" && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "72vh", gap: 32, animation: "fadeUp 0.4s ease" }}>
              <div style={{ position: "relative", width: 88, height: 88 }}>
                <svg width="88" height="88" viewBox="0 0 88 88">
                  <circle cx="44" cy="44" r="36" fill="none" stroke="rgba(59,130,246,0.15)" strokeWidth="6"/>
                  <circle cx="44" cy="44" r="36" fill="none" stroke={T.accentB} strokeWidth="6"
                    strokeDasharray={`${2*Math.PI*36}`}
                    strokeDashoffset={`${2*Math.PI*36*(1-fetchPct/100)}`}
                    strokeLinecap="round" transform="rotate(-90 44 44)" style={{ transition: "stroke-dashoffset 0.5s ease" }}/>
                </svg>
                <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontFamily: "'DM Mono',monospace", color: T.accentB }}>{Math.round(fetchPct)}%</div>
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "'Clash Display',sans-serif", marginBottom: 8 }}>Pulling Live GA4 Data</div>
                <div style={{ fontSize: 13, color: T.accentB, fontFamily: "'DM Mono',monospace" }}>{fetchStep || "Connecting…"}</div>
                <div style={{ fontSize: 12, color: T.text3, marginTop: 6 }}>8 parallel API queries · ~10 seconds</div>
              </div>
            </div>
          )}

          {/* ══════════════════════════════════════════════════════════════
              PHASE: ANALYZING
          ══════════════════════════════════════════════════════════════ */}
          {phase === "analyzing" && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "72vh", gap: 32, animation: "fadeUp 0.4s ease" }}>
              <div style={{ position: "relative", width: 88, height: 88 }}>
                <svg width="88" height="88" viewBox="0 0 88 88">
                  <circle cx="44" cy="44" r="36" fill="none" stroke="rgba(110,231,183,0.1)" strokeWidth="6"/>
                  <circle cx="44" cy="44" r="36" fill="none" stroke={T.accent} strokeWidth="6"
                    strokeDasharray={`${2*Math.PI*36}`} strokeDashoffset="50" strokeLinecap="round"
                    transform="rotate(-90 44 44)" style={{ animation: "spin 1.5s linear infinite" }}/>
                </svg>
                <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>◈</div>
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "'Clash Display',sans-serif", marginBottom: 8 }}>AI Analyzing Your Data</div>
                <div style={{ fontSize: 13, color: T.accent, fontFamily: "'DM Mono',monospace" }}>Claude is scanning {useDemo ? "demo" : "live"} data for revenue leaks…</div>
                <div style={{ fontSize: 12, color: T.text3, marginTop: 6 }}>Typically 8–15 seconds</div>
              </div>
            </div>
          )}

          {/* ══════════════════════════════════════════════════════════════
              PHASE: RESULTS
          ══════════════════════════════════════════════════════════════ */}
          {phase === "results" && results && (
            <div style={{ animation: "fadeUp 0.5s ease both" }}>

              {/* Hero recovery */}
              <div style={{ background: "linear-gradient(135deg,rgba(248,113,113,0.1),rgba(251,191,36,0.06))", border: "1px solid rgba(248,113,113,0.22)", borderRadius: 16, padding: "28px 30px", marginBottom: 24 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 20 }}>
                  <div>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
                      <div style={{ fontSize: 10, color: "#fb923c", fontFamily: "'DM Mono',monospace", letterSpacing: "0.15em" }}>ANALYSIS COMPLETE · {S.name.toUpperCase()}</div>
                      {S._live && <Tag color={T.green} bg="rgba(52,211,153,0.1)">● LIVE DATA</Tag>}
                      {!S._live && <Tag color={T.amber} bg="rgba(251,191,36,0.1)">DEMO DATA</Tag>}
                    </div>
                    <div style={{ fontSize: 13, color: T.text2, marginBottom: 14 }}>{results.summary}</div>
                    <div style={{ display: "flex", gap: 28, flexWrap: "wrap" }}>
                      <div>
                        <div style={{ fontSize: 10, color: T.text3, fontFamily: "'DM Mono',monospace", marginBottom: 4 }}>MONTHLY LEAK</div>
                        <div style={{ fontSize: 34, fontWeight: 800, fontFamily: "'Clash Display',sans-serif", color: T.red, letterSpacing: "-0.02em" }}>−{fmt(results.total_recoverable)}<span style={{ fontSize: 13, color: T.text3, fontWeight: 400 }}>/mo</span></div>
                      </div>
                      <div>
                        <div style={{ fontSize: 10, color: T.text3, fontFamily: "'DM Mono',monospace", marginBottom: 4 }}>ANNUAL OPPORTUNITY</div>
                        <div style={{ fontSize: 34, fontWeight: 800, fontFamily: "'Clash Display',sans-serif", color: "#fb923c", letterSpacing: "-0.02em" }}>{fmt(results.total_recoverable * 12)}<span style={{ fontSize: 13, color: T.text3, fontWeight: 400 }}>/yr</span></div>
                      </div>
                      <div>
                        <div style={{ fontSize: 10, color: T.text3, fontFamily: "'DM Mono',monospace", marginBottom: 4 }}>QUICK WINS</div>
                        <div style={{ fontSize: 34, fontWeight: 800, fontFamily: "'Clash Display',sans-serif", color: T.green, letterSpacing: "-0.02em" }}>{fmt(results.quick_wins_total)}<span style={{ fontSize: 13, color: T.text3, fontWeight: 400 }}>/mo</span></div>
                      </div>
                    </div>
                  </div>
                  <div style={{ textAlign: "center", flexShrink: 0 }}>
                    <div style={{ fontSize: 10, color: T.text3, fontFamily: "'DM Mono',monospace", marginBottom: 10 }}>RECOVERY SCORE</div>
                    <div style={{ position: "relative", width: 90, height: 90 }}>
                      <svg width="90" height="90" viewBox="0 0 90 90">
                        <circle cx="45" cy="45" r="36" fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="6"/>
                        <circle cx="45" cy="45" r="36" fill="none" stroke={T.accent} strokeWidth="6"
                          strokeDasharray={`${2*Math.PI*36}`} strokeDashoffset={`${2*Math.PI*36*(1-results.recovery_score/100)}`}
                          strokeLinecap="round" transform="rotate(-90 45 45)"/>
                      </svg>
                      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column" }}>
                        <div style={{ fontSize: 22, fontWeight: 800, fontFamily: "'Clash Display',sans-serif", color: T.accent }}>{results.recovery_score}</div>
                        <div style={{ fontSize: 8, color: T.text3, fontFamily: "'DM Mono',monospace" }}>/ 100</div>
                      </div>
                    </div>
                    <div style={{ fontSize: 10, color: T.text3, marginTop: 8 }}>{results.leaks?.length} leaks found</div>
                  </div>
                </div>
              </div>

              {/* KPIs */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 10, marginBottom: 24 }}>
                <KpiCard label="Revenue" value={fmt(S.monthly_revenue)} prev={S.prev_revenue} accent="#6366f1"/>
                <KpiCard label="AOV" value={`$${S.avg_order_value}`} prev={S.prev_aov} accent={T.green}/>
                <KpiCard label="Conv. Rate" value={`${S.funnel?.[5] ? ((S.funnel[5].users/S.funnel[0].users)*100).toFixed(2) : "?"}%`} sublabel="Industry" subval={`${S.industry_conv_avg}%`} accent={T.amber}/>
                <KpiCard label="Cart Abandon" value={`${S.cart_abandon_rate}%`} sublabel="Industry" subval={`${S.industry_cart_avg}%`} accent={T.red} invert/>
                {S.repeat_purchase_rate > 0 && <KpiCard label="Repeat Rate" value={`${S.repeat_purchase_rate}%`} sublabel="CLV" subval={`$${S.clv}`} accent={T.purple}/>}
                {S.refund_rate > 0 && <KpiCard label="Refund Rate" value={`${S.refund_rate}%`} accent="#f97316" invert/>}
              </div>

              {/* Tabs */}
              <div style={{ display: "flex", gap: 4, marginBottom: 20, background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 12, padding: 5 }}>
                {tabs.map(t => (
                  <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
                    flex: 1, padding: "9px 12px", borderRadius: 9, border: activeTab === t.id ? `1px solid rgba(99,102,241,0.35)` : "1px solid transparent",
                    cursor: "pointer", fontSize: 12, fontWeight: 600, fontFamily: "'DM Sans',sans-serif", transition: "all 0.2s",
                    background: activeTab === t.id ? "linear-gradient(135deg,rgba(99,102,241,0.3),rgba(139,92,246,0.2))" : "transparent",
                    color: activeTab === t.id ? T.text1 : T.text3,
                  }}>{t.label}</button>
                ))}
              </div>

              {/* TAB: LEAKS */}
              {activeTab === "leaks" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {(results.leaks || []).map((leak, i) => <LeakCard key={i} leak={leak} idx={i}/>)}
                </div>
              )}

              {/* TAB: FUNNEL & TRAFFIC */}
              {activeTab === "funnel" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                    <Section title="Purchase Funnel" subtitle="Full journey drop-off analysis">
                      <FunnelChart data={S.funnel || []}/>
                    </Section>
                    <Section title="Revenue Trend" subtitle="Daily revenue — last 28 days">
                      <RevenueSparkline data={S.daily_revenue}/>
                      <div style={{ marginTop: 12 }}>
                        <div style={{ fontSize: 10, color: T.text3, fontFamily: "'DM Mono',monospace", marginBottom: 10 }}>CONVERSION BY HOUR</div>
                        <HourlyHeatmap data={S.hourly_conv}/>
                      </div>
                    </Section>
                  </div>

                  <Section title="Traffic Source Performance" subtitle="Conversion rate vs. prior period">
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      {(S.traffic || []).map(t => {
                        const declining = t.conv < t.prev;
                        return (
                          <div key={t.src} style={{ display: "grid", gridTemplateColumns: "160px 1fr 60px 70px 70px 80px", gap: 12, alignItems: "center", padding: "12px 14px", background: T.bg1, borderRadius: 10, border: `1px solid ${T.border}` }}>
                            <div style={{ fontSize: 13, fontWeight: 500, color: T.text1 }}>{t.src}</div>
                            <MiniBar value={t.revenue} max={Math.max(...(S.traffic||[]).map(x=>x.revenue))} color={declining ? T.amber : T.accent}/>
                            <div style={{ fontSize: 12, fontFamily: "'DM Mono',monospace", color: T.text1, textAlign: "right" }}>{t.conv}%</div>
                            <div style={{ fontSize: 11, fontFamily: "'DM Mono',monospace", color: declining ? T.red : T.green, textAlign: "right" }}>{declining ? "↓" : "↑"} {Math.abs(t.conv - t.prev).toFixed(1)}pp</div>
                            <div style={{ fontSize: 11, color: T.text3, textAlign: "right" }}>B:{t.bounce}%</div>
                            <div style={{ fontSize: 12, fontFamily: "'DM Mono',monospace", color: T.text2, textAlign: "right" }}>{fmt(t.revenue)}</div>
                          </div>
                        );
                      })}
                    </div>
                  </Section>

                  <Section title="Device Performance" subtitle="Conversion gap across devices">
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 12 }}>
                      {(S.devices || []).map(d => {
                        const desktopConv = S.devices?.[0]?.conv || 1;
                        const gap = desktopConv - d.conv;
                        const lost = Math.round((gap / 100) * d.sessions * S.avg_order_value);
                        return (
                          <div key={d.name} style={{ background: T.bg1, border: `1px solid ${d.name === "Mobile" && d.conv < S.industry_mobile_conv ? "rgba(248,113,113,0.3)" : T.border}`, borderRadius: 12, padding: 18 }}>
                            <div style={{ fontSize: 10, color: T.text3, fontFamily: "'DM Mono',monospace", marginBottom: 10 }}>{d.name.toUpperCase()}</div>
                            <div style={{ fontSize: 28, fontWeight: 800, fontFamily: "'Clash Display',sans-serif", color: d.name === "Mobile" && d.conv < S.industry_mobile_conv ? T.red : T.text1, marginBottom: 8 }}>{d.conv}%</div>
                            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                              <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ fontSize: 11, color: T.text3 }}>Sessions</span><span style={{ fontSize: 11, color: T.text2 }}>{fmtN(d.sessions)}</span></div>
                              <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ fontSize: 11, color: T.text3 }}>Revenue</span><span style={{ fontSize: 11, color: T.text2 }}>{fmt(d.revenue)}</span></div>
                              {d.aov > 0 && <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ fontSize: 11, color: T.text3 }}>AOV</span><span style={{ fontSize: 11, color: T.text2 }}>${d.aov}</span></div>}
                              {gap > 0 && lost > 0 && <div style={{ fontSize: 11, color: T.red, marginTop: 4, paddingTop: 8, borderTop: `1px solid ${T.border}` }}>−{gap.toFixed(1)}pp gap → −{fmt(lost)}/mo</div>}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </Section>

                  {(S.exit_pages || []).length > 0 && (
                    <Section title="Top Exit Pages" subtitle="Where customers leave your store">
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {S.exit_pages.map(p => (
                          <div key={p.page} style={{ display: "flex", alignItems: "center", gap: 14, padding: "10px 14px", background: T.bg1, borderRadius: 10, border: `1px solid ${T.border}` }}>
                            <div style={{ flex: 1, fontSize: 12, fontFamily: "'DM Mono',monospace", color: T.text2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.page}</div>
                            <MiniBar value={p.pct} max={50} color={p.pct > 35 ? T.red : T.amber}/>
                            <div style={{ fontSize: 13, fontFamily: "'DM Mono',monospace", color: p.pct > 35 ? T.red : T.amber, minWidth: 50, textAlign: "right" }}>{p.pct}%</div>
                            <div style={{ fontSize: 11, color: T.text3, minWidth: 60, textAlign: "right" }}>{fmtN(p.exits)} exits</div>
                          </div>
                        ))}
                      </div>
                    </Section>
                  )}

                  {(S.geo_top || []).length > 0 && (
                    <Section title="Geographic Performance" subtitle="Conversion by top countries">
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {S.geo_top.map(g => (
                          <div key={g.country} style={{ display: "grid", gridTemplateColumns: "180px 1fr 70px 80px", gap: 12, alignItems: "center", padding: "10px 14px", background: T.bg1, borderRadius: 10, border: `1px solid ${T.border}` }}>
                            <div style={{ fontSize: 13, color: T.text1 }}>{g.country}</div>
                            <MiniBar value={g.revenue} max={Math.max(...S.geo_top.map(x=>x.revenue))} color={T.accentB}/>
                            <div style={{ fontSize: 12, fontFamily: "'DM Mono',monospace", color: g.conv < 1.5 ? T.red : T.text2, textAlign: "right" }}>{g.conv}% conv</div>
                            <div style={{ fontSize: 12, fontFamily: "'DM Mono',monospace", color: T.text2, textAlign: "right" }}>{fmt(g.revenue)}</div>
                          </div>
                        ))}
                      </div>
                    </Section>
                  )}
                </div>
              )}

              {/* TAB: PRODUCTS */}
              {activeTab === "products" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  {(S.top_products || []).length > 0 ? (
                    <Section title="Top Products — Conversion Funnel" subtitle="Views → Add to Cart → Purchase per product">
                      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        {S.top_products.map(p => {
                          const atcRate = p.views > 0 ? (p.atc / p.views * 100).toFixed(1) : "0";
                          const convRate = p.views > 0 ? (p.purchases / p.views * 100).toFixed(1) : "0";
                          return (
                            <div key={p.name} style={{ background: T.bg1, border: `1px solid ${p.returns > 12 ? "rgba(248,113,113,0.25)" : T.border}`, borderRadius: 12, padding: "16px 18px" }}>
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
                                <div>
                                  <div style={{ fontSize: 14, fontWeight: 600, fontFamily: "'Clash Display',sans-serif", marginBottom: 4 }}>{p.name}</div>
                                  <div style={{ display: "flex", gap: 8 }}>
                                    <Tag>ATC {atcRate}%</Tag>
                                    <Tag>Conv {convRate}%</Tag>
                                    {p.returns > 12 && <Tag color={T.red} bg="rgba(248,113,113,0.12)">⚠ {p.returns}% returns</Tag>}
                                  </div>
                                </div>
                                <div style={{ textAlign: "right" }}>
                                  <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "'Clash Display',sans-serif" }}>{fmt(p.revenue)}</div>
                                  <div style={{ fontSize: 10, color: T.text3, fontFamily: "'DM Mono',monospace" }}>{fmtN(p.purchases)} orders</div>
                                </div>
                              </div>
                              <div style={{ display: "flex", gap: 3, height: 8, borderRadius: 4, overflow: "hidden" }}>
                                <div style={{ flex: p.views, background: "rgba(99,102,241,0.4)" }}/>
                                <div style={{ flex: p.atc, background: "rgba(59,130,246,0.5)" }}/>
                                <div style={{ flex: Math.max(p.purchases, 1), background: T.green, minWidth: 4 }}/>
                              </div>
                              <div style={{ display: "flex", gap: 14, marginTop: 6 }}>
                                <span style={{ fontSize: 10, color: T.text3 }}>Views: <span style={{ color: T.text2 }}>{fmtN(p.views)}</span></span>
                                <span style={{ fontSize: 10, color: T.text3 }}>ATC: <span style={{ color: T.text2 }}>{fmtN(p.atc)}</span></span>
                                <span style={{ fontSize: 10, color: T.text3 }}>Sold: <span style={{ color: T.text2 }}>{fmtN(p.purchases)}</span></span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </Section>
                  ) : (
                    <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 14, padding: 32, textAlign: "center" }}>
                      <div style={{ fontSize: 13, color: T.text3 }}>Product data not available — ensure <strong style={{color:T.text2}}>view_item</strong>, <strong style={{color:T.text2}}>add_to_cart</strong>, and <strong style={{color:T.text2}}>purchase</strong> events are tracked in GA4 with item parameters.</div>
                    </div>
                  )}

                  {(S.search_terms || []).length > 0 && (
                    <Section title="Site Search — Unanswered Intent" subtitle="High-volume searches with no destination page" badge={{ label: "Revenue Signal", color: T.amber, bg: "rgba(251,191,36,0.1)" }}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {S.search_terms.map(s => (
                          <div key={s.term} style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 14px", background: T.bg1, borderRadius: 10, border: `1px solid ${!s.found ? "rgba(248,113,113,0.25)" : T.border}` }}>
                            <div style={{ flex: 1, fontSize: 13, color: T.text1, fontFamily: "'DM Mono',monospace" }}>"{s.term}"</div>
                            <MiniBar value={s.searches} max={2500} color={!s.found ? T.red : T.green}/>
                            <div style={{ fontSize: 11, fontFamily: "'DM Mono',monospace", color: T.text3, minWidth: 80, textAlign: "right" }}>{fmtN(s.searches)} searches</div>
                            <Tag color={!s.found ? T.red : T.green} bg={!s.found ? "rgba(248,113,113,0.1)" : "rgba(52,211,153,0.1)"}>{!s.found ? "NO PAGE" : "HAS PAGE"}</Tag>
                          </div>
                        ))}
                      </div>
                    </Section>
                  )}
                </div>
              )}

              {/* TAB: SPEED & UX */}
              {activeTab === "tech" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  <Section title="Core Web Vitals" subtitle="Google performance thresholds — affects both SEO and conversion">
                    {S.page_speed?.mobile_lcp > 0 ? (
                      <>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(100px,1fr))", gap: 20, marginBottom: 20 }}>
                          <SpeedGauge label="Mobile LCP"  value={S.page_speed.mobile_lcp}  good={2.5} bad={4.0}/>
                          <SpeedGauge label="Desktop LCP" value={S.page_speed.desktop_lcp} good={2.5} bad={4.0}/>
                          <SpeedGauge label="Mobile FID"  value={S.page_speed.mobile_fid}  good={100} bad={300} unit="ms"/>
                          <SpeedGauge label="Mobile CLS"  value={S.page_speed.mobile_cls}  good={0.1} bad={0.25} unit=""/>
                          <SpeedGauge label="Desktop CLS" value={S.page_speed.desktop_cls} good={0.1} bad={0.25} unit=""/>
                        </div>
                      </>
                    ) : (
                      <div style={{ padding: "20px 0", textAlign: "center" }}>
                        <div style={{ fontSize: 13, color: T.text3, marginBottom: 12 }}>Core Web Vitals are not available via GA4 API directly.</div>
                        <div style={{ fontSize: 12, color: T.text2, lineHeight: 1.7 }}>
                          Check your real CWV scores at:<br/>
                          <strong style={{color:T.accent}}>pagespeed.web.dev</strong> · <strong style={{color:T.accent}}>search.google.com/search-console</strong><br/>
                          Or enable <strong style={{color:T.text1}}>Web Vitals extension</strong> in Chrome DevTools.
                        </div>
                      </div>
                    )}
                  </Section>

                  <Section title="Checkout UX Audit" subtitle="Common friction points that kill conversion">
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      {[
                        { issue: "No guest checkout visible above the fold", impact: "HIGH", loss: "~6–8% of checkout abandons", fix: "Move guest checkout CTA to hero position" },
                        { issue: "Limited payment methods — no BNPL (Afterpay/Klarna)", impact: "HIGH", loss: "BNPL lifts AOV 20–30% for fashion", fix: "Integrate Afterpay or Klarna" },
                        { issue: "Shipping cost hidden until final checkout step", impact: "MEDIUM", loss: "Surprise costs = #1 abandonment reason", fix: "Show estimated shipping on product + cart pages" },
                        { issue: "No urgency signals (stock level, scarcity messaging)", impact: "MEDIUM", loss: "Urgency lifts conv 5–15%", fix: "Show 'Only X left' badge below inventory threshold" },
                        { issue: "Exit-intent offer not deployed on checkout pages", impact: "MEDIUM", loss: "Recovers 5–8% of abandoners", fix: "10% off popup triggered on exit-intent" },
                        { issue: "No trust badges at checkout (SSL, guarantee)", impact: "LOW", loss: "Trust seals lift checkout conv ~4%", fix: "Add 3 trust badges above checkout CTA" },
                      ].map(r => (
                        <div key={r.issue} style={{ padding: "14px 16px", background: T.bg1, borderRadius: 10, border: `1px solid ${T.border}` }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 6 }}>
                            <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                              <Tag color={r.impact === "HIGH" ? T.red : r.impact === "MEDIUM" ? T.amber : T.text3} bg={r.impact === "HIGH" ? "rgba(248,113,113,0.1)" : r.impact === "MEDIUM" ? "rgba(251,191,36,0.1)" : "rgba(255,255,255,0.05)"}>{r.impact}</Tag>
                              <div style={{ fontSize: 13, color: T.text1 }}>{r.issue}</div>
                            </div>
                            <div style={{ fontSize: 11, color: T.amber, flexShrink: 0, textAlign: "right", maxWidth: 120 }}>{r.loss}</div>
                          </div>
                          <div style={{ fontSize: 12, color: T.text3 }}>→ {r.fix}</div>
                        </div>
                      ))}
                    </div>
                  </Section>
                </div>
              )}

              {/* Footer CTA */}
              <div style={{ marginTop: 28, background: "rgba(99,102,241,0.07)", border: "1px solid rgba(99,102,241,0.18)", borderRadius: 16, padding: "24px 28px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 18 }}>
                <div>
                  <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "'Clash Display',sans-serif", marginBottom: 5 }}>Want these fixed for you?</div>
                  <div style={{ fontSize: 13, color: T.text2 }}>Book a 30-min Revenue Recovery call. We'll build a 90-day fix roadmap tailored to your store.</div>
                </div>
                <div style={{ display: "flex", gap: 10 }}>
                  <button onClick={reset} style={{ padding: "11px 18px", background: "transparent", border: `1px solid ${T.border}`, borderRadius: 10, color: T.text3, fontSize: 12, cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>← New Scan</button>
                  <button style={{ padding: "11px 22px", background: "linear-gradient(135deg,#6366f1,#4f46e5)", border: "none", borderRadius: 10, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "'Clash Display',sans-serif", letterSpacing: "0.02em" }}>Book a Call →</button>
                </div>
              </div>
            </div>
          )}

        </div>
      </div>
    </>
  );
}
