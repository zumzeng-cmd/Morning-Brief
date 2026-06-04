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

    const usdEvents = json.filter(e => {
      const name = (e.event || "").toLowerCase();
      const country = (e.country || "").toUpperCase();
      return country === "US" && important.some(k => name.includes(k));
    });

    const eventsToUse = usdEvents.length > 0 ? usdEvents : json.filter(e => (e.country || "").toUpperCase() === "US");
    if (eventsToUse.length === 0) return "No USD economic events found for " + todayStr;

    const lines = eventsToUse.map(e => {
      const act = (e.actual !== null && e.actual !== undefined) ? String(e.actual) : "TBD";
      const est = (e.estimate !== null && e.estimate !== undefined) ? String(e.estimate) : "N/A";
      const prev = e.previous ? " | Prev: " + e.previous : "";
      let beat = "";
      if (act !== "TBD" && est !== "N/A") {
        beat = parseFloat(act) > parseFloat(est) ? " → BEAT" : parseFloat(act) < parseFloat(est) ? " → MISS" : " → IN-LINE";
      }
      return (e.event || "") + " | Act: " + act + " vs Est: " + est + prev + beat;
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
        epsActual: r.eps,
        epsEstimate: r.epsEstimated,
        revenueActual: r.revenue,
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

  const yestAMC = yestRows.filter(r => r.hour && (r.hour.toLowerCase().includes("amc") || r.hour.toLowerCase().includes("after")));
  const todayBMO = todayRows.filter(r => r.hour && (r.hour.toLowerCase().includes("bmo") || r.hour.toLowerCase().includes("before")));
  const todayAll = todayRows;
  const seen = new Set();
  const combined = [...yestAMC, ...todayBMO, ...todayAll].filter(r => { if(seen.has(r.symbol)) return false; seen.add(r.symbol); return true; });
  if (combined.length === 0) return "No earnings data from Finnhub for " + yestStr + " or " + todayStr + ".";
  combined.sort((a, b) => { const aS = MEGA.includes(a.symbol)?0:LARGE.includes(a.symbol)?1:2; const bS = MEGA.includes(b.symbol)?0:LARGE.includes(b.symbol)?1:2; return aS-bS; });
  const lines = combined.slice(0, 40).map(r => {
    const isYestAMC = yestAMC.some(y => y.symbol === r.symbol);
    const isTodayBMO = todayBMO.some(b => b.symbol === r.symbol);
    const tag = isYestAMC ? "[YEST AMC]" : isTodayBMO ? "[TODAY BMO]" : "[TODAY]";
    return formatRow(r, tag);
  });
  const nonGaapNote = "NOTE: Mega-caps like AVGO, NVDA, AAPL report non-GAAP adjusted EPS. MEGA-CAP STRICT RULE: any miss is a miss regardless of size.";
  return "EARNINGS (yesterday=" + yestStr + " AMC, today=" + todayStr + "):\n" + lines.join("\n") + "\n\n" + nonGaapNote;
}

async function fetchPremarket() {
  const html = await fetchUrl("https://www.cnbc.com/world/?region=world");
  return stripHtml(html, 2500);
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
      system: "You are a futures trader morning briefing assistant. Today is " + today + ". CRITICAL: Reply ONLY with raw JSON, no markdown, no backticks, no explanation. Format: {\"signal\":\"bull\",\"summary\":\"2 sentence summary\",\"score\":1} where signal is bull/bear/neutral and score is 1/-1/0.",
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
  "From this economic calendar data, extract ONLY the following report types and IGNORE everything else.",
  "INCLUDE ONLY: Monetary policy (Fed rate decisions, FOMC, Fed speeches, ECB/BOE/BOJ), Labor market (NFP, JOLTS, Jobless Claims, ADP, Unemployment Rate, Average Hourly Earnings), Inflation (CPI, Core CPI, PPI, Core PPI, PCE, Core PCE), Growth (GDP), Sentiment & Manufacturing (ISM Manufacturing, ISM Services, PMI, Consumer Confidence, UoM Sentiment), Energy (EIA Crude Oil Inventories, EIA Natural Gas Storage), London metals session (Gold, Silver, Copper, Platinum London fix or LME), Any HIGH or MEDIUM impact USD event.",
  "EXCLUDE: Low impact events, non-USD data (except London metals).",
  "For each included report: name, actual vs forecast, beat or miss.",
  "MARKET REGIME (2025-2026): Inflation has cooled but remains above target. Fed is on hold. We are in GOOD NEWS IS GOOD NEWS mode — strong economic data = bullish for equities. Only flip bearish if inflation re-accelerates sharply.",
  "TIER 1 (dominates everything): Fed rate decision, FOMC, NFP, CPI, PCE. TIER 2 (high weight): JOLTS, Jobless Claims, ADP, Unemployment Rate, PPI. TIER 3 (medium): GDP, ISM, PMI, Sentiment. TIER 4 (lower): Oil/gas inventories, metals.",
  "JOLTS beat = bullish (strong economy). Jobless Claims rising = bearish. Only score labor beats as bearish if CPI is hot simultaneously.",
  "TODAY-ONLY RULE: Only score reports confirmed released or scheduled for TODAY. Strictly ignore any reports from yesterday or earlier.",
  "MEGA-CAP STRICT RULE: any miss is a miss regardless of size.",
  "Score: bull=1, bear=-1, neutral=0."
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
  "Score: bull=1, bear=-1, neutral=0."
].join(" ");

const PREMARKET_PROMPT = [
  "From this CNBC data extract Asia and Europe overnight market performance and US futures direction (NQ, ES, DOW, YM).",
  "Name specific index levels or % changes if visible.",
  "Score: bull if majority green, bear if majority red, neutral if mixed.",
  "Score: bull=1, bear=-1, neutral=0."
].join(" ");

const NEWS_PROMPT = [
  "From this CNBC markets page identify the most impactful stories for US index futures (NQ/ES) today.",
  "LEVEL 5 - MARKET SHOCK OVERRIDE (completely dominates all other signals): Active military conflict outbreak, emergency Fed rate decision, major bank failure, pandemic declaration, emergency executive order affecting markets, surprise nationalization, sweeping antitrust breakup of mega-cap, extreme overnight tariff (50%+), contested election causing constitutional crisis, surprise election outcome reversing expected policy. If Level 5 detected: score -1 AND include MARKET_SHOCK_OVERRIDE in summary.",
  "LEVEL 4 - HIGHEST IMPACT (moves NQ 1%+ intraday): Fed surprise pivot, major geopolitical escalation, oil supply shock >5%, large tariff announcement.",
  "LEVEL 3 - HIGH IMPACT: Fed speaker hawkish/dovish shift, Middle East escalation, trade action, regulatory ruling.",
  "LEVEL 2 - MEDIUM: Sector news, individual large-cap catalyst.",
  "LEVEL 1 - LOW (do not score): Routine analyst calls, minor company news.",
  "IMPORTANT: Do NOT include level labels like Level 3 or Level 4 in your summary text. Write natural plain English.",
  "Score: bull=1, bear=-1, neutral=0."
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
        // Make.com has good data
        rawData = latestMakeData.econ;
        prompt = ECON_PROMPT;
        useSearch = false;
        console.log("Econ: using Make.com data");
      } else {
        // Always use web search for econ — most reliable for live data
        rawData = "NO EXTERNAL DATA";
        prompt = ECON_PROMPT + " TODAY IS " + dayName2 + " (" + todayStr2 + ")." +
          " Search the web NOW for: USD economic reports released or scheduled for today " + todayStr2 + "." +
          " Search specifically for: 'Initial Jobless Claims " + todayStr2 + "' AND 'Natural Gas Storage EIA " + todayStr2 + "' AND 'economic calendar " + todayStr2 + "'." +
          " Report the actual numbers released today with beat/miss vs forecast." +
          " Only include reports for " + todayStr2 + ".";
        useSearch = false;
        console.log("Econ: using Claude knowledge");
      }
    } else if (topic === "earn") {
      prompt = EARN_PROMPT;
      const today3 = new Date();
      const todayStr3 = today3.toISOString().slice(0, 10);
      const yest3 = new Date(today3); yest3.setDate(yest3.getDate()-1);
      const yestStr3 = yest3.toISOString().slice(0, 10);
      if (latestMakeData.earnings && latestMakeData.earnings.length > 50) {
        rawData = latestMakeData.earnings;
        console.log("Earnings: using Make.com data");
      } else {
        rawData = await fetchEarnings();
        // Check if FMP has mega-cap actual data
        const hasMegaActuals = rawData && (rawData.includes("BEAT") || rawData.includes("MISS") || rawData.includes("IN-LINE")) && (rawData.includes("AVGO") || rawData.includes("NVDA") || rawData.includes("AAPL") || rawData.includes("MSFT") || rawData.includes("META"));
        if (!hasMegaActuals) {
          // Supplement with web search for recent mega-cap results
          prompt = EARN_PROMPT + " Search the web for major S&P500/Nasdaq earnings reported on " + yestStr3 + " AMC or " + todayStr3 + " BMO. Focus on AVGO, NVDA, AAPL, MSFT, META, GOOGL, AMZN, TSLA, NFLX, AMD and major banks. State EPS actual vs estimate and beat/miss. Also include this API data: " + (rawData || "none");
          useSearch = true;
          console.log("Earnings: using web search for mega-cap results");
        }
      }
    } else if (topic === "premarket") {
      prompt = PREMARKET_PROMPT;
      rawData = latestMakeData.premarket || await fetchPremarket();
      if (latestMakeData.premarket) console.log("Premarket: using Make.com data");
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

app.get("/health", function(req, res) {
  res.json({ status: "ok", apiKeySet: !!process.env.ANTHROPIC_API_KEY });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log("Morning brief server running on port " + PORT); });
