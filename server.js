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
    .replace(/\s+/g, " ").trim()
    .slice(0, maxLen || 2500);
}

// ── Data fetchers ─────────────────────────────────────────────
async function fetchEcon() {
  // Try ForexFactory first, fall back to investing.com economic calendar
  try {
    const html = await fetchUrl("https://www.forexfactory.com/calendar");
    const text = stripHtml(html, 4500);
    // If we got blocked or got a login page, text will be short or missing calendar data
    if (text.length > 500 && (text.includes("USD") || text.includes("GMT") || text.includes("forecast"))) {
      return text;
    }
    throw new Error("ForexFactory returned insufficient data");
  } catch(e) {
    console.log("ForexFactory failed (" + e.message + "), trying Tradingeconomics...");
    try {
      const html2 = await fetchUrl("https://tradingeconomics.com/calendar", {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      });
      const text2 = stripHtml(html2, 4500);
      if (text2.length > 500) return text2;
      throw new Error("TradingEconomics also blocked");
    } catch(e2) {
      console.log("TradingEconomics failed (" + e2.message + "), trying ISM/BLS direct...");
      // Last resort: return a message so Claude uses its knowledge
      return "Economic calendar scraping unavailable. Use your knowledge of today s date to recall any major USD economic reports scheduled or released today including NFP, CPI, JOLTS, ISM, GDP, Fed speeches, jobless claims, PCE, PPI. State what you know and score accordingly.";
    }
  }
}

async function fetchEarnings() {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const todayStr = today.toISOString().slice(0, 10);
  const yestStr = yesterday.toISOString().slice(0, 10);
  const FINNHUB_KEY = process.env.FINNHUB_API_KEY || "d8gh1phr01qlgcujfjfgd8gh1phr01qlgcujfjg0";

  async function fetchFinnhub(from, to) {
    try {
      const raw = await fetchUrl(
        "https://finnhub.io/api/v1/calendar/earnings?from=" + from + "&to=" + to + "&token=" + FINNHUB_KEY
      );
      const json = JSON.parse(raw);
      return (json && json.earningsCalendar) ? json.earningsCalendar : [];
    } catch(e) {
      console.log("Finnhub error:", e.message);
      return [];
    }
  }

  const [todayRows, yestRows] = await Promise.all([
    fetchFinnhub(todayStr, todayStr),
    fetchFinnhub(yestStr, yestStr)
  ]);

  // Mega-caps that single-handedly move NQ/ES
  const MEGA = ["NVDA","AAPL","MSFT","META","GOOGL","GOOG","AMZN","TSLA","AVGO","NFLX","AMD","BROADCOM"];

  // Large-caps with significant index impact — banks, financials, tech, healthcare, energy, retail, industrials
  const LARGE = [
    // Banks & Financials
    "JPM","GS","BAC","MS","WFC","C","BLK","SCHW","AXP","CB","MMC","PGR","MET","PRU","TRV","BK","STT",
    // Payments
    "V","MA","PYPL","SQ",
    // Tech & Semis
    "CRM","ORCL","ADBE","QCOM","MU","NOW","INTC","TXN","AMAT","LRCX","KLAC","MRVL","ARM","PANW","SNOW","PLTR",
    // Healthcare & Pharma
    "UNH","LLY","JNJ","PFE","ABBV","MRK","BMY","AMGN","GILD","CVS","CI","HUM","ELV","ISRG","MDT","ABT",
    // Energy
    "XOM","CVX","COP","SLB","EOG","PSX","VLO","MPC",
    // Retail & Consumer
    "WMT","AMZN","HD","COST","TGT","LOW","NKE","SBUX","MCD","YUM",
    // Industrials & Defense
    "BA","CAT","GE","HON","MMM","RTX","LMT","NOC","DE","UPS","FDX",
    // Comm & Media
    "DIS","CMCSA","T","VZ","NFLX","SNAP","UBER","LYFT",
    // Autos
    "F","GM","RIVN",
    // REITs & Utilities (less impact but included)
    "AMT","PLD","NEE"
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
      // Only call BEAT/MISS if difference is more than 1% — anything within 1% is IN-LINE
      // This avoids false misses from consensus differences between data providers
      if (pct < 0.01) beat = "IN-LINE";
      else beat = diff > 0 ? "BEAT" : "MISS";
    }
    const rev = r.revenueActual ? " | Rev: $" + (r.revenueActual/1e9).toFixed(2) + "B" : "";
    const revEst = r.revenueEstimate ? " vs Est: $" + (r.revenueEstimate/1e9).toFixed(2) + "B" : "";
    return tag + " " + tier + " " + r.symbol + " | EPS Act: " + epsAct + " vs Est: " + epsEst + " " + beat + rev + revEst + " | " + (r.hour || "");
  }

  const yestAMC = yestRows.filter(r => r.hour && (r.hour.toLowerCase().includes("amc") || r.hour.toLowerCase().includes("after")));
  const todayBMO = todayRows.filter(r => r.hour && (r.hour.toLowerCase().includes("bmo") || r.hour.toLowerCase().includes("before")));
  const todayAll = todayRows;

  const seen = new Set();
  const combined = [...yestAMC, ...todayBMO, ...todayAll].filter(r => {
    if (seen.has(r.symbol)) return false;
    seen.add(r.symbol);
    return true;
  });

  if (combined.length === 0) return "No earnings data from Finnhub for " + yestStr + " or " + todayStr + ".";

  combined.sort((a, b) => {
    const aScore = MEGA.includes(a.symbol) ? 0 : LARGE.includes(a.symbol) ? 1 : 2;
    const bScore = MEGA.includes(b.symbol) ? 0 : LARGE.includes(b.symbol) ? 1 : 2;
    return aScore - bScore;
  });

  const lines = combined.slice(0, 40).map(r => {
    const isYestAMC = yestAMC.some(y => y.symbol === r.symbol);
    const isTodayBMO = todayBMO.some(b => b.symbol === r.symbol);
    const tag = isYestAMC ? "[YEST AMC]" : isTodayBMO ? "[TODAY BMO]" : "[TODAY]";
    return formatRow(r, tag);
  });

  return "EARNINGS (yesterday=" + yestStr + " AMC, today=" + todayStr + "):\n" + lines.join("\n");
}


