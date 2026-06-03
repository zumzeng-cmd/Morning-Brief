const express = require("express");
const cors = require("cors");
const path = require("path");
const app = express();

app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Proxy endpoint — frontend calls this, server calls Anthropic with the API key
app.post("/api/analyze", async (req, res) => {
  const { prompt, topic } = req.body;
  if (!prompt) return res.status(400).json({ error: "No prompt" });

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        system: `You are a futures trader's morning briefing assistant.
Analyze the given topic and return ONLY a JSON object with NO markdown, NO backticks, NO preamble.
Format: {"signal":"bull"|"bear"|"neutral","summary":"2-3 sentence plain English summary","score":1|-1|0}
Be direct and specific. Focus on NQ/ES futures impact. Today's date: ${new Date().toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}.`,
        messages: [{ role: "user", content: prompt }]
      })
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });

    const text = data.content.filter(b => b.type === "text").map(b => b.text).join("");
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    res.json(parsed);
  } catch (e) {
    console.error("Claude API error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Morning brief server running on port ${PORT}`));
