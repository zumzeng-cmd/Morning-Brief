const express = require("express");
const cors = require("cors");
const path = require("path");
const https = require("https");
const app = require("express")();

const express2 = require("express");
app.use(cors({ origin: "*" }));
app.use(express2.json());
app.use(express2.static(path.join(__dirname, "public")));

// Fetch a URL and return text
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? require("https") : require("http");
    const req = mod.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9"
      }
    }, (res) => {
      // handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

// Strip HTML tags and collapse whitespace
function stripHtml(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 3000); // hard cap to stay under token limits
}

// Call Claude with a short prompt and raw text context
function callClaude(systemPrompt, userContent) {
  return new Promise((resolve, reject) => {
    const today = new Date().toLocaleDateString("en-US", { weekday:"long", year:"numeric", month:"long", day:"numeric" });
    const payload = JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system: `You are a futures trader morning briefing assistant. Today is ${today}.
CRITICAL: Reply with ONLY raw JSON, no markdown, no backticks, no explanation:
{"signal":"bull","summary":"2 sentence summary","score":1}
signal: bull | bear | neutral. score: 1 | -1 | 0`,
      messages: [{ role: "user", content: `${systemPrompt}\n\nDATA:\n${userContent}` }]
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

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          const text = (parsed.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
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

// ── ECON: ForexFactory USD only ──────────────────────────────
async function fetchEcon() {
  const html = await fetchUrl("https://www.forexfactory.com/calendar");
  // Extract rows mentioning USD
  const rows = [];
  const regex = /USD[\s\S]{0,400}?(?=USD|$)/g;
  let m;
  const section = html.slice(html.indexOf("calendar__table") > 0 ? html.indexOf("calendar__table") : 0, html.indexOf("calendar__table") + 50000);
  const stripped = stripHtml(section);
  // Just send the stripped text — Claude will find USD events
  return stripped.slice(0, 2500);
}

// ── EARNINGS: Nasdaq earnings calendar (API) ─────────────────
async function fetchEarnings() {
  const today = new Date().toISOString().slice(0,10);
  // Nasdaq public API - no auth required
  const url = `https://api.nasdaq.com/api/calendar/earnings?date=${today}`;
  return new Promise((resolve, reject) => {
    const req = require("https").get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json",
        "Origin": "https://www.nasdaq.com",
        "Referer": "https://www.nasdaq.com/"
      }
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          const rows = json?.data?.rows || [];
          const summary = rows.slice(0, 20).map(r =>
            `${r.symbol} | EPS Est: ${r.epsForecast} | EPS Act: ${r.eps || "TBD"} | Time: ${r.time}`
          ).join("
");
          resolve(summary || "No earnings data available today");
        } catch(e) {
          resolve(data.slice(0, 2000));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

// ── PREMARKET: CNBC markets page ─────────────────────────────
async function fetchPremarket() {
  const html = await fetchUrl("https://www.cnbc.com/world/?region=world");
  return stripHtml(html).slice(0, 2500);
}

// ── NEWS: CNBC markets news ───────────────────────────────────
async function fetchNews() {
  const html = await fetchUrl("https://www.cnbc.com/markets/");
  return stripHtml(html).slice(0, 2500);
}

// ── Main endpoint ─────────────────────────────────────────────
app.post("/api/analyze", async (req, res) => {
  const { topic } = req.body;
  if (!topic) return res.status(400).json({ error: "No topic" });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "API key not set" });

  console.log("Analyzing topic:", topic);

  try {
    let rawData = "";
    let prompt = "";

    if (topic === "econ") {
      rawData = await fetchEcon();
      prompt = "From this ForexFactory calendar data, identify today's USD economic reports (impact level, name, actual vs forecast if released). Score bull if risk-on surprises or no major events, bear if risk-off surprises.";
    } else if (topic === "earn") {
      rawData = await fetchEarnings();
      prompt = "From this Yahoo Finance earnings calendar data, identify major S&P500/Nasdaq companies reporting today. Any big beats or misses vs EPS estimates? Score bull if beats with good guidance, bear if misses or bad guidance, neutral if mixed or no major reports.";
    } else if (topic === "premarket") {
      rawData = await fetchPremarket();
      prompt = "From this CNBC data, extract Asia and Europe market performance overnight and US futures direction (NQ, ES, DOW). Score bull if majority green, bear if majority red, neutral if mixed.";
    } else if (topic === "news") {
      rawData = await fetchNews();
      prompt = "From this CNBC markets news, identify the 2-3 most market-moving headlines for US index futures today. Score bull if risk-on, bear if risk-off, neutral if mixed.";
    } else {
      return res.status(400).json({ error: "Unknown topic" });
    }

    console.log("Fetched data length:", rawData.length);
    const result = await callClaude(prompt, rawData);
    console.log("Result:", JSON.stringify(result));
    res.json(result);

  } catch(e) {
    console.error("Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok", apiKeySet: !!process.env.ANTHROPIC_API_KEY }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Morning brief server running on port ${PORT}`));
