const express = require("express");
const cors = require("cors");
const path = require("path");
const https = require("https");
const app = express();

app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── Generic HTTP GET ──────────────────────────────────────────
function fetchUrl(url, extraHeaders) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? require("https") : require("http");
    const headers = Object.assign({
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      "Accept": "text/html,application/json,*/*",
      "Accept-Language": "en-US,en;q=0.9"
    }, extraHeaders || {});

    const req = mod.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, extraHeaders).then(resolve).catch(reject);
      }
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

// ── Strip HTML to plain text ──────────────────────────────────
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ").trim()
    .slice(0, 2500);
}

// ── ECON: ForexFactory USD calendar ──────────────────────────
async function fetchEcon() {
  const html = await fetchUrl("https://www.forexfactory.com/calendar");
  return stripHtml(html);
}

// ── EARNINGS: Nasdaq public API ───────────────────────────────
async function fetchEarnings() {
  const today = new Date().toISOString().slice(0, 10);
  const url = "https://api.nasdaq.com/api/calendar/earnings?date=" + today;
  const raw = await fetchUrl(url, {
    "Origin": "https://www.nasdaq.com",
    "Referer": "https://www.nasdaq.com/"
  });
  try {
    const json = JSON.parse(raw);
    const rows = (json && json.data && json.data.rows) ? json.data.rows : [];
    if (rows.length === 0) return "No earnings reported today.";
    const summary = rows.slice(0, 25).map(function(r) {
      return r.symbol + " | Est: " + r.epsForecast + " | Act: " + (r.eps || "TBD") + " | " + r.time;
    }).join("\n");
    return summary;
  } catch(e) {
    return stripHtml(raw);
  }
}

// ── PREMARKET: CNBC world markets ────────────────────────────
async function fetchPremarket() {
  const html = await fetchUrl("https://www.cnbc.com/world/?region=world");
  return stripHtml(html);
}

// ── NEWS: CNBC markets ────────────────────────────────────────
async function fetchNews() {
  const html = await fetchUrl("https://www.cnbc.com/markets/");
  return stripHtml(html);
}

// ── Claude API call ───────────────────────────────────────────
function callClaude(prompt, data) {
  return new Promise((resolve, reject) => {
    const today = new Date().toLocaleDateString("en-US", {
      weekday: "long", year: "numeric", month: "long", day: "numeric"
    });
    const payload = JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system: "You are a futures trader morning briefing assistant. Today is " + today + ". CRITICAL: Reply with ONLY raw JSON, no markdown, no backticks: {\"signal\":\"bull\",\"summary\":\"2 sentence summary\",\"score\":1} — signal: bull|bear|neutral, score: 1|-1|0",
      messages: [{ role: "user", content: prompt + "\n\nDATA:\n" + data }]
    });

    const options = {
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      }
    };

    const req = https.request(options, function(res) {
      let raw = "";
      res.on("data", function(c) { raw += c; });
      res.on("end", function() {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.error) return reject(new Error(parsed.error.message));
          const text = (parsed.content || []).filter(function(b) { return b.type === "text"; }).map(function(b) { return b.text; }).join("").trim();
          const clean = text.replace(/```json|```/g, "").trim();
          resolve(JSON.parse(clean));
        } catch(e) {
          reject(new Error("Parse error: " + e.message));
        }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ── Main endpoint ─────────────────────────────────────────────
app.post("/api/analyze", async function(req, res) {
  const topic = req.body && req.body.topic;
  if (!topic) return res.status(400).json({ error: "No topic" });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "API key not set" });

  console.log("Analyzing:", topic);

  try {
    var rawData, prompt;

    if (topic === "econ") {
      rawData = await fetchEcon();
      prompt = "From this ForexFactory calendar, identify today's USD economic reports and their impact. Any beats or misses vs forecast? Score bull if risk-on surprises, bear if risk-off surprises, neutral if nothing major.";
    } else if (topic === "earn") {
      rawData = await fetchEarnings();
      prompt = "From this Nasdaq earnings data (symbol | EPS estimate | EPS actual | time), identify major S&P500/Nasdaq companies. Beats or misses? Score bull if beats dominate, bear if misses dominate, neutral if mixed or no reports.";
    } else if (topic === "premarket") {
      rawData = await fetchPremarket();
      prompt = "From this CNBC data, extract Asia and Europe overnight performance and US futures (NQ, ES, DOW). Score bull if majority green, bear if majority red, neutral if mixed.";
    } else if (topic === "news") {
      rawData = await fetchNews();
      prompt = "From this CNBC markets page, identify the top 2-3 market-moving stories for US index futures. Score bull if risk-on, bear if risk-off, neutral if mixed.";
    } else {
      return res.status(400).json({ error: "Unknown topic" });
    }

    console.log("Data length:", rawData.length);
    const result = await callClaude(prompt, rawData);
    console.log("Result:", JSON.stringify(result));
    res.json(result);

  } catch(e) {
    console.error("Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/health", function(req, res) {
  res.json({ status: "ok", apiKeySet: !!process.env.ANTHROPIC_API_KEY });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log("Morning brief server running on port " + PORT);
});
