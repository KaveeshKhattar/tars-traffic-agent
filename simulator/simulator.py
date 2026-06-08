#!/usr/bin/env python3
"""
Live traffic simulator for TARS demo.

Mock inference gateway + async load generator + rolling metrics window.
Run: python simulator.py
Then: node agent.js (reads http://localhost:9090/metrics)
"""

from __future__ import annotations

import asyncio
import json
import math
import random
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Deque, Literal

from aiohttp import web

Scenario = Literal["healthy", "cold_start", "overload"]
PORT = 9090
WINDOW_SECONDS = 60

SCENARIO_CONFIG: dict[Scenario, dict] = {
    "healthy": {"rps": 10, "workers": 22, "max_queue": 60, "cold_sonnet": False},
    "cold_start": {"rps": 10, "workers": 22, "max_queue": 60, "cold_sonnet": True},
    "overload": {"rps": 45, "workers": 6, "max_queue": 55, "cold_sonnet": False},
}


@dataclass
class MetricEvent:
    ts: float
    latency_ms: float
    error: bool
    tokens: int
    queue_depth: int


class MetricsCollector:
    def __init__(self, window_seconds: int = WINDOW_SECONDS) -> None:
        self.window_seconds = window_seconds
        self.events: Deque[MetricEvent] = deque()
        self.current_queue = 0

    def prune(self, now: float | None = None) -> None:
        now = now or time.time()
        cutoff = now - self.window_seconds
        while self.events and self.events[0].ts < cutoff:
            self.events.popleft()

    def record(self, latency_ms: float, error: bool, tokens: int, queue_depth: int) -> None:
        now = time.time()
        self.events.append(MetricEvent(now, latency_ms, error, tokens, queue_depth))
        self.prune(now)

    def snapshot(self) -> dict:
        now = time.time()
        self.prune(now)
        if not self.events:
            return {
                "window_seconds": self.window_seconds,
                "p95_latency_ms": 0,
                "error_rate_pct": 0.0,
                "queue_depth": self.current_queue,
                "tokens_per_sec": 0,
                "sample_count": 0,
            }

        latencies = sorted(e.latency_ms for e in self.events if not e.error)
        errors = sum(1 for e in self.events if e.error)
        total = len(self.events)
        tokens = sum(e.tokens for e in self.events)
        span = max(self.events[-1].ts - self.events[0].ts, 1.0)

        if latencies:
            idx = min(int(math.ceil(0.95 * len(latencies))) - 1, len(latencies) - 1)
            p95 = latencies[max(idx, 0)]
        else:
            p95 = 0.0

        recent_queues = [e.queue_depth for e in self.events]
        avg_queue = sum(recent_queues) / len(recent_queues)

        return {
            "window_seconds": self.window_seconds,
            "p95_latency_ms": round(p95),
            "error_rate_pct": round(100.0 * errors / total, 1),
            "queue_depth": round(avg_queue),
            "tokens_per_sec": round(tokens / span),
            "sample_count": total,
        }


@dataclass
class Backend:
    name: str
    warm_latency_ms: float
    cold_latency_ms: float
    warm: bool = True
    warm_progress: int = 0
    warm_threshold: int = 18

    def reset_cold(self) -> None:
        self.warm = False
        self.warm_progress = 0

    async def infer(self) -> tuple[float, int]:
        if self.warm:
            latency = random.gauss(self.warm_latency_ms, self.warm_latency_ms * 0.08)
        else:
            latency = random.gauss(self.cold_latency_ms, self.cold_latency_ms * 0.07)
            self.warm_progress += 1
            if self.warm_progress >= self.warm_threshold:
                self.warm = True

        latency = max(latency, 50)
        await asyncio.sleep(latency / 1000.0)
        tokens = random.randint(80, 180)
        return latency, tokens


