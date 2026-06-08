# TARS — Autonomous Inference Traffic Agent
**Tetrate AI Buildathon 2026**

Most AI gateways react to thresholds. This one reasons.

When latency spikes, a rule fires, but a cold backend and an overloaded one look identical on a single metric. TARS reads multiple signals together, diagnoses *why* traffic is degrading, and reroutes with a plain-English explanation of every decision. It also remembers past incidents, so it gets faster at recognizing patterns it's seen before.

---

## Quick start

**Terminal 1 — traffic simulator**

```bash
cd simulator
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python simulator.py
```

**Terminal 2 — TARS agent**

```bash
npm install
export TARS_API_KEY=sk-your-key-here   # router.tetrate.ai → API Keys
node agent.js
```

Or: `npm run simulator` in one terminal, `npm start` in another.

---

## What you'll see

| Cycle | Scenario | What the agent does |
|-------|----------|---------------------|
| 1 | Healthy | Reads metrics → all clear → logs NO_ACTION |
| 2 | Cold start | Latency high, errors low, queue empty → diagnoses cold start → warms backend → writes to memory |
| 3 | Cold start (repeat) | Recognises pattern from memory → acts faster → references past incident |
| 4 | True overload | Latency high, errors high, queue deep → correctly sheds load → explains why this is different from cycle 2 |

---

## Why not just a bash script?

A threshold rule gives one answer to "latency is high." This agent reads three signals simultaneously:

- **High latency + low errors + empty queue** → cold start → warm the backend
- **High latency + high errors + deep queue** → overload → shed load

Same surface symptom. Different root cause. Different correct response. A script cannot make this distinction without a hand-written decision tree that someone has to maintain. The LLM reads the signal combination and reasons to the right answer.

---

## Architecture

```
simulator/     →   Python mock gateway + load generator + /metrics API (port 9090)
tools.js       →   get_metrics (live fetch), patch_routing, audit_log, remember_incident
memory.js      →   append-only MEMORY.md, read at start of every cycle
agent.js       →   TARS loop: call model → run tools → feed back → repeat
scenarios.js   →   legacy static snapshots (unused when simulator is running)
```

Each demo cycle activates a traffic pattern on the simulator (`healthy`, `cold_start`, `overload`), waits ~8s for correlated metrics to accumulate, then the agent reads live p95 latency, error rate, and queue depth from real request samples — not hardcoded numbers.

**Model strategy:** `claude-haiku-4-5` for every triage cycle (fast, cheap). `claude-sonnet-4-6` as fallback on 429/5xx. Both via TARS — one endpoint, one key, model is a single string swap.

**Hardening:** MAX_TURNS = 8, fallback model, structured errors from every tool so the agent can recover without crashing.

---

## Replacing simulated tools with real infrastructure

The simulator already matches the production shape: `get_metrics()` reads a metrics endpoint, `patch_routing()` pushes weight changes back. To go live:

```js
// get_metrics → fetch from Prometheus
GET /api/v1/query?query=histogram_quantile(0.95, rate(envoy_request_duration_ms_bucket[60s]))

// patch_routing → k8s client PATCH on LLMRoutingRule CRD
kubectl patch llmroutingrule inference-router --type=merge --patch '{...}'
```

The agent loop in `agent.js` is identical either way.

---

## Repo structure

```
tars-traffic-agent/
├── agent.js       # main loop
├── tools.js       # tool implementations + definitions
├── scenarios.js   # legacy static snapshots
├── simulator/
│   ├── simulator.py
│   └── requirements.txt
├── memory.js      # cross-run incident memory
├── MEMORY.md      # starts empty, agent writes here
├── package.json
└── README.md
```