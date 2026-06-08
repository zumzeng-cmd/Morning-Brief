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

  // Weekend/overnight session detection
  const now = new Date();
  const etNow = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const dayOfWeek = etNow.getDay(); // 0=Sun, 6=Sat
  const hourET = etNow.getHours();

  // Saturday all day — fully closed, return neutral immediately
  if (dayOfWeek === 6) {
    console.log("Premarket: Saturday — markets fully closed");
    return "WEEKEND SATURDAY — All markets closed. No pre-market data available. Score neutral (0).";
  }

  // Sunday before 5pm ET — still closed, return neutral
  if (dayOfWeek === 0 && hourET < 17) {
    console.log("Premarket: Sunday before 5pm ET — markets still closed");
    return "WEEKEND SUNDAY (pre-open) — Markets remain closed. Asian session has not yet opened. Score neutral (0).";
  }

  // Sunday 5pm ET or later — Asia is opening/open, fall through to web search
  // (Finnhub ETF proxies won't have data yet — use web search for live Asian market context)
  if (dayOfWeek === 0 && hourET >= 17) {
    console.log("Premarket: Sunday evening — Asia opening, will use web search for live context");
    return null; // null triggers web search fallback in the analyze endpoint
  }

  // Monday before 3am ET — Asia trading, Europe not yet open
  // Finnhub ETFs still won't be live — use web search
  if (dayOfWeek === 1 && hourET < 3) {
    console.log("Premarket: Monday pre-Europe — Asia trading, using web search");
    return null; // null triggers web search fallback
  }

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
      max_tokens: useWebSearch ? 1000 : 500,  // web search needs more tokens for search results
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
          if (!text) {
            // Web search may return only tool_use blocks with no text — log and return neutral
            console.log("callClaude: empty text response, stop_reason:", parsed.stop_reason, "content types:", (parsed.content||[]).map(b=>b.type).join(","));
            return resolve({ signal: "neutral", summary: "Could not fetch data. Use override buttons to set manually.", score: 0, guidance: null });
          }
          // Extract JSON — handle cases where Claude wraps it in preamble text
          let cleaned = text.replace(/```json|```/g, "").trim();
          // Try to find JSON object if Claude added preamble
          const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
          if (jsonMatch) cleaned = jsonMatch[0];
          const result = JSON.parse(cleaned);
          // Ensure result has required fields
          if (!result.signal || !result.hasOwnProperty("score")) {
            console.log("callClaude: missing required fields in result:", JSON.stringify(result).slice(0,100));
            resolve({ signal: "neutral", summary: "Could not fetch data. Use override buttons to set manually.", score: 0, guidance: null });
          } else {
            if (!result.hasOwnProperty("guidance")) result.guidance = null;
            resolve(result);
          }
        } catch(e) {
          console.log("callClaude parse error:", e.message, "| raw snippet:", raw.slice(0,200));
          reject(new Error("Parse error: " + e.message));
        }
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
  "TIEBREAKER RULE: If multiple stories conflict (e.g. hawkish rate narrative AND geopolitical tensions), score based on whichever has the LARGER index impact. A hot jobs report delaying Fed cuts = Level 3-4 bearish for NQ/ES. An oil price surge without supply shock = Level 2 at most. Do NOT score neutral just because two stories conflict — identify the dominant driver and score it.",
  "HAWKISH RULE: If the dominant news is rate-cut delays, higher-for-longer Fed narrative, or yields rising on economic strength, score BEARISH (-1). This is unambiguous bearish for growth equities regardless of any positive geopolitical or commodity offsets.",
  "IMPORTANT: Do NOT include level labels like Level 3 or Level 4 in your summary text. Write natural plain English.",
  "Score: bull=1, bear=-1, neutral=0. Reserve neutral ONLY for days with genuinely no directional catalyst — not for days where competing stories exist.",
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
        const today2 = new Date();
        const todayStr2 = today2.toISOString().slice(0, 10);
        const etNow2 = new Date(today2.toLocaleString("en-US", { timeZone: "America/New_York" }));
        const dayET = etNow2.getDay();
        const hourET2 = etNow2.getHours();

        if (rawData && !rawData.startsWith("WEEKEND") && rawData.includes("ASIA")) {
          // Good Finnhub ETF data
          console.log("Premarket: using Finnhub ETF data");
        } else if (rawData && rawData.startsWith("WEEKEND SATURDAY")) {
          // Saturday — score neutral, no search needed
          console.log("Premarket: Saturday closed");
        } else if (rawData && rawData.startsWith("WEEKEND SUNDAY (pre-open)")) {
          // Sunday before 5pm — neutral
          console.log("Premarket: Sunday pre-open closed");
        } else {
          // null (Sunday evening / Monday pre-Europe) OR Finnhub failed — web search
          rawData = "NO EXTERNAL DATA";
          let searchCtx = "";
          if (dayET === 0 && hourET2 >= 17) {
            searchCtx = " It is Sunday evening ET — Asian markets are opening or in early session. Search for LIVE current performance of: HSI (Hang Seng), Nikkei 225, ASX 200 (Australia), Shanghai Composite, STI (Singapore). State current % change for each. Also check if US index futures (NQ, ES) are showing any direction in overnight trading.";
          } else if (dayET === 1 && hourET2 < 3) {
            searchCtx = " It is early Monday morning ET — Asian markets are trading, European markets have not opened yet. Search for LIVE current performance of: HSI, Nikkei, ASX 200, Shanghai, STI. State current % change for each. Note European markets open at approximately 3am ET.";
          } else {
            searchCtx = " Search the web for today " + todayStr2 + " pre-market performance of: HSI (Hang Seng), Nikkei 225, ASX 200, Shanghai Composite, STI. Also STOXX 600, DAX, FTSE 100, AEX, CAC 40. Also NQ futures, ES futures, DOW futures. State % change for each.";
          }
          prompt = PREMARKET_PROMPT + searchCtx;
          useSearch = true;
          console.log("Premarket: using web search —", dayET === 0 ? "Sunday evening" : dayET === 1 && hourET2 < 3 ? "Monday pre-Europe" : "Finnhub fallback");
        }
      }
    } else if (topic === "news") {
      prompt = NEWS_PROMPT;
      if (latestMakeData.news && latestMakeData.news.length > 50) {
        rawData = latestMakeData.news;
        console.log("News: using Make.com data");
      } else {
        // Weekend detection — CNBC scrape shows stale Friday content on weekends
        const nowNews = new Date();
        const etNowNews = new Date(nowNews.toLocaleString("en-US", { timeZone: "America/New_York" }));
        const dayNews = etNowNews.getDay(); // 0=Sun, 6=Sat
        const hourNews = etNowNews.getHours();
        const isWeekend = dayNews === 6 || (dayNews === 0);
        const isSundayEvening = dayNews === 0 && hourNews >= 17;

        if (isWeekend && !isSundayEvening) {
          // Saturday or Sunday daytime — use scrape but note it may be stale
          rawData = await fetchNews();
          console.log("News: weekend — using CNBC scrape (may show Friday data)");
        } else if (isSundayEvening) {
          // Sunday evening — web search for weekend developments + Asia open context
          rawData = "NO EXTERNAL DATA";
          const todayStrNews = nowNews.toISOString().slice(0, 10);
          prompt = NEWS_PROMPT + " It is Sunday evening ET. Search the web for: (1) any major market-moving news that broke this weekend (geopolitical events, Fed commentary, economic surprises, corporate news), (2) the tone of Asian markets as they open tonight, (3) any developments since Friday's US close that could move NQ/ES on Monday open. If nothing significant happened, note that markets closed Friday's session with [summarize Friday's dominant narrative] and no major weekend catalysts have emerged.";
          useSearch = true;
          console.log("News: Sunday evening — using web search for weekend developments");
        } else {
          // Normal weekday — use CNBC scrape
          rawData = await fetchNews();
          console.log("News: using CNBC scrape");
        }
      }
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
function scoreInstruments(econ, earn, premarket, news, metaScore, regime) {
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
  // Use the passed-in regime object (not module-level cache) to determine
  // whether the econ signal was flipped. This ensures correctness even if
  // the module cache differs from what was active when the analysis ran.
  const econFlipped = regime && regime.econScoreFlip === true;
  const econDataStrong = (econSig === "bull" && !econFlipped) ||
    (econSig === "bear" && econFlipped);  // flipped bear = actually strong data
  const econDataWeak   = (econSig === "bear" && !econFlipped) ||
    (econSig === "bull" && econFlipped);  // flipped bull = actually weak data

  // ── Market conditions — derived from RAW data direction + market signals ──
  // When econ is neutral (no data released, e.g. Fed speech day), we infer
  // dollar/yield conditions from premarket + news alone. Premarket bearish
  // with news bearish on a prior strong data day = yields still elevated.

  const econIsNeutral = !econDataStrong && !econDataWeak; // econ scored 0, no directional data

  // Dollar: strong when underlying data is strong OR when prior strong data
  // is still driving the narrative (inferred from news bearish on neutral econ day)
  const dollarStrong = (econDataStrong && newsSig !== "bull") ||
    (econIsNeutral && newsSig === "bear" && preSig === "bear"); // prior strong data echo
  const dollarWeak   = (econDataWeak && !econIsNeutral) ||
    (newsSig === "bull" && !econDataStrong && !econIsNeutral);

  // Risk-off: driven purely by market price action
  const riskOff = (newsSig === "bear") || (preSig === "bear");
  const riskOn  = (newsSig === "bull") && (preSig !== "bear");

  // Yields rising: strong data in restrictive regime = higher-for-longer pricing
  // Also infer yields still elevated if econ neutral but both news + pre bearish
  // (prior NFP beat is still driving yield narrative next session)
  const yieldsRising  = (econDataStrong && newsSig === "bear") ||
    (econIsNeutral && newsSig === "bear" && preSig === "bear");
  const yieldsFalling = econDataWeak && newsSig === "bull";

  // Asia weakness: premarket bear
  const asiaWeak   = preSig === "bear";
  const asiaStrong = preSig === "bull";

  // Growth fears: premarket bear + news bear
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
  if      (econDataStrong && riskOff)                              dxyBias = "bull";    // strong data + safety bid = dollar bid on all fronts
  else if (econDataStrong)                                         dxyBias = "bull";    // strong data alone = rate premium drives dollar
  else if (econIsNeutral && newsSig === "bear" && preSig === "bear") dxyBias = "bull";  // no new data but prior strong data still echoing through yields/risk-off
  else if (econDataWeak   && riskOn)                               dxyBias = "bear";   // weak data + risk-on = dollar sold
  else if (econDataWeak)                                           dxyBias = "bear";   // weak data = rate cut expectations = dollar weak
  else if (econIsNeutral  && newsSig === "bull" && preSig === "bull") dxyBias = "bear"; // no data, risk-on = dollar pressure
  else if (riskOff)                                                dxyBias = "neutral"; // safety bid but no data direction = no conviction
  else                                                             dxyBias = "neutral";

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

  // NQ leads equities when yields are rising (most rate-sensitive)
  // RTY leads only when growth/credit fears dominate without yield driver
  const equityOrder = yieldsRising ? ["NQ","ES","YM","RTY"] : ["NQ","ES","RTY","YM"];
  const equityBest = pickBest(equityOrder, equityBias);
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
  const { econ, earn, premarket, news, metaScore, regime } = req.body;
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
    const activeRegime = regime || regimeCache; // prefer frontend-sent regime, fall back to server cache
    const scores = scoreInstruments(econ, earn, premarket, news, metaScore, activeRegime);

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


// ── Summary endpoint ──────────────────────────────────────────
// Generates a plain-English layman's summary of the full dashboard
const SUMMARY_PROMPT = [
  "You are explaining today's financial market conditions to someone who is intelligent but not a trader.",
  "They want to understand what is happening in markets today, why it matters, and what it means — in plain English with no jargon.",
  "You have been given the full morning brief: the market regime, overall bias, all four signal cards with their individual sentiments, and market implications for specific instruments.",
  "Write a clear, conversational summary in 5 short paragraphs:",
  "PARAGRAPH 1 — THE BIG PICTURE: What is the overall mood in markets today and what is the single most important thing driving it? State the overall bias clearly (e.g. bearish, neutral, bullish) and the primary reason. Use plain language. No ticker symbols in this paragraph.",
  "PARAGRAPH 2 — THE FOUR SIGNALS: Briefly explain what each of the four cards is saying in plain English — (1) what economic data released today means, (2) what earnings are telling us, (3) what overnight global markets (Asia and Europe) did and why, (4) what the key news narrative is. Each signal gets 1 sentence. Connect them to the overall picture.",
  "PARAGRAPH 3 — WHY IT MATTERS: Explain the key cause-and-effect chain for a non-trader. E.g. 'A stronger-than-expected jobs report means the Fed is less likely to cut interest rates soon, which makes borrowing more expensive, which weighs on growth stocks.' Connect the dots clearly.",
  "PARAGRAPH 4 — WHAT THE MARKETS ARE DOING: Briefly describe what stocks, gold, oil, and the dollar are doing today and why — in plain English. Mention the directional bias for each asset class. Avoid futures codes.",
  "PARAGRAPH 5 — WHAT TO WATCH: One or two specific things that could change the picture today or this week. Keep it forward-looking and actionable for a non-trader.",
  "TONE: Conversational, clear, confident. Like a smart friend explaining the news over coffee — not a Bloomberg terminal.",
  "LENGTH: 5 paragraphs, 2-4 sentences each. No headers, no bullet points, no bold text. Just clean readable prose.",
  "JSON SCHEMA: {",
  "  \"headline\": \"8-10 word headline summarising today in plain English\",",
  "  \"paragraphs\": [\"paragraph 1\", \"paragraph 2\", \"paragraph 3\", \"paragraph 4\", \"paragraph 5\"]",
  "}"
].join(" ");

app.post("/api/summary", async function(req, res) {
  const { econ, earn, premarket, news, metaScore, regime, markets } = req.body;
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "API key not set" });

  try {
    const today = new Date().toLocaleDateString("en-US", { weekday:"long", year:"numeric", month:"long", day:"numeric" });
    const etTime = new Date().toLocaleTimeString("en-US", { hour:"2-digit", minute:"2-digit", hour12:true, timeZone:"America/New_York" });

    const weights = metaScore ? metaScore.weights : { econ:3, earn:2, premarket:1, news:2 };
    const context = [
      "TODAY: " + today + " | TIME (ET): " + etTime,
      "REGIME: " + (regime ? regime.regime + " (" + (regime.regime === "GNISBN" ? "Good News Is Bad News" : regime.regime === "GNISGN" ? "Good News Is Good News" : regime.regime === "BNISBN" ? "Bad News Is Bad News" : "Bad News Is Good News") + ") — " + regime.rationale : "Unknown"),
      "OVERALL BIAS: " + (metaScore ? metaScore.biasLabel + " (weighted score: " + metaScore.weightedScore + ")" : "Unknown"),
      "AI WEIGHTING RATIONALE: " + (metaScore ? metaScore.rationale : "N/A"),
      "",
      "SIGNAL 1 — ECON CALENDAR (weight " + (weights.econ||3) + "x): " + (econ ? econ.signal.toUpperCase() + " (score: " + econ.score + ") | " + econ.summary : "No data"),
      "SIGNAL 2 — EARNINGS (weight " + (weights.earn||2) + "x): " + (earn ? earn.signal.toUpperCase() + " (score: " + earn.score + ") | " + earn.summary : "No data"),
      "SIGNAL 3 — PRE-MARKET (weight " + (weights.premarket||1) + "x): " + (premarket ? premarket.signal.toUpperCase() + " (score: " + premarket.score + ") | " + premarket.summary : "No data"),
      "SIGNAL 4 — MARKET NEWS (weight " + (weights.news||2) + "x): " + (news ? news.signal.toUpperCase() + " (score: " + news.score + ") | " + news.summary : "No data"),
      "",
      "MARKET IMPLICATIONS:",
      markets && markets.equities ? "Stocks — S&P 500: " + markets.equities.ES.bias + ", Nasdaq: " + markets.equities.NQ.bias + ", Dow: " + markets.equities.YM.bias + ", Small-caps: " + markets.equities.RTY.bias : "",
      markets && markets.metals   ? "Metals — Gold: " + markets.metals.GC.bias + " (" + (markets.metals.GC.implication||"") + "), Silver: " + markets.metals.SI.bias + ", Copper: " + markets.metals.HG.bias : "",
      markets && markets.energies ? "Energy — Oil: " + markets.energies.CL.bias + " (" + (markets.energies.CL.implication||"") + ")" : "",
      markets && markets.dxy      ? "Dollar: " + markets.dxy.DXY.bias + " (" + (markets.dxy.DXY.implication||"") + ")" : "",
    ].filter(Boolean).join("\n");

    const body = {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1200,
      temperature: 0,
      system: "You are a clear, friendly market commentator writing for a non-trader audience. CRITICAL: Reply ONLY with raw JSON, no markdown, no backticks, no explanation.",
      messages: [{ role: "user", content: SUMMARY_PROMPT + "\n\nDATA:\n" + context }]
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

    console.log("Summary generated");
    res.json(result);
  } catch(e) {
    console.error("Summary error:", e.message);
    res.status(500).json({ error: e.message });
  }
});


// ── Backtest endpoint ─────────────────────────────────────────
// Hybrid: Claude Memory Mode (pre-Aug 2025) or API History Mode (post-Aug 2025)
const MEMORY_CUTOFF = new Date("2025-08-31");

// Prompts for memory-mode reconstruction
function buildMemoryPrompt(topic, dateStr) {
  const base = "You are reconstructing historical market data for " + dateStr + " from your training data. " +
    "Search the web to supplement your recall with accurate data. " +
    "IMPORTANT: This is historical reconstruction — include a one-sentence confidence note at the end of your summary " +
    "stating which data points are confirmed vs approximate. " +
    "Reply ONLY with raw JSON with fields: signal (bull/bear/neutral), summary (2 sentences), score (1/0/-1), guidance (null), confidence (confirmed/approximate/estimated).";

  const topics = {
    econ: "Reconstruct the US economic calendar for " + dateStr + ". " +
      "Search for: what major USD economic reports were released that day (NFP, CPI, FOMC, jobless claims, etc), " +
      "their actual values vs consensus estimates, and whether they beat or missed. " +
      "Apply the correct market regime for that date when scoring. " +
      "If no major reports were scheduled, score neutral. " + base,

    earn: "Reconstruct the earnings landscape for " + dateStr + " (including AMC reports from the prior day). " +
      "Search for: which S&P500/Nasdaq companies reported earnings on or around " + dateStr + ", " +
      "their EPS actual vs estimate, revenue vs estimate, and any notable forward guidance. " +
      "Focus on mega-caps (NVDA, AAPL, MSFT, META, GOOGL, AMZN, TSLA, AVGO) and large-caps first. " + base,

    premarket: "Reconstruct the pre-market conditions on the morning of " + dateStr + ". " +
      "Search for: how Asian markets (HSI, Nikkei, ASX, Shanghai, STI) and European markets " +
      "(STOXX, DAX, FTSE, AEX, CAC) performed overnight before US open on that date. " +
      "Also find US futures direction (NQ, ES) pre-market that morning. " + base,

    news: "Reconstruct the dominant market news narrative for " + dateStr + ". " +
      "Search for: what were the top market-moving stories and themes that day — " +
      "Fed commentary, geopolitical events, sector moves, macro surprises. " +
      "Score based on net impact on US index futures (NQ/ES) that day. " + base
  };
  return topics[topic] || base;
}

// Fetch historical Finnhub quote for a specific date
async function fetchHistoricalPremarket(dateStr) {
  const FINNHUB_KEY = process.env.FINNHUB_API_KEY || "d8gh1phr01qlgcujfjfgd8gh1phr01qlgcujfjg0";
  const date = new Date(dateStr);
  const fromTs = Math.floor(date.getTime() / 1000) - 86400;
  const toTs   = Math.floor(date.getTime() / 1000) + 3600;

  const symbols = [
    { symbol: "EWH",  label: "HSI (Hang Seng)",    region: "asia" },
    { symbol: "EWJ",  label: "Nikkei 225",          region: "asia" },
    { symbol: "EWA",  label: "ASX 200",             region: "asia" },
    { symbol: "MCHI", label: "Shanghai Composite",  region: "asia" },
    { symbol: "EWS",  label: "STI (Singapore)",     region: "asia" },
    { symbol: "VGK",  label: "STOXX 600",           region: "europe" },
    { symbol: "EWG",  label: "DAX",                 region: "europe" },
    { symbol: "EWU",  label: "FTSE 100",            region: "europe" },
    { symbol: "EWN",  label: "AEX (Netherlands)",   region: "europe" },
    { symbol: "EWQ",  label: "CAC 40",              region: "europe" },
  ];

  try {
    const results = await Promise.all(symbols.map(async (s) => {
      try {
        const url = "https://finnhub.io/api/v1/stock/candle?symbol=" + s.symbol +
          "&resolution=D&from=" + fromTs + "&to=" + toTs + "&token=" + FINNHUB_KEY;
        const raw = await fetchUrl(url);
        const q = JSON.parse(raw);
        if (!q || q.s === "no_data" || !q.c || q.c.length < 2) return { ...s, pct: null, status: "unavailable" };
        const prev = q.c[q.c.length - 2];
        const curr = q.c[q.c.length - 1];
        const pct = prev ? ((curr - prev) / prev) * 100 : 0;
        const status = pct > 0.1 ? "up" : pct < -0.1 ? "down" : "flat";
        return { ...s, pct: parseFloat(pct.toFixed(2)), status };
      } catch(e) { return { ...s, pct: null, status: "unavailable" }; }
    }));

    function fmt(items, name) {
      const lines = items.map(r => r.status === "unavailable" ? r.label + ": N/A"
        : r.label + ": " + (r.status === "up" ? "UP" : r.status === "down" ? "DOWN" : "FLAT") +
          " " + (r.pct >= 0 ? "+" : "") + r.pct + "%").join("\n");
      const up = items.filter(r => r.status === "up").length;
      const dn = items.filter(r => r.status === "down").length;
      const verdict = up >= 3 ? "BULLISH" : dn >= 3 ? "BEARISH" : "MIXED";
      return name + " [" + verdict + "]:\n" + lines;
    }

    return [
      "HISTORICAL PRE-MARKET DATA FOR " + dateStr + ":",
      fmt(results.filter(r => r.region === "asia"),   "ASIA"),
      fmt(results.filter(r => r.region === "europe"), "EUROPE")
    ].join("\n\n");
  } catch(e) {
    console.log("Historical premarket error:", e.message);
    return null;
  }
}

app.post("/api/backtest", async function(req, res) {
  const { date, topic } = req.body;
  if (!date || !topic) return res.status(400).json({ error: "Missing date or topic" });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "API key not set" });

  const targetDate = new Date(date);
  const isMemoryMode = targetDate <= MEMORY_CUTOFF;
  const dateStr = date; // YYYY-MM-DD

  console.log("Backtest:", dateStr, "| topic:", topic, "| mode:", isMemoryMode ? "MEMORY" : "API");

  try {
    let prompt, rawData, useSearch = false;

    if (isMemoryMode) {
      // ── Claude Memory Mode — Sonnet + web search ──
      prompt = buildMemoryPrompt(topic, dateStr);
      rawData = "NO EXTERNAL DATA — use web search to find historical data for " + dateStr;
      useSearch = true;
    } else {
      // ── API History Mode — FMP + Finnhub historical data ──
      const FMP_KEY = process.env.FMP_API_KEY || "WQMcZiIIJ1rarvN3puluUNQoGXFdvkjg";
      const prevDate = new Date(targetDate);
      prevDate.setDate(prevDate.getDate() - 1);
      const prevStr = prevDate.toISOString().slice(0, 10);

      if (topic === "econ") {
        try {
          const raw = await fetchUrl("https://financialmodelingprep.com/stable/economic-calendar?from=" + dateStr + "&to=" + dateStr + "&apikey=" + FMP_KEY);
          rawData = "HISTORICAL ECONOMIC CALENDAR FOR " + dateStr + ":\n" + raw;
        } catch(e) { rawData = null; }
        const regimeForDate = "Use the correct market regime for " + dateStr + " based on Fed policy and inflation at that time.";
        prompt = ECON_PROMPT.replace("REGIME_PLACEHOLDER", regimeForDate);
        if (!rawData) { rawData = "NO FMP DATA"; useSearch = true; }

      } else if (topic === "earn") {
        try {
          const [todayRaw, yestRaw] = await Promise.all([
            fetchUrl("https://financialmodelingprep.com/stable/earnings-calendar?from=" + dateStr + "&to=" + dateStr + "&apikey=" + FMP_KEY),
            fetchUrl("https://financialmodelingprep.com/stable/earnings-calendar?from=" + prevStr + "&to=" + prevStr + "&apikey=" + FMP_KEY)
          ]);
          rawData = "HISTORICAL EARNINGS FOR " + prevStr + "-" + dateStr + ":\n" + yestRaw + "\n" + todayRaw;
        } catch(e) { rawData = null; }
        prompt = EARN_PROMPT + " CURRENT TIME (ET): 09:30 AM. BACKTEST DATE: " + dateStr + ".";
        if (!rawData) { rawData = "NO FMP DATA"; useSearch = true; }

      } else if (topic === "premarket") {
        rawData = await fetchHistoricalPremarket(dateStr);
        prompt = PREMARKET_PROMPT;
        if (!rawData) {
          prompt = buildMemoryPrompt("premarket", dateStr);
          rawData = "NO FINNHUB DATA";
          useSearch = true;
        }

      } else if (topic === "news") {
        // News has no historical API — always use memory/search
        prompt = buildMemoryPrompt("news", dateStr);
        rawData = "NO EXTERNAL DATA — search for market news and dominant narrative for " + dateStr;
        useSearch = true;
      }
    }

    // Use Sonnet for all backtest calls (better recall + web search)
    const body = {
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      temperature: 0,
      system: "You are a historical market data analyst. Today is " + dateStr + " (backtest mode). " +
        "CRITICAL: Reply ONLY with raw JSON with fields: signal (bull/bear/neutral), summary (2 sentences), score (1/0/-1), guidance (null), confidence (confirmed/approximate/estimated). " +
        "confidence field: confirmed = verified from data/search, approximate = recalled from training, estimated = inferred from context.",
      messages: [{ role: "user", content: prompt + (rawData && rawData !== "NO EXTERNAL DATA" && rawData !== "NO FMP DATA" && rawData !== "NO FINNHUB DATA" ? "\n\nDATA:\n" + rawData : "") }]
    };
    if (useSearch) body.tools = [{ type: "web_search_20250305", name: "web_search" }];

    const payload = JSON.stringify(body);
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    };
    if (useSearch) headers["anthropic-beta"] = "web-search-2025-03-05";

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
            const out = JSON.parse(cleaned);
            if (!out.hasOwnProperty("guidance")) out.guidance = null;
            if (!out.hasOwnProperty("confidence")) out.confidence = "estimated";
            out.backtestMode = isMemoryMode ? "memory" : "api";
            resolve(out);
          } catch(e) { reject(new Error("Parse error: " + e.message)); }
        });
      });
      req2.on("error", reject);
      // Web search calls can take up to 60s — set generous timeout
      req2.setTimeout(90000, () => { req2.destroy(); reject(new Error("Backtest timeout — try again")); });
      req2.write(payload);
      req2.end();
    });

    console.log("Backtest result for", topic, "on", dateStr, ":", result.signal, "| confidence:", result.confidence);
    res.json(result);
  } catch(e) {
    console.error("Backtest error:", e.message);
    res.status(500).json({ error: e.message });
  }
});


