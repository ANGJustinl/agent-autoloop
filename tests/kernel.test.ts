// Failure modes: deciding mutates the input; time/randomness changes replay; uncommitted facts become visible;
// replay loses rules, keys or receipts; plaintext capabilities enter the log; projection writes bypass evolve;
// a crash commits half a receipt; stream loses its cursor; why cannot identify the rule used for a run.
// Normalizing receipt events must not mutate the request; reconnecting workers must close offline cards without a tick.
// Closing that card must not bring it straight back, or hide work that comes later for as long as the worker stays away.
// Rebuilding a projection must hold the same transaction as its log snapshot, or it can overwrite a concurrent receipt.
// Source event IDs must not collide with internally generated answer or timer IDs.
// Quiet notices must not escape through a channel; a stale writer must receive Conflict rather than a database failure.
// A queued run whose rule was removed or renamed waits for good, unnoticed, because nothing can claim it.
// A run stopped by its failed receipt puts that receipt's usage, session and dedupe mark back to what they were before it.
// Existing logs can contain a queued run with an old agent after a rules change; replay must retain claimed configurations.
// An input the kernel doesn't have must be refused, even one named like something every object inherits.
// A deadline nothing will move on again has the shell's one timer firing at once for good: a schedule whose rule is gone or
// no longer scheduled, a resend whose time has passed with the channel gone. A resend must also come due at its time, or
// a channel waiting for the next card isn't woken for it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { empty, evolve, rows, snapshot, type Fact } from "../kernel/evolve.ts";
import { decide } from "../kernel/decide.ts";
import { InputError } from "../kernel/errors.ts";
import { parseRules } from "../protocol/rules.ts";
import { at } from "./helpers.ts";

const environment = { secret: "simulation-secret", publicUrl: "https://hub.test" };
const rules = parseRules(readFileSync(new URL("./rules.fixture.json", import.meta.url), "utf8"), 0, "UTC");
const seeded = () => evolve(empty(), decide(empty(), { type: "rules", args: [rules] }, 1, environment).facts);
test("decisions are deterministic and leave their input untouched", () => {
  const view = seeded();
  const before = snapshot(view);
  const input = { type: "ingest", args: ["app", { id: "1", type: "feedback.new", subject: "#1" }] };
  const a = decide(view, input, 1000, environment);
  const b = decide(view, input, 1000, environment);
  assert.deepEqual(a, b);
  assert.deepEqual(snapshot(view), before);
  assert.equal(rows(view, "events").length, 0);
  assert.equal(rows(evolve(view, a.facts), "events").length, 1);
  assert.throws(() => {
    view.get("config", "rules")!.value.bad = {};
  }, TypeError);
});

test("rules, receipt replay and rebuild retain the exact acknowledgment", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { commit, readLog } = await import("../kernel/store.ts");
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE facts(seq INTEGER PRIMARY KEY,fact TEXT); CREATE TABLE projections(collection TEXT,key TEXT,data TEXT,PRIMARY KEY(collection,key))",
  );
  let v = empty();
  const d = decide(v, { type: "rules", args: [rules] }, 0, environment);
  v = commit(db, v, () => d.facts);
  const expected = snapshot(v);
  db.prepare("INSERT INTO projections VALUES ('events','junk','{}')").run();
  const rebuilt = evolve(empty(), readLog(db), db, true);
  assert.deepEqual(snapshot(rebuilt), expected);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM projections WHERE key='junk'").get()!.n, 0);
  db.close();
});

