const express = require("express");
const cors = require("cors");
const path = require("path");
const https = require("https");
const fs = require("fs");
const app = express();

app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── History ───────────────────────────────────────────────────
const HISTORY_FILE = path.join(__dirname, "history.json");
function loadHistory() {
  try { if (fs.existsSync(HISTORY_FILE)) return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8")); }
  catch(e) { console.error("History load error:", e.message); }
  return {};
}
function saveHistory(h) {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(h, null, 2)); }
  catch(e) { console.error("History save error:", e.message); }
}

// ── Make.com data store ───────────────────────────────────────
let latestMakeData = { econ: null, earnings: null, premarket: null, news: null, timestamp: null };

// ── HTTP fetch ────────────────────────────────────────────────
function fetchUrl(url, extraHeaders) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? require("https") : require("http");
    const headers = Object.assign({
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      "Accept": "text/html,application/json,*/*",
      "Accept-Language": "en-US,en;q=0.9"
    }, extraHeaders || {});
    const req = mod.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return fetchUrl(res.headers.location, extraHeaders).then(resolve).catch(reject);
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

function stripHtml(html, maxLen) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ").trim().slice(0, maxLen || 2500);
}

// ── Data fetchers (fallbacks when Make.com not available) ─────
async function fetchEconFMP() {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const FMP_KEY = process.env.FMP_API_KEY || "WQMcZiIIJ1rarvN3puluUNQoGXFdvkjg";

  try {
    const raw = await fetchUrl(
      "https://financialmodelingprep.com/stable/economic-calendar?from=" + todayStr + "&to=" + todayStr + "&apikey=" + FMP_KEY
    );
    const json = JSON.parse(raw);
    if (!Array.isArray(json) || json.length === 0) {
      console.log("FMP econ: no events today");
      return null;
    }

    // Filter to high/medium impact USD events
    const important = ["nonfarm","payroll","jobless","claims","unemployment","jolts","adp",
      "cpi","consumer price","ppi","producer price","pce","personal consumption",
      "gdp","gross domestic","fomc","federal reserve","fed rate","interest rate",
      "ism","purchasing manager","pmi","consumer confidence","sentiment","michigan",
      "crude oil","oil inventor","natural gas","eia","retail sales","durable"];

    // Log first event to debug field names
    if (json.length > 0) console.log("FMP econ sample:", JSON.stringify(json[0]));

    const usdEvents = json.filter(e => {
      const name = (e.event || e.indicator || e.name || "").toLowerCase();
      const country = (e.country || e.countryCode || e.currency || "").toUpperCase();
      // Match US, USD, United States, or empty (some APIs don't tag country for US data)
      const isUSD = country === "US" || country === "USD" || country.includes("UNITED STATES") || country.includes("AMERICA");
      return isUSD && important.some(k => name.includes(k));
    });

    // Fall back to all events if filter too strict
    const eventsToUse = usdEvents.length > 0 ? usdEvents : json.filter(e => {
      const country = (e.country || e.countryCode || e.currency || "").toUpperCase();
      return country === "US" || country === "USD" || country.includes("UNITED");
    });

    if (eventsToUse.length === 0) {
      console.log("FMP econ: no USD events found in", json.length, "total events");
      return null;
    }

    const lines = eventsToUse.map(e => {
      const eventName = e.event || e.indicator || e.name || "Unknown";
      const act = (e.actual !== null && e.actual !== undefined) ? String(e.actual) : "TBD";
      const est = (e.estimate !== null && e.estimate !== undefined && e.estimate !== "") ? String(e.estimate) :
                  (e.consensus !== null && e.consensus !== undefined) ? String(e.consensus) : "N/A";
      const prev = (e.previous !== null && e.previous !== undefined) ? " | Prev: " + e.previous : "";
      const impact = e.impact ? " [" + e.impact + "]" : "";
      let beat = "";
      if (act !== "TBD" && est !== "N/A") {
        beat = parseFloat(act) > parseFloat(est) ? " → BEAT" : parseFloat(act) < parseFloat(est) ? " → MISS" : " → IN-LINE";
      }
      return eventName + impact + " | Act: " + act + " vs Est: " + est + prev + beat;
    });

    return "FMP ECONOMIC CALENDAR FOR " + todayStr + ":\n" + lines.join("\n");
  } catch(e) {
    console.log("FMP econ error:", e.message);
    return null;
  }
}