// ── Backtest job queue ────────────────────────────────────────
// Frontend fires job → server runs async → frontend polls for result.
// Connection drops don't matter — work continues server-side.
const backtestJobs = {}; // jobId -> { status, progress, result, error }

function makeBacktestJob(date) {
  const jobId = "bt-" + date + "-" + Date.now();
  backtestJobs[jobId] = { status: "running", progress: "Starting...", step: 0, result: null, error: null, date };

  // Run async — don't await, let it run in background
  runBacktestJob(jobId, date).catch(e => {
    backtestJobs[jobId].status = "error";
    backtestJobs[jobId].error = e.message;
  });

  return jobId;
}

async function runBacktestJob(jobId, date) {
  const job = backtestJobs[jobId];
  const targetDate = new Date(date);
  const isMemoryMode = targetDate <= MEMORY_CUTOFF;
  const FMP_KEY = process.env.FMP_API_KEY || "WQMcZiIIJ1rarvN3puluUNQoGXFdvkjg";
  const prevDate = new Date(targetDate);
  prevDate.setDate(prevDate.getDate() - 1);
  const prevStr = prevDate.toISOString().slice(0, 10);

  function updateJob(progress, step) {
    job.progress = progress; job.step = step;
    console.log("Backtest job", jobId, "step", step, ":", progress);
  }

  async function getTopicData(topic) {
    let prompt, rawData, useSearch = false;
    if (isMemoryMode) {
      prompt = buildMemoryPrompt(topic, date); rawData = null; useSearch = true;
    } else {
      if (topic === "econ") {
        try {
          const raw = await fetchUrl("https://financialmodelingprep.com/stable/economic-calendar?from=" + date + "&to=" + date + "&apikey=" + FMP_KEY);
          rawData = "HISTORICAL ECONOMIC CALENDAR FOR " + date + ":\n" + raw;
        } catch(e) { rawData = null; }
        prompt = ECON_PROMPT.replace("REGIME_PLACEHOLDER", "Use the correct market regime for " + date + " based on Fed policy and inflation at that time.");
        if (!rawData) useSearch = true;
      } else if (topic === "earn") {
        try {
          const [todayRaw, yestRaw] = await Promise.all([
            fetchUrl("https://financialmodelingprep.com/stable/earnings-calendar?from=" + date + "&to=" + date + "&apikey=" + FMP_KEY),
            fetchUrl("https://financialmodelingprep.com/stable/earnings-calendar?from=" + prevStr + "&to=" + prevStr + "&apikey=" + FMP_KEY)
          ]);
          rawData = "HISTORICAL EARNINGS FOR " + prevStr + "-" + date + ":\n" + yestRaw + "\n" + todayRaw;
        } catch(e) { rawData = null; }
        prompt = EARN_PROMPT + " CURRENT TIME (ET): 09:30 AM. BACKTEST DATE: " + date + ".";
        if (!rawData) useSearch = true;
      } else if (topic === "premarket") {
        rawData = await fetchHistoricalPremarket(date);
        prompt = PREMARKET_PROMPT;
        if (!rawData) { prompt = buildMemoryPrompt("premarket", date); useSearch = true; }
      } else if (topic === "news") {
        prompt = buildMemoryPrompt("news", date); rawData = null; useSearch = true;
      }
    }
    return { prompt, rawData, useSearch };
  }

  async function callClaude(topic, prompt, rawData, useSearch) {
    const body = {
      model: "claude-sonnet-4-6", max_tokens: 1000, temperature: 0,
      system: "You are a historical market data analyst. The date being analyzed is " + date + " (backtest mode). " +
        "CRITICAL: Reply ONLY with raw JSON with fields: signal (bull/bear/neutral), summary (MAXIMUM 2 sentences — be concise), score (1/0/-1), guidance (null), confidence (confirmed/approximate/estimated). Do NOT write more than 2 sentences in the summary field.",
      messages: [{ role: "user", content: prompt + (rawData ? "\n\nDATA:\n" + rawData : "") }]
    };
    if (useSearch) body.tools = [{ type: "web_search_20250305", name: "web_search" }];
    const payload = JSON.stringify(body);
    const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" };
    if (useSearch) headers["anthropic-beta"] = "web-search-2025-03-05";
    return new Promise((resolve, reject) => {
      const opts = { hostname: "api.anthropic.com", path: "/v1/messages", method: "POST", headers };
      const req2 = https.request(opts, r => {
        let raw = "";
        r.on("data", c => raw += c);
        r.on("end", () => {
          try {
            const parsed = JSON.parse(raw);
            if (parsed.error) return reject(new Error(parsed.error.message));
            const text = (parsed.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("").trim();
            const out = JSON.parse(text.replace(/```json|```/g,"").trim());
            if (!out.hasOwnProperty("guidance")) out.guidance = null;
            if (!out.hasOwnProperty("confidence")) out.confidence = "estimated";
            out.backtestMode = isMemoryMode ? "memory" : "api";
            resolve(out);
          } catch(e) { reject(new Error("Parse error on " + topic + ": " + e.message)); }
        });
      });
      req2.on("error", reject);
      req2.setTimeout(150000, () => { req2.destroy(); reject(new Error("Timeout on " + topic)); });
      req2.write(payload); req2.end();
    });
  }

  const fallback = (t) => ({ signal:"neutral", score:0, summary:"Could not fetch " + t + " data for " + date + ".", guidance:null, confidence:"estimated", backtestMode: isMemoryMode ? "memory" : "api" });

  try {
    // ── Round 1: 4 topics in parallel ──
    updateJob("Fetching historical data for all 4 signals...", 1);
    const topicDataArr = await Promise.all(["econ","earn","premarket","news"].map(t => getTopicData(t)));
    const [eD, rnD, pD, nD] = topicDataArr;
    const [econRes, earnRes, preRes, newsRes] = await Promise.allSettled([
      callClaude("econ",      eD.prompt,  eD.rawData,  eD.useSearch),
      callClaude("earn",      rnD.prompt, rnD.rawData, rnD.useSearch),
      callClaude("premarket", pD.prompt,  pD.rawData,  pD.useSearch),
      callClaude("news",      nD.prompt,  nD.rawData,  nD.useSearch)
    ]);
    const results = {
      econ:      econRes.status==="fulfilled" ? econRes.value : fallback("econ"),
      earn:      earnRes.status==="fulfilled" ? earnRes.value : fallback("earn"),
      premarket: preRes.status ==="fulfilled" ? preRes.value  : fallback("premarket"),
      news:      newsRes.status==="fulfilled" ? newsRes.value : fallback("news")
    };
    job.partialResults = results;
    updateJob("Cards complete. Running meta-score...", 2);
    console.log("Job", jobId, "Round 1:", Object.keys(results).map(k=>k+":"+results[k].signal).join(", "));

    // ── Round 2: meta-score ──
    const cardScores = { econ:parseFloat(results.econ.score)||0, earn:parseFloat(results.earn.score)||0, premarket:parseFloat(results.premarket.score)||0, news:parseFloat(results.news.score)||0 };
    const metaCtx = ["BACKTEST DATE: " + date,
      "ECON: signal="+results.econ.signal+", score="+results.econ.score+", summary="+results.econ.summary,
      "EARNINGS: signal="+results.earn.signal+", score="+results.earn.score+", summary="+results.earn.summary,
      "PRE-MARKET: signal="+results.premarket.signal+", score="+results.premarket.score+", summary="+results.premarket.summary,
      "MARKET NEWS: signal="+results.news.signal+", score="+results.news.score+", summary="+results.news.summary
    ].join("\n");
    const metaBody = { model:"claude-haiku-4-5-20251001", max_tokens:400, temperature:0,
      system:"You are a futures trader bias engine. CRITICAL: Reply ONLY with raw JSON, no markdown.",
      messages:[{ role:"user", content: META_PROMPT + "\n\nDATA:\n" + metaCtx }] };
    const metaPayload = JSON.stringify(metaBody);
    const metaHeaders = { "Content-Type":"application/json","Content-Length":Buffer.byteLength(metaPayload),"x-api-key":process.env.ANTHROPIC_API_KEY,"anthropic-version":"2023-06-01" };
    let metaScore = { weights:{econ:3,earn:2,premarket:1,news:2}, weightedScore:0, signal:"neutral", biasLabel:"MIXED / NEUTRAL", rationale:"" };
    try {
      const mRaw = await new Promise((resolve, reject) => {
        const opts = { hostname:"api.anthropic.com", path:"/v1/messages", method:"POST", headers:metaHeaders };
        const mReq = https.request(opts, r => { let d=""; r.on("data",c=>d+=c); r.on("end",()=>resolve(d)); });
        mReq.on("error", reject);
        mReq.setTimeout(30000, () => { mReq.destroy(); reject(new Error("Meta timeout")); });
        mReq.write(metaPayload); mReq.end();
      });
      const mParsed = JSON.parse(mRaw);
      const mText = (mParsed.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("").trim();
      const mResult = JSON.parse(mText.replace(/```json|```/g,"").trim());
      const weights = mResult.weights || {econ:3,earn:2,premarket:1,news:2};
      const totalW = Object.keys(weights).reduce((s,k)=>s+(weights[k]||0),0);
      const rawW = Object.keys(weights).reduce((s,k)=>s+(cardScores[k]||0)*(weights[k]||0),0);
      const ws = totalW>0 ? parseFloat((rawW/totalW).toFixed(2)) : 0;
      let signal, biasLabel;
      if      (ws >=  0.50) { signal="bull";    biasLabel="STRONGLY BULLISH"; }
      else if (ws >=  0.30) { signal="bull";    biasLabel="BULLISH"; }
      else if (ws >=  0.15) { signal="bull";    biasLabel="MILDLY BULLISH"; }
      else if (ws >  -0.15) { signal="neutral"; biasLabel="MIXED / NEUTRAL"; }
      else if (ws >  -0.30) { signal="bear";    biasLabel="MILDLY BEARISH"; }
      else if (ws >  -0.50) { signal="bear";    biasLabel="BEARISH"; }
      else                  { signal="bear";    biasLabel="STRONGLY BEARISH"; }
      metaScore = { weights, weightedScore:ws, signal, biasLabel, rationale:mResult.rationale||"" };
    } catch(e) { console.error("Job meta error:", e.message); }

    updateJob("Meta-score complete. Scoring markets...", 3);
    const marketScores = scoreInstruments(results.econ, results.earn, results.premarket, results.news, metaScore, null);

    // ── Round 3: summary ──
    updateJob("Generating plain-English summary...", 4);
    const sumCtx = ["BACKTEST DATE: " + date, "OVERALL BIAS: " + metaScore.biasLabel, "RATIONALE: " + metaScore.rationale,
      "ECON: " + results.econ.signal.toUpperCase() + " | " + results.econ.summary,
      "EARNINGS: " + results.earn.signal.toUpperCase() + " | " + results.earn.summary,
      "PRE-MARKET: " + results.premarket.signal.toUpperCase() + " | " + results.premarket.summary,
      "NEWS: " + results.news.signal.toUpperCase() + " | " + results.news.summary,
      "Equities: ES="+marketScores.equities.ES.bias+", NQ="+marketScores.equities.NQ.bias,
      "DXY: "+marketScores.dxy.DXY.bias
    ].join("\n");
    const sumBody = { model:"claude-haiku-4-5-20251001", max_tokens:800, temperature:0,
      system:"You are a clear, friendly market commentator. CRITICAL: Reply ONLY with raw JSON, no markdown. This is a historical backtest for " + date + " — write in past tense. Each paragraph must be 2-3 sentences maximum.",
      messages:[{ role:"user", content: SUMMARY_PROMPT + "\n\nDATA:\n" + sumCtx }] };
    const sumPayload = JSON.stringify(sumBody);
    const sumHeaders = { "Content-Type":"application/json","Content-Length":Buffer.byteLength(sumPayload),"x-api-key":process.env.ANTHROPIC_API_KEY,"anthropic-version":"2023-06-01" };
    let summary = { headline:"Historical Analysis — " + date, paragraphs:["Summary unavailable."] };
    try {
      const sRaw = await new Promise((resolve, reject) => {
        const opts = { hostname:"api.anthropic.com", path:"/v1/messages", method:"POST", headers:sumHeaders };
        const sReq = https.request(opts, r => { let d=""; r.on("data",c=>d+=c); r.on("end",()=>resolve(d)); });
        sReq.on("error", reject);
        sReq.setTimeout(30000, () => { sReq.destroy(); reject(new Error("Summary timeout")); });
        sReq.write(sumPayload); sReq.end();
      });
      const sParsed = JSON.parse(sRaw);
      const sText = (sParsed.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("").trim();
      summary = JSON.parse(sText.replace(/```json|```/g,"").trim());
    } catch(e) { console.error("Job summary error:", e.message); }

    // ── Save to backtest history ──
    const btHist = loadBacktestHistory();
    btHist["backtest-" + date] = { date, isBacktest:true, savedAt:new Date().toISOString(),
      bias:metaScore.biasLabel, norm:metaScore.weightedScore,
      econ:results.econ, earn:results.earn, premarket:results.premarket, news:results.news,
      metaScore, summary };
    saveBacktestHistory(btHist);

    job.status = "done";
    job.step = 6;
    job.progress = "Complete";
    job.result = { date, results, metaScore, markets: marketScores, summary };
    console.log("Backtest job", jobId, "complete:", metaScore.biasLabel);

  } catch(e) {
    job.status = "error";
    job.error = e.message;
    console.error("Backtest job", jobId, "error:", e.message);
  }
}

// Start a backtest job
app.post("/api/backtest/start", function(req, res) {
  const { date } = req.body;
  if (!date) return res.status(400).json({ error: "Missing date" });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "API key not set" });
  const jobId = makeBacktestJob(date);
  console.log("Backtest job started:", jobId);
  res.json({ jobId });
});

// Poll job status + result
app.get("/api/backtest/poll/:jobId", function(req, res) {
  const job = backtestJobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({
    status: job.status,
    progress: job.progress,
    step: job.step || 0,
    result: job.status === "done" ? job.result : null,
    partialResults: job.partialResults || null,
    error: job.error || null
  });
});

// Backtest history — stored separately from live history
const BACKTEST_FILE = path.join(__dirname, "backtest-history.json");
function loadBacktestHistory() {
  try { if (fs.existsSync(BACKTEST_FILE)) return JSON.parse(fs.readFileSync(BACKTEST_FILE, "utf8")); }
  catch(e) {}
  return {};
}
function saveBacktestHistory(h) {
  try { fs.writeFileSync(BACKTEST_FILE, JSON.stringify(h, null, 2)); }
  catch(e) { console.error("Backtest history save error:", e.message); }
}

app.post("/api/backtest/history/save", function(req, res) {
  const { dateKey, snapshot } = req.body;
  if (!dateKey || !snapshot) return res.status(400).json({ error: "Missing dateKey or snapshot" });
  const history = loadBacktestHistory();
  history[dateKey] = { ...snapshot, isBacktest: true, savedAt: new Date().toISOString() };
  saveBacktestHistory(history);
  console.log("Backtest history saved for:", dateKey);
  res.json({ ok: true, dateKey });
});

app.get("/api/backtest/history", function(req, res) { res.json(loadBacktestHistory()); });

app.get("/health", function(req, res) {
  res.json({ status: "ok", apiKeySet: !!process.env.ANTHROPIC_API_KEY });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log("Morning brief server running on port " + PORT); });