test("old logs with stale queued routing claim the current configuration and replay held versions", () => {
  let view = seeded();
  const log: Fact[] = [...decide(empty(), { type: "rules", args: [rules] }, 1, environment).facts];
  const act = (type: string, ...args: unknown[]) => {
    const decided = decide(view, { type, args }, 1000 + log.length, environment);
    log.push(...decided.facts);
    view = evolve(view, decided.facts);
    return decided.value;
  };
  try {
    act("ingest", "app", { id: "old-log", type: "feedback.new" });
    const changed = structuredClone(rules);
    changed.rules[0].to = "a2";
    changed.rules[0].cwd = "/new-project";
    const version = view.seq + 1;
    // Before this fix, a rules fact replaced only config and left queued assignments untouched.
    const oldFact: Fact = {
      version: 1,
      seq: version,
      at: 1002,
      type: "rules",
      changes: [{ table: "config", key: "rules", row: { value: changed, version } }],
    };
    log.push(oldFact);
    view = evolve(view, [oldFact]);
    assert.equal(act("claimNext", "w1", "old-worker"), null);
    const first = act("claimNext", "w2", "held");
    assert.equal(first.agent.id, "a2");
    assert.equal(first.rule.cwd, "/new-project");
    act("rules", rules);
    const rebuilt = evolve(empty(), log);
    try {
      const again = decide(rebuilt, { type: "claimNext", args: ["w2", "held"] }, 2000, environment).value;
      assert.deepEqual({ ...again, token: first.token }, first);
    } finally {
      rebuilt.close();
    }
  } finally {
    view.close();
  }
});
test("a queued run whose rule is gone stops and says so, and the rest of the queue goes on", () => {
  let view = seeded();
  const act = (type: string, ...args: unknown[]) => {
    const decided = decide(view, { type, args }, 1000, environment);
    view = evolve(view, decided.facts);
    return decided.value;
  };
  try {
    act("ingest", "app", { id: "gone", type: "feedback.new" });
    act("ingest", "ops", { id: "stays", type: "alert.raised" });
    const [gone] = rows(view, "runs", { rule: "意见" });
    const [stays] = rows(view, "runs", { rule: "告警" });
    const renamed = structuredClone(rules);
    renamed.rules.find((rule: { name: string }) => rule.name === "意见")!.name = "新名字";
    act("rules", renamed);
    const stopped = view.get("runs", gone.id)!;
    assert.equal(stopped.state, "cancelled");
    assert.ok(stopped.finished_at);
    assert.match(stopped.summary, /规则「意见」不在了/);
    assert.equal(view.get("runs", stays.id)!.state, "queued");
    const open = rows(view, "cards", { state: "open" });
    assert.deepEqual(
      open.map((card) => card.key),
      [`run:${gone.id}:rule-gone`],
    );
    assert.match(open[0].text, /规则「意见」不在了/);
    act("rules", renamed);
    assert.equal(rows(view, "cards", { state: "open" }).length, 1, "told once");
  } finally {
    view.close();
  }
});
test("a run already going when its rule goes finishes normally, and if it fails it stops rather than waits", () => {
  let view = seeded();
  const act = (type: string, ...args: unknown[]) => {
    const decided = decide(view, { type, args }, 1000, environment);
    view = evolve(view, decided.facts);
    return decided.value;
  };
  try {
    act("ingest", "app", { id: "held", type: "feedback.new" });
    const job = act("claimNext", "w1", "claim");
    const renamed = structuredClone(rules);
    renamed.rules.find((rule: { name: string }) => rule.name === "意见")!.name = "新名字";
    act("rules", renamed);
    assert.equal(view.get("runs", job.run)!.state, "claimed");
    act("finish", job.run, job.token, { outcome: "failed", error: "没跑成" });
    const stopped = view.get("runs", job.run)!;
    assert.equal(stopped.state, "cancelled");
    assert.deepEqual([stopped.attempts, stopped.error, stopped.claim], [1, "没跑成", null]);
    assert.equal(rows(view, "cards", { key: `run:${job.run}:rule-gone` }).length, 1);
  } finally {
    view.close();
  }
});
test("a run stopped by its failed receipt keeps that receipt's usage, session and dedupe mark", () => {
  let view = seeded();
  const act = (type: string, ...args: unknown[]) => {
    const decided = decide(view, { type, args }, 1000, environment);
    view = evolve(view, decided.facts);
    return decided.value;
  };
  try {
    act("ingest", "app", { id: "held", type: "feedback.new" });
    const job = act("claimNext", "w1", "claim");
    const renamed = structuredClone(rules);
    renamed.rules.find((rule: { name: string }) => rule.name === "意见")!.name = "新名字";
    act("rules", renamed);
    const receipt = { outcome: "failed", error: "没跑成", session: "s1", usage: { input: 5 } };
    act("finish", job.run, job.token, receipt);
    const stopped = view.get("runs", job.run)!;
    assert.equal(stopped.state, "cancelled");
    assert.equal(stopped.session, "s1");
    assert.deepEqual(JSON.parse(stopped.usage).input, 5);
    assert.equal(act("finish", job.run, job.token, receipt).duplicate, true);
  } finally {
    view.close();
  }
});
test("facts replay the whole receipt with no capability plaintext", () => {
  let view = empty();
  const log: Fact[] = [];
  const act = (type: string, ...args: unknown[]) => {
    const d = decide(view, { type, args }, 1000 + log.length, environment);
    log.push(...d.facts);
    view = evolve(view, d.facts);
    return d.value;
  };
  act("rules", rules);
  act("ingest", "app", { id: "1", type: "feedback.new" });
  const job = act("claimNext", "w1", "claim");
  act("finish", job.run, job.token, {
    outcome: "done",
    ask: [{ title: "选一个", text: "内容", options: ["甲", "乙"] }],
  });
  assert.deepEqual(snapshot(evolve(empty(), log)), snapshot(view));
  assert.ok(!JSON.stringify(log).includes(job.token));
  assert.ok(!JSON.stringify(log).includes(environment.secret));
  assert.equal(rows(view, "cards").length, 1);
});

