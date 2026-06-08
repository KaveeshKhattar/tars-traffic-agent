# TARS — Autonomous Inference Traffic Agent
**Tetrate AI Buildathon 2026**

Most AI gateways react to thresholds. This one reasons.

When latency spikes, a rule fires — but a cold backend and an overloaded one look identical on a single metric. TARS reads multiple signals together, diagnoses *why* traffic is degrading, and reroutes with a plain-English explanation of every decision. It also remembers past incidents, so it gets faster at recognizing patterns it's seen before.

---

## Quick start

```bash
git clone https://github.com/kaveeshkhattar/tars-traffic-agent
cd tars-traffic-agent
npm install
```

**Terminal 1 — live traffic simulator**
```bash
npm run simulator
```

**Terminal 2 — dashboard**
```bash
node dashboard/server.js
# open http://localhost:3000
```

**Terminal 3 — agent**
```bash
export TARS_API_KEY=sk-your-key-here   # router.tetrate.ai → API Keys
npm start
```

---

## What you'll see

| Cycle | Scenario | What the agent does |
|-------|----------|---------------------|
| 1 | Healthy | Reads live metrics → all clear → logs NO_ACTION |
| 2 | Cold start | Latency high, errors 0%, queue low → diagnoses cold start → warms backend → writes to memory |
| 3 | Cold start (repeat) | Recognises pattern from memory → references prior incident → acts faster |
| 4 | True overload | Latency high, errors 80%, queue deep → sheds load → explains why this is different from cycle 2 |

The dashboard at `http://localhost:3000` shows routing weights updating live, metrics going red/amber/green, and the agent's reasoning streaming into the audit log in real time.

---

## Why not just a bash script?

A threshold rule gives one answer to "latency is high." TARS reads three signals simultaneously:

| Signals | Diagnosis | Action |
|---------|-----------|--------|
| Latency↑, errors✓, queue✓ | Cold start | Warm the backend |
| Latency↑, errors↑, queue↑ | Overload | Shed load to haiku |
| All normal | Healthy | NO_ACTION |

Same surface symptom. Different root cause. Different correct response. A script cannot make this distinction without a hand-written decision tree. The LLM reads the signal combination and reasons to the right answer — and explains it.

---

## Architecture

```
simulator/simulator.py   →   async Python gateway, real queue/latency modelling
                              exposes /metrics, /control/scenario, /control/routing
                              on http://localhost:9090

tools.js                 →   get_metrics (reads live simulator), patch_routing
                              (syncs weights back to simulator), audit_log,
                              remember_incident

memory.js                →   append-only MEMORY.md, read at start of every cycle

agent.js                 →   TARS loop: call model → run tools → feed back → repeat
                              emits events to dashboard in real time

dashboard/server.js      →   Express SSE server, receives events from agent
dashboard/index.html     →   live UI: routing bars, metric cards, audit log stream
```

**Model strategy:** `claude-haiku-4-5` for every triage cycle (fast, cheap, 30s polling). `claude-sonnet-4-6` as fallback on 429/5xx. Both via TARS — one endpoint, one key, model is a single string swap.

**Hardening:** MAX_TURNS = 8, fallback model, structured errors from every tool, dashboard emit is fire-and-forget (agent runs fine without it).

---

## Replacing simulated tools with real infrastructure

Each tool in `tools.js` has a comment marking the drop-in point:

```js
// get_metrics → real Prometheus
GET /api/v1/query?query=histogram_quantile(0.95, rate(envoy_request_duration_ms_bucket[60s]))

// patch_routing → real Kubernetes LLMRoutingRule
kubectl patch llmroutingrule inference-router --type=merge --patch '{...}'
```

The agent loop is identical either way.

---

## Repo structure

```
tars-traffic-agent/
├── agent.js                # main loop + dashboard emit
├── tools.js                # tool implementations + schemas
├── scenarios.js            # fallback static snapshots
├── memory.js               # cross-run incident memory
├── MEMORY.md               # starts empty, agent writes here
├── simulator/
│   ├── simulator.py        # async Python mock gateway
│   └── requirements.txt
├── dashboard/
│   ├── server.js           # SSE event server
│   └── index.html          # live dashboard UI
├── package.json
└── README.md
```