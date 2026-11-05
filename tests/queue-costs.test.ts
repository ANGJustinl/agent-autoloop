// What a long queue costs each input. Everything runs on one thread and a worker with work in hand asks every second, so
// a read that grows with the queue holds up every other request.
// Failure cases: the rules are read and parsed again for each queued run, and again for each worker; remembering them
// hides new rules from the next view or from another writer's next reader, leaks a draft's change into the view it came
// from, keeps a decision from seeing the rules it just changed, or hands a held run the current rules for its own.
// An input that changed nothing still reads the queue to work out deadlines that can't have moved, or writes a fact for
// them; leaving them alone strands what only the clock changes, because a tick no longer brings the table up to date, or
// a change no longer does, or a clock set back never gets its deadlines back.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { test } from "node:test";
import { decide } from "../kernel/decide.ts";
import { credential } from "../kernel/credentials.ts";
import { deadlines } from "../kernel/due.ts";
import { empty, evolve, rows, snapshot, type Fact, type View } from "../kernel/evolve.ts";
import { configuration, workerOf } from "../kernel/query.ts";
import { commit, openView } from "../kernel/store.ts";
import { parseRules } from "../protocol/rules.ts";

const environment = { secret: "test-queue-costs", publicUrl: "https://hub.test" };
const fixture = parseRules(readFileSync(new URL("./rules.fixture.json", import.meta.url), "utf8"), 0, "UTC");
const rules = { ...fixture, rules: fixture.rules.filter((rule) => "source" in rule.when) };

/** The kernel as the shell runs it, at a fixed time. */
class Hub {
  view: View = empty();
  now = 1000;
  constructor(given = rules) {
    this.act("rules", given);
  }
  act(type: string, ...args: unknown[]) {
    const decided = decide(this.view, { type, args }, this.now, environment);
    this.view = evolve(this.view, decided.facts);
    return decided.value;
  }
  /** Runs queued for w1, each its own subject. */
  queue(count: number, from = 0) {
    for (let n = from; n < from + count; n++)
      this.act("ingest", "app", { id: `${n}`, type: "feedback.new", subject: `#${n}` });
  }
}

/** How many times the rules are parsed while this runs, on a view nothing has read from yet. */
function rulesParsed(hub: Hub, type: string, ...args: unknown[]) {
  const fresh = evolve(hub.view, []);
  const parse = JSON.parse;
  let parsed = 0;
  JSON.parse = (text: string, ...rest: []) => {
    if (typeof text === "string" && text.includes('"askFirst"')) parsed++;
    return parse(text, ...rest);
  };
  try {
    decide(fresh, { type, args }, hub.now, environment);
  } finally {
    JSON.parse = parse;
  }
  return parsed;
}

for (const [type, args] of [
  ["heartbeat", ["w1", []]],
  ["claimNext", ["w1", "new"]],
  ["ingest", ["app", { id: "more", type: "feedback.new", subject: "#more" }]],
  ["tick", []],
] as const) {
  test(`${type} parses the rules once, however long the queue`, () => {
    const hub = new Hub();
    hub.queue(1);
    assert.equal(rulesParsed(hub, type, ...args), 1);
    hub.queue(49, 1);
    assert.equal(rulesParsed(hub, type, ...args), 1);
  });
}

test("a held run's older rules are parsed once more, however many runs hold them", () => {
  const hub = new Hub();
  hub.queue(3);
  for (const n of [0, 1, 2]) hub.act("claimNext", "w1", `claim-${n}`);
  hub.act("rules", { ...rules, askFirst: ["别的"] });
  assert.equal(rulesParsed(hub, "tick"), 2);
});

test("new rules reach the next view, and a decision in flight leaves the view it came from alone", () => {
  const hub = new Hub();
  const before = hub.view;
  const was = configuration(before).askFirst;
  const decided = decide(before, { type: "rules", args: [{ ...rules, askFirst: ["别的"] }] }, 2000, environment);
  assert.deepEqual(configuration(before).askFirst, was);
  assert.deepEqual(configuration(evolve(before, decided.facts)).askFirst, ["别的"]);
});