test("one due table retains cron, retry, timer and offline deadlines without periodic ticking", () => {
  let v = seeded();
  const act = (type: string, args: unknown[], now: number) => {
    const d = decide(v, { type, args }, now, environment);
    v = evolve(v, d.facts);
    return d.value;
  };
  act("tick", [], 1000);
  assert.ok(rows(v, "due").some((d) => d.kind === "cron"));
  act("ingest", ["app", { id: "1", type: "feedback.new" }], 1000);
  const job = act("claimNext", ["w1", "c"], 1000);
  act("finish", [job.run, job.token, { outcome: "failed" }], 2000);
  assert.ok(rows(v, "due").some((d) => d.kind === "retry" && d.at === 302000));
  assert.deepEqual(decide(v, { type: "tick", args: [] }, 2000, environment).facts, []);
});

test("a schedule whose rule is gone or no longer scheduled stops coming due", () => {
  let v = seeded();
  const act = (type: string, args: unknown[], now: number) => {
    v = evolve(v, decide(v, { type, args }, now, environment).facts);
  };
  act("tick", [], 1000);
  const schedules = () =>
    rows(v, "due")
      .filter((due) => due.kind === "cron")
      .map((due) => due.key)
      .sort();
  assert.deepEqual(schedules(), ["巡检", "早报"].sort());
  const withoutMorning = rules.rules.filter((rule) => rule.name !== "早报");
  act("rules", [{ ...rules, rules: withoutMorning }], 2000);
  assert.deepEqual(schedules(), ["巡检"]);
  const unscheduled = withoutMorning.map((rule) =>
    rule.name === "巡检" ? { ...rule, when: { source: "app", types: ["poll.done"] } } : rule,
  );
  act("rules", [{ ...rules, rules: unscheduled }], 3000);
  assert.deepEqual(schedules(), []);
  // Nothing moves their next time on any more, so past it they would be overdue on every tick from then on.
  act("tick", [], 30 * 24 * 3600_000);
  assert.deepEqual(schedules(), []);
});

