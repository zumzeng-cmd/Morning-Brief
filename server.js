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

// ── Regime cache — detected once per trading day, reused all day ──
let regimeCache = { regime: null, rationale: null, dateKey: null };
const REGIMES = {
  GNISGN: "GOOD NEWS IS GOOD NEWS",
  GNISBN: "GOOD NEWS IS BAD NEWS",
  BNISBN: "BAD NEWS IS BAD NEWS",
  BNISGNBN: "BAD NEWS IS GOOD NEWS"
};

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


// ── Regime detection prompt ───────────────────────────────────
const REGIME_PROMPT = [
  "You are a macro market analyst. Determine which of four market regimes is currently active for US equity index futures (NQ/ES).",
  "THE FOUR REGIMES:",
  "GNISGN (Good News Is Good News): Strong economic data = equities rally. Fed is easing or expected to cut. Growth optimism dominates. Market rewards beats. Typical in early-to-mid rate cut cycle or strong growth with low inflation.",
  "GNISBN (Good News Is Bad News): Strong economic data = equities sell off. Fed is on hold or hiking. Market fears rate cuts being delayed/reversed. Yields spike on beats. Strong NFP/CPI = bearish for stocks. THIS WAS THE DOMINANT REGIME IN 2022-2023 and returns whenever inflation is above target and Fed is restrictive.",
  "BNISBN (Bad News Is Bad News): Weak economic data = equities sell off. Recession fears dominate. Even Fed cut hopes don't offset growth collapse fears. Typical in deep recession or growth scare environments.",
  "BNISGNBN (Bad News Is Good News): Weak economic data = equities rally. Fed pivot hopes drive stocks higher on weak prints. Typical when market is pricing aggressive rate cuts and inflation is no longer the primary concern.",
  "DETECTION RULES — use ALL of the following signals:",
  "1. Fed stance: Is Fed hiking, on hold, or cutting? On hold above 4% = likely GNISBN.",
  "2. Inflation: Is CPI/PCE above 2.5% target? If yes, Fed constrained = likely GNISBN or BNISBN.",
  "3. Recent data reactions: Did the last NFP/CPI beat cause equities to sell off? If yes = GNISBN.",
  "4. Yield behavior: Do Treasury yields spike on strong data? If yes = GNISBN.",
  "5. Growth outlook: Are recession fears elevated? If yes and inflation still high = BNISBN.",
  "6. Market breadth: Is the market selling risk broadly or just rate-sensitives? Broad selloff on beats = GNISBN.",
  "CURRENT MACRO CONTEXT (2025-2026): Fed has been on hold at restrictive rates. Inflation cooled from peak but remains above 2% target. Any strong labor or inflation data extends the higher-for-longer narrative. This strongly suggests GNISBN as the base regime unless you detect clear evidence of a pivot or inflation at/below target.",
  "Use today's news and premarket data to confirm or override the base regime.",
  "CONFIDENCE: Rate your confidence 1-5. If 4+, the regime is clear. If 3 or below, default to GNISBN for safety.",
  "JSON SCHEMA: {\"regime\":\"GNISGN|GNISBN|BNISBN|BNISGNBN\",\"confidence\":4,\"rationale\":\"One sentence explaining why this regime is active today.\",\"econScoreFlip\":true}",
  "econScoreFlip: true if strong econ data should score BEARISH (GNISBN or BNISBNBN), false if strong data scores BULLISH (GNISGN or BNISGNBN)."
].join(" ");

