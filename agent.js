// agent.js
// TARS — Autonomous Inference Traffic Agent
// Tetrate AI Buildathon 2026

import OpenAI from "openai";
import { recallMemory } from "./memory.js";
import { TOOLS, TOOL_HANDLERS, getAuditLog, waitForSimulator, SIMULATOR_URL } from "./tools.js";

// ── Config ────────────────────────────────────────────────────────────────────

const TARS_API_KEY = process.env.TARS_API_KEY;
if (!TARS_API_KEY) {
  console.error("❌  Missing TARS_API_KEY. Get one at router.tetrate.ai → API Keys");
  process.exit(1);
}

const client = new OpenAI({
  baseURL: "https://api.router.tetrate.ai/v1",
  apiKey:  TARS_API_KEY,
});

const TRIAGE_MODEL  = "claude-haiku-4-5";
const FALLBACK_MODEL = "claude-sonnet-4-6";
const MAX_TURNS     = 8;

// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt() {
  return `You are TARS — an autonomous inference traffic management agent.
You observe telemetry signals and make routing decisions for an AI gateway.

## Past incidents you remember:
${recallMemory()}

## Your loop every cycle:
1. Call get_metrics with the provided scenario (live traffic simulator — metrics are real samples, not static snapshots).
2. Diagnose by reading ALL three signals together — not just latency:
   - High latency + LOW errors + LOW queue = cold start → WARM the backend (send a small amount of traffic to it, do not shed)
   - High latency + HIGH errors + HIGH queue = overload → SHED load to claude-haiku-4-5
   - All signals normal = healthy → NO_ACTION
3. If action needed: call patch_routing with updated weights (must sum to 100).
4. Always call audit_log at the end with your action and 2–3 sentence rationale.
5. If you took action: call remember_incident so you recognize this pattern next time.
6. Respond with one line: the diagnosis and what you did.

## Hard rules:
- Never call patch_routing without first reading metrics.
- Never skip audit_log.
- Weights must always sum to exactly 100.
- If you see a pattern in your memory, reference it explicitly in your rationale.`;
}

// ── Agent loop ────────────────────────────────────────────────────────────────

async function runCycle(scenario, cycleNumber) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`🔄 CYCLE ${cycleNumber} — scenario: ${scenario}`);
  console.log(`${"═".repeat(60)}`);

  const messages = [
    { role: "system", content: buildSystemPrompt() },
    { role: "user",   content: `Run one observation cycle for scenario: ${scenario}` },
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    console.log(`\n  ── turn ${turn + 1}`);

    // Call model with fallback
    let msg;
    try {
      const resp = await client.chat.completions.create({
        model:  TRIAGE_MODEL,
        messages,
        tools:  TOOLS,
        tool_choice: "auto",
      });
      msg = resp.choices[0].message;
    } catch (err) {
      console.warn(`  ⚠️  Primary model failed (${err.message}), falling back...`);
      const resp = await client.chat.completions.create({
        model:  FALLBACK_MODEL,
        messages,
        tools:  TOOLS,
        tool_choice: "auto",
      });
      msg = resp.choices[0].message;
    }

    messages.push(msg);

    // Final answer — no more tool calls
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      console.log(`\n  ✅ ${msg.content}`);
      return msg.content;
    }

    // Run each tool
    for (const call of msg.tool_calls) {
      const name = call.function.name;
      let args = {};
      try { args = JSON.parse(call.function.arguments); } catch { /* empty args */ }

      console.log(`\n  🔧 ${name}(${JSON.stringify(args)})`);

      let result;
      try {
        const handler = TOOL_HANDLERS[name];
        if (!handler) throw new Error(`Unknown tool: ${name}`);
        result = await handler(args);
      } catch (err) {
        result = { error: "tool_failed", message: err.message };
      }

      console.log(`     → ${JSON.stringify(result)}`);

      messages.push({
        role:        "tool",
        tool_call_id: call.id,
        content:     JSON.stringify(result),
      });
    }
  }

  return "Stopped: MAX_TURNS reached.";
}

// ── Demo: four cycles showing the happy path ──────────────────────────────────

async function main() {
  console.log("🚀 TARS — Autonomous Inference Traffic Agent");
  console.log("   Tetrate AI Buildathon 2026\n");

  console.log(`⏳ Waiting for traffic simulator at ${SIMULATOR_URL} ...`);
  if (!(await waitForSimulator())) {
    console.error("❌  Simulator not running. Start it in another terminal:");
    console.error("    cd simulator && pip install -r requirements.txt && python simulator.py");
    process.exit(1);
  }
  console.log("✅ Simulator ready\n");

  // Cycle 1: healthy — agent should do nothing
  await runCycle("healthy", 1);

  // Cycle 2: cold start — agent should WARM, not shed
  await runCycle("cold_start", 2);

  // Cycle 3: cold start again — agent should recognise pattern from memory
  await runCycle("cold_start", 3);

  // Cycle 4: true overload — agent should shed load, explain why different from cycle 2
  await runCycle("overload", 4);

  // Print full audit log at the end
  console.log(`\n${"═".repeat(60)}`);
  console.log("📋 FULL AUDIT LOG:");
  console.log(JSON.stringify(getAuditLog(), null, 2));
}

main().catch(console.error);