test("a card's resend comes due at its time, and stops being due once that's passed, it's sent, or it's given up", () => {
  let v = seeded();
  const act = (type: string, args: unknown[], now: number) => {
    const d = decide(v, { type, args }, now, environment);
    v = evolve(v, d.facts);
    return d.value;
  };
  const { card } = act("tell", ["k", "应用", "周报"], at(0));
  const resendAt = (id = card) => rows(v, "due").find((due) => due.kind === "delivery" && due.key === `${id}:chat`)?.at;
  // Taken and not heard of again: a channel waiting for the next card wakes when this one can go again. The channel may be
  // gone by then, so the deadline can't stay behind.
  act("nextCard", ["chat"], at(0));
  assert.equal(resendAt(), at(1));
  act("tick", [], at(1));
  assert.equal(resendAt(), undefined);
  const tries = [1, 3, 7, 15, 25, 35, 45, 55];
  for (const [n, minute] of tries.entries()) {
    const { version } = act("nextCard", ["chat"], at(minute));
    act("failed", ["chat", card, version, "挂了"], at(minute));
    assert.equal(resendAt(), n + 1 < tries.length ? at(tries[n + 1]) : undefined, `after the try at ${minute}`);
  }
  const { card: sent } = act("tell", ["k2", "应用", "月报"], at(60));
  const { version } = act("nextCard", ["chat"], at(60));
  assert.equal(resendAt(sent), at(61));
  act("delivered", ["chat", sent, version, "om_1"], at(60));
  assert.equal(resendAt(sent), undefined);
});

test("an input the kernel doesn't have is refused, even one named like something every object has", () => {
  const view = seeded();
  for (const type of ["nope", "constructor", "toString"])
    assert.throws(() => decide(view, { type, args: [] }, 1000, environment), InputError, type);
});

test("receipt normalization leaves the request unchanged and can be decided twice", () => {
  let v = seeded();
  const act = (type: string, ...args: unknown[]) => {
    const d = decide(v, { type, args }, 1000, environment);
    v = evolve(v, d.facts);
    return d.value;
  };
  act("ingest", "app", { id: "x", type: "feedback.new" });
  const job = act("claimNext", "w1", "c");
  const input = {
    type: "finish",
    args: [job.run, job.token, { outcome: "done", events: [{ id: "next", type: "feedback.new" }] }],
  };
  const before = structuredClone(input);
  const a = decide(v, input, 2000, environment);
  const b = decide(v, input, 2000, environment);
  assert.deepEqual(input, before);
  assert.deepEqual(a, b);
});

/** A hub with one worker and one rule, and what its card about that worker not connecting has come to. */
function workerAway() {
  const local = { ...rules, rules: rules.rules.filter((r) => "source" in r.when) };
  let v = evolve(empty(), decide(empty(), { type: "rules", args: [local] }, 0, environment).facts);
  const act = (type: string, args: unknown[], now: number) => {
    const d = decide(v, { type, args }, now, environment);
    v = evolve(v, d.facts);
    return d.value;
  };
  return {
    act,
    cards: () => rows(v, "cards").filter((card) => card.key.startsWith("worker:w1:offline:")),
    // The shell's only timer is what's here, so a card nothing comes due for is a card that never appears.
    dueBy: (now: number) => rows(v, "due").filter((due) => due.kind === "offline" && due.at <= now),
    waiting: () => rows(v, "runs", { state: "queued" }),
  };
}

test("the card about a worker not connecting, once closed, stays closed until the worker has been back", () => {
  const { act, cards, dueBy } = workerAway();
  act("heartbeat", ["w1", []], 0);
  act("ingest", ["app", { id: "x", type: "feedback.new" }], 0);
  assert.deepEqual(dueBy(600000), []);
  assert.equal(dueBy(600001).length, 1);
  act("tick", [], 600001);
  assert.equal(cards().length, 1);
  assert.deepEqual(dueBy(Infinity), [], "told, so nothing is left to come due");
  act("answer", [cards()[0].id, { by: "本人" }], 600002);
  assert.deepEqual(dueBy(Infinity), [], "nothing comes due to bring it back");
  act("tick", [], 700000);
  assert.equal(cards().length, 1, "told once for this work");
  act("heartbeat", ["w1", []], 800000);
  assert.equal(dueBy(800000 + 600000).length, 0);
  assert.equal(dueBy(800000 + 600001).length, 1, "back and gone again comes due by itself");
  act("tick", [], 800000 + 600001);
  assert.equal(cards().length, 2, "a new absence is told");
  assert.equal(cards().filter((card) => card.state === "open").length, 1);
});

