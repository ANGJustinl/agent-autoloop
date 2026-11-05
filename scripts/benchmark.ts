// Failure modes: measuring buffered writes as durable; excluding process startup; counting serial polls as concurrent;
// a busy hub whose queue isn't really there, or whose polls have lapsed, passing for one under load.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, cpus } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { observePolls, checkPolls, observe, checkBudget, dispatchLatency, percentile, timed } from "./metrics.ts";
import type { Change } from "../kernel/evolve.ts";

if (process.argv.includes("--server")) {
  // A cron tick can claim the poll before its measured event and leave readiness waiting forever.
  const fixture = JSON.parse(readFileSync(new URL("../tests/rules.fixture.json", import.meta.url), "utf8"));
  fixture.rules = fixture.rules.filter((rule: { when: { cron?: string } }) => !rule.when.cron);
  fixture.elsewhere = [];
  process.env.AGENT_AUTOLOOP_RULES = join(process.env.AGENT_AUTOLOOP_HOME!, "rules.json");
  writeFileSync(process.env.AGENT_AUTOLOOP_RULES, JSON.stringify(fixture));
  const { serve } = await import("../host/http.ts");
  const { keepKeyHash } = await import("../host/runtime.ts");
  const { db, environment, execute, getView, parseRules } = await import("../host/runtime.ts");
  const { createHash } = await import("node:crypto");
  const { decide } = await import("../kernel/decide.ts");
  const { commit } = await import("../kernel/store.ts");
  const { configuration } = await import("../kernel/query.ts");
  for (const [kind, name] of [
    ["source", "app"],
    ["worker", "w1"],
  ] as const)
    keepKeyHash(kind, name, createHash("sha256").update(kind).digest("hex"));
  db.exec("PRAGMA synchronous = FULL");
  const server = serve(0);
  const polls = observePolls(server);
  await once(server, "listening");
  console.log(
    JSON.stringify({
      port: (server.address() as { port: number }).port,
      rssMB: process.memoryUsage().rss / 1e6,
      sqlite: db.prepare("PRAGMA synchronous").get(),
    }),
  );
  // What a read of the rules costs goes with their size, and the fixture is much smaller than a real rules file.
  const padRules = () => {
    const extra = Array.from({ length: 15 }, (_, i) => ({
      name: `规则 ${i}`,
      when: { source: "ops", types: [`padding.${i}`] },
      to: "a1",
      cwd: "~/x",
      prompt: "按手册做。".repeat(20),
    }));
    execute("rules", [parseRules(JSON.stringify({ ...fixture, rules: [...fixture.rules, ...extra] }))]);
  };
  // One fact with the whole queue in it, each row a copy of what ingest writes. Taking them through ingest one by one
  // is quadratic for as long as each input rescans the queue, and that is what the scenario is there to measure.
  const seedQueue = (count: number) => {
    const view = getView();
    const event = { id: "queued", type: "feedback.new", subject: "#queued" };
    const now = Date.now();
    const [{ changes }] = decide(view, { type: "ingest", args: ["app", event] }, now, environment).facts;
    const template = (table: string) => changes.find((change) => change.table === table)!.row!;
    const seeded: Change[] = [];
    for (let i = 1; i <= count; i++) {
      const eventId = (view.next.events ?? 0) + i;
      const runId = (view.next.runs ?? 0) + i;
      const lane = `#queued${i}`;
      const row = { ...template("events"), id: eventId, key: `queued:${i}`, subject: lane };
      seeded.push({ table: "events", key: String(eventId), row });
      seeded.push({ table: "runs", key: String(runId), row: { ...template("runs"), id: runId, lane } });
      seeded.push({ table: "run_events", key: `${runId}:${eventId}`, row: { run_id: runId, event_id: eventId } });
    }
    commit(db, view, () => [{ version: 1, seq: view.seq + 1, at: now, type: "seed", changes: seeded }]);
    // The fact above went round decide, so this is what brings the due table up to date with it.
    execute("tick", []);
  };
  const busyFigures = () => {
    const { user, system } = process.cpuUsage();
    const view = getView();
    return {
      cpuMs: (user + system) / 1000,
      facts: view.seq,
      rulesBytes: JSON.stringify(configuration(view)).length,
      queued: db.prepare("SELECT COUNT(*) AS n FROM runs WHERE state='queued'").get()!.n,
    };
  };
  process.on("message", (message: string | { padRules?: boolean; queue?: number }) => {
    if (typeof message === "object" && message.padRules) padRules();
    if (typeof message === "object" && message.queue) seedQueue(message.queue);
    server.getConnections((error, connections) => {
      if (error) throw error;
      const figures = typeof message === "object" ? busyFigures() : {};
      process.send!({ rssMB: process.memoryUsage().rss / 1e6, connections, ...polls, ...figures });
    });
  });
  process.on("SIGTERM", () => {
    server.closeAllConnections();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
} else {
  const { spawn } = await import("node:child_process");
  const home = mkdtempSync(join(tmpdir(), "agent-autoloop-bench-"));
  const start = performance.now();
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", import.meta.filename, "--server"], {
    env: {
      ...process.env,
      AGENT_AUTOLOOP_HOME: home,
      AGENT_AUTOLOOP_RULES: join(import.meta.dirname, "../tests/rules.fixture.json"),
    },
    stdio: ["ignore", "pipe", "inherit", "ipc"],
  });
  try {
    const ready = JSON.parse(String((await once(child.stdout!, "data"))[0]));
    const coldMs = performance.now() - start;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    child.send("sample");
    const [idle] = await once(child, "message");
    const url = `http://127.0.0.1:${ready.port}`;
    const request = async (path: string, key: string, body?: unknown, signal?: AbortSignal) => {
      const res = await fetch(url + path, {
        method: body ? "POST" : "GET",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(signal ? { signal } : {}),
      });
      assert.equal(res.status, 200);
      return res.json();
    };
    const busyHub = async () => {
      const ask = async (message: object = {}) => {
        child.send(message);
        return (await once(child, "message"))[0];
      };
      const until = async (done: (figures: any) => boolean) => {
        for (let tries = 0; tries < 2000; tries++) {
          if (done(await ask())) return;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.fail("长轮询没有到位");
      };
      const queued = Number(process.env.BENCH_QUEUE ?? 5000);
      const { rulesBytes } = await ask({ padRules: true });
      // The polls go in before the queue: while each heartbeat rescans the queue, a thousand of them would outlast their wait.
      const abort = new AbortController();
      const waiting = [];
      for (let i = 0; i < 1000; i++) {
        waiting.push(observe(request(`/v1/work?wait=50&capacity=0&claim=busy${i}`, "worker", undefined, abort.signal)));
        if (i % 32 === 31) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await until((figures) => figures.active === 1000);
      const before = await ask({ queue: queued });
      const heartbeats = await timed(200, 20_000, () => request("/v1/work?wait=0&capacity=0&claim=beat", "worker"));
      const after = await ask();
      assert.ok(after.queued >= queued, "排队必须真的在");
      abort.abort();
      const responses = await Promise.all(waiting);
      assert.ok(responses.every((r) => r.status === "fulfilled" || r.reason.name === "AbortError"));
      checkPolls(after, responses.length);
      await until((figures) => figures.active === 0);
      const event = (i: number) => ({ id: `busy:${i}`, type: "feedback.new", subject: `#busy${i}` });
      const ingest = await timed(20, 20_000, (i) => request("/v1/events", "source", event(i)));
      const [claim, finish]: number[][] = [[], []];
      await timed(20, 20_000, async (i) => {
        const claimedAt = performance.now();
        const { job } = await request(`/v1/work?wait=0&claim=c${i}`, "worker");
        const finishedAt = performance.now();
        claim.push(finishedAt - claimedAt);
        await request(`/v1/runs/${job.run}/result`, job.token, { outcome: "done" });
        finish.push(performance.now() - finishedAt);
      });
      // Every lane the group allows is taken and more are behind them: a worker with room asks this every second for nothing.
      for (let i = 0; i < 4; i++) await request("/v1/events", "source", event(1000 + i));
      const held = [];
      for (let i = 0; i < 3; i++) held.push((await request(`/v1/work?wait=0&claim=held${i}`, "worker")).job);
      const running = held.map((job) => job.run).join();
      const blockedClaim = await timed(50, 20_000, async () => {
        assert.equal((await request(`/v1/work?wait=0&claim=blocked&running=${running}`, "worker")).job, null);
      });
      for (const job of held) await request(`/v1/runs/${job.run}/result`, job.token, { outcome: "done" });
      const ms = (values: number[], share: number) => Number(percentile(values, share).toFixed(3));
      return {
        queued,
        rulesBytes,
        waitingPolls: after.active,
        heartbeats: heartbeats.length,
        heartbeatP50Ms: ms(heartbeats, 0.5),
        heartbeatP99Ms: ms(heartbeats, 0.99),
        cpuMsPerHeartbeat: Number(((after.cpuMs - before.cpuMs) / heartbeats.length).toFixed(3)),
        secondsOfHeartbeats: Number((heartbeats.reduce((total, ms) => total + ms, 0) / 1000).toFixed(1)),
        factsFromHeartbeats: after.facts - before.facts,
        ingestP50Ms: ms(ingest, 0.5),
        claimP50Ms: ms(claim, 0.5),
        finishP50Ms: ms(finish, 0.5),
        blockedClaimP50Ms: ms(blockedClaim, 0.5),
      };
    };
    if (process.argv.includes("--busy")) {
      console.log(JSON.stringify({ machine: cpus()[0].model, node: process.version, ...(await busyHub()) }, null, 2));
    } else {
      const count = Number(process.env.BENCH_EVENTS ?? 1000);
      const writeAt = performance.now();
      for (let i = 0; i < count; i++) await request("/v1/events", "source", { id: `write:${i}`, type: "unrouted" });
      const durableEventsPerSecond = (count * 1000) / (performance.now() - writeAt);
      const latency = [];
      for (let i = 0; i < 100; i++) {
        const { job, ms } = await dispatchLatency(
          request,
          async () => {
            for (;;) {
              child.send("sample");
              const [sample] = await once(child, "message");
              if (sample.active === 1) break;
              await new Promise((resolve) => setTimeout(resolve, 1));
            }
          },
          i,
        );
        latency.push(ms);
        await request(`/v1/runs/${job.run}/result`, job.token, { outcome: "done" });
      }
      const polls = [];
      for (let i = 0; i < 1000; i++) {
        polls.push(observe(request(`/v1/work?wait=5&capacity=0&claim=p${i}`, "worker")));
        if (i % 32 === 31) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      child.send("sample");
      const [loaded] = await once(child, "message");
      const responses = (await Promise.all(polls)).map((result) => {
        if (result.status === "rejected") throw result.reason;
        return result.value;
      });
      assert.ok(responses.every((r) => r.job === null));
      checkPolls(loaded, responses.length);
      const busy = await busyHub();
      const simulation = (await import("../sim/random.ts")).simulate();
      const kernelFolder = join(import.meta.dirname, "../kernel");
      const kernelLines = readdirSync(kernelFolder)
        .filter((file) => file.endsWith(".ts"))
        .reduce(
          (total, file) => total + readFileSync(join(kernelFolder, file), "utf8").trimEnd().split("\n").length,
          0,
        );
      const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
      const measured = {
        kernelLines,
        runtimeDependencies: Object.keys(manifest.dependencies ?? {}).length,
        machine: cpus()[0].model,
        node: process.version,
        coldMs,
        idleRssMB: idle.rssMB,
        loadedRssMB: loaded.rssMB,
        synchronous: ready.sqlite,
        events: count,
        durableEventsPerSecond,
        eventToClaimP99Ms: latency.sort((a, b) => a - b)[98],
        concurrentPolls: loaded.active,
        completedPolls: responses.length,
        connectionsAtPeak: loaded.connections,
        busy,
        simulation,
        simulationStepsPerSecond: simulation.stepsPerSecond,
      };
      console.log(JSON.stringify(measured, null, 2));
      if (process.argv.includes("--check")) checkBudget(measured);
    }
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    rmSync(home, { recursive: true, force: true });
  }
}
