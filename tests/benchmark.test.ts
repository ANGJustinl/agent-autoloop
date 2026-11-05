// Failure modes: completed or keep-alive requests masquerade as concurrent long polls; a failed response counts as success;
// cron work is claimed before the measured event, leaving the readiness wait stuck and invalidating dispatch timing;
// a percentile off by one, so a slow outlier is hidden or a p99 from a few samples reads low; a slow case left with no
// samples, or one that runs on past its budget and lets the polls it depends on lapse.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { checkPolls, observe, checkBudget, dispatchLatency, percentile, timed } from "../scripts/metrics.ts";

test("a thousand completed requests cannot stand in for a thousand waiting ones", () => {
  assert.throws(() => checkPolls({ active: 0, peak: 1 }, 1000), /1000/);
  assert.throws(() => checkPolls({ active: 999, peak: 999 }, 1000), /1000/);
  assert.throws(() => checkPolls({ active: 1000, peak: 1000 }, 999), /1000/);
  checkPolls({ active: 1000, peak: 1000 }, 1000);
});

test("a percentile is the sample that share stays at or under, and a few samples can't hide the slowest", () => {
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1).reverse();
  assert.equal(percentile(hundred, 0.5), 50);
  assert.equal(percentile(hundred, 0.99), 99);
  assert.equal(percentile([3, 1, 2], 0.5), 2);
  assert.equal(percentile([3, 1, 2], 0.99), 3);
  assert.equal(percentile([7], 0.99), 7);
});

test("timing stops at the count or the budget, and always takes one sample", async () => {
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const seen: number[] = [];
  assert.equal((await timed(3, 60_000, async (i) => void seen.push(i))).length, 3);
  assert.deepEqual(seen, [0, 1, 2]);
  assert.equal((await timed(100, 0, () => pause(1))).length, 1);
  // A busy machine can stretch any pause past the whole budget, so how many fit says nothing. None may start past it.
  const slow = await timed(1000, 30, () => pause(10));
  assert.ok(slow.length < 1000, `${slow.length}`);
  const beforeTheLast = slow.slice(0, -1).reduce((total, ms) => total + ms, 0);
  assert.ok(beforeTheLast < 30, `${beforeTheLast}`);
  assert.ok(slow.every((ms) => ms >= 5));
});

test("an early request rejection stays observable until the batch is consumed", async () => {
  const failure = new Error("连接断了");
  const pending = observe(Promise.reject(failure));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await pending, { status: "rejected", reason: failure });
});

test("budget checks fail on startup, idle memory, durable throughput, latency, a heartbeat that scans the queue; simulation speed is observational", () => {
  const measured = {
    coldMs: 85,
    idleRssMB: 55,
    durableEventsPerSecond: 2356,
    eventToClaimP99Ms: 1.8,
    busy: { heartbeatP99Ms: 1.7 },
    simulationStepsPerSecond: 34000,
  };
  checkBudget(measured);
  checkBudget({ ...measured, simulationStepsPerSecond: 100 });
  for (const [key, value] of Object.entries({
    coldMs: 151,
    idleRssMB: 61,
    durableEventsPerSecond: 1999,
    eventToClaimP99Ms: 11,
  }))
    assert.throws(() => checkBudget({ ...measured, [key]: value }));
  assert.throws(() => checkBudget({ ...measured, busy: { heartbeatP99Ms: 11 } }));
});
test("dispatch latency includes waking an already waiting worker", async () => {
  let waiting = false;
  let finish: (value: unknown) => void = () => {};
  const request = async (path: string) => {
    if (path.startsWith("/v1/work")) {
      waiting = true;
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
    assert.equal(waiting, true);
    setTimeout(() => finish({ job: { run: 1 } }), 55);
    return {};
  };
  const measured = await dispatchLatency(request, async () => assert.equal(waiting, true), 1);
  assert.ok(measured.ms >= 40);
  assert.equal(measured.job.run, 1);
});

test("the benchmark server has no scheduled work competing with measured events", async () => {
  const home = mkdtempSync(join(tmpdir(), "agent-autoloop-benchmark-setup-"));
  const child = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", join(import.meta.dirname, "../scripts/benchmark.ts"), "--server"],
    {
      env: {
        ...process.env,
        AGENT_AUTOLOOP_HOME: home,
        AGENT_AUTOLOOP_RULES: join(import.meta.dirname, "rules.fixture.json"),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  try {
    await once(child.stdout!, "data");
    const db = new DatabaseSync(join(home, "hub.db"), { readOnly: true });
    try {
      const row = db.prepare("SELECT count(*) AS count FROM projections WHERE collection='schedules'").get()!;
      assert.equal(row.count, 0, "a cron tick can finish a work poll before the timed event");
    } finally {
      db.close();
    }
  } finally {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
    rmSync(home, { recursive: true, force: true });
  }
});