test("the card about a worker that has never connected, once closed, stays closed too", () => {
  const { act, cards, dueBy } = workerAway();
  act("ingest", ["app", { id: "x", type: "feedback.new" }], 0);
  assert.deepEqual(dueBy(600000), []);
  assert.equal(dueBy(600001).length, 1);
  act("tick", [], 600001);
  assert.equal(cards().length, 1);
  act("answer", [cards()[0].id, { by: "本人" }], 600002);
  assert.deepEqual(dueBy(Infinity), []);
  act("tick", [], 700000);
  assert.equal(cards().length, 1);
  assert.equal(cards()[0].state, "closed");
});

test("work that comes after the card was closed is told, whether or not the worker was ever seen", () => {
  for (const seen of [true, false]) {
    const { act, cards, dueBy, waiting } = workerAway();
    if (seen) act("heartbeat", ["w1", []], 0);
    act("ingest", ["app", { id: "x", type: "feedback.new" }], 0);
    act("tick", [], 600001);
    act("answer", [cards()[0].id, { by: "本人" }], 600002);
    act("cancel", [waiting()[0].id], 700000);
    act("tick", [], 700000);
    assert.equal(cards().length, 1, "nothing is waiting");

    const later = 7 * 24 * 60 * 60_000;
    act("ingest", ["app", { id: "y", type: "feedback.new" }], later);
    const whenDue = seen ? later : later + 600001;
    assert.deepEqual(dueBy(whenDue - 1), []);
    assert.equal(dueBy(whenDue).length, 1, "it comes due by itself");
    act("tick", [], whenDue);
    assert.equal(cards().length, 2);
    assert.equal(cards()[1].state, "open");
    assert.match(cards()[1].text, /1 件任务/);
    assert.deepEqual(dueBy(Infinity), [], "told, so nothing is left to come due");
  }
});

test("more for the work the owner already closed the card on isn't news", () => {
  const { act, cards, dueBy } = workerAway();
  act("heartbeat", ["w1", []], 0);
  act("ingest", ["app", { id: "x", type: "feedback.new" }], 0);
  act("tick", [], 600001);
  act("answer", [cards()[0].id, { by: "本人" }], 600002);
  act("ingest", ["app", { id: "y", type: "feedback.new" }], 700000);
  assert.deepEqual(dueBy(Infinity), []);
  act("tick", [], 700000);
  assert.equal(cards().length, 1);
});

test("a worker heartbeat closes its offline card with no later scheduled work", () => {
  const local = { ...rules, rules: rules.rules.filter((r) => "source" in r.when) };
  let v = evolve(empty(), decide(empty(), { type: "rules", args: [local] }, 0, environment).facts);
  const act = (type: string, args: unknown[], now: number) => {
    const d = decide(v, { type, args }, now, environment);
    v = evolve(v, d.facts);
    return d.value;
  };
  act("ingest", ["app", { id: "x", type: "feedback.new" }], 0);
  act("tick", [], 600001);
  assert.equal(rows(v, "cards").filter((c) => c.state === "open").length, 1);
  act("heartbeat", ["w1", []], 610000);
  assert.equal(rows(v, "cards").filter((c) => c.state === "open").length, 0);
  const job = act("claimNext", ["w1", "back"], 610000);
  act("finish", [job.run, job.token, { outcome: "done" }], 610001);
  assert.deepEqual(rows(v, "due"), []);
});

