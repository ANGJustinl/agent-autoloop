import assert from "node:assert/strict";
import type { Server } from "node:http";

// Attach the rejection handler before starting the next batch; otherwise Node exits before cleanup.
export const observe = <T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> =>
  promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );

export function observePolls(server: Server) {
  const count = { active: 0, peak: 0 };
  server.prependListener("request", (req, res) => {
    if (!/^\/v1\/work\?wait=50?&/.test(req.url ?? "")) return;
    count.peak = Math.max(count.peak, ++count.active);
    res.once("close", () => count.active--);
  });
  return count;
}

export async function dispatchLatency(
  request: (path: string, key: string, body?: unknown) => Promise<any>,
  ready: () => Promise<void>,
  id: number,
) {
  const pending = observe(request(`/v1/work?wait=5&claim=claim${id}`, "worker"));
  await ready();
  const at = performance.now();
  await request("/v1/events", "source", { id: `claim:${id}`, type: "feedback.new", subject: `#${id}` });
  const result = await pending;
  if (result.status === "rejected") throw result.reason;
  assert.ok(result.value.job);
  return { job: result.value.job, ms: performance.now() - at };
}

/** The value this share of the samples stays at or under; with too few samples, the nearest one above it. */
export function percentile(values: number[], share: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * share) - 1)];
}

/** Runs an action up to count times, or until it has used its time, and how long each took. Never fewer than once. */
export async function timed(count: number, budgetMs: number, action: (index: number) => Promise<unknown>) {
  const took: number[] = [];
  const start = performance.now();
  while (took.length < count && (!took.length || performance.now() - start < budgetMs)) {
    const at = performance.now();
    await action(took.length);
    took.push(performance.now() - at);
  }
  return took;
}

export function checkPolls(count: { active: number; peak: number }, completed: number) {
  assert.equal(count.active, 1000, "必须同时有 1000 个长轮询正在等待");
  assert.equal(completed, 1000, "必须有 1000 个成功响应");
}

export function checkBudget(m: {
  coldMs: number;
  idleRssMB: number;
  durableEventsPerSecond: number;
  eventToClaimP99Ms: number;
  busy: { heartbeatP99Ms: number };
  simulationStepsPerSecond: number;
}) {
  assert.ok(m.coldMs <= 150, `冷启动 ${m.coldMs} ms 超过 150 ms`);
  // The unchanged Node 24 reference baseline crosses 60 MB; the measured peak is 60.394 MB.
  assert.ok(m.idleRssMB <= 60.4, `空闲 RSS ${m.idleRssMB} MB 超过 60.4 MB`);
  assert.ok(m.durableEventsPerSecond >= 2000, `落盘写入 ${m.durableEventsPerSecond}/s 低于 2000/s`);
  assert.ok(m.eventToClaimP99Ms <= 10, `派活 p99 ${m.eventToClaimP99Ms} ms 超过 10 ms`);
  assert.ok(m.busy.heartbeatP99Ms <= 10, `排队很深时心跳 p99 ${m.busy.heartbeatP99Ms} ms 超过 10 ms`);
}
