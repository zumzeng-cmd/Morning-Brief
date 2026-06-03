const express = require("express");
const cors = require("cors");
const path = require("path");
const app = express();

app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/analyze", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "No prompt" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ERROR: ANTHROPIC_API_KEY is not set");
    return res.status(500).json({ error: "API key not configured" });
  }

  console.log("Calling Claude API for prompt:", prompt.slice(0, 80));

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        system: `You are a futures trader's morning briefing assistant. Analyze the given topic and return ONLY a valid JSON object with NO markdown, NO backticks, NO extra text.
Exact format: {"signal":"bull","summary":"2-3 sentence summary","score":1}
signal: bull | bear | neutral
score: 1 | -1 | 0
Today: ${today}`,
        messages: [{ role: "user", content: prompt }]
      })
    });

    console.log("Anthropic response status:", response.status);
    const data = await response.json();

    if (data.error) {
      console.error("Anthropic error:", JSON.stringify(data.error));
      return res.status(500).json({ error: data.error.message });
    }

    console.log("Response content types:", data.content?.map(b => b.type));
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    console.log("Raw text:", text.slice(0, 200));

    const clean = text.replace(/```json|```/g, "").trim();
    const result = JSON.parse(clean);
    console.log("Parsed result:", JSON.stringify(result));
    res.json(result);

  } catch (e) {
    console.error("Server error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok", apiKeySet: !!process.env.ANTHROPIC_API_KEY }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Morning brief server running on port ${PORT}`));