async function fetchPremarket() {
  const html = await fetchUrl("https://www.cnbc.com/world/?region=world");
  return stripHtml(html, 2500);
}

async function fetchNews() {
  const html = await fetchUrl("https://www.cnbc.com/markets/");
  return stripHtml(html, 2500);
}

// ── Claude ────────────────────────────────────────────────────
function callClaude(prompt, data) {
  return new Promise((resolve, reject) => {
    const today = new Date().toLocaleDateString("en-US", { weekday:"long", year:"numeric", month:"long", day:"numeric" });
    const payload = JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system: "You are a futures trader morning briefing assistant. Today is " + today + ". CRITICAL: Reply ONLY with raw JSON, no markdown, no backticks, no explanation. Format: {\"signal\":\"bull\",\"summary\":\"2 sentence summary\",\"score\":1} where signal is bull/bear/neutral and score is 1/-1/0.",
      messages: [{ role: "user", content: prompt + "\n\nDATA:\n" + data }]
    });
    const options = {
      hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
      headers: {
        "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload),
        "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01"
      }
    };
    const req = https.request(options, res => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.error) return reject(new Error(parsed.error.message));
          const text = (parsed.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
          resolve(JSON.parse(text.replace(/```json|```/g, "").trim()));
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
  "From this ForexFactory calendar data, extract ONLY reports that are scheduled for TODAY or were released TODAY. Strictly ignore any reports from yesterday or earlier even if they appear in the data. Today is " + new Date().toLocaleDateString("en-US", {weekday:"long", year:"numeric", month:"long", day:"numeric"}) + ".",
  "INCLUDE ONLY:",
  "- Monetary policy: Fed rate decisions, FOMC statements/minutes, Fed member speeches, any major central bank (ECB, BOE, BOJ)",
  "- Labor market: NFP, JOLTS, Weekly Jobless Claims, ADP Employment, Unemployment Rate, Average Hourly Earnings",
  "- Inflation: CPI, Core CPI, PPI, Core PPI, PCE, Core PCE",
  "- Growth: GDP (advance/prelim/final), GDPNow",
  "- Sentiment & Manufacturing: ISM Manufacturing, ISM Services, PMI (Mfg & Services), Consumer Confidence, UoM Consumer Sentiment",
  "- Energy: EIA Crude Oil Inventories, EIA Natural Gas Storage",
  "- London metals session: Gold, Silver, Copper and Platinum London fix or LME reports",
  "- Any other HIGH or MEDIUM impact USD event",
  "EXCLUDE: Low impact events, non-USD currency data (except London metals), routine housing data.",
  "For each included report list: name, actual vs forecast, beat or miss.",
  "INTELLIGENT SCORING RULES - use context to determine score, do not treat all reports equally:",
  "TIER 1 (highest weight - market-moving): Fed rate decision, FOMC statement, NFP, CPI, Core CPI, PCE, Core PCE. These can single-handedly move NQ 1-2%. If any Tier 1 report released today, it dominates the score.",
  "TIER 2 (high weight - currently Fed-focused): JOLTS, Jobless Claims, ADP, Unemployment Rate, PPI. IMPORTANT NUANCE FOR JOLTS AND LABOR DATA: A JOLTS beat (more openings) signals strong economy which is BULLISH for earnings and risk assets UNLESS the market is specifically worried about Fed overtightening. In the current environment where market has largely priced in higher-for-longer, a strong labor market = strong economy = bullish for equities. Only score labor beats as bearish if there is an active Fed meeting imminent or CPI is running hot simultaneously. Jobless Claims rising = bearish (layoffs), Jobless Claims falling = bullish (employment strong).",
  "TIER 3 (medium weight): GDP, ISM, PMI, Consumer Confidence, UoM Sentiment, Average Hourly Earnings.",
  "TIER 4 (lower weight): Oil inventories, Natural Gas, London metals fixes.",
  "MARKET REGIME AWARENESS - critical for correct scoring:",
  "GOOD NEWS IS GOOD NEWS regime (current default): Strong economic data = bullish for equities. Use this when: inflation is trending down, Fed is on hold or cutting, no imminent rate hike fears.",
  "BAD NEWS IS GOOD NEWS regime: Weak data = bullish because it forces Fed to cut. Use this when: inflation is running very hot AND Fed is actively hiking.",
  "CURRENT REGIME (2025-2026): Inflation has cooled significantly from 2022 peaks. Fed has been cutting. Market is in GOOD NEWS IS GOOD NEWS mode. Therefore: strong labor data = bullish, strong GDP = bullish, strong ISM = bullish. Only flip to bearish if inflation re-accelerates sharply (CPI/PCE well above forecast).",
  "SCORING LOGIC: Score based on the highest-tier reports released. A Tier 1 beat overrides mixed Tier 3 data. Mixed Tier 1 = neutral. Multiple Tier 2 beats with Tier 3 miss = lean bull. Use score: 1 (bull), -1 (bear), 0 (neutral). In your summary explain WHICH reports drove the score, WHY they matter more than others, and which market regime you are applying."
].join(" ");

const EARN_PROMPT = [
  "From this earnings data, score based on INDEX IMPACT not equal weighting of all companies.",
  "MEGA-CAP INDEX HEAVYWEIGHTS (highest weight - these move NQ/ES by themselves): NVDA, AAPL, MSFT, META, GOOGL, GOOG, AMZN, TSLA, AVGO, NFLX, AMD.",
  "LARGE-CAP HIGH IMPACT (significant weight): JPM, GS, BAC, MS, V, MA, UNH, LLY, JNJ, XOM, CVX, CRM, ORCL, ADBE, QCOM, MU, INTC, NOW.",
  "SECTOR BELLWETHERS (medium weight - moves sector not full index): Any company that is the largest in its sector.",
  "SMALL/MID CAP (low weight - ignore unless massive beat/miss): Everything else.",
  "SCORING LOGIC: If a mega-cap beats big = strong bull. If a mega-cap misses = strong bear. Multiple large-caps beating with no mega-cap = mild bull. All TBD = neutral. Mixed mega-caps = neutral.","CRITICAL RULE: Only score based on CONFIRMED actual EPS figures in the data provided. If epsActual shows TBD for all companies, score 0 neutral - do NOT use your own knowledge to guess results. Do not infer or assume any company beat or missed unless the actual number is explicitly in the data. If data shows all TBD, say so and score neutral.","IN-LINE RULE: A result marked IN-LINE (within 1% of estimate) for a mega-cap should score neutral not bearish. Consensus estimates differ between data providers by small amounts. Only a clear BEAT or MISS of more than 1% should move the score. Revenue beats/misses can also factor in but should not override EPS direction.","DATA SOURCE: StockAnalysis.com which reports non-GAAP adjusted EPS — the same basis analysts use for estimates. This is the correct number to compare against consensus estimates.",
  "In your summary, lead with the mega-cap and large-cap results first. Mention the company name and whether it beat or missed. Ignore or briefly mention small caps.",
  "Score: 1 (bull), -1 (bear), 0 (neutral)."
].join(" ");
const PREMARKET_PROMPT = "From this CNBC data extract Asia and Europe overnight market performance and US futures direction (NQ, ES, DOW, YM). Name specific index levels or % changes if visible. Score bull if majority green, bear if majority red, neutral if mixed.";
const NEWS_PROMPT = [
  "From this CNBC markets page identify the most impactful stories for US index futures (NQ/ES) today.",
  "INTELLIGENT WEIGHTING - use these severity levels:",

  "LEVEL 5 - MARKET SHOCK OVERRIDE (these completely dominate all other signals including econ data):",
  "- GEOPOLITICAL: Active military conflict outbreak or major escalation (US-Iran strike, Russia-NATO confrontation, China-Taiwan military action), terrorist attack on major financial center, oil embargo, Strait of Hormuz closure, nuclear/biological threat",
  "- SYSTEMIC FINANCIAL: Unexpected major bank failure (SVB-scale or larger), sovereign debt crisis/default of major economy, sudden liquidity freeze, emergency central bank intervention outside scheduled meetings, flash crash",
  "- NATURAL DISASTER/PANDEMIC: Major earthquake hitting financial hub, hurricane/flood shutting down key infrastructure, new pandemic declaration by WHO, supply chain catastrophe",
  "- POLICY/REGULATORY SHOCK: Emergency presidential executive order affecting markets, surprise nationalization of major industry, sweeping antitrust breakup ruling on mega-cap (AAPL, GOOGL, META), extreme overnight tariff announcement (50%+ on major trade partner), crypto ban or asset freeze",
  "- ELECTIONS & POLITICAL: Surprise election outcome reversing expected policy (unexpected party win, contested election results causing constitutional crisis), presidential impeachment or removal, major cabinet resignation during crisis",
  "- CORPORATE MEGA-SHOCK: Sudden CEO removal of Magnificent 7 company, accounting fraud discovery at systemically important firm, unexpected merger of two index heavyweights",
  "If ANY Level 5 event detected: score -1 AND include MARKET_SHOCK_OVERRIDE in summary. This tells the dashboard to discount all other signals.",

  "LEVEL 4 - HIGHEST IMPACT (moves NQ 1%+ intraday, does not override but heavily weights score):",
  "- Fed surprise rate move or emergency statement, major geopolitical tension spike, oil supply shock >5%, large tariff announcement on key sector, major country sanctions, significant election result (not crisis level), large-scale cyber attack on critical infrastructure",

  "LEVEL 3 - HIGH IMPACT (significant move, normal scoring):",
  "- Fed speaker hawkish/dovish pivot, Middle East escalation, China-US trade action, major tech regulatory action, broad risk-off catalyst, significant natural disaster affecting supply chains, election polls showing major shift",

  "LEVEL 2 - MEDIUM IMPACT: Sector news, individual large-cap catalyst, routine policy update, moderate geopolitical tension",

  "LEVEL 1 - LOW IMPACT (do not score): Routine analyst calls, minor company news, social media trends",

  "SCORING LOGIC: Score based on highest severity level present. Level 5 = MARKET_SHOCK_OVERRIDE + score -1. Level 4 = strong -1. Level 3 = -1 or +1 depending on direction. In summary state: event name, severity level, and specifically why it moves NQ/ES.",
  "Score: 1 (bull), -1 (bear), 0 (neutral)."
].join(" ");

// ── Main analyze endpoint ─────────────────────────────────────
app.post("/api/analyze", async function(req, res) {
  const topic = req.body && req.body.topic;
  if (!topic) return res.status(400).json({ error: "No topic" });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "API key not set" });
  console.log("Analyzing:", topic);
  try {
    var rawData, prompt;
    if      (topic === "econ")      { rawData = await fetchEcon();      prompt = ECON_PROMPT; }
    else if (topic === "earn")      { rawData = await fetchEarnings();   prompt = EARN_PROMPT; }
    else if (topic === "premarket") { rawData = await fetchPremarket();  prompt = PREMARKET_PROMPT; }
    else if (topic === "news")      { rawData = await fetchNews();       prompt = NEWS_PROMPT; }
    else return res.status(400).json({ error: "Unknown topic" });

    console.log("Data length:", rawData.length);
    const result = await callClaude(prompt, rawData);
    console.log("Result:", JSON.stringify(result));
    res.json(result);
  } catch(e) {
    console.error("Error for " + topic + ":", e.message);
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

app.get("/api/history", function(req, res) {
  res.json(loadHistory());
});

app.get("/api/history/:dateKey", function(req, res) {
  const history = loadHistory();
  const entry = history[req.params.dateKey];
  if (!entry) return res.status(404).json({ error: "No data for this date" });
  res.json(entry);
});

app.get("/health", function(req, res) {
  res.json({ status: "ok", apiKeySet: !!process.env.ANTHROPIC_API_KEY });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log("Morning brief server running on port " + PORT); });