async function fetchEarnings() {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const todayStr = today.toISOString().slice(0, 10);
  const yestStr = yesterday.toISOString().slice(0, 10);
  const FMP_KEY = process.env.FMP_API_KEY || "WQMcZiIIJ1rarvN3puluUNQoGXFdvkjg";

  async function fetchFMP(from, to) {
    try {
      const raw = await fetchUrl(
        "https://financialmodelingprep.com/stable/earnings-calendar?from=" + from + "&to=" + to + "&apikey=" + FMP_KEY
      );
      const json = JSON.parse(raw);
      if (!Array.isArray(json)) { console.log("FMP earnings error:", JSON.stringify(json).slice(0,100)); return []; }
      // Convert FMP format to our expected format
      return json.map(r => ({
        symbol: r.symbol,
        epsActual: r.epsActual,
        epsEstimate: r.epsEstimated,
        revenueActual: r.revenueActual,
        revenueEstimate: r.revenueEstimated,
        hour: r.time || ""
      }));
    } catch(e) { console.log("FMP earnings error:", e.message); return []; }
  }

  const [todayRows, yestRows] = await Promise.all([fetchFMP(todayStr, todayStr), fetchFMP(yestStr, yestStr)]);
  const MEGA = ["NVDA","AAPL","MSFT","META","GOOGL","GOOG","AMZN","TSLA","AVGO","NFLX","AMD"];
  const LARGE = [
    "JPM","GS","BAC","MS","WFC","C","BLK","SCHW","AXP","CB","MMC","PGR","MET","PRU","TRV","BK","STT",
    "V","MA","PYPL","SQ","CRM","ORCL","ADBE","QCOM","MU","NOW","INTC","TXN","AMAT","LRCX","KLAC","MRVL","ARM","PANW","SNOW","PLTR",
    "UNH","LLY","JNJ","PFE","ABBV","MRK","BMY","AMGN","GILD","CVS","CI","HUM","ELV","ISRG","MDT","ABT",
    "XOM","CVX","COP","SLB","EOG","PSX","VLO","MPC",
    "WMT","HD","COST","TGT","LOW","NKE","SBUX","MCD","YUM",
    "BA","CAT","GE","HON","MMM","RTX","LMT","NOC","DE","UPS","FDX",
    "DIS","CMCSA","T","VZ","SNAP","UBER","LYFT","F","GM","RIVN","AMT","PLD","NEE"
  ];

  function formatRow(r, tag) {
    const isMega = MEGA.includes(r.symbol);
    const isLarge = LARGE.includes(r.symbol);
    const tier = isMega ? "[MEGA-CAP]" : isLarge ? "[LARGE-CAP]" : "[MID/SMALL]";
    const epsAct = (r.epsActual !== null && r.epsActual !== undefined) ? parseFloat(r.epsActual).toFixed(2) : "TBD";
    const epsEst = (r.epsEstimate !== null && r.epsEstimate !== undefined) ? parseFloat(r.epsEstimate).toFixed(2) : "N/A";
    let beat = "";
    if (epsAct !== "TBD" && epsEst !== "N/A") {
      const diff = parseFloat(epsAct) - parseFloat(epsEst);
      const pct = Math.abs(diff) / Math.abs(parseFloat(epsEst));
      if (isMega) { beat = diff > 0 ? "BEAT" : diff < 0 ? "MISS" : "IN-LINE"; }
      else { beat = pct < 0.01 ? "IN-LINE" : diff > 0 ? "BEAT" : "MISS"; }
    }
    const rev = r.revenueActual ? " | Rev: $" + (r.revenueActual/1e9).toFixed(2) + "B" : "";
    const revEst = r.revenueEstimate ? " vs Est: $" + (r.revenueEstimate/1e9).toFixed(2) + "B" : "";
    return tag + " " + tier + " " + r.symbol + " | EPS Act: " + epsAct + " vs Est: " + epsEst + " " + beat + rev + revEst + " | " + (r.hour || "");
  }

  // FMP doesn't always have time-of-day (AMC/BMO) — include all yesterday + today rows
  // Yesterday rows = reported after yesterday close, moving today's market
  // Today rows = reporting today BMO or during market
  const seen = new Set();
  const combined = [...yestRows, ...todayRows].filter(r => {
    if(seen.has(r.symbol)) return false;
    seen.add(r.symbol);
    return true;
  });
  if (combined.length === 0) return "No earnings data from FMP for " + yestStr + " or " + todayStr + ".";
  combined.sort((a, b) => { const aS = MEGA.includes(a.symbol)?0:LARGE.includes(a.symbol)?1:2; const bS = MEGA.includes(b.symbol)?0:LARGE.includes(b.symbol)?1:2; return aS-bS; });
  const lines = combined.slice(0, 40).map(r => {
    const isYest = yestRows.some(y => y.symbol === r.symbol);
    const tag = isYest ? "[YEST]" : "[TODAY]";
    return formatRow(r, tag);
  });
  const nonGaapNote = "NOTE: Mega-caps like AVGO, NVDA, AAPL report non-GAAP adjusted EPS. MEGA-CAP STRICT RULE: any miss is a miss regardless of size.";
  return "EARNINGS (yesterday=" + yestStr + " AMC, today=" + todayStr + "):\n" + lines.join("\n") + "\n\n" + nonGaapNote;
}

async function fetchPremarket() {
  const FINNHUB_KEY = process.env.FINNHUB_API_KEY || "d8gh1phr01qlgcujfjfgd8gh1phr01qlgcujfjg0";

  // ETF proxies for international indices (free tier compatible)
  const symbols = [
    // Asia ETF proxies
    { symbol: "EWH",  label: "HSI (Hang Seng)",       region: "asia" },
    { symbol: "EWJ",  label: "Nikkei 225",             region: "asia" },
    { symbol: "EWA",  label: "ASX 200",                region: "asia" },
    { symbol: "MCHI", label: "Shanghai Composite",     region: "asia" },
    { symbol: "EWS",  label: "STI (Singapore)",        region: "asia" },
    // Europe ETF proxies
    { symbol: "VGK",  label: "STOXX 600",              region: "europe" },
    { symbol: "EWG",  label: "DAX",                    region: "europe" },
    { symbol: "EWU",  label: "FTSE 100",               region: "europe" },
    { symbol: "EWN",  label: "AEX (Netherlands)",      region: "europe" },
    { symbol: "EWQ",  label: "CAC 40",                 region: "europe" },
    // US Futures
    { symbol: "NQ=F", label: "NQ Futures",             region: "us" },
    { symbol: "ES=F", label: "ES Futures",             region: "us" },
    { symbol: "YM=F", label: "DOW Futures",            region: "us" },
  ];

  try {
    // Fetch all quotes in parallel — Finnhub free tier: 60 calls/min, well within limit
    const results = await Promise.all(symbols.map(async (s) => {
      try {
        const raw = await fetchUrl(
          "https://finnhub.io/api/v1/quote?symbol=" + s.symbol + "&token=" + FINNHUB_KEY
        );
        const q = JSON.parse(raw);
        // q.c = current price, q.dp = % change, q.d = change
        if (!q || q.c === 0 || q.c === null || q.error) {
          return { ...s, pct: null, status: "unavailable" };
        }
        const pct = parseFloat(q.dp) || 0;
        const status = pct > 0.1 ? "up" : pct < -0.1 ? "down" : "flat";
        return { ...s, pct, price: q.c, status };
      } catch(e) {
        return { ...s, pct: null, status: "unavailable" };
      }
    }));

    // Build readable text for Claude
    const asia    = results.filter(r => r.region === "asia");
    const europe  = results.filter(r => r.region === "europe");
    const futures = results.filter(r => r.region === "us");

    function formatRegion(items, regionName) {
      const lines = items.map(r => {
        if (r.status === "unavailable") return r.label + ": N/A";
        const arrow = r.status === "up" ? "UP" : r.status === "down" ? "▼" : "FLAT";
        const sign  = r.pct >= 0 ? "+" : "";
        return r.label + ": " + arrow + " " + sign + r.pct.toFixed(2) + "%";
      });
      // Majority vote summary
      const up   = items.filter(r => r.status === "up").length;
      const down = items.filter(r => r.status === "down").length;
      const verdict = up >= 3 ? "BULLISH" : down >= 3 ? "BEARISH" : "MIXED";
      return regionName + " [" + verdict + "]:\n" + lines.join("\n");
    }

    function formatFutures(items) {
      const lines = items.map(r => {
        if (r.status === "unavailable") return r.label + ": N/A";
        const arrow = r.status === "up" ? "UP" : r.status === "down" ? "▼" : "FLAT";
        const sign  = r.pct >= 0 ? "+" : "";
        return r.label + ": " + arrow + " " + sign + r.pct.toFixed(2) + "%";
      });
      return "US FUTURES:\n" + lines.join("\n");
    }

    const output = [
      "PRE-MARKET DATA (ETF proxies for international indices):",
      formatRegion(asia, "ASIA"),
      formatRegion(europe, "EUROPE"),
      formatFutures(futures)
    ].join("\n\n");

    console.log("Premarket: Finnhub data fetched successfully");
    return output;

  } catch(e) {
    console.log("Finnhub premarket error:", e.message);
    return null;
  }
}