test("a view opened after another writer changed the rules sees the new ones", () => {
  const db = new DatabaseSync(":memory:");
  const facts = (view: View, given: typeof rules) =>
    decide(view, { type: "rules", args: [given] }, 1000, environment).facts;
  const view = openView(db, "format");
  const first = commit(db, view, () => facts(view, rules));
  assert.deepEqual(configuration(first).askFirst, rules.askFirst);
  // A command writes to this database from its own process, on a view of its own.
  const other = openView(db, "format");
  commit(db, other, () => facts(other, { ...rules, askFirst: ["别的"] }));
  assert.deepEqual(configuration(openView(db, "format")).askFirst, ["别的"]);
  db.close();
});

test("a decision that changes the rules sees its own change for what it does next", () => {
  const moved = { ...rules, rules: rules.rules.map((rule) => (rule.name === "意见" ? { ...rule, to: "a2" } : rule)) };
  const hub = new Hub();
  hub.queue(1);
  const decided = decide(hub.view, { type: "rules", args: [moved] }, 2000, environment);
  const run = decided.facts[0].changes.find((change) => change.table === "runs")!.row!;
  assert.equal(run.agent, "a2");
  assert.equal(run.rules_version, decided.facts[0].seq);
});

test("a held run keeps the rules it was claimed under, read off the same view as the current ones", () => {
  const moved = { ...rules, agents: { ...rules.agents, a1: { ...rules.agents.a1, worker: "w2" } } };
  const hub = new Hub();
  hub.queue(1);
  const { run } = hub.act("claimNext", "w1", "claim");
  hub.act("rules", moved);
  const view = evolve(hub.view, []);
  assert.equal(configuration(view).agents.a1.worker, "w2");
  assert.equal(workerOf(view, view.get("runs", run)!), "w1");
  assert.equal(configuration(view).agents.a1.worker, "w2");
});

