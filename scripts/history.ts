// Failure modes: completed history grows the hot heap or slows ordinary requests; a slow stream buffers the log;
// restart loses ID high water, delivery updates, answers or timer state; SIGKILL loses an acknowledged receipt;
// rebuilding trusts the saved projection or loads all facts into memory. Fixtures use the real kernel and WAL + FULL.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mode = process.argv[2];
if (["seed", "server", "rebuild"].includes(mode)) {
  const hub = await import("../host/runtime.ts");
  const { db } = hub;
  if (mode === "seed") {
    const start = Number(process.argv[3]),
      end = Number(process.argv[4]);
    const base = Date.parse("2026-01-01T00:00:00Z");
    for (let n = start; n < end; n++) {
      const now = base + n * 60_000;
      hub.ingest(
        "app",
        { id: `history-${n}`, type: "feedback.new", subject: "recurring", detail: "业务资料。".repeat(100) },
        now,
      );
      const first = hub.claimNext("w1", `first-${n}`, now)!;
      hub.finish(
        first.run,
        first.token,
        {
          outcome: "done",
          usage: { input: 1200, output: 200, cost: 0.01 },
          ask: [{ title: `问题 ${n}`, text: "需要确认的内容。".repeat(50), options: ["继续", "结束"] }],
          later: [{ key: "check", at: new Date(now + 30_000).toISOString(), about: "检查结果" }],
        },
        now,
      );
      const card = hub.nextCard("chat", now)!;
      assert.ok(card);
      hub.delivered("chat", card.id, card.version, `message-${n}`, now);
      hub.answer(card.id, { choice: 0, by: "本人" }, now);
      hub.tick(now + 31_000);
      const second = hub.claimNext("w1", `second-${n}`, now + 31_000)!;
      assert.equal(second.context.answers.length, 1);
      assert.equal(second.context.timers.length, 1);
      hub.finish(second.run, second.token, { outcome: "done" }, now + 31_000);
      const update = hub.nextCard("chat", now + 31_000)!;
      assert.equal(update.id, card.id);
      assert.equal(update.state, "done");
      hub.delivered("chat", update.id, update.version, `message-${n}`, now + 31_000);
      if ((n + 1) % 1000 === 0)
        console.log(
          JSON.stringify({
            seeded: n + 1,
            facts: hub.getView().seq,
            rssMB: process.memoryUsage().rss / 1e6,
            heapMB: process.memoryUsage().heapUsed / 1e6,
          }),
        );
    }
    db.close();
  } else if (mode === "rebuild") {
    const { rebuild } = await import("../kernel/store.ts");
    const hash = () => {
      const h = createHash("sha256");
      for (const table of ["projections", "projection_meta", "projection_refs", "projection_pending"])
        for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY 1,2,3`).iterate()) h.update(JSON.stringify(row));
      return h.digest("hex");
    };
    const before = hash();
    const start = performance.now();
    rebuild(db, hub.getView().format);
    const ms = performance.now() - start;
    assert.equal(hash(), before);
    assert.equal(db.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
    console.log(
      JSON.stringify({
        rebuildMs: ms,
        rssMB: process.memoryUsage().rss / 1e6,
        peakRssMB: process.resourceUsage().maxRSS / 1024,
        facts: hub.getView().seq,
      }),
    );
    db.close();
  } else {
    const { serve } = await import("../host/http.ts");
    const server = serve(0);
    await once(server, "listening");
    const sample = () => ({
      rssMB: process.memoryUsage().rss / 1e6,
      peakRssMB: process.resourceUsage().maxRSS / 1024,
      seq: hub.getView().seq,
    });
    console.log(JSON.stringify({ port: (server.address() as { port: number }).port, ...sample() }));
    process.on("message", () => process.send!(sample()));
    process.on("SIGTERM", () => {
      server.closeAllConnections();
      server.close(() => {
        db.close();
        process.exit(0);
      });
    });
  }
} else {
  const home = mkdtempSync(join(tmpdir(), "agent-autoloop-history-"));
  const rules = JSON.parse(readFileSync(new URL("../tests/rules.fixture.json", import.meta.url), "utf8"));
  rules.rules = rules.rules.filter((r: any) => r.name === "意见");
  rules.elsewhere = [];
  rules.channels.chat.links = true;
  writeFileSync(join(home, "rules.json"), JSON.stringify(rules));
  process.env.AGENT_AUTOLOOP_HOME = home;
  process.env.AGENT_AUTOLOOP_PUBLIC_URL = "";
  process.env.AGENT_AUTOLOOP_RULES = join(home, "rules.json");
  const hub = await import("../host/runtime.ts");
  for (const [kind, name] of [
    ["owner", "me"],
    ["source", "app"],
    ["worker", "w1"],
    ["channel", "chat"],
  ] as const)
    hub.keepKeyHash(kind, name, createHash("sha256").update(kind).digest("hex"));
  hub.db.close();
  const children = new Set<ChildProcess>();
  const launch = (...args: string[]) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", import.meta.filename, ...args], {
      env: process.env,
      stdio: ["ignore", "pipe", "inherit", "ipc"],
    });
    children.add(child);
    child.once("exit", () => children.delete(child));
    return child;
  };
  const run = async (...args: string[]) => {
    const child = launch(...args);
    child.stdout!.pipe(process.stdout);
    const [code] = await once(child, "exit");
    assert.equal(code, 0);
  };
  const startServer = async () => {
    const at = performance.now();
    const child = launch("server");
    const ready = JSON.parse(String((await once(child.stdout!, "data"))[0]));
    const request = async (path: string, key: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${ready.port}${path}`, {
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
      });
      if (response.status !== 200) assert.fail(`${path}: ${response.status} ${await response.text()}`);
      return response.headers.get("content-type")?.includes("application/json") ? response.json() : response.text();
    };
    return { child, ready, request, coldMs: performance.now() - at };
  };
  const stop = async (child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") => {
    const exited = once(child, "exit");
    child.kill(signal);
    await exited;
  };
  try {
    let seeded = 0,
      probes = 0;
    const marks = process.argv.slice(2).map(Number);
    for (const mark of marks.length ? marks : [1000, 10000, 100000]) {
      await run("seed", String(seeded), String(mark));
      seeded = mark;
      let server = await startServer();
      const latencies: Record<string, number[]> = {};
      const timed = async (name: string, path: string, key: string, body?: unknown) => {
        const at = performance.now();
        const value = await server.request(path, key, body);
        (latencies[name] ??= []).push(performance.now() - at);
        return value;
      };
      for (let n = 0; n < 30; n++) {
        const event = { id: `probe-${mark}-${n}`, type: "feedback.new", subject: `probe-${mark}-${n}` };
        await timed("ingest", "/v1/events", "source", event);
        assert.equal((await timed("duplicate", "/v1/events", "source", event)).duplicate, true);
        const { job } = await timed("claim", `/v1/work?wait=0&claim=probe-${n}`, "worker");
        assert.ok(job);
        await timed("finish", `/v1/runs/${job.run}/result`, job.token, { outcome: "done" });
        assert.equal((await timed("idleChannel", "/v1/cards/next?wait=0", "channel")).card, null);
        await timed("heartbeat", "/v1/work?wait=0&capacity=0&claim=heartbeat", "worker");
        const why = await timed("why", `/v1/runs/${job.run}/why`, "owner");
        assert.ok(why.some((f: any) => f.type === "finish"));
      }
      probes += 30;
      let status: any;
      for (let n = 0; n < 30; n++) status = await timed("status", "/v1/state", "owner");
      assert.equal(status.totals.queued, 0);
      assert.equal(status.totals.running, 0);
      assert.equal(status.totals.done, mark * 2 + probes);
      const abort = new AbortController();
      const stream = await fetch(`http://127.0.0.1:${server.ready.port}/v1/stream`, {
        headers: { authorization: "Bearer owner" },
        signal: abort.signal,
      });
      assert.equal(stream.status, 200);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      server.child.send("sample");
      const [loaded] = await once(server.child, "message");
      abort.abort();
      console.log(
        JSON.stringify({
          cycles: mark,
          coldMs: server.coldMs,
          idle: server.ready,
          loaded,
          latencyMs: Object.fromEntries(
            Object.entries(latencies).map(([name, values]) => [
              name,
              { p50: values.sort((a, b) => a - b)[Math.floor(values.length / 2)], max: Math.max(...values) },
            ]),
          ),
        }),
      );
      const event = { id: `recover-${mark}`, type: "feedback.new", subject: `recover-${mark}` };
      const ack = await server.request("/v1/events", "source", event);
      const { job } = await server.request(`/v1/work?wait=0&claim=recover-${mark}`, "worker");
      assert.ok(job);
      const receipt = { outcome: "done", notice: [{ title: "恢复检查", text: "确认回执和投递没有丢失" }] };
      const pending = server.request(`/v1/runs/${job.run}/result`, job.token, receipt).then(
        () => true,
        () => false,
      );
      await stop(server.child, "SIGKILL");
      const acknowledged = await pending;
      server = await startServer();
      const duplicate = await server.request("/v1/events", "source", event);
      assert.equal(duplicate.duplicate, true);
      assert.equal(duplicate.event, ack.event);
      await server.request(`/v1/runs/${job.run}/result`, job.token, receipt);
      assert.equal(
        (await server.request(`/v1/runs/${job.run}/why`, "owner")).filter((f: any) => f.type === "finish").length,
        1,
      );
      const { card } = await server.request("/v1/cards/next?wait=0", "channel");
      assert.ok(card);
      const at = performance.now();
      assert.match(await server.request(card.link, ""), /恢复检查/);
      const cardLinkMs = performance.now() - at;
      await server.request(`/v1/cards/${card.id}/delivered`, "channel", {
        version: card.version,
        ref: `recovery-${mark}`,
      });
      await server.request(`/v1/cards/${card.id}/resolve`, "owner", { reason: "已核实" });
      const { card: update } = await server.request("/v1/cards/next?wait=0", "channel");
      assert.equal(update.id, card.id);
      assert.equal(update.state, "closed");
      await server.request(`/v1/cards/${update.id}/delivered`, "channel", {
        version: update.version,
        ref: `recovery-${mark}`,
      });
      probes++;
      console.log(
        JSON.stringify({
          cycles: mark,
          recoveryMs: server.coldMs,
          recovered: true,
          receiptAcknowledgedBeforeKill: acknowledged,
          cardLinkMs,
          rssMB: server.ready.rssMB,
        }),
      );
      await stop(server.child);
    }
    await run("rebuild");
  } finally {
    for (const child of children) await stop(child, "SIGKILL");
    rmSync(home, { recursive: true, force: true });
  }
}