test("rebuilding locks the log snapshot and projection into one transaction", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const store = await import("../kernel/store.ts");
  const directory = mkdtempSync(`${tmpdir()}/hub-rebuild-`);
  const db = new DatabaseSync(`${directory}/hub.db`);
  const other = new DatabaseSync(`${directory}/hub.db`);
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE facts(seq INTEGER PRIMARY KEY,fact TEXT); CREATE TABLE projections(collection TEXT,key TEXT,data TEXT,PRIMARY KEY(collection,key));",
    );
    let v = store.commit(db, empty(), () => decide(empty(), { type: "rules", args: [rules] }, 0, environment).facts);
    const concurrent = decide(
      v,
      { type: "ingest", args: ["app", { id: "during", type: "feedback.new" }] },
      1000,
      environment,
    );
    let attempted = false;
    const proxy = new Proxy(db, {
      get(target, key) {
        if (key === "exec")
          return (sql: string) => {
            target.exec(sql);
            if (sql === "DELETE FROM projections") {
              attempted = true;
              assert.throws(() => store.commit(other, v, () => concurrent.facts), /locked/);
            }
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    assert.equal(typeof store.rebuild, "function");
    const expected = snapshot(v);
    assert.deepEqual(snapshot(store.rebuild(proxy)), expected);
    assert.ok(attempted);
    v = store.commit(other, v, () => concurrent.facts);
    const updated = snapshot(v);
    assert.deepEqual(snapshot(store.rebuild(db)), updated);
  } finally {
    db.close();
    other.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("source IDs cannot collide with the events generated by answers or timers", () => {
  let v = seeded();
  const act = (type: string, args: unknown[], now = 1000) => {
    const d = decide(v, { type, args }, now, environment);
    v = evolve(v, d.facts);
    return d.value;
  };
  act("ingest", ["app", { id: "start", type: "feedback.new" }]);
  const job = act("claimNext", ["w1", "start"]);
  act("finish", [
    job.run,
    job.token,
    {
      outcome: "done",
      ask: [{ title: "选择", text: "内容", options: ["甲", "乙"] }],
      later: [{ key: "check", at: "1970-01-01T00:00:02Z", about: "核实" }],
    },
  ]);
  for (const id of ["card:1", "card:1:1", "timer:1"]) act("ingest", ["app", { id, type: "unmatched" }]);
  act("answer", [1, { choice: 0 }]);
  act("tick", [], 2000);
  const events = rows(v, "events");
  assert.equal(new Set(events.map((e) => `${e.source}:${e.key}`)).size, events.length);
  assert.equal(events.filter((e) => e.type === "card.answered").length, 1);
  assert.equal(events.filter((e) => e.type === "timer.due").length, 1);
});

test("quiet notices are absent from channel delivery", () => {
  let v = seeded();
  v = evolve(
    v,
    decide(
      v,
      { type: "createCard", args: [{ key: "quiet", kind: "notice", title: "静默", text: "记录", quiet: true }] },
      1000,
      environment,
    ).facts,
  );
  assert.equal(decide(v, { type: "nextCard", args: ["chat"] }, 1000, environment).value, null);
});

test("a stale writer receives a conflict and cannot change the committed view", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { commit, readLog } = await import("../kernel/store.ts");
  const { Conflict } = await import("../kernel/errors.ts");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE facts(seq INTEGER PRIMARY KEY,fact TEXT); CREATE TABLE projections(collection TEXT,key TEXT,data TEXT,PRIMARY KEY(collection,key));",
    );
    const initial = commit(db, empty(), () => decide(empty(), { type: "rules", args: [rules] }, 0, environment).facts);
    const changed = commit(
      db,
      initial,
      () =>
        decide(initial, { type: "ingest", args: ["app", { id: "first", type: "feedback.new" }] }, 1000, environment)
          .facts,
    );
    const stale = decide(
      initial,
      { type: "ingest", args: ["app", { id: "second", type: "feedback.new" }] },
      1000,
      environment,
    );
    assert.throws(() => commit(db, initial, () => stale.facts), Conflict);
    assert.deepEqual(snapshot(evolve(empty(), readLog(db))), snapshot(changed));
  } finally {
    db.close();
  }
});
