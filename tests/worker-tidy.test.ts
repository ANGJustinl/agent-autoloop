// What a worker keeps of finished runs. Failure cases: old output stays for as long as the worker runs, because it's only
// cleared when it starts, or stays for a loop of its own that drives the worker round by round; the folder of a run still in
// hand, or one not old enough, goes; one folder that can't be cleared
// stops the worker or the rest of the clearing; session totals pile up for ever, or one still in use goes.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("worker-tidy");
const { createWorker } = await import("../worker/worker.ts");
const { saveUsage } = await import("../worker/usage.ts");

const runs = join(home, "worker", "runs");
const totals = join(home, "worker", "usage");
const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 3600_000);
const age = (path: string, days: number) => utimesSync(path, daysAgo(days), daysAgo(days));

/** The folder of a finished run, this many days after it finished. */
function finished(name: string, days: number) {
  const dir = join(runs, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "stdout-1.log"), "它说过的话");
  age(dir, days);
  return dir;
}

const quiet = () => ({
  asked: 0,
  async work() {
    this.asked += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { job: null, cancel: [] };
  },
  async started() {
    return { ok: true };
  },
  async result() {
    return { rejected: [] };
  },
});

async function until(done: () => boolean) {
  const end = Date.now() + 15_000;
  while (!done()) {
    if (Date.now() > end) assert.fail("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("old output goes while the worker keeps running, not only when it starts", async () => {
  const hub = quiet();
  let clock = Date.now();
  const worker = createWorker({ hub: hub as any, name: "w1", wait: 0, now: () => clock });
  const stop = new AbortController();
  const running = worker.run(stop.signal);
  await until(() => hub.asked > 0);
  const old = finished("1-1", 15);
  const asked = hub.asked;
  await until(() => hub.asked > asked + 2);
  assert.equal(existsSync(old), true, "cleared at the start, so not again at once");
  clock += 60 * 60_000 + 1;
  await until(() => !existsSync(old));
  stop.abort();
  await running;
});

test("a loop of its own, going round by round, gets the clearing too", async () => {
  let clock = Date.now();
  const worker = createWorker({ hub: quiet() as any, name: "w1", wait: 0, now: () => clock });
  await worker.tick();
  const old = finished("7-1", 15);
  await worker.tick();
  assert.equal(existsSync(old), true, "cleared at the first round, so not again at once");
  clock += 60 * 60_000 + 1;
  await worker.tick();
  assert.equal(existsSync(old), false);
});

test("only finished runs' folders old enough go", () => {
  const worker = createWorker({ hub: quiet() as any, name: "w1", wait: 0 });
  const old = finished("2-1", 15);
  const recent = finished("3-1", 13);
  const inHand = finished("4-1", 15);
  writeFileSync(join(inHand, "entry.json"), "{}");
  age(inHand, 15);
  worker.tidy();
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(recent), true);
  assert.equal(existsSync(inHand), true);
  rmSync(inHand, { recursive: true });
});

test("a folder that can't be cleared is said and leaves the rest to go", { skip: process.getuid!() === 0 }, () => {
  const lines: string[] = [];
  const worker = createWorker({ hub: quiet() as any, name: "w1", wait: 0, log: (line) => lines.push(line) });
  const stuck = finished("5-1", 15);
  const locked = join(stuck, "locked");
  mkdirSync(locked);
  chmodSync(locked, 0o000);
  age(stuck, 15);
  const other = finished("6-1", 15);
  try {
    assert.doesNotThrow(() => worker.tidy());
    assert.equal(existsSync(other), false);
    assert.equal(existsSync(stuck), true);
    assert.ok(lines.some((line) => line.includes("5-1")));
  } finally {
    chmodSync(locked, 0o700);
    rmSync(stuck, { recursive: true });
  }
});

test("a session's total goes after three months without use, and not before", () => {
  const worker = createWorker({ hub: quiet() as any, name: "w1", wait: 0 });
  saveUsage("printed", "long-gone", { input: 1 });
  const [gone] = readdirSync(totals);
  age(join(totals, gone), 91);
  saveUsage("printed", "still-in-use", { input: 1 });
  const kept = readdirSync(totals).find((name) => name !== gone)!;
  age(join(totals, kept), 89);
  worker.tidy();
  assert.deepEqual(readdirSync(totals), [kept]);
});

test(
  "session totals that can't be cleared are said once and don't stop the worker",
  { skip: process.getuid!() === 0 },
  () => {
    const lines: string[] = [];
    const worker = createWorker({ hub: quiet() as any, name: "w1", wait: 0, log: (line) => lines.push(line) });
    mkdirSync(totals, { recursive: true });
    chmodSync(totals, 0o000);
    try {
      assert.doesNotThrow(() => worker.tidy());
      worker.tidy();
      assert.equal(lines.filter((line) => line.includes("session totals")).length, 1);
    } finally {
      chmodSync(totals, 0o700);
    }
  },
);