async function fetchNews() {
  const html = await fetchUrl("https://www.cnbc.com/markets/");
  return stripHtml(html, 2500);
}

// ── Claude API ────────────────────────────────────────────────
function callClaude(prompt, data, useWebSearch) {
  return new Promise((resolve, reject) => {
    const today = new Date().toLocaleDateString("en-US", { weekday:"long", year:"numeric", month:"long", day:"numeric" });
    const body = {
      model: useWebSearch ? "claude-sonnet-4-6" : "claude-haiku-4-5-20251001",
      max_tokens: 500,
      temperature: 0,
      // ── MODIFIED: added "guidance" field to the JSON schema description ──
      system: "You are a futures trader morning briefing assistant. Today is " + today + ". CRITICAL: Reply ONLY with raw JSON, no markdown, no backticks, no explanation. Format: {\"signal\":\"bull\",\"summary\":\"2 sentence summary\",\"score\":1,\"guidance\":null} where signal is bull/bear/neutral, score is 1/-1/0, and guidance is a one-sentence forward guidance note (for earnings topics only) or null if not applicable.",
      messages: [{ role: "user", content: prompt + (data && data !== "NO EXTERNAL DATA" ? "\n\nDATA:\n" + data : "") }]
    };
    if (useWebSearch) body.tools = [{ type: "web_search_20250305", name: "web_search" }];
    const payload = JSON.stringify(body);
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    };
    if (useWebSearch) headers["anthropic-beta"] = "web-search-2025-03-05";
    const options = { hostname: "api.anthropic.com", path: "/v1/messages", method: "POST", headers };
    const req = https.request(options, res => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.error) return reject(new Error(parsed.error.message));
          const text = (parsed.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
          const cleaned = text.replace(/```json|```/g, "").trim();
          const result = JSON.parse(cleaned);
          // Ensure result has required fields — if Claude returned an error object, normalize it
          if (!result.signal || !result.hasOwnProperty("score")) {
            resolve({ signal: "neutral", summary: "Could not fetch data. Use override buttons to set manually.", score: 0, guidance: null });
          } else {
            // ── MODIFIED: ensure guidance key always exists (null if not returned) ──
            if (!result.hasOwnProperty("guidance")) result.guidance = null;
            resolve(result);
          }
        } catch(e) { reject(new Error("Parse error: " + e.message)); }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ── Prompts ───────────────────────────────────────────────────
const ECON_PROMPT = [
  "From this economic calendar data, extract ONLY the following report types and IGNORE everything else.",
  "INCLUDE ONLY: Monetary policy (Fed rate decisions, FOMC, Fed speeches, ECB/BOE/BOJ), Labor market (NFP, JOLTS, Jobless Claims, ADP, Unemployment Rate, Average Hourly Earnings), Inflation (CPI, Core CPI, PPI, Core PPI, PCE, Core PCE), Growth (GDP), Sentiment & Manufacturing (ISM Manufacturing, ISM Services, PMI, Consumer Confidence, UoM Sentiment), Energy (EIA Crude Oil Inventories, EIA Natural Gas Storage), London metals session (Gold, Silver, Copper, Platinum London fix or LME), Any HIGH or MEDIUM impact USD event.",
  "EXCLUDE: Low impact events, non-USD data (except London metals).",
  "For each included report: name, actual vs forecast, beat or miss.",
  "MARKET REGIME (2025-2026): Inflation has cooled but remains above target. Fed is on hold. We are in GOOD NEWS IS GOOD NEWS mode — strong economic data = bullish for equities. Only flip bearish if inflation re-accelerates sharply.",
  "TIER 1 (dominates everything): Fed rate decision, FOMC, NFP, CPI, PCE. TIER 2 (high weight): JOLTS, Jobless Claims, ADP, Unemployment Rate, PPI. TIER 3 (medium): GDP, ISM, PMI, Sentiment. TIER 4 (lower): Oil/gas inventories, metals.",
  "JOBLESS CLAIMS RULE: Initial Jobless Claims HIGHER than forecast = BEARISH (more people unemployed = labor weakening). Claims LOWER than forecast = BULLISH (fewer unemployed = strong labor). This is the opposite of most indicators — a higher number is bad. 225K vs 213K forecast = MISS = BEARISH.",
  "JOLTS RULE: JOLTS job openings HIGHER than forecast = BULLISH (more demand for workers). JOLTS lower = bearish.",
  "TODAY-ONLY RULE: Only score reports confirmed released or scheduled for TODAY. Strictly ignore any reports from yesterday or earlier.",
  "MEGA-CAP STRICT RULE: any miss is a miss regardless of size.",
  "Score: bull=1, bear=-1, neutral=0.",
  // ── MODIFIED: guidance is not applicable for econ, explicitly set null ──
  "JSON SCHEMA: {\"signal\":\"bull|bear|neutral\",\"summary\":\"2 sentence summary\",\"score\":1,\"guidance\":null}"
].join(" ");

const EARN_PROMPT = [
  "From this earnings data, score based on INDEX IMPACT not equal weighting.",
  "MEGA-CAP INDEX HEAVYWEIGHTS (highest weight): NVDA, AAPL, MSFT, META, GOOGL, GOOG, AMZN, TSLA, AVGO, NFLX, AMD.",
  "LARGE-CAP HIGH IMPACT (significant weight): JPM, GS, BAC, MS, WFC, C, V, MA, UNH, LLY, JNJ, XOM, CVX, CRM, ORCL, ADBE, QCOM, MU, NOW.",
  "SMALL/MID CAP (low weight): Everything else.",
  "DATA SOURCE: non-GAAP adjusted EPS — the correct basis vs analyst estimates.",
  "MEGA-CAP STRICT RULE: any miss is a miss regardless of size. Trust the BEAT/MISS/IN-LINE label in the data.",
  "CRITICAL: Only score based on CONFIRMED actual EPS in the data. If all TBD, score 0 neutral — do NOT guess.",
  "IN-LINE RULE: IN-LINE for a mega-cap = neutral. Revenue beats/misses also factor in.",
  "FORWARD GUIDANCE RULE: For mega-caps, forward guidance is often MORE important than the EPS beat/miss. Strong guidance that beats consensus = add +0.5 to score. Weak or below-consensus guidance = subtract 0.5. Reaffirmed full-year targets = mild positive. If guidance is included in the data, factor it into your summary and score.",
  "SUMMARY RULE: For any mega-cap result, your summary must include: (1) EPS beat/miss, (2) revenue beat/miss, (3) forward guidance vs consensus if available, (4) any key metric like AI revenue, cloud growth, or segment performance that moves NQ/ES.",
  "Score: bull=1, bear=-1, neutral=0. You may use 0.5 increments when guidance meaningfully changes the picture.",
  // ── MODIFIED: tightened staleness rule — stale reports omitted entirely ──
  "STALENESS RULE: If current time is past 10:00am ET, any report tagged [YEST] is fully priced in and must be completely ignored — do NOT mention it, do NOT reference it as context, do NOT let it influence your signal or summary in any way. Treat [YEST] reports as if they do not exist after 10:00am ET. Base your entire analysis only on [TODAY] reports. If there are no [TODAY] reports with confirmed actuals, score 0 neutral. [YEST] reports only score and appear in your summary if current time is before 10:00am ET.",
  // ── MODIFIED: explicit JSON schema requiring guidance field ──
  "JSON SCHEMA: {\"signal\":\"bull|bear|neutral\",\"summary\":\"2 sentence summary\",\"score\":1,\"guidance\":\"One sentence on forward guidance vs consensus — include specific numbers if available (e.g. Q3 revenue guided $X vs $Y consensus). Set to null only if absolutely no guidance data is present in the source material.\"}"
].join(" ");

const PREMARKET_PROMPT = [
  "From this data, score pre-market sentiment for US index futures (NQ/ES) using this exact methodology:",
  "ASIA SCORE: Evaluate these 5 indices individually — HSI (Hang Seng), Nikkei 225, ASX 200, Shanghai Composite, STI (Straits Times). For each: up = bullish, down = bearish, flat/missing = neutral. If 3 or more are bullish, Asia = bullish. If 3 or more are bearish, Asia = bearish. Otherwise Asia = neutral.",
  "EUROPE SCORE: Evaluate these 5 indices individually — STOXX 600, DAX, FTSE 100, AEX, CAC 40. Apply the same majority rule: 3+ bullish = Europe bullish, 3+ bearish = Europe bearish, otherwise neutral.",
  "US FUTURES: Note direction of NQ, ES, DOW/YM if visible. Use as tiebreaker only — do not let US futures override the Asia/Europe majority vote.",
  "FINAL SIGNAL: If both Asia and Europe are bullish = bull. If both are bearish = bear. If they disagree or one is neutral = neutral. US futures break the tie if Asia and Europe split.",
  "MAX SCORE RULE: Pre-market is a supporting indicator only. Hard cap score at +1 (bull) or -1 (bear). Never return a score outside the range of -1 to +1.",
  "SUMMARY RULE: Your summary must state (1) Asia verdict with the specific indices that drove it, (2) Europe verdict with the specific indices that drove it, (3) US futures direction. Two sentences max.",
  "Score: bull=1, bear=-1, neutral=0.",
  "JSON SCHEMA: {\"signal\":\"bull|bear|neutral\",\"summary\":\"2 sentence summary\",\"score\":1,\"guidance\":null}"
].join(" ");

const NEWS_PROMPT = [
  "From this CNBC markets page identify the most impactful stories for US index futures (NQ/ES) today.",
  "LEVEL 5 - MARKET SHOCK OVERRIDE (completely dominates all other signals): Active military conflict outbreak, emergency Fed rate decision, major bank failure, pandemic declaration, emergency executive order affecting markets, surprise nationalization, sweeping antitrust breakup of mega-cap, extreme overnight tariff (50%+), contested election causing constitutional crisis, surprise election outcome reversing expected policy. If Level 5 detected: score -1 AND include MARKET_SHOCK_OVERRIDE in summary.",
  "LEVEL 4 - HIGHEST IMPACT (moves NQ 1%+ intraday): Fed surprise pivot, major geopolitical escalation, oil supply shock >5%, large tariff announcement.",
  "LEVEL 3 - HIGH IMPACT: Fed speaker hawkish/dovish shift, Middle East escalation, trade action, regulatory ruling.",
  "LEVEL 2 - MEDIUM: Sector news, individual large-cap catalyst.",
  "LEVEL 1 - LOW (do not score): Routine analyst calls, minor company news.",
  "IMPORTANT: Do NOT include level labels like Level 3 or Level 4 in your summary text. Write natural plain English.",
  "Score: bull=1, bear=-1, neutral=0.",
  // ── MODIFIED: guidance is not applicable for news ──
  "JSON SCHEMA: {\"signal\":\"bull|bear|neutral\",\"summary\":\"2 sentence summary\",\"score\":1,\"guidance\":null}"
].join(" ");

// ── Make.com intake endpoint ──────────────────────────────────
app.post("/intake", function(req, res) {
  const d = req.body;
  if (!d) return res.status(400).json({ error: "No body" });
  if (d.econ)      latestMakeData.econ      = d.econ;
  if (d.earnings)  latestMakeData.earnings  = d.earnings;
  if (d.premarket) latestMakeData.premarket = d.premarket;
  if (d.news)      latestMakeData.news      = d.news;
  latestMakeData.timestamp = new Date().toISOString();
  console.log("Make.com data received:", Object.keys(d).join(", "));
  res.json({ ok: true, received: Object.keys(d), timestamp: latestMakeData.timestamp });
});

app.get("/intake-status", function(req, res) {
  res.json({
    hasEcon:      !!latestMakeData.econ,
    hasEarnings:  !!latestMakeData.earnings,
    hasPremarket: !!latestMakeData.premarket,
    hasNews:      !!latestMakeData.news,
    timestamp:    latestMakeData.timestamp
  });
});

// Debug endpoint — shows first 500 chars of each data source
app.get("/intake-preview", function(req, res) {
  res.json({
    econ:      latestMakeData.econ      ? latestMakeData.econ.slice(0, 500)      : null,
    earnings:  latestMakeData.earnings  ? latestMakeData.earnings.slice(0, 500)  : null,
    premarket: latestMakeData.premarket ? latestMakeData.premarket.slice(0, 500) : null,
    news:      latestMakeData.news      ? latestMakeData.news.slice(0, 500)      : null,
    timestamp: latestMakeData.timestamp
  });
});

// ── Main analyze endpoint ─────────────────────────────────────
app.post("/api/analyze", async function(req, res) {
  const topic = req.body && req.body.topic;
  if (!topic) return res.status(400).json({ error: "No topic" });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "API key not set" });
  console.log("Analyzing:", topic, "| Make.com data:", !!latestMakeData[topic === "earn" ? "earnings" : topic]);

  try {
    var rawData, prompt, useSearch = false;

    if (topic === "econ") {
      const today2 = new Date();
      const todayStr2 = today2.toISOString().slice(0, 10);
      const dayName2 = today2.toLocaleDateString("en-US", { weekday:"long", year:"numeric", month:"long", day:"numeric" });

      if (latestMakeData.econ && latestMakeData.econ.length > 100) {
        rawData = latestMakeData.econ;
        prompt = ECON_PROMPT;
        useSearch = false;
        console.log("Econ: using Make.com data");
      } else {
        // Try FMP first
        const fmpEconData = await fetchEconFMP();
        if (fmpEconData) {
          rawData = fmpEconData;
          prompt = ECON_PROMPT;
          useSearch = false;
          console.log("Econ: using FMP data");
        } else {
          // Web search fallback with Sonnet
          rawData = "NO EXTERNAL DATA";
          prompt = ECON_PROMPT + " TODAY IS " + dayName2 + " (" + todayStr2 + ")." +
            " Search the web for USD economic reports released or scheduled for today " + todayStr2 + "." +
            " Find actual values for Jobless Claims, Natural Gas Storage, and any other USD reports today." +
            " Only include " + todayStr2 + " data.";
          useSearch = true;
          console.log("Econ: using web search");
        }
      }
    } else if (topic === "earn") {
      const today3 = new Date();
      const todayStr3 = today3.toISOString().slice(0, 10);
      const yest3 = new Date(today3); yest3.setDate(yest3.getDate()-1);
      const yestStr3 = yest3.toISOString().slice(0, 10);
      // Inject current ET time so the staleness rule fires correctly
      const etTime = today3.toLocaleTimeString("en-US", { hour:"2-digit", minute:"2-digit", hour12:true, timeZone:"America/New_York" });
      prompt = EARN_PROMPT + " CURRENT TIME (ET): " + etTime + ".";
      if (latestMakeData.earnings && latestMakeData.earnings.length > 50) {
        rawData = latestMakeData.earnings;
        console.log("Earnings: using Make.com data");
      } else {
        rawData = await fetchEarnings();
        // Check if FMP has mega-cap actual data
        const hasMegaActuals = rawData && (rawData.includes("BEAT") || rawData.includes("MISS") || rawData.includes("IN-LINE")) && (rawData.includes("AVGO") || rawData.includes("NVDA") || rawData.includes("AAPL") || rawData.includes("MSFT") || rawData.includes("META"));
        if (!hasMegaActuals) {
          // ── MODIFIED: web search prompt now explicitly asks for guidance data ──
          prompt = EARN_PROMPT + " CURRENT TIME (ET): " + etTime + ". Search the web for major S&P500/Nasdaq earnings reported on " + yestStr3 + " AMC or " + todayStr3 + " BMO. Focus on AVGO, NVDA, AAPL, MSFT, META, GOOGL, AMZN, TSLA, NFLX, AMD and major banks. For each company found state: EPS actual vs estimate (beat/miss), revenue actual vs estimate, AND forward guidance vs consensus — include specific guided figures (e.g. Q3 revenue $X guided vs $Y consensus) as guidance often moves the stock more than EPS. Also include this API data: " + (rawData || "none");
          useSearch = true;
          console.log("Earnings: using web search for mega-cap results");
        }
      }
    } else if (topic === "premarket") {
      prompt = PREMARKET_PROMPT;
      if (latestMakeData.premarket && latestMakeData.premarket.length > 50) {
        rawData = latestMakeData.premarket;
        console.log("Premarket: using Make.com data");
      } else {
        rawData = await fetchPremarket();
        if (rawData) {
          console.log("Premarket: using Finnhub ETF data");
        } else {
          // Finnhub failed — fall back to web search
          const today2 = new Date();
          const todayStr2 = today2.toISOString().slice(0, 10);
          rawData = "NO EXTERNAL DATA";
          prompt = PREMARKET_PROMPT + " Search the web for today " + todayStr2 + " pre-market performance of: HSI (Hang Seng), Nikkei 225, ASX 200, Shanghai Composite, STI. Also STOXX 600, DAX, FTSE 100, AEX, CAC 40. Also NQ futures, ES futures, DOW futures. State % change for each.";
          useSearch = true;
          console.log("Premarket: using web search fallback");
        }
      }
    } else if (topic === "news") {
      prompt = NEWS_PROMPT;
      rawData = latestMakeData.news || await fetchNews();
      if (latestMakeData.news) console.log("News: using Make.com data");
    } else {
      return res.status(400).json({ error: "Unknown topic" });
    }

    const result = await callClaude(prompt, rawData, useSearch);
    console.log("Result for " + topic + ":", JSON.stringify(result));
    res.json(result);
  } catch(e) {
    console.error("Error for " + topic + ":", e.message);
    res.status(500).json({ error: e.message });
  }
});


