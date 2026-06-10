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

    // Check if today has any Tier 1 data (NFP, CPI, PCE, FOMC, GDP)
    const tier1Keywords = ["nonfarm","payroll","consumer price","cpi","pce","personal consumption","fomc","federal reserve","fed rate","interest rate","gross domestic","gdp"];
    const hasTier1Today = eventsToUse.some(e => {
      const name = (e.event || e.indicator || e.name || "").toLowerCase();
      return tier1Keywords.some(k => name.includes(k));
    });
    const hasTier2Today = eventsToUse.some(e => {
      const name = (e.event || e.indicator || e.name || "").toLowerCase();
      return ["jobless","claims","jolts","adp","unemployment","ppi","producer price"].some(k => name.includes(k));
    });

    let priorCarryNote = "";
    // If no Tier 1 or Tier 2 today, check prior 3 days for carry-forward
    if (!hasTier1Today && !hasTier2Today) {
      try {
        const priorDate = new Date(today);
        // Go back up to 5 calendar days to find last trading day with major data
        const fromDate = new Date(today);
        fromDate.setDate(fromDate.getDate() - 5);
        const fromStr = fromDate.toISOString().slice(0, 10);
        const prevStr2 = new Date(today.getTime() - 86400000).toISOString().slice(0, 10);
        const priorRaw = await fetchUrl(
          "https://financialmodelingprep.com/stable/economic-calendar?from=" + fromStr + "&to=" + prevStr2 + "&apikey=" + FMP_KEY
        );
        const priorJson = JSON.parse(priorRaw);
        if (Array.isArray(priorJson)) {
          // Find the most recent Tier 1 report with actual data
          const tier1Prior = priorJson.filter(e => {
            const name = (e.event || e.indicator || e.name || "").toLowerCase();
            const country = (e.country || e.countryCode || e.currency || "").toUpperCase();
            const isUSD = country === "US" || country === "USD" || country.includes("UNITED");
            const isTier1 = tier1Keywords.some(k => name.includes(k));
            const hasActual = e.actual !== null && e.actual !== undefined;
            return isUSD && isTier1 && hasActual;
          }).sort((a, b) => new Date(b.date) - new Date(a.date)); // most recent first

          if (tier1Prior.length > 0) {
            const latest = tier1Prior[0];
            const latestName = latest.event || latest.indicator || latest.name || "Unknown";
            const latestDate = (latest.date || "").slice(0, 10);
            const act2 = String(latest.actual);
            const est2 = (latest.estimate !== null && latest.estimate !== undefined) ? String(latest.estimate) : "N/A";
            let beat2 = "";
            if (est2 !== "N/A") {
              beat2 = parseFloat(act2) > parseFloat(est2) ? "BEAT" : parseFloat(act2) < parseFloat(est2) ? "MISS" : "IN-LINE";
            }
            const daysAgo = Math.round((today - new Date(latestDate)) / 86400000);
            priorCarryNote = "\n\nCARRY-FORWARD CONTEXT (" + daysAgo + " days ago, prior session):\n" +
              latestName + " | Date: " + latestDate + " | Act: " + act2 + " vs Est: " + est2 +
              (beat2 ? " → " + beat2 : "") +
              "\n[Apply CARRY-FORWARD RULE: score at ±0.5 with note this is prior session data, not today\'s release]";
            console.log("Econ carry-forward:", latestName, latestDate, beat2);
          }
        }
      } catch(priorErr) {
        console.log("Econ prior fetch error:", priorErr.message);
      }
    }

    return "FMP ECONOMIC CALENDAR FOR " + todayStr + ":\n" + lines.join("\n") + priorCarryNote;
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

// Premarket cache — locks at 9:30am ET so US session doesn't contaminate overnight data
var premarketCache = { data: null, lockedAt: null, dateKey: null };

