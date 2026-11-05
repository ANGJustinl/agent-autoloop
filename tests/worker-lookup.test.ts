// Failure modes: the worker cannot run ps at all (the sandbox forbids it, or it is missing or not executable), and it
// reports a run that is still going as finished because the failed lookup was read as "the process is gone"; or, unable
// to look, it holds a stuck or stopped run forever because its timeout and its stop wait on a sighting that never comes.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const scratch = mkdtempSync(join(tmpdir(), "agent-autoloop-worker-look-"));
const home = join(scratch, "home");
const project = join(scratch, "project");
const bin = join(scratch, "bin");
mkdirSync(home, { recursive: true });
mkdirSync(project, { recursive: true });
mkdirSync(bin, { recursive: true });
process.env.AGENT_AUTOLOOP_HOME = home;
process.env.SHELL = "/bin/sh";
after(() => rmSync(scratch, { recursive: true, force: true }));
const { createWorker } = await import("../worker/worker.ts");

/** Put a ps in front of the real one that answers the question the way a gone process does. */
function psSaysGone() {
  writeFileSync(join(bin, "ps"), `#!/bin/sh\nexit 1\n`, { mode: 0o755 });
  chmodSync(join(bin, "ps"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
}

/**
 * Put a ps in front of the real one that fails the way one that cannot run does. A file without the execute bit would
 * not do: the lookup skips it and finds the real ps further along PATH, so outside a sandbox the test would check nothing.
 */
function psCannotRun() {
  writeFileSync(join(bin, "ps"), `#!/bin/sh\nexit 126\n`, { mode: 0o755 });
  chmodSync(join(bin, "ps"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
}

function workerThatReports(results: any[], job: any, now: () => number = Date.now) {
  let claimed = false;
  return createWorker({
    name: "test",
    wait: 0,
    now,
    hub: {
      work: async () => {
        const next = claimed ? null : job;
        claimed = true;
        return { job: next, cancel: [] };
      },
      started: async () => ({}),
      result: async (_run: number, _token: string, body: unknown) => {
        results.push(body);
        return {};
      },
    } as any,
  });
}

/** Each run gets its own number so one run's exit file is never read as another's. */
function jobFor(run: number, seconds: number, timeout?: number) {
  return {
    run,
    token: "test-token",
    attempt: 1,
    session: null,
    askFirst: [],
    rule: { name: "lookup", cwd: project, prompt: "Read the input." },
    agent: {
      id: "a",
      name: "Agent",
      use: "command",
      access: "edit",
      timeout,
      command: ["/bin/sh", "-c", `sleep ${seconds}`],
    },
    context: { events: [], answers: [], timers: [], waiting: [], open: [], decided: [] },
  };
}

test("a run whose process is gone is reported as finished", async () => {
  psSaysGone();
  const results: any[] = [];
  const worker = workerThatReports(results, jobFor(12, 0));
  for (let i = 0; i < 100 && !results.length; i++) {
    await worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(results.length, 1, "the finished run was never reported");
});

test("a run that cannot be looked up is not reported as finished", async () => {
  psCannotRun();
  const results: any[] = [];
  const worker = workerThatReports(results, jobFor(11, 30));
  for (let i = 0; i < 60 && !results.length; i++) {
    await worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(results.length, 0, "the run was reported before it finished");
  process.kill(-JSON.parse(readFileSync(join(home, "worker", "runs", "11-1", "entry.json"), "utf8")).pid, "SIGKILL");
});

test("a stuck run that cannot be looked up still times out and is reported", async () => {
  psCannotRun();
  const results: any[] = [];
  let moment = Date.now();
  const worker = workerThatReports(results, jobFor(15, 30, 1), () => moment);
  await worker.tick();
  await worker.tick();
  assert.equal(results.length, 0, "the run was reported before its timeout");
  moment += 61_000;
  await worker.tick();
  moment += 11_000;
  for (let i = 0; i < 20 && !results.length; i++) {
    await worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(results.length, 1, "the timed-out run was never reported");
});

test("a run that cannot be looked up is reported once its exit file shows up", async () => {
  psCannotRun();
  const results: any[] = [];
  const worker = workerThatReports(results, jobFor(14, 0));
  for (let i = 0; i < 100 && !results.length; i++) {
    await worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(results.length, 1, "the finished run was never reported");
});
