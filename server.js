const express = require("express");
const cors = require("cors");
const path = require("path");
const https = require("https");
const app = express();

app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/analyze", (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "No prompt" });

  const today = new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

  const payload = JSON.stringify({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1000,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    system: `You are a futures trader's morning briefing assistant. Analyze the given topic and return ONLY a valid JSON object with NO markdown, NO backticks, NO preamble, NO explanation. Just the raw JSON.
Format: {"signal":"bull","summary":"your summary here","score":1}
signal must be exactly: bull, bear, or neutral
score must be exactly: 1, -1, or 0
Today's date: ${today}.`,
    messages: [{ role: "user", content: prompt }]
  });

  const options = {
    hostname: "api.anthropic.com",
    path: "/v1/messages",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "web-search-2025-03-05"
    }
  };

  const apiReq = https.request(options, (apiRes) => {
    let data = "";
    apiRes.on("data", chunk => data += chunk);
    apiRes.on("end", () => {
      try {
        const parsed = JSON.parse(data);
        if (parsed.error) return res.status(500).json({ error: parsed.error.message });
        const text = (parsed.content || []).filter(b => b.type === "text").map(b => b.text).join("");
        const clean = text.replace(/```json|```/g, "").trim();
        const result = JSON.parse(clean);
        res.json(result);
      } catch (e) {
        console.error("Parse error:", e.message, "Raw:", data.slice(0, 300));
        res.status(500).json({ error: "Parse error: " + e.message });
      }
    });
  });

  apiReq.on("error", e => {
    console.error("Request error:", e.message);
    res.status(500).json({ error: e.message });
  });

  apiReq.write(payload);
  apiReq.end();
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Morning brief server running on port ${PORT}`));
