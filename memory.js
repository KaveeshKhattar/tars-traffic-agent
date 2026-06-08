// memory.js
// Append-only incident memory. Agent reads at start of every cycle,
// writes one fact at the end. No database — just a file.

import { readFileSync, appendFileSync, writeFileSync, existsSync } from "fs";

const MEMORY_FILE = "MEMORY.md";

export function recallMemory() {
  if (!existsSync(MEMORY_FILE)) return "No past incidents recorded.";
  const contents = readFileSync(MEMORY_FILE, "utf8").trim();
  return contents || "No past incidents recorded.";
}

export function rememberIncident({ pattern, action, outcome }) {
  if (!existsSync(MEMORY_FILE)) {
    writeFileSync(MEMORY_FILE, "# Incident Memory\n");
  }
  const date = new Date().toISOString().slice(0, 10);
  const entry = `- ${date} | pattern: ${pattern} | action: ${action} | outcome: ${outcome}\n`;
  appendFileSync(MEMORY_FILE, entry);
  return { remembered: true, entry: entry.trim() };
}