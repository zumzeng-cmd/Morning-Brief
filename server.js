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

  async function fetchDay(dateStr) {
    try {
      const raw = await fetchUrl("https://api.nasdaq.com/api/calendar/earnings?date=" + dateStr, {
        "Origin": "https://www.nasdaq.com", "Referer": "https://www.nasdaq.com/"
      });
      const json = JSON.parse(raw);
      return (json && json.data && json.data.rows) ? json.data.rows : [];
    } catch(e) { return []; }
  }

  const [todayRows, yestRows] = await Promise.all([fetchDay(todayStr), fetchDay(yestStr)]);
  const yestAMC = yestRows.filter(r => r.time && r.time.toLowerCase().includes("after"));
  const todayBMO = todayRows.filter(r => r.time && r.time.toLowerCase().includes("before"));
  const todayOther = todayRows.filter(r => !r.time || !r.time.toLowerCase().includes("before"));
  const combined = [...yestAMC, ...todayBMO, ...todayOther];
  const seen = new Set();
  const unique = combined.filter(r => { if(seen.has(r.symbol)) return false; seen.add(r.symbol); return true; });
  if (unique.length === 0) return "No earnings data available for " + todayStr;
  const lines = unique.slice(0, 30).map(function(r) {
    const isYestAMC = yestAMC.some(y => y.symbol === r.symbol);
    const isTodayBMO = todayBMO.some(b => b.symbol === r.symbol);
    const tag = isYestAMC ? "[YEST AMC]" : isTodayBMO ? "[TODAY BMO]" : "[TODAY]";
    var beat = "";
    if (r.eps && r.epsForecast) {
      beat = parseFloat(r.eps) > parseFloat(r.epsForecast) ? "BEAT" : parseFloat(r.eps) < parseFloat(r.epsForecast) ? "MISS" : "IN-LINE";
    }
    return tag + " " + r.symbol + " | Est: " + (r.epsForecast || "N/A") + " | Act: " + (r.eps || "TBD") + " " + beat + " | " + (r.time || "");
  });
  return "EARNINGS (" + yestStr + " AMC + " + todayStr + "):\n" + lines.join("\n");
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
  "From this ForexFactory calendar data, extract ONLY the following report types and IGNORE everything else.",
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
  "TIER 2 (high weight - currently Fed-focused): JOLTS, Jobless Claims, ADP, Unemployment Rate, PPI. The Fed is using labor market data to guide rate decisions so JOLTS and claims carry more weight than GDP right now.",
  "TIER 3 (medium weight): GDP, ISM, PMI, Consumer Confidence, UoM Sentiment, Average Hourly Earnings.",
  "TIER 4 (lower weight): Oil inventories, Natural Gas, London metals fixes.",
  "SCORING LOGIC: Score based on the highest-tier reports released. A Tier 1 beat overrides mixed Tier 3 data. Mixed Tier 1 = neutral. Multiple Tier 2 beats with Tier 3 miss = lean bull. Use score: 1 (bull), -1 (bear), 0 (neutral). In your summary explain WHICH reports drove the score and WHY they matter more than others."
].join(" ");

const EARN_PROMPT = [
  "From this earnings data, score based on INDEX IMPACT not equal weighting of all companies.",
  "MEGA-CAP INDEX HEAVYWEIGHTS (highest weight - these move NQ/ES by themselves): NVDA, AAPL, MSFT, META, GOOGL, GOOG, AMZN, TSLA, AVGO, NFLX, AMD.",
  "LARGE-CAP HIGH IMPACT (significant weight): JPM, GS, BAC, MS, V, MA, UNH, LLY, JNJ, XOM, CVX, CRM, ORCL, ADBE, QCOM, MU, INTC, NOW.",
  "SECTOR BELLWETHERS (medium weight - moves sector not full index): Any company that is the largest in its sector.",
  "SMALL/MID CAP (low weight - ignore unless massive beat/miss): Everything else.",
  "SCORING LOGIC: If a mega-cap beats big = strong bull. If a mega-cap misses = strong bear. Multiple large-caps beating with no mega-cap = mild bull. All TBD = neutral. Mixed mega-caps = neutral.",
  "In your summary, lead with the mega-cap and large-cap results first. Mention the company name and whether it beat or missed. Ignore or briefly mention small caps.",
  "Score: 1 (bull), -1 (bear), 0 (neutral)."
].join(" ");
const PREMARKET_PROMPT = "From this CNBC data extract Asia and Europe overnight market performance and US futures direction (NQ, ES, DOW, YM). Name specific index levels or % changes if visible. Score bull if majority green, bear if majority red, neutral if mixed.";
const NEWS_PROMPT = [
  "From this CNBC markets page identify the most impactful stories for US index futures (NQ/ES) today.",
  "INTELLIGENT WEIGHTING - not all news is equal:",
  "HIGHEST IMPACT (can move NQ 1%+): Fed surprise announcements, emergency rate decisions, major geopolitical escalation (war, oil embargo), financial system stress (bank failures, credit events), unexpected major macro data.",
  "HIGH IMPACT: Fed speaker hawkish/dovish shift, Middle East/oil supply disruption, China-US trade escalation, major tech regulatory action, broad market selloff/rally drivers.",
  "MEDIUM IMPACT: Sector-specific news, individual company news (unless mega-cap), routine geopolitical updates.",
  "LOW IMPACT (do not let this drive the score): Social media trends, minor company news, routine analyst upgrades/downgrades.",
  "SCORING LOGIC: Score based on the highest-impact story present. One major geopolitical shock = bear even if other news is positive. Fed dovish surprise = bull even with negative earnings news. Mixed high-impact stories = neutral.",
  "In summary, state the top story, why it matters for NQ/ES specifically, and what the likely market reaction is.",
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
