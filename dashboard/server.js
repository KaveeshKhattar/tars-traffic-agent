// dashboard/server.js
// Tiny Express server that:
// 1. Receives events from agent.js via POST /event
// 2. Streams them to the browser via SSE GET /stream
// 3. Serves the dashboard HTML at GET /

import express from "express";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

const PORT = 3000;
let clients = [];
let eventHistory = [];

// Reset on each agent run
app.post("/reset", (req, res) => {
  eventHistory = [];
  clients.forEach(c => c.res.write(`data: ${JSON.stringify({ type: "reset" })}\n\n`));
  res.json({ ok: true });
});

// Agent pushes events here
app.post("/event", (req, res) => {
  const event = { ...req.body, ts: Date.now() };
  eventHistory.push(event);
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  clients.forEach(c => c.res.write(payload));
  res.json({ ok: true });
});

// Browser subscribes here
app.get("/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");

  // Replay history to new subscriber
  eventHistory.forEach(e => res.write(`data: ${JSON.stringify(e)}\n\n`));

  const client = { id: Date.now(), res };
  clients.push(client);
  req.on("close", () => { clients = clients.filter(c => c.id !== client.id); });
});

// Serve dashboard
app.get("/", (req, res) => {
  res.sendFile(join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
});