// ── Meta-score endpoint ───────────────────────────────────────
// Takes all 4 card results, asks Claude to assign dynamic weights
// and return a final weighted bias with rationale.
const META_PROMPT = [
  "You are a senior futures trader reviewing today's morning brief. You have 4 signal cards below.",
  "Your job: assign a DYNAMIC WEIGHT (1-5) to each card based on which is most likely to move NQ/ES index futures TODAY.",
  "WEIGHTING RULES:",
  "Weight 5 = Market-defining event (NFP, CPI, FOMC, mega-cap earnings shock, geopolitical crisis). Everything else is noise.",
  "Weight 4 = High impact (strong supporting data, sector-moving earnings, major yield move).",
  "Weight 3 = Moderate impact (confirming signal, mid-cap earnings, regional market moves).",
  "Weight 2 = Low impact (background noise, already priced in, conflicting signals).",
  "Weight 1 = Negligible (stale data, no confirmed actuals, neutral/mixed with no clear direction).",
  "DYNAMIC RULES: On NFP/CPI/FOMC days, econ starts at weight 5 and pre-market gets weight 1 (pre-market just reflects the same data). On mega-cap earnings days with no macro, earnings gets 5. Pre-market max weight is 2 on days with major macro catalysts. News max weight is 4 (never 5 unless MARKET_SHOCK_OVERRIDE).",
  "MARKET REACTION RULE (CRITICAL): The market's actual price reaction always takes precedence over the raw data beat or miss. If econ is bullish (data beat) BUT news is bearish (market is selling the news — e.g. yields spiking, equities falling), this means the market is REJECTING the bullish interpretation. In this case: REDUCE econ weight by 2 (min 2) and INCREASE news weight by 2 (max 4). The news card captures real-time price action; when it contradicts econ, it wins. Example: NFP beats big (econ=bull) but 10yr yield spikes above 4.5% and NQ sells off (news=bear) = econ weight drops from 5 to 3, news weight rises from 2 to 4.",
  "CONTRADICTION RULE: If pre-market and news both contradict econ, treat that as strong confirmation that the market is not trading the data bullishly. In this scenario econ weight max is 3.",
  "RATIONALE: One sentence explaining what is driving the market today, whether the market is trading the data or rejecting it, and why you weighted things the way you did.",
  "YOUR ONLY JOB IS TO RETURN WEIGHTS AND RATIONALE. Do not calculate scores or bias labels — the server will handle all math deterministically.",
  "JSON SCHEMA: {",
  "  \"weights\": {\"econ\":3,\"earn\":1,\"premarket\":1,\"news\":2},",
  "  \"rationale\": \"One sentence explaining today's dominant driver.\"",
  "}"
].join(" ");