// ── Regime detection endpoint ─────────────────────────────────
app.post("/api/regime", async function(req, res) {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "API key not set" });
  const todayKey = new Date().toISOString().slice(0, 10);

  // Return cached regime if same day
  if (regimeCache.regime && regimeCache.dateKey === todayKey) {
    console.log("Regime: returning cached", regimeCache.regime);
    return res.json(regimeCache);
  }

  try {
    const { newsData, premarketData } = req.body;
    const today = new Date().toLocaleDateString("en-US", { weekday:"long", year:"numeric", month:"long", day:"numeric" });

    const contextData = [
      "TODAY: " + today,
      "",
      "NEWS/MARKET CONTEXT:",
      newsData || "No news data provided.",
      "",
      "PRE-MARKET CONTEXT:",
      premarketData || "No premarket data provided."
    ].join("\n");

    const body = {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      temperature: 0,
      system: "You are a macro market regime analyst. CRITICAL: Reply ONLY with raw JSON, no markdown, no backticks, no explanation.",
      messages: [{ role: "user", content: REGIME_PROMPT + "\n\nDATA:\n" + contextData }]
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
            resolve(JSON.parse(text.replace(/```json|```/g, "").trim()));
          } catch(e) { reject(new Error("Parse error: " + e.message)); }
        });
      });
      req2.on("error", reject);
      req2.write(payload);
      req2.end();
    });

    // Validate regime value — reject invalid or low-confidence results
    const validRegimes = ["GNISGN", "GNISBN", "BNISBN", "BNISGNBN"];
    const confidence = parseInt(result.confidence) || 0;

    if (!validRegimes.includes(result.regime) || confidence < 3) {
      // Low confidence — retry once with web search via Sonnet for more context
      console.log("Regime: low confidence (" + confidence + "), retrying with web search...");
      throw new Error("LOW_CONFIDENCE:" + confidence);
    }

    // Cache for the day
    regimeCache = { ...result, dateKey: todayKey };
    console.log("Regime detected:", regimeCache.regime, "| confidence:", regimeCache.confidence);
    res.json(regimeCache);

  } catch(e) {
    if (e.message && e.message.startsWith("LOW_CONFIDENCE")) {
      // ── Retry with Sonnet + web search for richer context ──
      console.log("Regime: attempting web search retry with Sonnet...");
      try {
        const retryBody = {
          model: "claude-sonnet-4-6",
          max_tokens: 400,
          temperature: 0,
          system: "You are a macro market regime analyst. CRITICAL: Reply ONLY with raw JSON, no markdown, no backticks, no explanation.",
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: [{
            role: "user",
            content: REGIME_PROMPT + "\n\nSearch the web for: current Fed policy stance, latest inflation data, recent market reaction to economic data (did equities rise or fall on last NFP/CPI?), 10-year Treasury yield trend. Use this to determine the current market regime."
          }]
        };
        const retryPayload = JSON.stringify(retryBody);
        const retryHeaders = {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(retryPayload),
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "web-search-2025-03-05"
        };
        const retryResult = await new Promise((resolve, reject) => {
          const opts = { hostname: "api.anthropic.com", path: "/v1/messages", method: "POST", headers: retryHeaders };
          const r2 = https.request(opts, rr => {
            let raw = "";
            rr.on("data", c => raw += c);
            rr.on("end", () => {
              try {
                const parsed = JSON.parse(raw);
                if (parsed.error) return reject(new Error(parsed.error.message));
                const text = (parsed.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
                resolve(JSON.parse(text.replace(/```json|```/g, "").trim()));
              } catch(err) { reject(err); }
            });
          });
          r2.on("error", reject);
          r2.write(retryPayload);
          r2.end();
        });

        const validRegimes = ["GNISGN", "GNISBN", "BNISBN", "BNISGNBN"];
        if (validRegimes.includes(retryResult.regime) && parseInt(retryResult.confidence) >= 3) {
          regimeCache = { ...retryResult, dateKey: todayKey };
          console.log("Regime retry succeeded:", regimeCache.regime, "| confidence:", regimeCache.confidence);
          return res.json(regimeCache);
        }
      } catch(retryErr) {
        console.error("Regime retry failed:", retryErr.message);
      }
    }

    // Both attempts failed — return null regime, econ scores neutral
    console.log("Regime: undetermined — econ will score neutral");
    const nullRegime = {
      regime: null,
      confidence: 0,
      rationale: "Regime undetermined — insufficient data. Econ card scoring suspended pending regime confirmation.",
      econScoreFlip: null,
      dateKey: todayKey
    };
    regimeCache = nullRegime;
    res.json(nullRegime);
  }
});