/** How many times the runs are read from the database while an input is decided, and what it decided. */
function runReads(hub: Hub, type: string, ...args: unknown[]) {
  const all = StatementSync.prototype.all;
  let reads = 0;
  StatementSync.prototype.all = function (...given: any[]) {
    if (this.sourceSQL.includes("collection='runs'")) reads++;
    return all.apply(this, given as any);
  };
  try {
    const decided = decide(hub.view, { type, args }, hub.now, environment);
    return { ...decided, reads };
  } finally {
    StatementSync.prototype.all = all;
  }
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** One run in hand and more behind it, and everyone just seen. */
function busyHub() {
  const hub = new Hub();
  hub.queue(5);
  const job = hub.act("claimNext", "w1", "held");
  hub.act("heartbeat", "w1", [job.run]);
  hub.act("heartbeat", "w2", []);
  hub.act("channelSeen", "chat");
  hub.now += SECOND;
  return { hub, job };
}

test("an input that changes nothing reads no runs and writes no fact", () => {
  const { hub, job } = busyHub();
  const nothing: [string, ...unknown[]][] = [
    ["heartbeat", "w1", [job.run]],
    ["heartbeat", "w2", []],
    ["channelSeen", "chat"],
    ["ingest", "app", { id: "0", type: "feedback.new", subject: "#0" }],
    ["nextCard", "chat"],
  ];
  for (const [type, ...args] of nothing) {
    const decided = runReads(hub, type, ...args);
    assert.deepEqual(decided.facts, [], type);
    assert.equal(decided.reads, 0, type);
  }
});

test("a receipt handed in again reads no runs", () => {
  const { hub, job } = busyHub();
  hub.act("finish", job.run, job.token, { outcome: "done" });
  const again = runReads(hub, "finish", job.run, job.token, { outcome: "done" });
  assert.equal(again.value.duplicate, true);
  assert.deepEqual(again.facts, []);
  assert.equal(again.reads, 0);
});

test("a claim that finds nothing reads the runs only to look for one", () => {
  const hub = new Hub();
  hub.queue(5);
  for (const n of [0, 1, 2]) hub.act("claimNext", "w1", `claim-${n}`);
  hub.act("heartbeat", "w1", []);
  hub.now += SECOND;
  const blocked = runReads(hub, "claimNext", "w1", "nothing");
  assert.equal(blocked.value, null);
  assert.deepEqual(blocked.facts, []);
  assert.equal(blocked.reads, 1);
});

/** A failed run waiting for its retry, with its deadline in the table. */
function waitingForRetry() {
  const hub = new Hub();
  hub.queue(1);
  const job = hub.act("claimNext", "w1", "first");
  hub.act("finish", job.run, job.token, { outcome: "failed", error: "没跑成" });
  const retry = rows(hub.view, "due").find((due) => due.kind === "retry")!;
  assert.equal(retry.at, hub.now + 5 * MINUTE);
  return { hub, job, retry };
}

test("what only the clock changes waits for the tick the deadline brings, and that tick sees to it", () => {
  const { hub, retry } = waitingForRetry();
  hub.now = retry.at - 30 * SECOND;
  hub.act("heartbeat", "w1", []);
  hub.now = retry.at + 1;
  // Past its time and nothing changed: the table stands until the timer set for that deadline fires.
  assert.deepEqual(decide(hub.view, { type: "heartbeat", args: ["w1", []] }, hub.now, environment).facts, []);
  assert.equal(
    rows(hub.view, "due").some((due) => due.kind === "retry"),
    true,
  );
  const [fact] = decide(hub.view, { type: "tick", args: [] }, hub.now, environment).facts;
  assert.ok(fact.changes.every((change) => change.table === "due"));
  hub.act("tick");
  const kinds = rows(hub.view, "due").map((due) => due.kind);
  assert.equal(kinds.includes("retry"), false);
  assert.equal(kinds.includes("offline"), true, "a run ready to go is now waiting on its worker");
});

test("a run past its retry time can be claimed before any tick", () => {
  const { hub, retry } = waitingForRetry();
  hub.now = retry.at + 1;
  const job = hub.act("claimNext", "w1", "second");
  assert.equal(job.attempt, 2);
  assert.equal(
    rows(hub.view, "due").some((due) => due.kind === "retry"),
    false,
  );
});

test("anything that changes something brings the whole table up to date", () => {
  const { hub, retry } = waitingForRetry();
  hub.now = retry.at + 1;
  hub.act("ingest", "ops", { id: "other", type: "alert.raised" });
  assert.equal(
    rows(hub.view, "due").some((due) => due.kind === "retry"),
    false,
  );
});

test("a tick with nothing to do leaves the table and writes nothing", () => {
  const { hub, retry } = waitingForRetry();
  hub.now = retry.at - MINUTE;
  assert.deepEqual(decide(hub.view, { type: "tick", args: [] }, hub.now, environment).facts, []);
});

test("a clock set back gets its deadlines back at the next tick", () => {
  const { hub, retry } = waitingForRetry();
  hub.now = retry.at + 1;
  hub.act("tick");
  assert.equal(
    rows(hub.view, "due").some((due) => due.kind === "retry"),
    false,
  );
  hub.now = retry.at - MINUTE;
  hub.act("tick");
  assert.equal(rows(hub.view, "due").find((due) => due.kind === "retry")?.at, retry.at);
});

test("the table is what working it out says, as of the last fact, whatever came after", () => {
  const hub = new Hub();
  const log: Fact[] = [];
  const act = (type: string, ...args: unknown[]) => {
    const decided = decide(hub.view, { type, args }, hub.now, environment);
    log.push(...decided.facts);
    hub.view = evolve(hub.view, decided.facts);
    if (log.length) assert.deepEqual(snapshot(hub.view).tables.due, deadlines(hub.view, log.at(-1)!.at), type);
    return decided.value;
  };
  act("ingest", "app", { id: "a", type: "feedback.new", subject: "#a" });
  act("ingest", "app", { id: "b", type: "feedback.new", subject: "#b" });
  const job = act("claimNext", "w1", "one");
  for (let n = 0; n < 20; n++) {
    hub.now += 30 * SECOND;
    act("heartbeat", "w1", [job.run]);
    act("channelSeen", "chat");
    act("claimNext", "w1", `poll-${n}`);
  }
  act("finish", job.run, credential(environment, "run", job.run, hub.view.get("runs", job.run)!.issued), {
    outcome: "failed",
  });
  for (let n = 0; n < 30; n++) {
    hub.now += MINUTE;
    act("heartbeat", "w2", []);
    if (rows(hub.view, "due").some((due) => due.at <= hub.now)) act("tick");
  }
});
