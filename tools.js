// tools.js
// The three tools the agent can call, plus remember_incident for memory.
//
// Metrics: live from Python simulator (simulator/simulator.py)
// Production: replace get_metrics() with Prometheus, patch_routing() with k8s PATCH

import { rememberIncident } from "./memory.js";

export const SIMULATOR_URL = process.env.SIMULATOR_URL ?? "http://127.0.0.1:9090";
const METRICS_WARMUP_MS = Number(process.env.METRICS_WARMUP_MS ?? 8000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Shared routing state — patch_routing mutates this and syncs to simulator
export const ROUTING_STATE = {
  backends: [
    { name: "claude-haiku-4-5",  weight: 70 },
    { name: "claude-sonnet-4-6", weight: 30 },
  ],
};

async function syncRoutingToSimulator(backends) {
  try {
    await fetch(`${SIMULATOR_URL}/control/routing`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ backends }),
    });
  } catch {
    // Simulator may be offline during static fallback tests
  }
}

// ── Tool: get_metrics ─────────────────────────────────────────────────────────

export async function get_metrics({ scenario }) {
  const valid = ["healthy", "cold_start", "overload"];
  if (!valid.includes(scenario)) {
    return { error: "unknown_scenario", message: `Valid scenarios: ${valid.join(", ")}` };
  }

  let scenarioResp;
  try {
    scenarioResp = await fetch(`${SIMULATOR_URL}/control/scenario`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ scenario }),
    });
  } catch (err) {
    return {
      error:   "simulator_unreachable",
      message: `Start the simulator first: cd simulator && pip install -r requirements.txt && python simulator.py (${err.message})`,
    };
  }

  if (!scenarioResp.ok) {
    const body = await scenarioResp.text();
    return { error: "scenario_failed", message: body };
  }

  // Let load generator produce correlated metrics in the rolling window
  await sleep(METRICS_WARMUP_MS);

  let metricsResp;
  try {
    metricsResp = await fetch(`${SIMULATOR_URL}/metrics`);
  } catch (err) {
    return { error: "metrics_fetch_failed", message: err.message };
  }

  if (!metricsResp.ok) {
    return { error: "metrics_fetch_failed", message: await metricsResp.text() };
  }

  const live = await metricsResp.json();
  return {
    window_seconds:  live.window_seconds,
    p95_latency_ms:  live.p95_latency_ms,
    error_rate_pct:  live.error_rate_pct,
    queue_depth:     live.queue_depth,
    tokens_per_sec:  live.tokens_per_sec,
    sample_count:    live.sample_count,
    scenario:        live.scenario,
    backends:        ROUTING_STATE.backends.map(b => ({ ...b })),
    source:          "live_simulator",
  };
}

// ── Tool: patch_routing ───────────────────────────────────────────────────────

export async function patch_routing({ backends }) {
  const total = backends.reduce((sum, b) => sum + b.weight, 0);
  if (total !== 100) {
    return {
      error:   "invalid_weights",
      message: `Weights must sum to 100, got ${total}. Adjust and retry.`,
    };
  }

  const before = ROUTING_STATE.backends.map(b => ({ ...b }));
  ROUTING_STATE.backends = backends.map(b => ({ ...b }));

  let simResult = null;
  try {
    const resp = await fetch(`${SIMULATOR_URL}/control/routing`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ backends }),
    });
    simResult = resp.ok ? await resp.json() : { error: await resp.text() };
  } catch (err) {
    simResult = { warning: "simulator_unreachable", message: err.message };
  }

  return {
    success: true,
    diff:    { before, after: backends },
    message: "LLMRoutingRule patched successfully.",
    simulator: simResult,
  };
}

// ── Tool: audit_log ───────────────────────────────────────────────────────────

const AUDIT_ENTRIES = [];

export function audit_log({ action, rationale, metrics_snapshot }) {
  const entry = {
    timestamp:        new Date().toISOString(),
    action,
    rationale,
    metrics_snapshot: metrics_snapshot ?? null,
  };
  AUDIT_ENTRIES.push(entry);
  return { logged: true };
}

export function getAuditLog() {
  return AUDIT_ENTRIES;
}

// ── Tool: remember_incident ───────────────────────────────────────────────────

export function remember_incident({ pattern, action, outcome }) {
  return rememberIncident({ pattern, action, outcome });
}

// ── Tool definitions (handed to the model) ────────────────────────────────────

export const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_metrics",
      description:
        "Fetch live inference traffic telemetry for the last 60 seconds from the running gateway simulator. " +
        "Starts the requested traffic scenario, waits for metrics to accumulate, then returns p95 latency (ms), " +
        "error rate (%), queue depth, tokens/sec, and current backend weights. " +
        "Always call this first before making any routing decision.",
      parameters: {
        type: "object",
        properties: {
          scenario: {
            type: "string",
            enum: ["healthy", "cold_start", "overload"],
            description: "Traffic pattern to activate before reading metrics.",
          },
        },
        required: ["scenario"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "patch_routing",
      description:
        "Update LLMRoutingRule backend weights. " +
        "Use when rebalancing is needed. Weights must sum to exactly 100. " +
        "Prefer shifting load to claude-haiku-4-5 under high load (faster, higher throughput). " +
        "To warm a cold backend, shift traffic toward claude-sonnet-4-6. " +
        "Never call this without first reading metrics.",
      parameters: {
        type: "object",
        properties: {
          backends: {
            type: "array",
            description: "New weight distribution. Must sum to 100.",
            items: {
              type: "object",
              properties: {
                name:   { type: "string",  description: "Backend model name" },
                weight: { type: "number",  description: "Traffic weight 0–100" },
              },
              required: ["name", "weight"],
            },
          },
        },
        required: ["backends"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "audit_log",
      description:
        "Write a human-readable audit entry for this cycle. " +
        "Always call at the end of every cycle — even if no action was taken.",
      parameters: {
        type: "object",
        properties: {
          action:           { type: "string", description: "One line: what happened, or NO_ACTION." },
          rationale:        { type: "string", description: "2–3 sentences: why you did or didn't act." },
          metrics_snapshot: { type: "object", description: "Key metrics that drove the decision." },
        },
        required: ["action", "rationale"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remember_incident",
      description:
        "Persist a one-line memory of this incident for future cycles. " +
        "Call after any routing patch so the agent can recognize this pattern next time.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Short description of the signal pattern observed." },
          action:  { type: "string", description: "What action was taken." },
          outcome: { type: "string", description: "Expected or observed outcome." },
        },
        required: ["pattern", "action", "outcome"],
      },
    },
  },
];

export const TOOL_HANDLERS = {
  get_metrics,
  patch_routing,
  audit_log,
  remember_incident,
};

export async function waitForSimulator(maxAttempts = 40) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const resp = await fetch(`${SIMULATOR_URL}/health`);
      if (resp.ok) return true;
    } catch {
      // retry
    }
    await sleep(500);
  }
  return false;
}