// Regime reset endpoint — call to force re-detection (e.g. after Fed decision)
app.post("/api/regime/reset", function(req, res) {
  regimeCache = { regime: null, rationale: null, dateKey: null };
  console.log("Regime cache cleared");
  res.json({ ok: true });
});

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
  "REGIME_PLACEHOLDER",
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

      // ── Inject current regime into ECON_PROMPT ──
      const todayKeyEcon = new Date().toISOString().slice(0, 10);
      let regimeInstruction;
      if (regimeCache.regime && regimeCache.dateKey === todayKeyEcon) {
        const r = regimeCache.regime;
        const flip = regimeCache.econScoreFlip;
        regimeInstruction = "CURRENT MARKET REGIME: " + r + " (" + (REGIMES[r] || r) + "). " +
          "Confidence: " + (regimeCache.confidence || 3) + "/5. " +
          "Rationale: " + (regimeCache.rationale || "") + " " +
          (flip
            ? "REGIME SCORING RULE: This regime means strong economic data (beats) = BEARISH for equities because good data delays Fed cuts. Score beats as bear (-1) and misses as bull (+1) for all TIER 1 and TIER 2 reports. Neutral data scores 0. This is the opposite of normal scoring — apply it rigorously."
            : "REGIME SCORING RULE: This regime means strong economic data (beats) = BULLISH for equities. Score normally: beats = bull (+1), misses = bear (-1).");
      } else if (regimeCache.regime === null && regimeCache.dateKey === todayKeyEcon) {
        // Regime detection ran but returned null (undetermined) — score econ neutral
        regimeInstruction = "CURRENT MARKET REGIME: UNDETERMINED. Regime detection did not return a confident result. CRITICAL SCORING RULE: You must score ALL reports as 0 (neutral) regardless of beat/miss. Set signal to neutral and score to 0. Do NOT apply any directional bias. In your summary, note the specific data releases and their actuals vs estimates, but state that directional scoring is suspended pending regime confirmation.";
      } else {
        // No regime detection has run yet — score econ neutral and prompt regime run
        regimeInstruction = "CURRENT MARKET REGIME: NOT YET DETECTED. Run regime detection first. CRITICAL SCORING RULE: Score ALL reports as 0 (neutral). Set signal to neutral and score to 0. Note the data releases in your summary but do not apply directional bias.";
      }
      const econPromptWithRegime = ECON_PROMPT.replace("REGIME_PLACEHOLDER", regimeInstruction);

      if (latestMakeData.econ && latestMakeData.econ.length > 100) {
        rawData = latestMakeData.econ;
        prompt = econPromptWithRegime;
        useSearch = false;
        console.log("Econ: using Make.com data | regime:", regimeCache.regime || "default-GNISBN");
      } else {
        // Try FMP first
        const fmpEconData = await fetchEconFMP();
        if (fmpEconData) {
          rawData = fmpEconData;
          prompt = econPromptWithRegime;
          useSearch = false;
          console.log("Econ: using FMP data | regime:", regimeCache.regime || "default-GNISBN");
        } else {
          // Web search fallback with Sonnet
          rawData = "NO EXTERNAL DATA";
          prompt = econPromptWithRegime + " TODAY IS " + dayName2 + " (" + todayStr2 + ")." +
            " Search the web for USD economic reports released or scheduled for today " + todayStr2 + "." +
            " Find actual values for Jobless Claims, Natural Gas Storage, and any other USD reports today." +
            " Only include " + todayStr2 + " data.";
          useSearch = true;
          console.log("Econ: using web search | regime:", regimeCache.regime || "default-GNISBN");
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
// NOTE: Claude only returns implication text and keyLevel.
// All bias, bestSetup, and setupDirection are calculated server-side
// using deterministic rules — Claude never decides instrument direction.
const MARKETS_PROMPT = [
  "You are a senior futures trader. Based on the morning brief signals below, write ONE specific implication sentence and ONE key level for each instrument.",
  "INSTRUMENTS: ES, NQ, YM, RTY (equities), GC, SI, HG, PL (metals), CL, NG (energies), DXY.",
  "FOR EACH INSTRUMENT provide ONLY:",
  "1. implication: ONE sentence on what today's specific drivers mean for this instrument. Name the actual catalyst (e.g. yield spike, risk-off, dollar strength, Asia weakness). Be precise, not generic.",
  "2. keyLevel: the single most important price level or zone to watch today, as a string (e.g. '5250' or '19200-19400'). Null if genuinely unknown.",
  "DO NOT include bias, signal, bestSetup, setupDirection, or divergence — the server calculates these.",
  "RETURN a JSON object with this exact structure:",
  "{ \"equities\": { \"ES\": {\"implication\":\"..\",\"keyLevel\":\"5250\"}, \"NQ\":{\"implication\":\"..\",\"keyLevel\":\"19200\"}, \"YM\":{\"implication\":\"..\",\"keyLevel\":\"38500\"}, \"RTY\":{\"implication\":\"..\",\"keyLevel\":\"2010\"} },",
  "\"metals\": { \"GC\":{\"implication\":\"..\",\"keyLevel\":\"2340\"}, \"SI\":{\"implication\":\"..\",\"keyLevel\":\"29.50\"}, \"HG\":{\"implication\":\"..\",\"keyLevel\":\"4.15\"}, \"PL\":{\"implication\":\"..\",\"keyLevel\":\"1050\"} },",
  "\"energies\": { \"CL\":{\"implication\":\"..\",\"keyLevel\":\"78.50\"}, \"NG\":{\"implication\":\"..\",\"keyLevel\":null} },",
  "\"dxy\": { \"DXY\":{\"implication\":\"..\",\"keyLevel\":\"104.50\"} } }"
].join(" ");

// ── Deterministic instrument scoring ─────────────────────────
// Derives all instrument bias/bestSetup/direction from card signals.
// Never relies on Claude for directional decisions.
function scoreInstruments(econ, earn, premarket, news, metaScore) {
  // ── Card signals (regime-adjusted) ──
  const econSig    = econ      ? econ.signal      : "neutral";
  const newsSig    = news      ? news.signal      : "neutral";
  const preSig     = premarket ? premarket.signal : "neutral";
  const econScore  = econ      ? parseFloat(econ.score)      || 0 : 0;
  const newsScore  = news      ? parseFloat(news.score)      || 0 : 0;
  const preScore   = premarket ? parseFloat(premarket.score) || 0 : 0;
  const earnScore  = earn      ? parseFloat(earn.score)      || 0 : 0;
  const overallWS  = metaScore ? parseFloat(metaScore.weightedScore) || 0 : 0;

  // ── RAW econ direction — independent of regime flip ──
  // The regime adjusts how econ scores affect equity bias, but for
  // dollar/yield/macro condition detection we need the RAW data direction,
  // not the regime-flipped signal. A strong NFP is still a strong NFP
  // even if it's bearish for equities under GNISBN regime.
  // We infer raw econ direction from the news/econ contradiction pattern.
  const econDataStrong = (econSig === "bull") ||
    (econSig === "bear" && regimeCache.econScoreFlip === true); // flipped bear = actually strong data
  const econDataWeak   = (econSig === "bear" && !regimeCache.econScoreFlip) ||
    (econSig === "bull" && regimeCache.econScoreFlip === true); // flipped bull = actually weak data

  // ── Market conditions — derived from RAW data direction, not regime-adjusted signals ──

  // Dollar: strong when underlying data is strong (NFP beat, CPI hot) regardless of equity regime
  // Also check news for yield/dollar language via news signal
  const dollarStrong = econDataStrong && (newsSig !== "bull");
  const dollarWeak   = econDataWeak   || (newsSig === "bull" && !econDataStrong);

  // Risk-off: driven purely by market price action — news and premarket capture this correctly
  const riskOff = (newsSig === "bear") || (preSig === "bear");
  const riskOn  = (newsSig === "bull") && (preSig !== "bear");

  // Yields rising: strong data in a restrictive regime = higher-for-longer pricing
  // This is a function of raw data strength + regime, not the flipped econ signal
  const yieldsRising  = econDataStrong && (newsSig === "bear"); // data beat + market selling = yields up
  const yieldsFalling = econDataWeak   && (newsSig === "bull"); // data miss + market rallying = yields down

  // Asia weakness: premarket bear
  const asiaWeak   = preSig === "bear";
  const asiaStrong = preSig === "bull";

  // Growth fears: premarket bear + news bear (global growth deteriorating)
  const growthFears = (preSig === "bear") && (newsSig === "bear");

  function sig(s) { return s > 0 ? "bull" : s < 0 ? "bear" : "neutral"; }

  // ── EQUITIES ──
  // Use regime-adjusted econ score (already flipped by GNISBN if applicable)
  const esScore  = (econScore * 0.35) + (newsScore * 0.45) + (earnScore * 0.20);
  const nqScore  = yieldsRising
    ? Math.min(esScore - 0.15, newsScore * 0.6 + econScore * 0.25 + earnScore * 0.15)
    : (econScore * 0.30) + (newsScore * 0.50) + (earnScore * 0.20);
  const ymScore  = (econScore * 0.45) + (newsScore * 0.35) + (earnScore * 0.20);
  const rtyScore = (econScore * 0.25) + (newsScore * 0.45) + (preScore * 0.10) + (earnScore * 0.20)
                   + (yieldsRising ? -0.20 : 0);

  const equityBias = { ES: sig(esScore), NQ: sig(nqScore), YM: sig(ymScore), RTY: sig(rtyScore) };

  // ── METALS ──
  // GC rules (in priority order):
  // 1. Strong dollar + rising yields + risk-off = BEAR (yields & dollar dominate safe-haven bid)
  // 2. Strong dollar + rising yields (no risk-off) = BEAR
  // 3. Strong dollar + risk-off (no yields rising) = NEUTRAL (competing forces, no clear winner)
  // 4. Risk-off alone (dollar neutral/weak) = BULL (safe-haven bid)
  // 5. Dollar weak or yields falling = BULL
  // 6. Risk-on + strong dollar + yields rising = BEAR
  // 7. Default = NEUTRAL
  let gcBias;
  if (dollarStrong && yieldsRising)         gcBias = "bear";   // yields + dollar both headwinds — wins vs safe-haven
  else if (dollarStrong && riskOff)         gcBias = "neutral"; // competing forces cancel
  else if (riskOff && !dollarStrong)        gcBias = "bull";    // safe-haven bid with no dollar headwind
  else if (dollarWeak || yieldsFalling)     gcBias = "bull";    // dollar/yield tailwind
  else if (riskOn && dollarStrong)          gcBias = "bear";    // risk-on removes safe-haven, dollar adds pressure
  else                                      gcBias = "neutral";

  // SI: follows GC direction but more volatile
  // Industrial demand component means growth fears push it further bear than GC
  let siBias;
  if (gcBias === "bear")                          siBias = "bear";
  else if (gcBias === "bull" && !growthFears)     siBias = "bull";
  else if (gcBias === "bull" && growthFears)      siBias = "neutral"; // safe-haven bid offset by industrial demand loss
  else if (gcBias === "neutral" && growthFears)   siBias = "bear";    // tips bear on industrial weakness
  else                                            siBias = "neutral";

  // HG: purely industrial/growth — growth fears or Asia weakness = bear
  let hgBias;
  if (growthFears || asiaWeak)   hgBias = "bear";
  else if (riskOn && asiaStrong) hgBias = "bull";
  else                           hgBias = "neutral";

  // PL: 60% precious metals complex (GC direction), 40% industrial (HG direction)
  const plMetals = gcBias === "bull" ? 1 : gcBias === "bear" ? -1 : 0;
  const plIndust = hgBias === "bull" ? 1 : hgBias === "bear" ? -1 : 0;
  const plScore  = (plMetals * 0.6) + (plIndust * 0.4);
  const plBias   = sig(plScore);

  // ── ENERGIES ──
  // CL: growth fears / dollar strength = bear; risk-on / dollar weak = bull
  let clBias;
  if (growthFears)                  clBias = "bear";  // demand destruction fears dominate
  else if (riskOff && dollarStrong) clBias = "bear";
  else if (riskOn  && dollarWeak)   clBias = "bull";
  else if (dollarStrong)            clBias = "bear";
  else if (riskOff)                 clBias = "bear";
  else                              clBias = "neutral";

  // NG: macro-independent, always neutral (weather/storage driven)
  const ngBias = "neutral";

  // ── DXY ──
  // Based on RAW data strength + regime — not regime-adjusted econ signal
  // Strong data = dollar bull (rate premium). Weak data = dollar bear.
  // Risk-off adds to dollar strength (flight to safety) but doesn't override data.
  let dxyBias;
  if      (econDataStrong && riskOff)   dxyBias = "bull";  // data strength + safety bid
  else if (econDataStrong)              dxyBias = "bull";  // data strength alone
  else if (econDataWeak   && riskOn)    dxyBias = "bear";  // weak data + risk-on = dollar sold
  else if (econDataWeak)                dxyBias = "bear";  // weak data
  else if (riskOff)                     dxyBias = "neutral"; // safety bid but no data direction
  else                                  dxyBias = "neutral";

  // ── BEST SETUP per group ──
  // Pick clearest directional (not neutral) + aligns with overall bias signal
  function pickBest(instruments, biases) {
    // Prefer instruments that match overall direction, then strongest signal
    const overall = overallWS < 0 ? "bear" : overallWS > 0 ? "bull" : null;
    const directional = instruments.filter(t => biases[t] !== "neutral");
    const aligned = directional.filter(t => !overall || biases[t] === overall);
    const pool = aligned.length > 0 ? aligned : directional.length > 0 ? directional : instruments;
    // Return first in pool — order of array = priority
    return pool[0];
  }

  const equityBest = pickBest(["NQ","ES","RTY","YM"], equityBias);
  const metalsBest = pickBest(["HG","GC","SI","PL"], { GC: gcBias, SI: siBias, HG: hgBias, PL: plBias });
  const energyBest = pickBest(["CL","NG"], { CL: clBias, NG: ngBias });

  function setupDir(b) { return b === "bull" ? "LONG" : b === "bear" ? "SHORT" : null; }
  function diverges(b) { return overallWS < -0.15 ? b === "bull" : overallWS > 0.15 ? b === "bear" : false; }

  return {
    equities: {
      ES:  { bias: equityBias.ES,  bestSetup: equityBest==="ES",  setupDirection: equityBest==="ES"  ? setupDir(equityBias.ES)  : null, divergence: diverges(equityBias.ES)  },
      NQ:  { bias: equityBias.NQ,  bestSetup: equityBest==="NQ",  setupDirection: equityBest==="NQ"  ? setupDir(equityBias.NQ)  : null, divergence: diverges(equityBias.NQ)  },
      YM:  { bias: equityBias.YM,  bestSetup: equityBest==="YM",  setupDirection: equityBest==="YM"  ? setupDir(equityBias.YM)  : null, divergence: diverges(equityBias.YM)  },
      RTY: { bias: equityBias.RTY, bestSetup: equityBest==="RTY", setupDirection: equityBest==="RTY" ? setupDir(equityBias.RTY) : null, divergence: diverges(equityBias.RTY) },
    },
    metals: {
      GC: { bias: gcBias, bestSetup: metalsBest==="GC", setupDirection: metalsBest==="GC" ? setupDir(gcBias) : null, divergence: diverges(gcBias) },
      SI: { bias: siBias, bestSetup: metalsBest==="SI", setupDirection: metalsBest==="SI" ? setupDir(siBias) : null, divergence: diverges(siBias) },
      HG: { bias: hgBias, bestSetup: metalsBest==="HG", setupDirection: metalsBest==="HG" ? setupDir(hgBias) : null, divergence: diverges(hgBias) },
      PL: { bias: plBias, bestSetup: metalsBest==="PL", setupDirection: metalsBest==="PL" ? setupDir(plBias) : null, divergence: diverges(plBias) },
    },
    energies: {
      CL: { bias: clBias, bestSetup: energyBest==="CL", setupDirection: energyBest==="CL" ? setupDir(clBias) : null, divergence: diverges(clBias) },
      NG: { bias: ngBias, bestSetup: energyBest==="NG", setupDirection: energyBest==="NG" ? setupDir(ngBias) : null, divergence: diverges(ngBias) },
    },
    dxy: {
      DXY: { bias: dxyBias, bestSetup: true, setupDirection: setupDir(dxyBias), divergence: false },
    }
  };
}

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

    // ── Merge Claude's text with server-side deterministic scores ──
    const scores = scoreInstruments(econ, earn, premarket, news, metaScore);

    function merge(claudeGroup, scoreGroup) {
      const out = {};
      Object.keys(scoreGroup).forEach(ticker => {
        const c = (claudeGroup && claudeGroup[ticker]) ? claudeGroup[ticker] : {};
        const s = scoreGroup[ticker];
        out[ticker] = {
          bias:           s.bias,
          implication:    c.implication || "No implication data.",
          keyLevel:       c.keyLevel    || null,
          divergence:     s.divergence,
          bestSetup:      s.bestSetup,
          setupDirection: s.setupDirection
        };
      });
      return out;
    }

    const finalMarkets = {
      equities: merge(result.equities, scores.equities),
      metals:   merge(result.metals,   scores.metals),
      energies: merge(result.energies, scores.energies),
      dxy:      merge(result.dxy,      scores.dxy)
    };

    console.log("Markets result generated (deterministic scoring applied)");
    res.json(finalMarkets);
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
