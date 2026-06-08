// scenarios.js
// LEGACY: static metric snapshots (pre-simulator demo).
// Live traffic now comes from simulator/simulator.py — see tools.js get_metrics().

export const SCENARIOS = {
    healthy: {
      p95_latency_ms:  780,
      error_rate_pct:  0.3,
      queue_depth:     3,
      tokens_per_sec:  420,
      backends: [
        { name: "claude-haiku-4-5",  weight: 70 },
        { name: "claude-sonnet-4-6", weight: 30 },
      ],
    },
  
    // High latency — but errors are clean and queue is empty.
    // Looks like overload on one metric. It's actually a cold backend.
    // Wrong response: shed load. Right response: warm it.
    cold_start: {
      p95_latency_ms:  2900,
      error_rate_pct:  0.5,
      queue_depth:     2,
      tokens_per_sec:  95,
      backends: [
        { name: "claude-haiku-4-5",  weight: 70 },
        { name: "claude-sonnet-4-6", weight: 30 },
      ],
    },
  
    // High latency AND high errors AND deep queue.
    // Genuine overload — shed load to haiku.
    overload: {
      p95_latency_ms:  3400,
      error_rate_pct:  9.2,
      queue_depth:     47,
      tokens_per_sec:  1820,
      backends: [
        { name: "claude-haiku-4-5",  weight: 70 },
        { name: "claude-sonnet-4-6", weight: 30 },
      ],
    },
  };