@dataclass
class GatewayState:
    metrics: MetricsCollector = field(default_factory=MetricsCollector)
    backends: dict[str, Backend] = field(default_factory=dict)
    routing: dict[str, int] = field(default_factory=lambda: {
        "claude-haiku-4-5": 70,
        "claude-sonnet-4-6": 30,
    })
    scenario: Scenario = "healthy"
    rps: float = 10.0
    workers: int = 22
    max_queue: int = 60
    load_task: asyncio.Task | None = None
    stop_load: asyncio.Event = field(default_factory=asyncio.Event)
    sem: asyncio.Semaphore | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    generation: int = 0

    def __post_init__(self) -> None:
        self.backends = {
            "claude-haiku-4-5": Backend("claude-haiku-4-5", warm_latency_ms=620, cold_latency_ms=620),
            "claude-sonnet-4-6": Backend("claude-sonnet-4-6", warm_latency_ms=980, cold_latency_ms=2900),
        }
        self.sem = asyncio.Semaphore(self.workers)

    def pick_backend(self) -> str:
        roll = random.uniform(0, 100)
        cumulative = 0.0
        for name, weight in self.routing.items():
            cumulative += weight
            if roll <= cumulative:
                return name
        return "claude-haiku-4-5"

    async def handle_inference(self) -> None:
        gen = self.generation

        async with self.lock:
            if gen != self.generation:
                return
            queue_depth = self.metrics.current_queue
            if queue_depth >= self.max_queue:
                self.metrics.record(0, error=True, tokens=0, queue_depth=queue_depth)
                return
            self.metrics.current_queue += 1
            queue_at_entry = self.metrics.current_queue

        wait_start = time.time()
        try:
            async with self.sem:
                if gen != self.generation:
                    return
                wait_ms = (time.time() - wait_start) * 1000.0
                backend_name = self.pick_backend()
                backend = self.backends[backend_name]
                latency, tokens = await backend.infer()
                if gen != self.generation:
                    return
                total_ms = wait_ms + latency
                self.metrics.record(total_ms, error=False, tokens=tokens, queue_depth=queue_at_entry)
        except Exception:
            if gen == self.generation:
                self.metrics.record(0, error=True, tokens=0, queue_depth=queue_at_entry)
        finally:
            async with self.lock:
                if gen == self.generation:
                    self.metrics.current_queue = max(0, self.metrics.current_queue - 1)

    async def load_loop(self) -> None:
        while not self.stop_load.is_set():
            interval = 1.0 / max(self.rps, 0.1)
            asyncio.create_task(self.handle_inference())
            try:
                await asyncio.wait_for(self.stop_load.wait(), timeout=interval)
                break
            except asyncio.TimeoutError:
                continue

    async def apply_scenario(self, scenario: Scenario) -> None:
        cfg = SCENARIO_CONFIG[scenario]
        async with self.lock:
            self.generation += 1
            await self._stop_load()
            self.scenario = scenario
            self.rps = cfg["rps"]
            self.workers = cfg["workers"]
            self.max_queue = cfg["max_queue"]
            self.sem = asyncio.Semaphore(self.workers)

            if cfg["cold_sonnet"]:
                self.backends["claude-sonnet-4-6"].reset_cold()
            else:
                self.backends["claude-sonnet-4-6"].warm = True
                self.backends["claude-sonnet-4-6"].warm_progress = self.backends["claude-sonnet-4-6"].warm_threshold

            self.metrics = MetricsCollector()
            self.stop_load = asyncio.Event()
            self.load_task = asyncio.create_task(self.load_loop())

    async def apply_routing(self, weights: dict[str, int]) -> None:
        async with self.lock:
            self.routing = dict(weights)

    async def _stop_load(self) -> None:
        if self.load_task and not self.load_task.done():
            self.stop_load.set()
            await self.load_task
        self.load_task = None


state = GatewayState()


async def post_scenario(request: web.Request) -> web.Response:
    body = await request.json()
    scenario = body.get("scenario")
    if scenario not in SCENARIO_CONFIG:
        return web.json_response(
            {"error": "unknown_scenario", "valid": list(SCENARIO_CONFIG)},
            status=400,
        )
    await state.apply_scenario(scenario)
    return web.json_response({"ok": True, "scenario": scenario})


async def post_routing(request: web.Request) -> web.Response:
    body = await request.json()
    backends = body.get("backends", [])
    total = sum(b.get("weight", 0) for b in backends)
    if total != 100:
        return web.json_response(
            {"error": "invalid_weights", "message": f"Weights must sum to 100, got {total}"},
            status=400,
        )
    weights = {b["name"]: b["weight"] for b in backends}
    await state.apply_routing(weights)
    return web.json_response({"ok": True, "routing": weights})


async def get_metrics(request: web.Request) -> web.Response:
    snap = state.metrics.snapshot()
    snap["scenario"] = state.scenario
    snap["backends"] = [
        {"name": name, "weight": weight, "warm": state.backends[name].warm}
        for name, weight in state.routing.items()
    ]
    return web.json_response(snap)


async def post_infer(request: web.Request) -> web.Response:
    """Optional manual probe — load gen uses internal loop instead."""
    await state.handle_inference()
    return web.json_response({"ok": True})


async def get_health(request: web.Request) -> web.Response:
    return web.json_response({"status": "ok", "scenario": state.scenario})


async def on_startup(app: web.Application) -> None:
    await state.apply_scenario("healthy")


async def on_cleanup(app: web.Application) -> None:
    await state._stop_load()


def main() -> None:
    app = web.Application()
    app.router.add_get("/health", get_health)
    app.router.add_get("/metrics", get_metrics)
    app.router.add_post("/control/scenario", post_scenario)
    app.router.add_post("/control/routing", post_routing)
    app.router.add_post("/v1/chat/completions", post_infer)
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)

    print(f"🚦 TARS traffic simulator listening on http://localhost:{PORT}")
    print("   GET  /metrics")
    print("   POST /control/scenario  { \"scenario\": \"healthy|cold_start|overload\" }")
    print("   POST /control/routing   { \"backends\": [{\"name\": \"...\", \"weight\": 70}] }")
    web.run_app(app, host="127.0.0.1", port=PORT, print=None)


if __name__ == "__main__":
    main()