app.post("/api/meta-score", async function(req, res) {
  const { econ, earn, premarket, news } = req.body;
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "API key not set" });

  try {
    const today = new Date().toLocaleDateString("en-US", { weekday:"long", year:"numeric", month:"long", day:"numeric" });
    const etTime = new Date().toLocaleTimeString("en-US", { hour:"2-digit", minute:"2-digit", hour12:true, timeZone:"America/New_York" });

    const cardSummary = [
      "TODAY IS " + today + ", TIME (ET): " + etTime,
      "",
      "ECON CALENDAR: signal=" + (econ ? econ.signal : "neutral") + ", score=" + (econ ? econ.score : 0) + ", summary=" + (econ ? econ.summary : "No data"),
      "EARNINGS: signal=" + (earn ? earn.signal : "neutral") + ", score=" + (earn ? earn.score : 0) + ", summary=" + (earn ? earn.summary : "No data"),
      "PRE-MARKET: signal=" + (premarket ? premarket.signal : "neutral") + ", score=" + (premarket ? premarket.score : 0) + ", summary=" + (premarket ? premarket.summary : "No data"),
      "MARKET NEWS: signal=" + (news ? news.signal : "neutral") + ", score=" + (news ? news.score : 0) + ", summary=" + (news ? news.summary : "No data"),
    ].join("\n");

    const body = {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      temperature: 0,
      system: "You are a futures trader bias engine. CRITICAL: Reply ONLY with raw JSON, no markdown, no backticks, no explanation.",
      messages: [{ role: "user", content: META_PROMPT + "\n\nDATA:\n" + cardSummary }]
    };

    const payload = JSON.stringify(body);
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    };

    const result = await new Promise((resolve, reject) => {
      const options = { hostname: "api.anthropic.com", path: "/v1/messages", method: "POST", headers };
      const req2 = https.request(options, r => {
        let raw = "";
        r.on("data", c => raw += c);
        r.on("end", () => {
          try {
            const parsed = JSON.parse(raw);
            if (parsed.error) return reject(new Error(parsed.error.message));
            const text = (parsed.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
            const cleaned = text.replace(/```json|```/g, "").trim();
            resolve(JSON.parse(cleaned));
          } catch(e) { reject(new Error("Parse error: " + e.message)); }
        });
      });
      req2.on("error", reject);
      req2.write(payload);
      req2.end();
    });

    // ── Server-side deterministic scoring — never trust Claude's math ──
    const weights = result.weights || { econ: 3, earn: 2, premarket: 1, news: 2 };

    // Get scores from request body
    const cardScores = {
      econ:      econ      ? (parseFloat(econ.score)      || 0) : 0,
      earn:      earn      ? (parseFloat(earn.score)      || 0) : 0,
      premarket: premarket ? (parseFloat(premarket.score) || 0) : 0,
      news:      news      ? (parseFloat(news.score)      || 0) : 0
    };

    // Weighted score: sum(score * weight) / sum(weights)
    const totalWeight = Object.keys(weights).reduce((s, k) => s + (weights[k] || 0), 0);
    const rawWeighted = Object.keys(weights).reduce((s, k) => s + (cardScores[k] || 0) * (weights[k] || 0), 0);
    const weightedScore = totalWeight > 0 ? parseFloat((rawWeighted / totalWeight).toFixed(2)) : 0;

    // Deterministic bias label — thresholds scaled to -1.0/+1.0 range
    // Possible range: -1.0 (all cards bear, max weights) to +1.0 (all cards bull, max weights)
    let signal, biasLabel;
    if      (weightedScore >=  0.50) { signal = "bull";    biasLabel = "STRONGLY BULLISH"; }
    else if (weightedScore >=  0.30) { signal = "bull";    biasLabel = "BULLISH"; }
    else if (weightedScore >=  0.15) { signal = "bull";    biasLabel = "MILDLY BULLISH"; }
    else if (weightedScore >  -0.15) { signal = "neutral"; biasLabel = "MIXED / NEUTRAL"; }
    else if (weightedScore >  -0.30) { signal = "bear";    biasLabel = "MILDLY BEARISH"; }
    else if (weightedScore >  -0.50) { signal = "bear";    biasLabel = "BEARISH"; }
    else                             { signal = "bear";    biasLabel = "STRONGLY BEARISH"; }

    const finalResult = {
      weights,
      weightedScore,
      signal,
      biasLabel,
      rationale: result.rationale || ""
    };

    console.log("Meta-score result:", JSON.stringify(finalResult));
    res.json(finalResult);
  } catch(e) {
    console.error("Meta-score error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── History endpoints ─────────────────────────────────────────
app.post("/api/history/save", function(req, res) {
  const { dateKey, snapshot } = req.body;
  if (!dateKey || !snapshot) return res.status(400).json({ error: "Missing dateKey or snapshot" });
  const history = loadHistory();
  history[dateKey] = snapshot;
  saveHistory(history);
  console.log("Saved history for:", dateKey);
  res.json({ ok: true, dateKey });
});

app.get("/api/history", function(req, res) { res.json(loadHistory()); });

app.get("/api/history/:dateKey", function(req, res) {
  const history = loadHistory();
  const entry = history[req.params.dateKey];
  if (!entry) return res.status(404).json({ error: "No data for this date" });
  res.json(entry);
});


// ── Markets implications endpoint ────────────────────────────
const MARKETS_PROMPT = [
  "You are a senior futures trader. Based on the morning brief signals below, provide specific trading implications for each of the following instruments.",
  "INSTRUMENTS TO COVER:",
  "EQUITIES: ES (S&P 500 futures), NQ (Nasdaq 100 futures), YM (Dow futures), RTY (Russell 2000 futures).",
  "METALS: GC (Gold futures), SI (Silver futures), HG (Copper futures), PL (Platinum futures).",
  "ENERGIES: CL (Crude Oil futures), NG (Natural Gas futures).",
  "DOLLAR INDEX: DXY.",
  "FOR EACH INSTRUMENT provide:",
  "1. bias: bull, bear, or neutral",
  "2. implication: ONE specific sentence on what the current signals mean for this instrument today. Be specific — mention actual drivers (yields, risk-off, dollar strength, growth fears etc). No generic statements.",
  "3. keyLevel: one key level or price zone to watch today if known, or null if not applicable.",
  "4. divergence: true if this instrument is moving differently from what the overall bias would suggest, false otherwise.",
  "5. bestSetup: true or false. For each sector group (equities, metals, energies), set bestSetup: true on EXACTLY ONE instrument — the one with the clearest directional conviction, strongest catalyst alignment, and best risk/reward today. Set false on all others in that group. DXY always gets bestSetup: true since it is the only instrument in its group.",
  "6. setupDirection: if bestSetup is true, set this to either LONG or SHORT based on the bias. If bestSetup is false, set to null.",
  "BEST SETUP SELECTION RULES: Choose the instrument where (a) the bias is clearly bull or bear (not neutral), (b) there is a specific named catalyst driving it today, (c) it aligns with the overall market bias rather than diverging from it, (d) it has a key level to define risk. If all instruments in a group are neutral, pick the one with the most potential for a move. Never pick a neutral instrument if a directional one exists in the group.",
  "INSTRUMENT-SPECIFIC RULES:",
  "ES/NQ/YM/RTY: Score from econ + earnings + news weighted by their dynamic weights. NQ is most sensitive to yields and tech. RTY is most sensitive to rate expectations and small-cap risk. YM is least tech-sensitive. If yields rising sharply, NQ bear > ES bear > YM bear.",
  "GC (Gold): Bull if risk-off OR dollar weakening OR inflation fears. Bear if dollar strengthening AND risk-on. Neutral if mixed. Rising yields without dollar strength = gold neutral to mildly bear.",
  "SI (Silver): Follows gold but amplified. Also sensitive to industrial demand (copper signal).",
  "HG (Copper): Bull if global growth optimism and risk-on. Bear if growth fears, strong dollar, risk-off. China/Asia market performance from pre-market is key input.",
  "PL (Platinum): Follows gold/silver direction but less correlated. Industrial + precious metal hybrid.",
  "CL (Crude Oil): Bull if risk-on, weak dollar, Middle East tension. Bear if strong dollar, demand fears, risk-off. News card is primary input.",
  "NG (Natural Gas): Least correlated to macro — driven by weather/storage. Score neutral unless news card has specific NG catalyst.",
  "DXY: Bull if strong econ data (NFP beat, CPI hot) AND risk-off. Bear if risk-on AND weak data. Note: DXY and gold often inverse. Rising yields typically strengthen DXY.",
  "RETURN a JSON object with this exact structure:",
  "{ \"equities\": { \"ES\": {\"bias\":\"bull\",\"implication\":\"..\",\"keyLevel\":\"5250\",\"divergence\":false,\"bestSetup\":false,\"setupDirection\":null}, \"NQ\":{...}, \"YM\":{...}, \"RTY\":{...} },",
  "\"metals\": { \"GC\":{...}, \"SI\":{...}, \"HG\":{...}, \"PL\":{...} },",
  "\"energies\": { \"CL\":{...}, \"NG\":{...} },",
  "\"dxy\": { \"DXY\":{\"bias\":\"bull\",\"implication\":\"..\",\"keyLevel\":\"103.5\",\"divergence\":false,\"bestSetup\":true,\"setupDirection\":\"LONG\"} } }"
].join(" ");

app.post("/api/markets", async function(req, res) {
  const { econ, earn, premarket, news, metaScore } = req.body;
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "API key not set" });

  try {
    const today = new Date().toLocaleDateString("en-US", { weekday:"long", year:"numeric", month:"long", day:"numeric" });
    const etTime = new Date().toLocaleTimeString("en-US", { hour:"2-digit", minute:"2-digit", hour12:true, timeZone:"America/New_York" });

    const context = [
      "TODAY: " + today + " TIME (ET): " + etTime,
      "",
      "OVERALL BIAS: " + (metaScore ? metaScore.biasLabel + " (weighted score: " + metaScore.weightedScore + ")" : "Unknown"),
      "RATIONALE: " + (metaScore ? metaScore.rationale : "N/A"),
      "",
      "ECON: signal=" + (econ ? econ.signal : "neutral") + ", score=" + (econ ? econ.score : 0) + ", weight=" + (metaScore && metaScore.weights ? metaScore.weights.econ : 3),
      "Summary: " + (econ ? econ.summary : "No data"),
      "",
      "EARNINGS: signal=" + (earn ? earn.signal : "neutral") + ", score=" + (earn ? earn.score : 0) + ", weight=" + (metaScore && metaScore.weights ? metaScore.weights.earn : 2),
      "Summary: " + (earn ? earn.summary : "No data"),
      "",
      "PRE-MARKET: signal=" + (premarket ? premarket.signal : "neutral") + ", score=" + (premarket ? premarket.score : 0) + ", weight=" + (metaScore && metaScore.weights ? metaScore.weights.premarket : 1),
      "Summary: " + (premarket ? premarket.summary : "No data"),
      "",
      "MARKET NEWS: signal=" + (news ? news.signal : "neutral") + ", score=" + (news ? news.score : 0) + ", weight=" + (metaScore && metaScore.weights ? metaScore.weights.news : 2),
      "Summary: " + (news ? news.summary : "No data"),
    ].join("\n");

    const body = {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1200,
      temperature: 0,
      system: "You are a futures trader market implications engine. CRITICAL: Reply ONLY with raw JSON matching the exact schema requested. No markdown, no backticks, no explanation.",
      messages: [{ role: "user", content: MARKETS_PROMPT + "\n\nDATA:\n" + context }]
    };

    const payload = JSON.stringify(body);
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    };

    const result = await new Promise((resolve, reject) => {
      const options = { hostname: "api.anthropic.com", path: "/v1/messages", method: "POST", headers };
      const req2 = https.request(options, r => {
        let raw = "";
        r.on("data", c => raw += c);
        r.on("end", () => {
          try {
            const parsed = JSON.parse(raw);
            if (parsed.error) return reject(new Error(parsed.error.message));
            const text = (parsed.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
            const cleaned = text.replace(/```json|```/g, "").trim();
            resolve(JSON.parse(cleaned));
          } catch(e) { reject(new Error("Parse error: " + e.message)); }
        });
      });
      req2.on("error", reject);
      req2.write(payload);
      req2.end();
    });

    console.log("Markets result generated");
    res.json(result);
  } catch(e) {
    console.error("Markets error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/health", function(req, res) {
  res.json({ status: "ok", apiKeySet: !!process.env.ANTHROPIC_API_KEY });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log("Morning brief server running on port " + PORT); });