async function fetchPremarket() {
  const FINNHUB_KEY = process.env.FINNHUB_API_KEY || "d8gh1phr01qlgcujfjfgd8gh1phr01qlgcujfjg0";

  // Weekend/overnight session detection
  const now = new Date();
  const etNow = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const dayOfWeek = etNow.getDay(); // 0=Sun, 6=Sat
  const hourET = etNow.getHours();
  const minuteET = etNow.getMinutes();
  const todayKey = etNow.toISOString().slice(0, 10);

  // ── 9:30am lock: return cached data if US session is open ──
  // Once US markets open, ETF proxies reflect US session moves, not overnight data
  // Lock the premarket read at the moment US session begins
  const usSessionOpen = (dayOfWeek >= 1 && dayOfWeek <= 5) &&
    (hourET > 9 || (hourET === 9 && minuteET >= 30));

  if (usSessionOpen) {
    if (premarketCache.data && premarketCache.dateKey === todayKey) {
      console.log("Premarket: US session open — returning locked snapshot from", premarketCache.lockedAt);
      return premarketCache.data;
    }
    // No cache yet for today — this is the first call after open (e.g. user opened dashboard at 10am)
    // Return null to trigger web search which can still find today's overnight data
    console.log("Premarket: US session open, no cache for today — web search for overnight data");
    return null;
  }

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

  // ── PRIMARY: Use TradingView cache if fresh ──
  // TV webhook provides actual live prices for all indices — far better than web search
  if (tvPriceCache.isFresh(1800)) { // fresh within 30 minutes
    const asia = tvPriceCache.asia;
    const europe = tvPriceCache.europe;
    const futures = tvPriceCache.futures;

    // Build structured premarket data string
    const asiaLines = [
      "Nikkei 225: " + (asia.Nikkei ? (asia.Nikkei.pct >= 0 ? "+" : "") + asia.Nikkei.pct + "% (" + (asia.Nikkei.pct >= 0 ? "UP" : "DOWN") + ")" : "N/A"),
      "Shanghai Composite: " + (asia.Shanghai ? (asia.Shanghai.pct >= 0 ? "+" : "") + asia.Shanghai.pct + "% (" + (asia.Shanghai.pct >= 0 ? "UP" : "DOWN") + ")" : "N/A"),
      "HSI (Hang Seng): " + (asia.HSI ? (asia.HSI.pct >= 0 ? "+" : "") + asia.HSI.pct + "% (" + (asia.HSI.pct >= 0 ? "UP" : "DOWN") + ")" : "N/A"),
      "ASX 200: " + (asia.ASX200 ? (asia.ASX200.pct >= 0 ? "+" : "") + asia.ASX200.pct + "% (" + (asia.ASX200.pct >= 0 ? "UP" : "DOWN") + ")" : "N/A"),
      "STI (Singapore): " + (asia.STI ? (asia.STI.pct >= 0 ? "+" : "") + asia.STI.pct + "% (" + (asia.STI.pct >= 0 ? "UP" : "DOWN") + ")" : "N/A")
    ];
    const euroLines = [
      "DAX: " + (europe.DAX ? (europe.DAX.pct >= 0 ? "+" : "") + europe.DAX.pct + "% (" + (europe.DAX.pct >= 0 ? "UP" : "DOWN") + ")" : "N/A"),
      "CAC 40: " + (europe.CAC40 ? (europe.CAC40.pct >= 0 ? "+" : "") + europe.CAC40.pct + "% (" + (europe.CAC40.pct >= 0 ? "UP" : "DOWN") + ")" : "N/A"),
      "FTSE 100: " + (europe.FTSE100 ? (europe.FTSE100.pct >= 0 ? "+" : "") + europe.FTSE100.pct + "% (" + (europe.FTSE100.pct >= 0 ? "UP" : "DOWN") + ")" : "N/A"),
      "AEX: " + (europe.AEX ? (europe.AEX.pct >= 0 ? "+" : "") + europe.AEX.pct + "% (" + (europe.AEX.pct >= 0 ? "UP" : "DOWN") + ")" : "N/A"),
      "STOXX 600: N/A (not in feed)"
    ];
    const futLines = [
      "NQ (Nasdaq 100): " + (futures.NQ ? (futures.NQ.pct >= 0 ? "+" : "") + futures.NQ.pct + "% | Price: " + futures.NQ.p : "N/A"),
      "ES (S&P 500): " + (futures.ES ? (futures.ES.pct >= 0 ? "+" : "") + futures.ES.pct + "% | Price: " + futures.ES.p : "N/A"),
      "YM (Dow Jones): " + (futures.YM ? (futures.YM.pct >= 0 ? "+" : "") + futures.YM.pct + "% | Price: " + futures.YM.p : "N/A"),
      "RTY (Russell 2000): " + (futures.RTY ? (futures.RTY.pct >= 0 ? "+" : "") + futures.RTY.pct + "% | Price: " + futures.RTY.p : "N/A")
    ];

    const tvData = [
      "LIVE MARKET DATA (TradingView, age: " + tvPriceCache.ageSeconds() + "s):",
      "",
      "ASIA (final close):",
      ...asiaLines,
      "",
      "EUROPE (current/final):",
      ...euroLines,
      "",
      "US FUTURES (current):",
      ...futLines
    ].join("\n");

    console.log("Premarket: using TradingView cache (age " + tvPriceCache.ageSeconds() + "s)");
    return tvData;
  }

  // If TV cache exists but is stale, still use it with a staleness note
  if (tvPriceCache.receivedAt) {
    console.log("Premarket: TV cache stale (" + tvPriceCache.ageSeconds() + "s) — using stale data with note");
    // Build data string same as fresh path but note the age
    const asia = tvPriceCache.asia; const europe = tvPriceCache.europe; const futures = tvPriceCache.futures;
    const ageMin = Math.round(tvPriceCache.ageSeconds() / 60);
    const asiaLines = Object.entries(asia).map(([k,v]) => k+": "+(v.pct>=0?"+":"")+v.pct+"% ("+(v.pct>=0?"UP":"DOWN")+")");
    const euroLines = Object.entries(europe).map(([k,v]) => k+": "+(v.pct>=0?"+":"")+v.pct+"% ("+(v.pct>=0?"UP":"DOWN")+")");
    const futLines = ["NQ: "+(futures.NQ?(futures.NQ.pct>=0?"+":"")+futures.NQ.pct+"%":"N/A"), "ES: "+(futures.ES?(futures.ES.pct>=0?"+":"")+futures.ES.pct+"%":"N/A"), "YM: "+(futures.YM?(futures.YM.pct>=0?"+":"")+futures.YM.pct+"%":"N/A"), "RTY: "+(futures.RTY?(futures.RTY.pct>=0?"+":"")+futures.RTY.pct+"%":"N/A")];
    return ["MARKET DATA (TradingView, "+ageMin+" min old — last available):", "", "ASIA:", ...asiaLines, "", "EUROPE:", ...euroLines, "", "US FUTURES:", ...futLines].join("\n");
  }

  // Any weekday before 9:30am ET — ETF proxies don't trade yet so they return stale data
  const isWeekdayPreOpen = dayOfWeek >= 1 && dayOfWeek <= 5 &&
    (hourET < 9 || (hourET === 9 && minuteET < 30));
  if (isWeekdayPreOpen) {
    console.log("Premarket: weekday pre-open (" + hourET + ":" + String(minuteET).padStart(2,"0") + " ET) — using web search for live data");
    return null; // null triggers web search fallback
  }

  // ETF proxies for international indices (US session only — after 9:30am ET)
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

    // Cache this ETF snapshot — will be locked at 9:30am for rest of day
    premarketCache = { data: output, lockedAt: etNow.toTimeString().slice(0,5) + " ET", dateKey: todayKey };
    console.log("Premarket: Finnhub data fetched and cached at", premarketCache.lockedAt);
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
  "2. Inflation: Is CPI/PCE above target? If yes, Fed constrained = likely GNISBN or BNISBN.",
  "3. Recent data reactions: Did the last NFP/CPI beat cause equities to sell off? If yes = GNISBN.",
  "4. Yield behavior: Do Treasury yields spike on strong data? If yes = GNISBN.",
  "5. Growth outlook: Are recession fears elevated? If yes and inflation still high = BNISBN.",
  "6. Market breadth: Is the market selling risk broadly or just rate-sensitives? Broad selloff on beats = GNISBN.",
  "CURRENT MACRO CONTEXT (2025-2026): Fed has been on hold at restrictive rates. Inflation cooled from peak but remains above 2% target. Any strong labor or inflation data extends the higher-for-longer narrative. This strongly suggests GNISBN as the base regime unless you detect clear evidence of a pivot or inflation at/below target.",
  "Use today's news and premarket data to confirm or override the base regime.",
  "CONFIDENCE: Rate your confidence 1-5. If 4+, the regime is clear. If 3 or below, default to GNISBN for safety.",
  "FED RATE EXTRACTION: Using web search, find and return the CURRENT Fed funds rate target range (e.g. 4.25-4.50%), the Fed's inflation target (always 2.0%), and calculate the CPI threshold above which inflation is clearly restrictive for the current regime. For GNISBN: threshold = Fed inflation target + 0.5% (e.g. 2.5%). For GNISGN: threshold = 3.5% (growth tolerates more inflation). For BNISBN: threshold = 2.0% (any inflation is bearish). For BNISGNBN: threshold = 4.0% (needs significant inflation drop to matter).",
  "NEXT FOMC: Find the date of the next scheduled FOMC meeting.",
  "JSON SCHEMA: {",
  "\"regime\":\"GNISGN|GNISBN|BNISBN|BNISGNBN\",",
  "\"confidence\":4,",
  "\"rationale\":\"One sentence explaining why this regime is active today.\",",
  "\"econScoreFlip\":true,",
  "\"fedFundsRate\":4.25,",
  "\"fedFundsRange\":\"4.25-4.50%\",",
  "\"fedInflationTarget\":2.0,",
  "\"cpiThreshold\":2.5,",
  "\"nextFOMC\":\"2026-07-29\"",
  "}",
  "econScoreFlip: true if strong econ data should score BEARISH (GNISBN or BNISBN), false if strong data scores BULLISH (GNISGN or BNISGNBN).",
  "fedFundsRate: the lower bound of the current Fed funds target range as a number.",
  "cpiThreshold: the CPI YoY level above which inflation scores BEARISH for the current regime."
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
      model: "claude-sonnet-4-6", // Sonnet needed for web search to find current Fed rate
      max_tokens: 500,
      temperature: 0,
      system: "You are a macro market regime analyst. Use web search to find the current Fed funds rate, latest FOMC statement, and CPI data. CRITICAL: Reply ONLY with raw JSON matching the exact schema. No markdown, no backticks.",
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
// Model routing — use Haiku for mechanical tasks, Sonnet for reasoning tasks
const HAIKU  = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-4-6";

// Topics that use Haiku even with web search (mechanical extraction tasks)
const HAIKU_TOPICS = new Set(["econ", "earn", "premarket"]);

function callClaude(prompt, data, useWebSearch, topicHint) {
  return new Promise((resolve, reject) => {
    // Use ET timezone so day/date matches what traders see
    const today = new Date().toLocaleDateString("en-US", { weekday:"long", year:"numeric", month:"long", day:"numeric", timeZone:"America/New_York" });
    // Use Haiku for mechanical extraction tasks, Sonnet for reasoning tasks
    const useHaiku = topicHint && HAIKU_TOPICS.has(topicHint);
    const body = {
      model: useHaiku ? HAIKU : (useWebSearch ? SONNET : HAIKU),
      max_tokens: useWebSearch ? 1000 : 500,
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
          // Extract JSON — handle preamble and nested JSON in web search responses
          let cleaned = text.replace(/```json|```/g, "").trim();
          // Find the LAST JSON object in the response (Claude's answer, not search result snippets)
          const allMatches = [];
          const jsonRe = /\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g;
          let m;
          while ((m = jsonRe.exec(cleaned)) !== null) allMatches.push(m[0]);
          // Prefer the match that contains "signal" and "score" fields
          const validMatch = allMatches.reverse().find(s => s.includes('"signal"') && s.includes('"score"'));
          if (validMatch) cleaned = validMatch;
          else {
            // Fallback: find outermost braces
            const start = cleaned.indexOf('{');
            const end = cleaned.lastIndexOf('}');
            if (start !== -1 && end > start) cleaned = cleaned.slice(start, end + 1);
          }
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

// ── Rate-limit aware wrapper — retries once after 20s if rate limited ──
async function callClaudeWithRetry(prompt, data, useWebSearch, topicHint) {
  try {
    return await callClaude(prompt, data, useWebSearch, topicHint);
  } catch(e) {
    if (e.message && e.message.includes("rate limit")) {
      console.log("Rate limit hit — waiting 20s before retry...");
      await new Promise(r => setTimeout(r, 20000));
      try {
        return await callClaude(prompt, data, useWebSearch, topicHint);
      } catch(e2) {
        console.error("Retry also failed:", e2.message);
        throw e2;
      }
    }
    throw e;
  }
}

// ── Prompts ───────────────────────────────────────────────────
const ECON_PROMPT = [
  "You are reviewing today's US economic calendar for a day trader. USD data only — ignore all non-USD events.",
  "HIGH IMPACT EVENTS to score: NFP, CPI, Core CPI, PCE, Core PCE, Fed rate decision, FOMC statement, GDP, JOLTS, Initial Jobless Claims, ADP Employment, Unemployment Rate, PPI, ISM Manufacturing, ISM Services, Retail Sales, University of Michigan Sentiment.",
  "EXCLUDE ALWAYS: Consumer Inflation Expectations, CB Employment Trends, Atlanta/Dallas/Richmond/Cleveland/NY Fed surveys, GDPNow, Treasury auctions, NFIB, Baker Hughes, API crude, Redbook, non-USD events.",
  "USD ONLY RULE: Completely ignore all non-USD data regardless of impact.",
  "CONFIRMED ACTUALS ONLY: NEVER score based on forecasts or expectations. A report scheduled but not yet released scores 0 neutral — always. Only score when the ACTUAL number is confirmed in the data (actual field is not null/empty). If CPI is expected at 4.2% but has not printed, score 0 and note it is pending. Forecasts are context only, not a scoring basis.",
  "SUMMARY FORMAT: If no confirmed actuals today — write one sentence on what is scheduled/expected, one sentence on timing. Score 0 neutral. Keep conversational.",
  "If a confirmed actual exists — state result plainly (e.g. 'CPI printed 3.4% vs 3.3% expected — hotter than forecast, bearish for equities under GNISBN.').",
  "CARRY-FORWARD RULE: If no high impact data today but NFP, CPI, PCE, or FOMC released in the prior session (yesterday or last Friday if today is Monday), carry it forward at half score (±0.5) with plain language: 'No new data today, but [event] from [day] is still influencing markets — [plain English result].'",
  "CPI HIERARCHY RULE: For CPI releases, YoY (year-over-year) is ALWAYS the primary scoring metric — it is what the Fed targets, what bond markets price, and what equity multiples reprice on. CPI MoM (month-over-month) is secondary context showing trajectory only. A cooler MoM print does NOT flip the score bullish if YoY remains elevated above the CPI threshold. CPI_THRESHOLD_PLACEHOLDER. Example: CPI YoY above threshold + CPI MoM cool = BEARISH — the structural inflation picture (YoY) dominates. Only score bullish on CPI if YoY is falling meaningfully toward or below the Fed's 2% target.",
  "EIA INVENTORY RULE: EIA crude oil and gasoline inventory data is a commodity signal for CL only — do NOT use it to score the econ card. It does not affect Fed policy, bond yields, or equity multiples. Ignore it for econ scoring purposes.",
  "JOBLESS CLAIMS: Higher than forecast = bad (more unemployed). Lower = good (fewer unemployed).",
  "JOLTS: Higher openings = bullish (strong labor demand). Lower = bearish.",
  "REGIME_PLACEHOLDER",
  "Score: bull=1, bear=-1, neutral=0.",
  // ── MODIFIED: guidance is not applicable for econ, explicitly set null ──
  "CATALYST FLAGS: After scoring, you must also identify which specific catalysts are present in the data. Set each flag to true or false based on what you actually read — do not infer or assume. These flags drive commodity and instrument scoring downstream so accuracy matters. " +
  "JSON SCHEMA: {" +
  "\"signal\":\"bull|bear|neutral\"," +
  "\"summary\":\"2 sentence summary\"," +
  "\"score\":1," +
  "\"guidance\":null," +
  "\"catalysts\":{" +
  "\"oilSupplyShock\":false," +        // Active supply disruption: OPEC cuts, Middle East conflict blocking supply routes, pipeline outage
  "\"oilSupplyUnwind\":false," +       // Supply disruption risk REDUCING: ceasefire, deal, reopening, or credible diplomatic progress that reduces geopolitical supply risk premium — set true if geopoliticalDeEscalation is true AND the conflict involves oil-producing regions or supply routes
  "\"geopoliticalEscalation\":false," + // Active military conflict, attacks, invasion, missile strikes, war escalating
  "\"geopoliticalDeEscalation\":false," + // Conflict risk REDUCING: ceasefire, peace deal, withdrawal, hostilities paused OR diplomatic progress — negotiations underway, deal being discussed, potential agreement signaled by officials, talks progressing. Set true even if deal not confirmed — credible diplomatic signal that reduces risk premium is sufficient
  "\"fedHawkish\":false," +            // Fed signaling higher rates, delays cuts, higher-for-longer, hawkish tone
  "\"fedDovish\":false," +             // Fed signaling cuts, pivot, easing, accommodative
  "\"inflationHot\":false," +          // CPI/PCE/PPI above expectations, inflation accelerating
  "\"inflationCool\":false," +         // CPI/PCE/PPI below expectations, inflation decelerating
  "\"laborStrong\":false," +           // NFP beat, jobless claims low, strong employment
  "\"laborWeak\":false," +             // NFP miss, jobless claims high, weak employment
  "\"chinaStimulus\":false," +         // PBOC action, Chinese stimulus, infrastructure spending, demand boost
  "\"growthFears\":false," + // Recession fears, demand destruction, global slowdown
  "\"riskOn\":false," +                // Risk appetite rising, equities bid, safe havens sold
  "\"riskOff\":false" +                // Risk appetite falling, safe havens bid, equities sold
  "}}"
].join(" ");

const EARN_PROMPT = [
  "You are reviewing today's earnings calendar for a day trader focused on index futures (NQ/ES).",
  "MAJOR COMPANIES (score these if they reported): NVDA, AAPL, MSFT, META, GOOGL, AMZN, TSLA, AVGO, NFLX, AMD, QCOM, JPM, GS, BAC, MS, XOM, CVX, LLY, UNH, COST, WMT, ORCL, CRM, ADBE, MU, NOW, V, MA.",
  "DATA SOURCE: non-GAAP adjusted EPS vs analyst estimates.",
  "ONLY score CONFIRMED actual EPS results. If all TBD, score 0 neutral.",
  "SUMMARY FORMAT: If no major companies reported today — write: 'No major earnings today.' Then add one sentence: 'Next up: [Company] reports [day] [BMO/AMC].' Score 0 neutral. Keep it conversational.",
  "If earnings DID release — state results in plain English: '[Company] beat EPS by X%, revenue [beat/missed], guidance [raised/lowered/reaffirmed] — [bullish/bearish] for [NQ/sector].' Include guidance as it often matters more than the beat.",
  "Score: bull=1, bear=-1, neutral=0. Use 0.5 increments when guidance changes the picture.",
  // ── MODIFIED: tightened staleness rule — stale reports omitted entirely ──
  "STALENESS RULE: Reports are scored ONLY within a strict time window. [TODAY] BMO (before market open) reports: score only if current time is before 10:00am ET. [TODAY] AMC (after market close) reports: score only after 4:00pm ET on that day. [YEST] reports: score ONLY if current time is before 10:00am ET on the NEXT trading day — i.e. the morning after they reported. If current time is past 10:00am ET, [YEST] reports are fully priced in and MUST be completely ignored — set score to 0 and do not mention them. CRITICAL: A report from 2, 3, 4 or more days ago (e.g. AVGO reported June 3 and today is June 8) is ANCIENT — it is NOT [YEST], it has zero scoring weight, and must not appear in your analysis under any circumstances. Only reports from TODAY or genuinely YESTERDAY count. If no valid in-window reports exist, score 0 neutral and state that no scoreable earnings exist today.",
  // ── MODIFIED: explicit JSON schema requiring guidance field ──
  "GUIDANCE FIELD: One sentence on forward guidance vs consensus with specific numbers if available. Set to null only if absolutely no guidance data present. " +
  "CATALYST FLAGS: After scoring, you must also identify which specific catalysts are present in the data. Set each flag to true or false based on what you actually read — do not infer or assume. These flags drive commodity and instrument scoring downstream so accuracy matters. " +
  "JSON SCHEMA: {" +
  "\"signal\":\"bull|bear|neutral\"," +
  "\"summary\":\"2 sentence summary\"," +
  "\"score\":1," +
  "\"guidance\":null," +
  "\"catalysts\":{" +
  "\"oilSupplyShock\":false," +        // Active supply disruption: OPEC cuts, Middle East conflict blocking supply routes, pipeline outage
  "\"oilSupplyUnwind\":false," +       // Supply disruption risk REDUCING: ceasefire, deal, reopening, or credible diplomatic progress that reduces geopolitical supply risk premium — set true if geopoliticalDeEscalation is true AND the conflict involves oil-producing regions or supply routes
  "\"geopoliticalEscalation\":false," + // Active military conflict, attacks, invasion, missile strikes, war escalating
  "\"geopoliticalDeEscalation\":false," + // Conflict risk REDUCING: ceasefire, peace deal, withdrawal, hostilities paused OR diplomatic progress — negotiations underway, deal being discussed, potential agreement signaled by officials, talks progressing. Set true even if deal not confirmed — credible diplomatic signal that reduces risk premium is sufficient
  "\"fedHawkish\":false," +            // Fed signaling higher rates, delays cuts, higher-for-longer, hawkish tone
  "\"fedDovish\":false," +             // Fed signaling cuts, pivot, easing, accommodative
  "\"inflationHot\":false," +          // CPI/PCE/PPI above expectations, inflation accelerating
  "\"inflationCool\":false," +         // CPI/PCE/PPI below expectations, inflation decelerating
  "\"laborStrong\":false," +           // NFP beat, jobless claims low, strong employment
  "\"laborWeak\":false," +             // NFP miss, jobless claims high, weak employment
  "\"chinaStimulus\":false," +         // PBOC action, Chinese stimulus, infrastructure spending, demand boost
  "\"growthFears\":false," + // Recession fears, demand destruction, global slowdown
  "\"riskOn\":false," +                // Risk appetite rising, equities bid, safe havens sold
  "\"riskOff\":false" +                // Risk appetite falling, safe havens bid, equities sold
  "}}"
].join(" ");

const PREMARKET_PROMPT = [
  "You are scoring overnight/pre-market or post-market sentiment for US index futures (NQ/ES) for a day trader.",
  "",
  "STEP 1 — BUILD THE TIMELINE FIRST. Before scoring, identify what happened and WHEN:",
  "List key events in chronological order with approximate times. This matters because a bullish catalyst at 9am followed by a military strike at 5pm means the STRIKE is the most recent signal, not the 9am comment.",
  "Ask: what is the sequence? What is the MOST RECENT market-moving development?",
  "",
  "STEP 2 — SCORE EACH REGION with exact counts from FINAL CLOSING prices:",
  "ASIA (5 indices): HSI, Nikkei 225, ASX 200, Shanghai Composite, STI. Count exactly: how many closed UP, how many DOWN. State as 'X of 5 bullish' — do not round or approximate. Up = bullish count, down = bearish. Majority (3+) wins.",
  "EUROPE (5 indices): STOXX 600, DAX, FTSE 100, AEX, CAC 40. Same exact count. If AEX or any index data is missing or inconclusive, state that and use available data only.",
  "US FUTURES: NQ and ES are the primary signal — they represent the S&P 500 and Nasdaq 100 which are the main instruments for most futures traders. YM (Dow) and RTY (Russell) are secondary context. DIVERGENCE RULE: If NQ/ES are down but YM/RTY are up, this indicates defensive rotation — NOT a bullish signal. Score based on NQ/ES direction. State the divergence explicitly in your summary (e.g. 'NQ -0.5%, ES -0.3% while YM/RTY slightly positive — defensive rotation, not broad risk-on').",
  "",
  "STEP 3 — WEIGHTING:",
  "US futures = primary signal, wins outright.",
  "Europe final close > Asia if no futures data.",
  "Context is critical: NQ +1.4% overnight after a -4.77% prior session crash = partial recovery, not a new bull trend. State this context explicitly.",
  "",
  "PARTIAL REBOUND RULE: Small bounce (<0.5%) after large crash = NEUTRAL. Meaningful recovery (>0.5%) with clear ongoing catalyst = BULL.",
  "SHOCK AFTERMATH RULE: If a military/emergency shock occurred in the prior session, overnight futures must be clearly positive (>0.5%) AND have a clear reason (ceasefire, deal confirmed, resolution) to score BULL. Otherwise NEUTRAL.",
  "",
  "SUMMARY: Two sentences.",
  "Sentence 1: Asia X/5 bullish [list which ones up/down with %], Europe X/5 bullish [list], US futures NQ/ES [%].",
  "Sentence 2: The dominant driver including timeline context — what happened in what order and what it means for today's open.",
  "Score: bull=1, bear=-1, neutral=0.",
  "JSON SCHEMA: {\"signal\":\"bull|bear|neutral\",\"summary\":\"2 sentence summary\",\"score\":1,\"guidance\":null}"
].join("\n");

const NEWS_PROMPT = [
  "You are scoring news for a DAY TRADER. The question is: what is moving markets RIGHT NOW during today's session — not what the structural macro backdrop is.",
  "From this CNBC markets page identify the most impactful stories for US index futures (NQ/ES) today.",
  "LEVEL 5 - MARKET SHOCK OVERRIDE (completely dominates all other signals): Active military conflict outbreak, emergency Fed rate decision, major bank failure, pandemic declaration, emergency executive order affecting markets, surprise nationalization, sweeping antitrust breakup of mega-cap, extreme overnight tariff (50%+), contested election causing constitutional crisis, surprise election outcome reversing expected policy. If Level 5 detected: score -1 AND include MARKET_SHOCK_OVERRIDE in summary.",
  "LEVEL 4 - HIGHEST IMPACT (moves NQ 1%+ intraday): Fed surprise pivot, major geopolitical escalation OR de-escalation, oil supply shock >5%, large tariff announcement, major war development.",
  "LEVEL 3 - HIGH IMPACT: Fed speaker hawkish/dovish shift, Middle East escalation or ceasefire, trade action, regulatory ruling.",
  "LEVEL 2 - MEDIUM: Sector news, individual large-cap catalyst.",
  "LEVEL 1 - LOW (do not score): Routine analyst calls, minor company news.",
  "FRESHNESS HIERARCHY — CRITICAL FOR DAY TRADING: Score based on what the market is trading TODAY, not stale carry-over narratives. Apply this priority order: (1) Events that broke SINCE the last US market close (overnight, weekend) take highest priority — the market has not yet priced these. (2) Events from TODAY's session take second priority. (3) Data or news from PRIOR trading sessions (yesterday, last week) is already priced in and should NOT dominate scoring. Example: If today is Monday and Iran announced a ceasefire over the weekend, that is FRESHER and MORE MARKET-MOVING than Friday's jobs data which traded all day Friday and was priced over the weekend. The jobs data becomes background context, not the primary driver.",
  "GEOPOLITICAL DE-ESCALATION RULE: Any credible reduction in geopolitical risk is a BULLISH catalyst for equities — it removes the risk premium suppressing markets. This includes: confirmed ceasefire or end of hostilities (Level 4), peace deal signed (Level 4), AND credible diplomatic progress — a senior official signaling a deal is close, negotiations underway, potential agreement within days (Level 3). You do NOT need a confirmed resolution to score bullish — credible de-escalation signals are sufficient. Set geopoliticalDeEscalation: true and oilSupplyUnwind: true if the conflict involves oil-producing regions. Score BULLISH even if a hawkish macro backdrop exists in older data.",
  "HAWKISH RULE: Rate-cut delay / higher-for-longer narrative scores BEARISH — BUT only if that narrative is the FRESHEST dominant catalyst. If a geopolitical resolution or other fresh Level 4+ event occurred more recently, the hawkish narrative is demoted to background context.",
  "TIEBREAKER RULE: When two catalysts conflict, the FRESHER one wins. If both are equally fresh, the LARGER market mover wins.",
  "IMPORTANT: Do NOT include level labels in your summary. Write natural plain English. State what is MOVING markets today specifically.",
  "Score: bull=1, bear=-1, neutral=0. Reserve neutral ONLY for days with genuinely no fresh directional catalyst.",
  "CATALYST FLAGS: After scoring, you must also identify which specific catalysts are present in the data. Set each flag to true or false based on what you actually read — do not infer or assume. These flags drive commodity and instrument scoring downstream so accuracy matters. " +
  "JSON SCHEMA: {" +
  "\"signal\":\"bull|bear|neutral\"," +
  "\"summary\":\"2 sentence summary\"," +
  "\"score\":1," +
  "\"guidance\":null," +
  "\"catalysts\":{" +
  "\"oilSupplyShock\":false," +        // Active supply disruption: OPEC cuts, Middle East conflict blocking supply routes, pipeline outage
  "\"oilSupplyUnwind\":false," +       // Supply disruption risk REDUCING: ceasefire, deal, reopening, or credible diplomatic progress that reduces geopolitical supply risk premium — set true if geopoliticalDeEscalation is true AND the conflict involves oil-producing regions or supply routes
  "\"geopoliticalEscalation\":false," + // Active military conflict, attacks, invasion, missile strikes, war escalating
  "\"geopoliticalDeEscalation\":false," + // Conflict risk REDUCING: ceasefire, peace deal, withdrawal, hostilities paused OR diplomatic progress — negotiations underway, deal being discussed, potential agreement signaled by officials, talks progressing. Set true even if deal not confirmed — credible diplomatic signal that reduces risk premium is sufficient
  "\"fedHawkish\":false," +            // Fed signaling higher rates, delays cuts, higher-for-longer, hawkish tone
  "\"fedDovish\":false," +             // Fed signaling cuts, pivot, easing, accommodative
  "\"inflationHot\":false," +          // CPI/PCE/PPI above expectations, inflation accelerating
  "\"inflationCool\":false," +         // CPI/PCE/PPI below expectations, inflation decelerating
  "\"laborStrong\":false," +           // NFP beat, jobless claims low, strong employment
  "\"laborWeak\":false," +             // NFP miss, jobless claims high, weak employment
  "\"chinaStimulus\":false," +         // PBOC action, Chinese stimulus, infrastructure spending, demand boost
  "\"growthFears\":false," + // Recession fears, demand destruction, global slowdown
  "\"riskOn\":false," +                // Risk appetite rising, equities bid, safe havens sold
  "\"riskOff\":false" +                // Risk appetite falling, safe havens bid, equities sold
  "}}"
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
      // Add Fed rate context dynamically from regime detection
      const cpiThresh  = regimeCache.cpiThreshold  || 2.5;
      const fedRate    = regimeCache.fedFundsRange  || "unknown";
      const nextFOMC   = regimeCache.nextFOMC       || "check FOMC calendar";
      const fedContext = "\n\nFED RATE CONTEXT: Current Fed funds rate: " + fedRate +
        ". Fed inflation target: 2.0%. " +
        "CPI threshold for " + (regimeCache.regime || "GNISBN") + " regime: " + cpiThresh + "% YoY. " +
        "CPI YoY above " + cpiThresh + "% = clearly restrictive territory, delays cuts = BEARISH under this regime. " +
        "CPI YoY below " + cpiThresh + "% = approaching tolerance band, potential for neutral/cut expectations. " +
        "Next FOMC meeting: " + nextFOMC + ".";

      const econPromptWithRegime = ECON_PROMPT
        .replace("REGIME_PLACEHOLDER", regimeInstruction)
        .replace("CPI_THRESHOLD_PLACEHOLDER", "CPI YoY threshold for this regime: " + cpiThresh + "%. " +
          "Fed funds rate: " + fedRate + ". Fed target: 2.0%. Next FOMC: " + nextFOMC + ".");

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
      // Append upcoming week econ events for context
      try {
        const wEcon = await fetchWeekAhead();
        if (wEcon && wEcon.econ) {
          const upEcon = wEcon.econ.filter(e => e.status === "scheduled").slice(0, 6).map(e => {
            const d = new Date(e.date + "T12:00:00");
            const dn = d.toLocaleDateString("en-US", {weekday:"long"});
            let ts = "";
            if (e.time && e.time !== "TBD") {
              try { const tp = e.time.split(":"); const td = new Date(); td.setUTCHours(parseInt(tp[0]),parseInt(tp[1]||0),0,0); ts = " at " + td.toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit",hour12:true,timeZone:"America/New_York"}) + " ET"; } catch(te){}
            }
            return "• " + e.name + " — " + dn + ts;
          }).join("\n");
          if (upEcon) rawData = (rawData || "") + "\n\nUPCOMING HIGH IMPACT EVENTS THIS WEEK:\n" + upEcon + "\n[Mention the next upcoming event in your summary if no data today]";
        }
      } catch(we) {}
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
      // Append upcoming earnings for context
      try {
        const wEarn = await fetchWeekAhead();
        if (wEarn && wEarn.earnings) {
          const upEarn = wEarn.earnings.filter(e => e.status === "scheduled").slice(0, 8).map(e => {
            const d = new Date(e.date + "T12:00:00");
            const dn = d.toLocaleDateString("en-US", {weekday:"long"});
            const revStr = e.revEst ? " · Rev Est: $" + (e.revEst/1e9).toFixed(1) + "B" : "";
            const epsStr = e.epsEst ? " · EPS Est: $" + e.epsEst.toFixed(2) : "";
            return "• " + e.ticker + " (" + (e.company||e.ticker) + ") — " + dn + " " + e.when + epsStr + revStr;
          }).join("\n");
          if (upEarn) rawData = (rawData || "") + "\n\nUPCOMING EARNINGS THIS WEEK:\n" + upEarn + "\n[Mention the next notable company in your summary if no earnings today]";
        }
      } catch(we) {}
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
          // Sunday evening, Monday pre-Europe, or Finnhub fallback — use Sonnet + web search
          rawData = "NO EXTERNAL DATA";
          let searchCtx = "";
          if (dayET === 0 && hourET2 >= 17) {
            searchCtx = " It is Sunday evening ET — Asian markets are opening or in early session. Search for LIVE current performance of: HSI (Hang Seng), Nikkei 225, ASX 200 (Australia), Shanghai Composite, STI (Singapore). State current % change for each. Also check if US index futures (NQ, ES) are showing any direction in overnight trading.";
          } else if (dayET >= 1 && dayET <= 5 && (hourET2 < 9 || (hourET2 === 9 && etNow2.getMinutes() < 30))) {
            // Any weekday pre-open — Tue-Sun before 9:30am ET
            if (hourET2 < 3) {
              searchCtx = " It is early morning ET — Asian markets are trading, European markets not yet open (~3am ET open). Search for LIVE overnight performance of: HSI (Hang Seng), Nikkei 225, ASX 200 (Australia), Shanghai Composite, STI (Singapore). State current % change for each.";
            } else if (hourET2 < 9) {
              searchCtx = " It is morning ET. Asian markets have closed, European markets are now open. Search for: HSI final close, Nikkei final close, ASX 200 final close, Shanghai final close, STI final close. Also STOXX 600, DAX, FTSE 100, AEX, CAC 40 current levels. US futures (NQ, ES) pre-market direction if available.";
            } else {
              searchCtx = " It is pre-market ET (after 9am, before US open). Asian markets have closed, European markets are trading. Search for: Asia final closes (HSI, Nikkei, ASX, Shanghai, STI with % change), Europe current levels (STOXX 600, DAX, FTSE 100, AEX, CAC 40 with % change), and US futures (NQ, ES, YM) pre-market direction right now.";
            }
          } else {
            searchCtx = " Search the web for today " + todayStr2 + " pre-market performance of: HSI (Hang Seng), Nikkei 225, ASX 200, Shanghai Composite, STI. Also STOXX 600, DAX, FTSE 100, AEX, CAC 40. Also NQ futures, ES futures, DOW futures. State % change for each.";
          }
          prompt = PREMARKET_PROMPT + searchCtx;
          useSearch = true;
          console.log("Premarket: using web search —", dayET === 0 ? "Sunday evening" : dayET === 1 && hourET2 < 10 ? "Monday pre-open (" + hourET2 + "h ET)" : "Finnhub fallback");
        }
      }
      // If news already ran and detected a market shock, inject timeline context
      // The shock occurred AFTER any pre-market bullish data was recorded
      const newsResultForPM = req.body && req.body.newsResult;
      const shockInNews = newsResultForPM && newsResultForPM.summary && newsResultForPM.summary.includes('MARKET_SHOCK_OVERRIDE');
      if (shockInNews && rawData) {
        rawData = rawData + "\n\n[IMPORTANT TIMELINE CONTEXT: A MARKET SHOCK was detected in today's news session — military strike, major crash, or emergency event. This shock occurred AFTER the pre-market data above was recorded. Pre-market data reflects pre-shock conditions. Apply MARKET SHOCK RULE: score BEARISH. A small overnight bounce after a shock session is noise, not a reversal.]";
        console.log("Premarket: market shock context injected from news result");
      }
    } else if (topic === "news") {
      prompt = NEWS_PROMPT;
      if (latestMakeData.news && latestMakeData.news.length > 50) {
        rawData = latestMakeData.news;
        console.log("News: using Make.com data");
      } else {
        // Use CNBC scrape as base data BUT also enable web search
        // Web search catches breaking news that CNBC scrape misses (e.g. Trump statements, diplomatic signals)
        const cnbcData = await fetchNews();
        rawData = cnbcData || "NO CNBC DATA";
        useSearch = true;
        const todayNewsStr = new Date().toLocaleDateString("en-US", { weekday:"long", month:"long", day:"numeric", year:"numeric" });
        // Append upcoming week events to give Claude forward context
        let weekCtx = "";
        try {
          const wData = await fetchWeekAhead();
          if (wData) {
            const upcoming = wData.econ.filter(e => e.status === "scheduled" && e.tier === 1).slice(0,3).map(e => e.name + " (" + e.date + ")").join(", ");
            const upEarn = wData.earnings.filter(e => e.status === "scheduled").slice(0,4).map(e => e.ticker + " " + e.when + " (" + e.date + ")").join(", ");
            if (upcoming || upEarn) {
              weekCtx = " UPCOMING THIS WEEK: Econ: " + (upcoming||"none") + ". Earnings: " + (upEarn||"none") + ". Mention these if they are relevant to today's market positioning.";
            }
          }
        } catch(we) {}
        prompt = NEWS_PROMPT + " IMPORTANT: The CNBC page data above may be incomplete or delayed. Use web search to supplement — search for 'market moving news today " + todayNewsStr + "' to find any breaking developments (geopolitical statements, Fed comments, economic surprises, corporate news) that may not appear in the CNBC data. Prioritize the FRESHEST and most market-moving stories from EITHER source." + weekCtx;
        console.log("News: using CNBC scrape + web search supplement");
      }
    } else {
      return res.status(400).json({ error: "Unknown topic" });
    }

    // Track last Sonnet web search time for rate limit management
    if (useSearch) global.lastSonnetCallMs = Date.now();
    const result = await callClaudeWithRetry(prompt, rawData, useSearch, 2, topic);
    console.log("Result for " + topic + ":", JSON.stringify(result));

    // Cache premarket result if US session is now open (lock it for the rest of the day)
    if (topic === "premarket") {
      const nowCache = new Date();
      const etCache = new Date(nowCache.toLocaleString("en-US", { timeZone: "America/New_York" }));
      const hourCache = etCache.getHours(); const minCache = etCache.getMinutes();
      const dayCache = etCache.getDay();
      const sessionOpenCache = dayCache >= 1 && dayCache <= 5 && (hourCache > 9 || (hourCache === 9 && minCache >= 30));
      if (sessionOpenCache && result && result.signal) {
        const todayKeyCache = etCache.toISOString().slice(0, 10);
        // Store the analyzed result summary as cache so next call returns locked data
        premarketCache = { data: result.summary || rawData, lockedAt: etCache.toTimeString().slice(0,5) + " ET", dateKey: todayKeyCache };
        console.log("Premarket: result cached at open for rest of day");
      }
    }

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
  "DYNAMIC RULES: On NFP/CPI/FOMC days, econ starts at weight 5 and pre-market gets weight 1 (pre-market just reflects the same data). On mega-cap earnings days with no macro, earnings gets 5. News max weight is 4 (never 5 unless MARKET_SHOCK_OVERRIDE).",
  "PRE-MARKET WEIGHT RULES: Pre-market weight is ALWAYS 1 — no exceptions. It is a supporting confirmation signal only, never a primary driver. A bullish or bearish pre-market alone cannot set the day's sentiment. Assign weight 1 regardless of how strong the overnight signal appears.",
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

    // Hard cap pre-market weight based on time of day
    // After US open (9:30am ET), pre-market is stale — hard cap at 1
    // Pre-market alone cannot set the day's sentiment once US session is live
    const etNowMeta = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    const etHourMeta = etNowMeta.getHours();
    const etMinMeta  = etNowMeta.getMinutes();
    const etDayMeta  = etNowMeta.getDay();
    const isWeekday  = etDayMeta >= 1 && etDayMeta <= 5;
    const afterOpen  = isWeekday && (etHourMeta > 9 || (etHourMeta === 9 && etMinMeta >= 30));
    // Get scores from request body — must be before weight cap logic
    const etNowScores = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    const etHourScores = etNowScores.getHours();
    const etMinScores  = etNowScores.getMinutes();
    const etDayScores  = etNowScores.getDay();
    const isWeekdayScores = etDayScores >= 1 && etDayScores <= 5;
    const afterOpenScores = isWeekdayScores && (etHourScores > 9 || (etHourScores === 9 && etMinScores >= 30));

    // Carry-forward econ: if econ summary mentions "carry-forward" or "prior session",
    // cap the score at ±0.5 — it's context, not a fresh catalyst
    let econRawScore = econ ? (parseFloat(econ.score) || 0) : 0;
    const econSummaryLower = econ && econ.summary ? econ.summary.toLowerCase() : "";
    const isCarryForward = econSummaryLower.includes("carry") || econSummaryLower.includes("prior session") || econSummaryLower.includes("carry-forward") || econSummaryLower.includes("carry forward");
    if (isCarryForward && Math.abs(econRawScore) > 0.5) {
      econRawScore = econRawScore > 0 ? 0.5 : -0.5;
      console.log("Meta: econ carry-forward score capped at", econRawScore);
    }

    const cardScores = {
      econ:      econRawScore,
      earn:      earn      ? (parseFloat(earn.score)      || 0) : 0,
      premarket: (premarket && !afterOpenScores) ? (parseFloat(premarket.score) || 0) : 0,
      news:      news      ? (parseFloat(news.score)      || 0) : 0
    };
    if (afterOpenScores && premarket && parseFloat(premarket.score) !== 0) {
      console.log("Meta: pre-market score zeroed after open (was " + premarket.score + ") — card text preserved for context");
    }

    // Pre-market is ALWAYS weight 1 — it confirms or contradicts but never drives sentiment alone
    if (weights.premarket > 1) {
      weights.premarket = 1;
      console.log("Meta: pre-market weight hard-capped at 1");
    }

    // SOLO PRE-MARKET RULE: After open, pre-market alone cannot drive bullish/bearish bias.
    const otherScoresAllNeutral = afterOpen &&
      (cardScores.econ === 0) && (cardScores.earn === 0) && (cardScores.news === 0);
    if (otherScoresAllNeutral && cardScores.premarket !== 0) {
      weights.premarket = 1;
      console.log("Meta: pre-market weight held at 1 — sole signal after open cannot set bias alone");
    }

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
    console.error("Meta-score stack:", e.stack ? e.stack.slice(0, 400) : "no stack");
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
// NOTE: Claude only returns implication text per instrument.
// All bias, bestSetup, and setupDirection are calculated server-side
// using deterministic rules — Claude never decides instrument direction.
const MARKETS_PROMPT = [
  "You are a senior futures trader with deep knowledge of how macro conditions, geopolitical events, and market catalysts affect specific instruments.",
  "You have been given today's full morning brief. Your job is to:",
  "1. Score each instrument's directional bias (bull/bear/neutral) based on TODAY's specific drivers",
  "2. Write ONE concise implication sentence explaining the dominant catalyst for each instrument",
  "3. Identify the 1-2 highest probability trade setups across ALL instruments",
  "",
  "INSTRUMENTS: ES (S&P 500), NQ (Nasdaq 100), YM (Dow Jones), RTY (Russell 2000), GC (Gold), SI (Silver), HG (Copper), PL (Platinum), CL (Crude Oil), NG (Natural Gas), DXY (US Dollar Index)",
  "",
  "SCORING PHILOSOPHY: Every instrument sits at the intersection of multiple competing forces. Identify ALL forces acting on each instrument today — what is pushing it up AND what is pushing it down — then score the NET direction. Never assign a score from a single catalyst alone.",
  "",
  "GC (Gold): Competing forces — safe-haven bid (escalation/fear = bullish) vs dollar strength (USD is also a safe haven = DXY up = bearish for USD-denominated gold) vs real yields (hawkish Fed/inflation = higher yields = bearish opportunity cost). Geopolitical escalation does NOT automatically make gold bullish. If DXY surges alongside, the net effect may be neutral or bearish. Under GNISBN with elevated real yields, the yield/dollar headwind often offsets or overwhelms the safe-haven bid. Always state both forces.",
  "SI (Silver): Follows GC direction amplified, with added industrial demand exposure. Risk-off weakens industrial demand (additional bearish force). More volatile than gold.",
  "HG (Copper): Pure industrial demand proxy — NOT a safe haven. Risk-off = growth fears = bearish. Dollar strength = bearish. China stimulus = bullish. Geopolitical escalation is bearish for copper (demand destruction fears), not bullish.",
  "PL (Platinum): Industrial/automotive demand. Risk-off is bearish. No meaningful safe-haven bid. Dollar strength is a headwind.",
  "CL (Crude Oil): Supply risk from Middle East conflict = bullish premium. BUT: dollar strength from same risk-off = bearish headwind (oil is USD-denominated). Growth fears/demand destruction = bearish. Net: score bull only if supply route threat clearly dominates dollar and demand headwinds.",
  "NG (Natural Gas): Weather, storage reports, LNG export demand ONLY. Not affected by geopolitics, macro, rates, or equity direction. Default neutral.",
  "DXY (US Dollar): Risk-off/safe-haven = bullish. Fed hawkish/strong data = bullish. Risk-on/Fed dovish/weak data = bearish. Geopolitical escalation = bullish (USD is the ultimate safe haven). DXY strength creates headwinds for ALL USD-denominated commodities simultaneously.",
  "NQ (Nasdaq 100): Most sensitive to real yields and rate expectations. Tech/growth multiples compress with higher yields. Geopolitical risk-off hits NQ hardest among equity indices.",
  "ES (S&P 500): Broader than NQ — more defensive sectors provide cushion. Still bearish on risk-off but less than NQ.",
  "YM (Dow Jones): Most defensive equity index — heavy in dividend/value stocks. Least sensitive to rate moves. Outperforms NQ/ES in risk-off if driven by yield concerns.",
  "RTY (Russell 2000): Most vulnerable to risk-off, recession fears, and dollar strength. Small-caps have least pricing power and most credit sensitivity.",
  "",
  "BEST SETUP RULES:",
  "- Only flag as best setup when there is HIGH CONVICTION — multiple signals align, clear catalyst, instrument is most sensitive to today's dominant theme",
  "- Prefer the instrument MOST sensitive to the dominant catalyst (e.g. NQ over ES when yields are the driver)",
  "- Can have 0, 1, or 2 best setups — do not force one if conviction is low",
  "- Direction: 'long' or 'short'",
  "",
  "IMPLICATION LANGUAGE RULE: Use cautious, forward-looking language in all implication sentences. Say 'may face selling pressure', 'could benefit from', 'faces headwinds from', 'likely to see support', 'at risk of', 'positioned to'. Avoid definitive 'is driving' or 'is causing' language — these are bias assessments, not confirmed outcomes.",
  "",
  "CRITICAL: Reply ONLY with raw JSON, no markdown, no backticks.",
  "SCHEMA: {",
  "  \"equities\": {",
  "    \"ES\": {\"bias\":\"bull|bear|neutral\", \"implication\":\"ONE sentence\"},",
  "    \"NQ\": {\"bias\":\"bull|bear|neutral\", \"implication\":\"ONE sentence\"},",
  "    \"YM\": {\"bias\":\"bull|bear|neutral\", \"implication\":\"ONE sentence\"},",
  "    \"RTY\": {\"bias\":\"bull|bear|neutral\", \"implication\":\"ONE sentence\"}",
  "  },",
  "  \"metals\": {",
  "    \"GC\": {\"bias\":\"bull|bear|neutral\", \"implication\":\"ONE sentence\"},",
  "    \"SI\": {\"bias\":\"bull|bear|neutral\", \"implication\":\"ONE sentence\"},",
  "    \"HG\": {\"bias\":\"bull|bear|neutral\", \"implication\":\"ONE sentence\"},",
  "    \"PL\": {\"bias\":\"bull|bear|neutral\", \"implication\":\"ONE sentence\"}",
  "  },",
  "  \"energies\": {",
  "    \"CL\": {\"bias\":\"bull|bear|neutral\", \"implication\":\"ONE sentence\"},",
  "    \"NG\": {\"bias\":\"bull|bear|neutral\", \"implication\":\"ONE sentence\"}",
  "  },",
  "  \"dxy\": {",
  "    \"DXY\": {\"bias\":\"bull|bear|neutral\", \"implication\":\"ONE sentence\"}",
  "  },",
  "  \"bestSetups\": [",
  "    {\"ticker\":\"NQ\", \"direction\":\"short\", \"reason\":\"ONE sentence on why this is the highest conviction setup today\"}",
  "  ]",
  "}"
].join("\n");

app.post("/api/markets", async function(req, res) {
  const { econ, earn, premarket, news, metaScore, regime } = req.body;
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "API key not set" });

  try {
    const today = new Date().toLocaleDateString("en-US", { weekday:"long", year:"numeric", month:"long", day:"numeric" });
    const etNow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    const etTime = etNow.toLocaleTimeString("en-US", { hour:"2-digit", minute:"2-digit", hour12:true });
    const etHour = etNow.getHours(); const etMin = etNow.getMinutes(); const etDay = etNow.getDay();
    const sessionOpen = etDay >= 1 && etDay <= 5 && (etHour > 9 || (etHour === 9 && etMin >= 30));
    const sessionStatus = sessionOpen ? "US SESSION OPEN (pre-market data is informational only)" : "PRE-MARKET (overnight data is active signal)";

    const activeRegime = regime || regimeCache;
    const regimeName = activeRegime ? activeRegime.regime : "Unknown";
    const regimeDesc = {
      "GNISBN": "Good News Is Bad News — strong data = delayed cuts = bearish for equities",
      "GNISGN": "Good News Is Good News — strong data = growth = bullish for equities",
      "BNISBN": "Bad News Is Bad News — weak data = recession fears = bearish",
      "BNISGNBN": "Bad News Is Good News — weak data = rate cuts coming = bullish"
    }[regimeName] || "Unknown regime";

    // Build catalyst context from Claude's structured flags
    const newsCats = (news && news.catalysts) || {};
    const econCats = (econ && econ.catalysts) || {};
    const cats = {};
    [...Object.keys(newsCats), ...Object.keys(econCats)].forEach(k => {
      cats[k] = !!(newsCats[k] || econCats[k]);
    });
    const activeCatalysts = Object.keys(cats).filter(k => cats[k]);

    const context = [
      "DATE: " + today + " | TIME: " + etTime + " ET | " + sessionStatus,
      "REGIME: " + regimeName + " — " + regimeDesc,
      "OVERALL BIAS: " + (metaScore ? metaScore.biasLabel + " (" + metaScore.weightedScore + ")" : "Unknown"),
      "AI RATIONALE: " + (metaScore ? metaScore.rationale : ""),
      activeCatalysts.length > 0 ? "ACTIVE CATALYSTS: " + activeCatalysts.join(", ") : "NO SPECIFIC CATALYSTS FLAGGED",
      "",
      "ECON [" + (econ ? econ.signal.toUpperCase() : "NEUTRAL") + ", weight " + (metaScore && metaScore.weights ? metaScore.weights.econ : 1) + "x]: " + (econ ? econ.summary : "No data"),
      "EARNINGS [" + (earn ? earn.signal.toUpperCase() : "NEUTRAL") + ", weight " + (metaScore && metaScore.weights ? metaScore.weights.earn : 1) + "x]: " + (earn ? earn.summary : "No data"),
      "PRE-MARKET [" + (premarket ? premarket.signal.toUpperCase() : "NEUTRAL") + (sessionOpen ? " — ZEROED AFTER OPEN" : "") + "]: " + (premarket ? premarket.summary : "No data"),
      "NEWS [" + (news ? news.signal.toUpperCase() : "NEUTRAL") + ", weight " + (metaScore && metaScore.weights ? metaScore.weights.news : 2) + "x]: " + (news ? news.summary : "No data"),
    ].join("\n");

    const body = {
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      temperature: 0,
      system: "You are a senior futures trader scoring instrument biases for a day-trading dashboard. You understand market microstructure, how different instruments react to macro/geopolitical events, and the difference between what matters for the session vs structural backdrop. CRITICAL: Reply ONLY with raw JSON matching the exact schema. No markdown, no backticks, no explanation outside the JSON.",
      messages: [{ role: "user", content: MARKETS_PROMPT + "\n\nMORNING BRIEF:\n" + context }]
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
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            const cleaned = jsonMatch ? jsonMatch[0] : text.replace(/```json|```/g, "").trim();
            resolve(JSON.parse(cleaned));
          } catch(e) { reject(new Error("Parse error: " + e.message)); }
        });
      });
      req2.on("error", reject);
      req2.setTimeout(45000, () => { req2.destroy(); reject(new Error("Markets timeout")); });
      req2.write(payload);
      req2.end();
    });

    // ── Build final markets structure ──
    // Claude now owns bias + implication. We handle best setup display.
    const GROUPS = {
      equities: ["ES","NQ","YM","RTY"],
      metals:   ["GC","SI","HG","PL"],
      energies: ["CL","NG"],
      dxy:      ["DXY"]
    };

    // Extract best setups from Claude's response
    const bestSetups = result.bestSetups || [];
    const bestTickers = bestSetups.map(s => s.ticker);

    function buildGroup(groupName) {
      const out = {};
      GROUPS[groupName].forEach(ticker => {
        const claudeData = (result[groupName] && result[groupName][ticker]) || {};
        const bias = (claudeData.bias || "neutral").toLowerCase();
        const isBest = bestTickers.includes(ticker);
        const setup = bestSetups.find(s => s.ticker === ticker);
        out[ticker] = {
          bias,
          implication: claudeData.implication || "No data.",
          bestSetup: isBest,
          setupDirection: isBest ? (setup ? setup.direction : (bias === "bull" ? "long" : "short")) : null,
          divergence: false
        };
      });
      return out;
    }

    const finalMarkets = {
      equities: buildGroup("equities"),
      metals:   buildGroup("metals"),
      energies: buildGroup("energies"),
      dxy:      buildGroup("dxy")
    };

    console.log("Markets result generated (Claude-driven scoring)");
    console.log("Best setups:", bestSetups.map(s => s.ticker + " " + s.direction).join(", "));
    res.json(finalMarkets);
  } catch(e) {
    console.error("Markets error:", e.message);
    console.error("Markets stack:", e.stack ? e.stack.slice(0,400) : "no stack");
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
  "PARAGRAPH 4 — WHAT THE MARKETS ARE DOING: Briefly describe what stocks, gold, oil, and the dollar are doing today and why — in plain English. Mention the directional bias for each asset class. End this paragraph with the HIGHEST PROBABILITY SETUPS — name the specific markets using their ticker symbol AND full name together (e.g. \'NQ (Nasdaq 100)\', \'CL (Crude Oil)\', \'GC (Gold)\', \'DXY (US Dollar Index)\') and briefly explain why they have the strongest conviction.",
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
      "",
      // Best setup instruments — these are flagged as Highest Probability by the server
      "HIGHEST PROBABILITY SETUPS (for paragraph 4):",
      (function() {
        const setups = [];
        const nameMap = {
          ES:"ES (S&P 500)", NQ:"NQ (Nasdaq 100)", YM:"YM (Dow Jones)", RTY:"RTY (Russell 2000)",
          GC:"GC (Gold)", SI:"SI (Silver)", HG:"HG (Copper)", PL:"PL (Platinum)",
          CL:"CL (Crude Oil)", NG:"NG (Natural Gas)", DXY:"DXY (US Dollar Index)"
        };
        if (markets) {
          const groups = [markets.equities, markets.metals, markets.energies, markets.dxy];
          groups.forEach(function(g) {
            if (!g) return;
            Object.keys(g).forEach(function(ticker) {
              const inst = g[ticker];
              if (inst && inst.bestSetup && inst.setupDirection) {
                setups.push(nameMap[ticker] + ": " + inst.setupDirection + " (" + inst.bias + ") — " + (inst.implication||""));
              }
            });
          });
        }
        return setups.length > 0 ? setups.join("\n") : "No clear best setups identified today.";
      })(),
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

        // Append upcoming week econ events for context
      try {
        const wEcon = await fetchWeekAhead();
        if (wEcon && wEcon.econ) {
          const upEcon = wEcon.econ.filter(e => e.status === "scheduled").slice(0, 6).map(e => {
            const d = new Date(e.date + "T12:00:00");
            const dn = d.toLocaleDateString("en-US", {weekday:"long"});
            let ts = "";
            if (e.time && e.time !== "TBD") {
              try { const tp = e.time.split(":"); const td = new Date(); td.setUTCHours(parseInt(tp[0]),parseInt(tp[1]||0),0,0); ts = " at " + td.toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit",hour12:true,timeZone:"America/New_York"}) + " ET"; } catch(te){}
            }
            return "• " + e.name + " — " + dn + ts;
          }).join("\n");
          if (upEcon) rawData = (rawData || "") + "\n\nUPCOMING HIGH IMPACT EVENTS THIS WEEK:\n" + upEcon + "\n[Mention the next upcoming event in your summary if no data today]";
        }
      } catch(we) {}
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

        // Append upcoming earnings for context
      try {
        const wEarn = await fetchWeekAhead();
        if (wEarn && wEarn.earnings) {
          const upEarn = wEarn.earnings.filter(e => e.status === "scheduled").slice(0, 8).map(e => {
            const d = new Date(e.date + "T12:00:00");
            const dn = d.toLocaleDateString("en-US", {weekday:"long"});
            const revStr = e.revEst ? " · Rev Est: $" + (e.revEst/1e9).toFixed(1) + "B" : "";
            const epsStr = e.epsEst ? " · EPS Est: $" + e.epsEst.toFixed(2) : "";
            return "• " + e.ticker + " (" + (e.company||e.ticker) + ") — " + dn + " " + e.when + epsStr + revStr;
          }).join("\n");
          if (upEarn) rawData = (rawData || "") + "\n\nUPCOMING EARNINGS THIS WEEK:\n" + upEarn + "\n[Mention the next notable company in your summary if no earnings today]";
        }
      } catch(we) {}
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
        // Append upcoming week econ events for context
      try {
        const wEcon = await fetchWeekAhead();
        if (wEcon && wEcon.econ) {
          const upEcon = wEcon.econ.filter(e => e.status === "scheduled").slice(0, 6).map(e => {
            const d = new Date(e.date + "T12:00:00");
            const dn = d.toLocaleDateString("en-US", {weekday:"long"});
            let ts = "";
            if (e.time && e.time !== "TBD") {
              try { const tp = e.time.split(":"); const td = new Date(); td.setUTCHours(parseInt(tp[0]),parseInt(tp[1]||0),0,0); ts = " at " + td.toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit",hour12:true,timeZone:"America/New_York"}) + " ET"; } catch(te){}
            }
            return "• " + e.name + " — " + dn + ts;
          }).join("\n");
          if (upEcon) rawData = (rawData || "") + "\n\nUPCOMING HIGH IMPACT EVENTS THIS WEEK:\n" + upEcon + "\n[Mention the next upcoming event in your summary if no data today]";
        }
      } catch(we) {}
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
        // Append upcoming earnings for context
      try {
        const wEarn = await fetchWeekAhead();
        if (wEarn && wEarn.earnings) {
          const upEarn = wEarn.earnings.filter(e => e.status === "scheduled").slice(0, 8).map(e => {
            const d = new Date(e.date + "T12:00:00");
            const dn = d.toLocaleDateString("en-US", {weekday:"long"});
            const revStr = e.revEst ? " · Rev Est: $" + (e.revEst/1e9).toFixed(1) + "B" : "";
            const epsStr = e.epsEst ? " · EPS Est: $" + e.epsEst.toFixed(2) : "";
            return "• " + e.ticker + " (" + (e.company||e.ticker) + ") — " + dn + " " + e.when + epsStr + revStr;
          }).join("\n");
          if (upEarn) rawData = (rawData || "") + "\n\nUPCOMING EARNINGS THIS WEEK:\n" + upEarn + "\n[Mention the next notable company in your summary if no earnings today]";
        }
      } catch(we) {}
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

    // ── Use MARKETS_PROMPT with Claude for backtest instrument scoring ──
    let marketScores = { equities:{ES:{bias:"neutral",implication:""},NQ:{bias:"neutral",implication:""},YM:{bias:"neutral",implication:""},RTY:{bias:"neutral",implication:""}}, metals:{GC:{bias:"neutral",implication:""},SI:{bias:"neutral",implication:""},HG:{bias:"neutral",implication:""},PL:{bias:"neutral",implication:""}}, energies:{CL:{bias:"neutral",implication:""},NG:{bias:"neutral",implication:""}}, dxy:{DXY:{bias:"neutral",implication:""}} };
    try {
      const btMktCtx = ["BACKTEST DATE: " + date, "REGIME: Unknown for this date — use your knowledge",
        "OVERALL BIAS: " + metaScore.biasLabel,
        "ECON: " + results.econ.signal.toUpperCase() + " | " + results.econ.summary,
        "EARNINGS: " + results.earn.signal.toUpperCase() + " | " + results.earn.summary,
        "PRE-MARKET: " + results.premarket.signal.toUpperCase() + " | " + results.premarket.summary,
        "NEWS: " + results.news.signal.toUpperCase() + " | " + results.news.summary,
        "NO ACTIVE CATALYSTS FLAGGED — use context from summaries above"
      ].join("\n");
      const btMktBody = { model:"claude-haiku-4-5-20251001", max_tokens:1500, temperature:0,
        system:"You are a senior futures trader scoring instrument biases. CRITICAL: Reply ONLY with raw JSON matching the exact schema. No markdown.",
        messages:[{ role:"user", content: MARKETS_PROMPT + "\n\nMORNING BRIEF:\n" + btMktCtx }] };
      const btMktPayload = JSON.stringify(btMktBody);
      const btMktHeaders = { "Content-Type":"application/json","Content-Length":Buffer.byteLength(btMktPayload),"x-api-key":process.env.ANTHROPIC_API_KEY,"anthropic-version":"2023-06-01" };
      const btMktRaw = await new Promise((resolve, reject) => {
        const opts = { hostname:"api.anthropic.com", path:"/v1/messages", method:"POST", headers:btMktHeaders };
        const r2 = https.request(opts, r => { let d=""; r.on("data",c=>d+=c); r.on("end",()=>resolve(d)); });
        r2.on("error", reject);
        r2.setTimeout(30000, ()=>{ r2.destroy(); reject(new Error("BT markets timeout")); });
        r2.write(btMktPayload); r2.end();
      });
      const btMktParsed = JSON.parse(btMktRaw);
      const btMktText = (btMktParsed.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("").trim();
      const btMktResult = JSON.parse(btMktText.replace(/```json|```/g,"").trim());
      const GROUPS = { equities:["ES","NQ","YM","RTY"], metals:["GC","SI","HG","PL"], energies:["CL","NG"], dxy:["DXY"] };
      const btBestSetups = btMktResult.bestSetups || [];
      const btBestTickers = btBestSetups.map(s=>s.ticker);
      Object.keys(GROUPS).forEach(grp => {
        marketScores[grp] = {};
        GROUPS[grp].forEach(ticker => {
          const cd = (btMktResult[grp] && btMktResult[grp][ticker]) || {};
          const bias = (cd.bias||"neutral").toLowerCase();
          const isBest = btBestTickers.includes(ticker);
          const setup = btBestSetups.find(s=>s.ticker===ticker);
          marketScores[grp][ticker] = { bias, implication:cd.implication||"", bestSetup:isBest, setupDirection:isBest?(setup?setup.direction:(bias==="bull"?"long":"short")):null };
        });
      });
    } catch(e) { console.error("BT market scoring error:", e.message); }

    updateJob("Markets scored. Generating summary...", 4);

    // Build best setups for summary context
    const btSetupsList = [];
    Object.keys(marketScores).forEach(grp => {
      Object.keys(marketScores[grp]).forEach(t => {
        const inst = marketScores[grp][t];
        if (inst && inst.bestSetup && inst.setupDirection) btSetupsList.push(t+": "+inst.setupDirection+" ("+inst.bias+")");
      });
    });
    const sumCtx = ["BACKTEST DATE: " + date, "OVERALL BIAS: " + metaScore.biasLabel, "RATIONALE: " + metaScore.rationale,
      "ECON: " + results.econ.signal.toUpperCase() + " | " + results.econ.summary,
      "EARNINGS: " + results.earn.signal.toUpperCase() + " | " + results.earn.summary,
      "PRE-MARKET: " + results.premarket.signal.toUpperCase() + " | " + results.premarket.summary,
      "NEWS: " + results.news.signal.toUpperCase() + " | " + results.news.summary,
      "Equities: ES="+marketScores.equities.ES.bias+", NQ="+marketScores.equities.NQ.bias,
      "DXY: "+marketScores.dxy.DXY.bias,
      "HIGHEST PROBABILITY SETUPS: " + (btSetupsList.length > 0 ? btSetupsList.join(", ") : "None identified")
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


// ── Live market prices endpoint ───────────────────────────────
// Fetches current price + % change for all traded instruments via Finnhub
// Used by Markets tab to show live data and relative strength ranking
const MARKET_SYMBOLS = [
  { ticker:"ES",  finnhub:"ES=F",  td:"ES1!",  group:"equities", name:"S&P 500 Futures" },
  { ticker:"NQ",  finnhub:"NQ=F",  td:"NQ1!",  group:"equities", name:"Nasdaq 100 Futures" },
  { ticker:"YM",  finnhub:"YM=F",  td:"YM1!",  group:"equities", name:"Dow Jones Futures" },
  { ticker:"RTY", finnhub:"RTY=F", td:"RTY1!",  group:"equities", name:"Russell 2000 Futures" },
  { ticker:"GC",  finnhub:"GC=F",  td:"GC1!",  group:"metals",   name:"Gold Futures" },
  { ticker:"SI",  finnhub:"SI=F",  td:"SI1!",  group:"metals",   name:"Silver Futures" },
  { ticker:"HG",  finnhub:"HG=F",  td:"HG1!",  group:"metals",   name:"Copper Futures" },
  { ticker:"PL",  finnhub:"PL=F",  td:"PL1!",  group:"metals",   name:"Platinum Futures" },
  { ticker:"CL",  finnhub:"CL=F",  td:"CL1!",  group:"energies", name:"Crude Oil Futures" },
  { ticker:"NG",  finnhub:"NG=F",  td:"NG1!",  group:"energies", name:"Natural Gas Futures" },
  { ticker:"DXY", finnhub:"DX=F",  td:"DX1!",  group:"dxy",      name:"US Dollar Index" },
];

// Build quote map with relative strength rankings
function buildQuoteMap(quotes) {
  const map = {};
  const groups = {};
  quotes.forEach(q => {
    map[q.ticker] = q;
    if (!groups[q.group]) groups[q.group] = [];
    if (q.pct !== null) groups[q.group].push(q);
  });
  // Rank within group by pct change
  Object.values(groups).forEach(grp => {
    const sorted = [...grp].sort((a,b) => (b.pct||0) - (a.pct||0));
    sorted.forEach((q, i) => {
      map[q.ticker].strengthRank = i + 1;
      map[q.ticker].strengthTotal = sorted.length;
      map[q.ticker].isStrongest = i === 0 && sorted.length > 1;
      map[q.ticker].isWeakest = i === sorted.length - 1 && sorted.length > 1;
    });
  });
  return map;
}

async function fetchLivePrices() {
  const TD_KEY = process.env.TWELVE_DATA_API_KEY || "559c9af13d024c02bc3dde90163dbf8d";

  // ── PRIMARY: TradingView webhook cache (real-time, no rate limits) ──
  if (tvPriceCache.isFresh(300)) { // fresh within 5 minutes
    console.log("Market prices: using TradingView cache (age " + tvPriceCache.ageSeconds() + "s)");
    const quotes = MARKET_SYMBOLS.map(s => {
      const tvData = tvPriceCache.futures[s.ticker];
      if (!tvData || !tvData.p) return { ticker: s.ticker, group: s.group, price: null, pct: null };
      return {
        ticker: s.ticker, group: s.group,
        price:  parseFloat(tvData.p),
        prev:   parseFloat(tvData.p) - parseFloat(tvData.c || 0),
        change: parseFloat(tvData.c || 0),
        pct:    parseFloat(tvData.pct || 0),
        high:   0, low: 0
      };
    });
    // Add relative strength rankings
    return buildQuoteMap(quotes);
  }

  console.log("Market prices: TV cache stale/empty (" + tvPriceCache.ageSeconds() + "s), falling back to Twelve Data");

  // Twelve Data — free tier = 8 credits/min, each symbol costs 2 credits = max 4 per call
  // Batch 1 (auto on load): NQ, ES, GC, CL — highest priority instruments
  // Batch 2 (on manual refresh): YM, RTY, SI, HG, PL, CL, NG, DXY
  // 60 second gap between batches stays within free tier limits

  const BATCH1 = ["NQ1!", "ES1!", "GC1!", "CL1!"];
  const BATCH2 = ["YM1!", "RTY1!", "SI1!", "HG1!", "PL1!", "NG1!", "DX1!"];

  async function fetchTDBatch(symbols) {
    try {
      const url = "https://api.twelvedata.com/quote?symbol=" + encodeURIComponent(symbols.join(",")) + "&apikey=" + TD_KEY;
      const raw = await fetchUrl(url);
      const json = JSON.parse(raw);
      if (json.code === 429) { console.log("Twelve Data rate limit hit"); return {}; }
      const map = {};
      // Handle both single symbol response and multi-symbol response
      const entries = json.symbol ? { [json.symbol]: json } : json;
      Object.keys(entries).forEach(sym => {
        const q = entries[sym];
        if (q && q.close && !q.code) {
          const price  = parseFloat(q.close);
          const prev   = parseFloat(q.previous_close || q.close);
          const change = parseFloat(q.change) || (price - prev);
          const pct    = parseFloat(q.percent_change) || (prev ? (change/prev)*100 : 0);
          map[sym] = {
            price:  price, prev,
            change: parseFloat(change.toFixed(2)),
            pct:    parseFloat(pct.toFixed(2)),
            high:   parseFloat(q.high || 0),
            low:    parseFloat(q.low  || 0),
          };
        }
      });
      console.log("Twelve Data batch returned", Object.keys(map).length, "of", symbols.length, "symbols:", symbols.join(","));
      return map;
    } catch(e) {
      console.log("Twelve Data batch error:", e.message);
      return {};
    }
  }

  // Fetch batch 1 immediately
  let tdMap = await fetchTDBatch(BATCH1);

  // Fetch batch 2 after 65 second delay (new rate limit window)
  // Run async — don't block the response
  setTimeout(async () => {
    const map2 = await fetchTDBatch(BATCH2);
    // Merge into a shared cache the next /api/market-prices call can use
    Object.assign(global.priceCache || {}, map2);
    console.log("Twelve Data batch 2 complete, cache updated");
  }, 65000);

  // Also merge any cached batch 2 data from previous calls
  if (global.priceCache) {
    Object.assign(tdMap, global.priceCache);
  }
  // Store batch 1 in cache too
  global.priceCache = global.priceCache || {};
  Object.assign(global.priceCache, tdMap);

  const quotes = MARKET_SYMBOLS.map(s => {
    const q = tdMap[s.td];
    if (!q) return { ticker: s.ticker, group: s.group, price: null, pct: null };
    return { ticker: s.ticker, group: s.group, ...q };
  });

  // Build results map + relative strength rank within each group
  const groups = {};
  quotes.forEach(q => {
    if (!groups[q.group]) groups[q.group] = [];
    groups[q.group].push(q);
    results[q.ticker] = q;
  });

  // Rank within each group by % change (1=strongest/highest, n=weakest/lowest)
  Object.keys(groups).forEach(g => {
    const grp = groups[g].filter(q => q.pct !== null);
    grp.sort((a, b) => b.pct - a.pct); // descending — highest % first
    grp.forEach((q, i) => {
      results[q.ticker].rank     = i + 1;       // 1 = strongest
      results[q.ticker].groupSize = grp.length;
      results[q.ticker].isStrongest = i === 0;
      results[q.ticker].isWeakest   = i === grp.length - 1;
    });
  });

  return results;
}

// Cache market prices for 60 seconds to avoid hitting rate limits on repeated calls
var marketPriceCache = { prices: null, fetchedAt: 0 };

app.get("/api/market-prices", async function(req, res) {
  try {
    const now = Date.now();
    const age = now - marketPriceCache.fetchedAt;
    const force = req.query.force === "1";

    // Return cache if less than 60 seconds old (unless forced)
    if (!force && marketPriceCache.prices && age < 60000) {
      console.log("Market prices: serving from cache (age " + Math.round(age/1000) + "s)");
      return res.json({ prices: marketPriceCache.prices, timestamp: new Date(marketPriceCache.fetchedAt).toISOString(), cached: true });
    }

    console.log("Market prices: fetching fresh data...");
    const prices = await fetchLivePrices();
    marketPriceCache = { prices, fetchedAt: now };
    res.json({ prices, timestamp: new Date().toISOString(), cached: false });
  } catch(e) {
    console.error("Market prices error:", e.message);
    res.status(500).json({ error: e.message });
  }
});


// ── Week Ahead endpoint ───────────────────────────────────────
// Fetches this week's key econ events and earnings, cached for 1 hour
const MEGA_CAPS = ["NVDA","AAPL","MSFT","META","GOOGL","GOOG","AMZN","TSLA","AVGO","NFLX","AMD","QCOM","ARM","SMCI","ORCL","CRM","SHOP","UBER","INTC","MU"];
const LARGE_CAPS = ["JPM","GS","BAC","MS","C","WFC","BLK","V","MA","PYPL","XOM","CVX","COP","OXY","LLY","UNH","JNJ","PFE","ABBV","MRK","COST","WMT","TGT","HD","NKE","SBUX","DIS","NFLX","T","VZ"];
const WATCH_TICKERS = new Set([...MEGA_CAPS, ...LARGE_CAPS]);

const TIER1_ECON = ["nonfarm","payroll","consumer price index","cpi","personal consumption expenditure","pce","fomc","federal open market","fed rate","interest rate decision","gross domestic product","gdp"];
const TIER2_ECON = ["jobless claims","initial claims","jolts","adp employment","unemployment rate","average hourly","producer price","ppi","ism manufacturing","ism services","retail sales","industrial production"];
const ECON_EXCLUDE = ["gdpnow","nowcast","atlanta fed","cleveland fed","new york fed nowcast","sticky price","wage growth tracker","fedspeak","fed speak","treasury auction","bill auction","note auction","bond auction","redbook","nfib","baker hughes","rig count","api crude","api oil","dallas fed","richmond fed","kansas city fed","chicago pmi","national activity","abc consumer","mortgage","purchasing managers","markit"];

var weekAheadCache = { data: null, fetchedAt: 0, weekKey: null };

async function fetchWeekAhead() {
  const FMP_KEY = process.env.FMP_API_KEY || "WQMcZiIIJ1rarvN3puluUNQoGXFdvkjg";
  const now = new Date();
  const etNow = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));

  // Get Monday of current week
  const day = etNow.getDay();
  const monday = new Date(etNow);
  monday.setDate(etNow.getDate() - (day === 0 ? 6 : day - 1));
  monday.setHours(0,0,0,0);
  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4);

  const fromStr = monday.toISOString().slice(0,10);
  const toStr   = friday.toISOString().slice(0,10);
  const weekKey = fromStr;

  // Use cache if same week and less than 1 hour old
  const cacheAge = Date.now() - weekAheadCache.fetchedAt;
  if (weekAheadCache.data && weekAheadCache.weekKey === weekKey && cacheAge < 3600000) {
    return weekAheadCache.data;
  }

  const [econRaw, earnRaw] = await Promise.allSettled([
    fetchUrl("https://financialmodelingprep.com/stable/economic-calendar?from=" + fromStr + "&to=" + toStr + "&apikey=" + FMP_KEY),
    fetchUrl("https://financialmodelingprep.com/stable/earnings-calendar?from=" + fromStr + "&to=" + toStr + "&apikey=" + FMP_KEY)
  ]);

  // ── Process econ events ──
  const econEvents = [];
  if (econRaw.status === "fulfilled") {
    try {
      const raw = JSON.parse(econRaw.value);
      if (Array.isArray(raw)) {
        raw.forEach(e => {
          const name = (e.event || e.indicator || e.name || "").toLowerCase();
          const country = (e.country || e.currency || "").toUpperCase();
          const isUSD = country === "US" || country === "USD";
          if (!isUSD) return;
          const isTier1 = TIER1_ECON.some(k => name.includes(k));
          const isTier2 = TIER2_ECON.some(k => name.includes(k));
          if (!isTier1 && !isTier2) return;
          // Exclude nowcasts, regional feds, auctions regardless of tier match
          const isExcluded = ECON_EXCLUDE.some(k => name.includes(k));
          if (isExcluded) return;
          const date = (e.date || "").slice(0,10);
          const time = (e.date || "").slice(11,16) || "TBD";
          const actual = e.actual !== null && e.actual !== undefined ? parseFloat(e.actual) : null;
          const estimate = e.estimate !== null && e.estimate !== undefined ? parseFloat(e.estimate) : null;
          const previous = e.previous !== null && e.previous !== undefined ? parseFloat(e.previous) : null;
          let status = "scheduled";
          let beat = null;
          if (actual !== null) {
            status = "released";
            if (estimate !== null) {
              beat = actual > estimate ? "beat" : actual < estimate ? "miss" : "inline";
            }
          }
          econEvents.push({
            date, time, name: e.event || e.indicator || e.name,
            tier: isTier1 ? 1 : 2,
            actual, estimate, previous, status, beat,
            impact: e.impact || "Medium"
          });
        });
      }
    } catch(e) { console.log("WeekAhead econ parse error:", e.message); }
  }

  // ── Process earnings ──
  const earnEvents = [];
  if (earnRaw.status === "fulfilled") {
    try {
      const raw = JSON.parse(earnRaw.value);
      if (Array.isArray(raw)) {
        raw.forEach(e => {
          const ticker = (e.symbol || "").toUpperCase();
          if (!WATCH_TICKERS.has(ticker)) return;
          const date = (e.date || "").slice(0,10);
          const time = e.time || (e.when === "bmo" ? "BMO" : e.when === "amc" ? "AMC" : "TBD");
          const when = (e.time || e.when || "").toLowerCase().includes("bmo") ? "BMO" : (e.time || e.when || "").toLowerCase().includes("amc") ? "AMC" : "TBD";
          const epsActual = e.eps !== null && e.eps !== undefined ? parseFloat(e.eps) : null;
          const epsEst = e.epsEstimated !== null && e.epsEstimated !== undefined ? parseFloat(e.epsEstimated) : null;
          const revActual = e.revenue !== null && e.revenue !== undefined ? parseFloat(e.revenue) : null;
          const revEst = e.revenueEstimated !== null && e.revenueEstimated !== undefined ? parseFloat(e.revenueEstimated) : null;
          let status = "scheduled";
          let beat = null;
          if (epsActual !== null) {
            status = "released";
            if (epsEst !== null) beat = epsActual > epsEst ? "beat" : epsActual < epsEst ? "miss" : "inline";
          }
          earnEvents.push({
            date, when, ticker, company: e.company || ticker,
            epsActual, epsEst, revActual, revEst,
            status, beat,
            guidance: e.guidance || null
          });
        });
      }
    } catch(e) { console.log("WeekAhead earnings parse error:", e.message); }
  }

  // Sort both by date
  econEvents.sort((a,b) => a.date.localeCompare(b.date) || (a.tier - b.tier));
  earnEvents.sort((a,b) => a.date.localeCompare(b.date));

  // ── Notable events (IPOs, Fed speeches, major expirations) ──
  const notableEvents = [];
  // Try multiple IPO endpoints — FMP has inconsistent endpoint naming
  const ipoEndpoints = [
    "https://financialmodelingprep.com/stable/ipos-confirmed?from=" + fromStr + "&to=" + toStr + "&apikey=" + FMP_KEY,
    "https://financialmodelingprep.com/stable/ipos-calendar?from=" + fromStr + "&to=" + toStr + "&apikey=" + FMP_KEY,
    "https://financialmodelingprep.com/stable/ipo-calendar?from=" + fromStr + "&to=" + toStr + "&apikey=" + FMP_KEY,
  ];
  const ipoSeen = new Set();
  for (const ipoUrl of ipoEndpoints) {
    try {
      const ipoRaw = await fetchUrl(ipoUrl);
      const ipoJson = JSON.parse(ipoRaw);
      const arr = Array.isArray(ipoJson) ? ipoJson : (ipoJson.ipoCalendar || []);
      arr.slice(0, 10).forEach(ipo => {
        const date = (ipo.date || ipo.ipoDate || "").slice(0,10);
        const sym = (ipo.symbol || ipo.ticker || "").toUpperCase();
        const key = sym + "|" + date;
        if (!date || ipoSeen.has(key)) return;
        ipoSeen.add(key);
        notableEvents.push({
          date, type: "IPO",
          name: ipo.company || ipo.companyName || ipo.name || sym || "Unknown",
          symbol: sym,
          detail: (ipo.exchange || ipo.market || "IPO"),
          priceRange: ipo.priceRange || ipo.offerPrice || (ipo.price ? "$" + ipo.price : null)
        });
      });
      if (notableEvents.length > 0) break; // stop if first endpoint returned data
    } catch(e) { console.log("IPO endpoint error:", ipoUrl.slice(-30), e.message); }
  }
  console.log("WeekAhead: found", notableEvents.length, "notable events");

  notableEvents.sort((a,b) => a.date.localeCompare(b.date));

  const data = { weekOf: fromStr, weekEnd: toStr, econ: econEvents, earnings: earnEvents, notable: notableEvents, fetchedAt: new Date().toISOString() };
  weekAheadCache = { data, fetchedAt: Date.now(), weekKey };
  console.log("WeekAhead: fetched", econEvents.length, "econ events,", earnEvents.length, "earnings,", notableEvents.length, "notable");
  return data;
}

app.get("/api/week-ahead", async function(req, res) {
  try {
    // ?bust= param forces cache bypass (used by event watchers checking for actuals)
    if (req.query.bust) weekAheadCache = { data: null, fetchedAt: 0, weekKey: null };
    const data = await fetchWeekAhead();
    res.json(data);
  } catch(e) {
    console.error("WeekAhead error:", e.message);
    res.status(500).json({ error: e.message });
  }
});


// ── TradingView Webhook Price Cache ──────────────────────────
// Receives real-time prices from TradingView Pine Script alerts
// Replaces Twelve Data (rate limited) and web scraping for prices

var tvPriceCache = {
  futures: {},   // ES, NQ, YM, RTY, GC, SI, HG, PL, CL, NG, DXY
  asia: {},      // Nikkei, Shanghai, HSI, ASX200, STI
  europe: {},    // DAX, CAC40, FTSE100, AEX, STOXX600
  receivedAt: null,
  ageSeconds: function() {
    return this.receivedAt ? Math.round((Date.now() - this.receivedAt) / 1000) : 9999;
  },
  isFresh: function(maxAgeSeconds) {
    return this.receivedAt && this.ageSeconds() < maxAgeSeconds;
  }
};

// Receive TradingView webhook payload
app.post("/api/tv-prices", function(req, res) {
  try {
    const data = req.body;
    if (!data || (!data.futures && !data.asia && !data.europe)) {
      return res.status(400).json({ error: "Invalid payload — expected futures/asia/europe keys" });
    }

    const prev = tvPriceCache.receivedAt ? tvPriceCache.ageSeconds() : null;

    if (data.futures) tvPriceCache.futures = data.futures;
    if (data.asia)    tvPriceCache.asia    = data.asia;
    if (data.europe)  tvPriceCache.europe  = data.europe;
    tvPriceCache.receivedAt = Date.now();

    const symCount = Object.keys(tvPriceCache.futures).length
      + Object.keys(tvPriceCache.asia).length
      + Object.keys(tvPriceCache.europe).length;

    console.log("TV webhook received:", symCount, "symbols",
      prev !== null ? "(prev was " + prev + "s ago)" : "(first ping)");

    // Log key futures for quick sanity check
    if (tvPriceCache.futures.NQ) console.log("  NQ:", tvPriceCache.futures.NQ.p, "(" + tvPriceCache.futures.NQ.pct + "%)");
    if (tvPriceCache.futures.ES) console.log("  ES:", tvPriceCache.futures.ES.p, "(" + tvPriceCache.futures.ES.pct + "%)");

    res.json({ ok: true, symbols: symCount, ts: new Date().toISOString() });
  } catch(e) {
    console.error("TV webhook error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET endpoint so you can inspect the cache from browser
app.get("/api/tv-prices", function(req, res) {
  res.json({
    cached: !!tvPriceCache.receivedAt,
    ageSeconds: tvPriceCache.receivedAt ? tvPriceCache.ageSeconds() : null,
    receivedAt: tvPriceCache.receivedAt ? new Date(tvPriceCache.receivedAt).toISOString() : null,
    futures: tvPriceCache.futures,
    asia: tvPriceCache.asia,
    europe: tvPriceCache.europe
  });
});


// ── Auto-Analysis Scheduler ───────────────────────────────────
// Runs full analysis automatically at scheduled times ET
// Toggle via POST /api/scheduler/toggle or GET /api/scheduler/status

var schedulerEnabled    = true; // ON by default
var schedulerLastRun    = null;
var schedulerNextRun    = null;
var schedulerLog        = [];
var schedulerRunning    = false;
var scheduleNextRunTimer = null;

// Scheduled run times in ET (24h format): [hour, minute]
const SCHEDULE_TIMES = [
  [7,  30],  // 7:30am  — pre-market, overnight data available
  [8,  35],  // 8:35am  — after most econ releases (8:30am ET)
  [9,  35],  // 9:35am  — post-open, US session confirmed
  [14,  0],  // 2:00pm  — mid-session update
  [16,  5],  // 4:05pm  — post-close, AMC earnings window
];

function getETNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
}

function msUntilNextSchedule() {
  const etNow = getETNow();
  const day = etNow.getDay();
  if (day === 0 || day === 6) return null;

  // Build scheduled times as proper ET Date objects using UTC offset
  // getETNow() returns a Date whose .getHours() etc reflect ET time
  const nowMs = Date.now();

  const futureTimes = SCHEDULE_TIMES
    .map(([h, m]) => {
      // Create a new ET "today" at h:m
      const t = new Date(etNow);
      t.setHours(h, m, 0, 0);
      // ms from now = t (in ET local time) - etNow (in ET local time) converted to real ms
      const diffMs = t.getTime() - etNow.getTime();
      return { label: (h < 12 ? h : h-12) + ":" + String(m).padStart(2,"0") + (h < 12 ? " AM" : " PM"), diffMs };
    })
    .filter(t => t.diffMs > 60000); // must be more than 1 minute in the future

  if (futureTimes.length === 0) return null;

  const next = futureTimes[0];
  schedulerNextRun = next.label + " ET";
  console.log("Scheduler: next scheduled slot in", Math.round(next.diffMs/1000/60), "min (" + next.label + " ET)");
  return next.diffMs;
}

async function runScheduledAnalysis() {
  if (!schedulerEnabled) return;
  const et = getETNow();
  const day = et.getDay();
  if (day === 0 || day === 6) return; // skip weekends

  // ── Duplicate run prevention ──
  if (schedulerRunning) {
    console.log("Scheduler: already running — skipping duplicate trigger");
    return;
  }
  schedulerRunning = true;

  console.log("Scheduler: running auto-analysis at", et.toLocaleTimeString("en-US", {timeZone:"America/New_York"}));
  schedulerLastRun = new Date().toISOString();
  schedulerLog.unshift({ time: schedulerLastRun, status: "running" });
  if (schedulerLog.length > 10) schedulerLog.pop();

  try {
    // ── Step 1: Run all 4 cards ──
    const [econData, earnData, preData, newsData] = await Promise.allSettled([
      fetchEconFMP(),
      fetchEarnings(),
      fetchPremarket(),
      fetchNews()
    ]);

    const rawEcon = econData.status === "fulfilled" ? econData.value : null;
    const rawEarn = earnData.status === "fulfilled" ? earnData.value : null;
    const rawPre  = preData.status  === "fulfilled" ? preData.value  : null;
    const rawNews = newsData.status === "fulfilled" ? newsData.value : null;

    // Detect active regime
    const activeRegime = regimeCache;

    // Build prompts
    const econPrompt = ECON_PROMPT.replace("REGIME_PLACEHOLDER", activeRegime ?
      "REGIME: " + activeRegime.regime + " — " + ({
        "GNISBN":"Good News Is Bad News — strong data delays cuts, bearish equities",
        "GNISGN":"Good News Is Good News — strong data = growth, bullish equities",
        "BNISBN":"Bad News Is Bad News — weak data = recession fears, bearish",
        "BNISGNBN":"Bad News Is Good News — weak data = cuts coming, bullish"
      }[activeRegime.regime]||"") : "");

    // ── Step 2: Analyze each card ──
    const [econ, earn, premarket, news] = await Promise.allSettled([
      callClaudeWithRetry(econPrompt, rawEcon || "No data", false, "econ"),
      callClaudeWithRetry(EARN_PROMPT, rawEarn || "No data", true, "earn"),
      rawPre ? callClaudeWithRetry(PREMARKET_PROMPT, rawPre, false, "premarket")
             : callClaudeWithRetry(PREMARKET_PROMPT, "No premarket data", true, "premarket"),
      callClaudeWithRetry(NEWS_PROMPT + " IMPORTANT: Use web search to supplement CNBC data. Search for \'market moving news today\'.", rawNews || "No data", true, "news")
    ]);

    const results = {
      econ:      econ.status      === "fulfilled" ? econ.value      : { signal:"neutral", score:0, summary:"Error" },
      earn:      earn.status      === "fulfilled" ? earn.value      : { signal:"neutral", score:0, summary:"Error" },
      premarket: premarket.status === "fulfilled" ? premarket.value : { signal:"neutral", score:0, summary:"Error" },
      news:      news.status      === "fulfilled" ? news.value      : { signal:"neutral", score:0, summary:"Error" }
    };

    // ── Step 3: Meta-score ──
    const metaPrompt = META_PROMPT;
    const metaCtx = [
      "SIGNAL 1 — ECON CALENDAR: " + results.econ.signal.toUpperCase() + " | " + results.econ.summary,
      "SIGNAL 2 — EARNINGS: " + results.earn.signal.toUpperCase() + " | " + results.earn.summary,
      "SIGNAL 3 — PRE/POST-MARKET: " + results.premarket.signal.toUpperCase() + " | " + results.premarket.summary,
      "SIGNAL 4 — MARKET NEWS: " + results.news.signal.toUpperCase() + " | " + results.news.summary,
    ].join("\n");

    const metaRaw = await callClaudeWithRetry(metaPrompt, metaCtx, false);
    const weights = metaRaw.weights || { econ:1, earn:1, premarket:1, news:2 };

    // Apply server-side caps
    const etNowMeta = getETNow();
    const afterOpen = etNowMeta.getDay() >= 1 && etNowMeta.getDay() <= 5 &&
      (etNowMeta.getHours() > 9 || (etNowMeta.getHours() === 9 && etNowMeta.getMinutes() >= 30));
    if (weights.premarket > 1) weights.premarket = 1;

    const cardScores = {
      econ:      parseFloat(results.econ.score)      || 0,
      earn:      parseFloat(results.earn.score)      || 0,
      premarket: afterOpen ? 0 : (parseFloat(results.premarket.score) || 0),
      news:      parseFloat(results.news.score)      || 0
    };

    // Carry-forward cap
    const econSumLower = (results.econ.summary||"").toLowerCase();
    if ((econSumLower.includes("carry") || econSumLower.includes("prior session")) && Math.abs(cardScores.econ) > 0.5) {
      cardScores.econ = cardScores.econ > 0 ? 0.5 : -0.5;
    }

    const totalWeight = Object.keys(weights).reduce((s, k) => s + (weights[k]||0), 0);
    const rawWeighted = Object.keys(weights).reduce((s, k) => s + (cardScores[k]||0) * (weights[k]||0), 0);
    const weightedScore = totalWeight > 0 ? parseFloat((rawWeighted / totalWeight).toFixed(3)) : 0;

    const signal = weightedScore >= 0.5 ? "strongly_bull" : weightedScore >= 0.3 ? "bull" : weightedScore >= 0.15 ? "mildly_bull" :
                   weightedScore <= -0.5 ? "strongly_bear" : weightedScore <= -0.3 ? "bear" : weightedScore <= -0.15 ? "mildly_bear" : "neutral";
    const biasLabel = { strongly_bull:"STRONGLY BULLISH", bull:"BULLISH", mildly_bull:"MILDLY BULLISH",
                        neutral:"MIXED / NEUTRAL", mildly_bear:"MILDLY BEARISH", bear:"BEARISH", strongly_bear:"STRONGLY BEARISH" }[signal];
    const metaScore = { weights, weightedScore, signal, biasLabel, rationale: metaRaw.rationale||"" };

    // ── Step 4: Validate before saving ──
    // Only save if at least 3 of 4 cards have real summaries (not error states)
    const validCards = Object.values(results).filter(r =>
      r && r.summary && !r.summary.includes("Error") && r.summary.length > 20
    ).length;

    if (validCards < 3) {
      console.log("Scheduler: only", validCards, "/4 cards valid — NOT saving to history (partial run)");
      schedulerLog[0].status = "partial — not saved (" + validCards + "/4 cards)";
    } else {
      const etDateKey = getETNow().toLocaleDateString('en-CA', {timeZone:'America/New_York'});
      const snapshot = { results, metaScore, regime: activeRegime, runAt: new Date().toISOString(), autoRun: true };
      const history = loadHistory();
      history[etDateKey] = snapshot;
      saveHistory(history);
      console.log("Scheduler: saved to history key:", etDateKey, "(", validCards, "/4 cards valid)");
    }

    schedulerLog[0].status = "complete";
    schedulerLog[0].bias = biasLabel;
    schedulerLog[0].date = etDateKey;
    console.log("Scheduler: auto-analysis complete —", biasLabel, "| saved to history:", etDateKey);

  } catch(e) {
    console.error("Scheduler: auto-analysis error:", e.message);
    if (schedulerLog[0]) schedulerLog[0].status = "error: " + e.message.slice(0,50);
  } finally {
    schedulerRunning = false; // always release lock, even on error
    console.log("Scheduler: lock released");
  }

  // Schedule next run (timer singleton prevents duplicates)
  scheduleNextRun();
}

function scheduleNextRun() {
  // Clear any existing timer to prevent duplicates
  if (scheduleNextRunTimer) {
    clearTimeout(scheduleNextRunTimer);
    scheduleNextRunTimer = null;
  }

  const ms = msUntilNextSchedule();

  if (ms === null) {
    // All times passed today — schedule check for tomorrow 7:25am ET
    const etNow = getETNow();
    const tomorrow = new Date(etNow);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(7, 25, 0, 0); // 7:25am ET tomorrow

    // Calculate ms from NOW (Date.now()) to tomorrow 7:25am ET
    // Convert ET time back to UTC for comparison
    const tomorrowUTC = new Date(tomorrow.toLocaleString("en-US", {timeZone:"UTC"}));
    const etOffset = etNow.getTime() - new Date(etNow.toLocaleString("en-US", {timeZone:"UTC"})).getTime();
    const msToTomorrow = tomorrow.getTime() + etOffset - Date.now();

    // Safety: never set a timer less than 1 minute to avoid rapid loops
    const safeMs = Math.max(msToTomorrow, 60000);
    console.log("Scheduler: no more runs today — next check in", Math.round(safeMs/1000/60), "min");
    scheduleNextRunTimer = setTimeout(scheduleNextRun, safeMs);
    return;
  }

  // Safety: never fire in less than 30 seconds
  const safeMs = Math.max(ms, 30000);
  const nextET = new Date(Date.now() + safeMs);
  console.log("Scheduler: next run at", nextET.toLocaleTimeString("en-US", {timeZone:"America/New_York"}), "ET (in", Math.round(safeMs/1000/60), "min)");

  scheduleNextRunTimer = setTimeout(function() {
    scheduleNextRunTimer = null;
    if (schedulerEnabled) runScheduledAnalysis();
    else scheduleNextRun();
  }, safeMs);
}

// Toggle endpoint
app.post("/api/scheduler/toggle", function(req, res) {
  schedulerEnabled = !schedulerEnabled;
  console.log("Scheduler:", schedulerEnabled ? "ENABLED" : "DISABLED");
  res.json({ enabled: schedulerEnabled, nextRun: schedulerNextRun, log: schedulerLog.slice(0,3) });
});

app.get("/api/scheduler/status", function(req, res) {
  res.json({
    enabled:  schedulerEnabled,
    running:  schedulerRunning,
    lastRun:  schedulerLastRun,
    nextRun:  schedulerNextRun,
    log:      schedulerLog.slice(0,5)
  });
});

// Start scheduling on server boot — small delay to let server fully initialize
setTimeout(scheduleNextRun, 5000);

app.get("/health", function(req, res) {
  res.json({ status: "ok", apiKeySet: !!process.env.ANTHROPIC_API_KEY });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log("Morning brief server running on port " + PORT); });
