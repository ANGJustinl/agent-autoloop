// The clock's events. Failure cases: a schedule fires when it isn't due, twice for one moment, or on a schedule that has
// just been changed; a hub asleep through several runs each of them (only the latest is owed) or none; a timer fires early,
// twice, or doesn't wake its own thread in its session; writing the same key makes a second timer; cancelling leaves it; a
// fired timer stops a new one being set under its key; a bad rules file stops the hub or isn't told; told every tick, or
// the card stays after it's fixed; a rules file that is gone stops the hub, or isn't picked up when it's moved back, or
// brings back a card the owner closed at every tick.
// Cancelling a timer that isn't waiting spoils the receipt it's in; a timer coming due after its rule has gone stops the
// clock for everything else, or starts something; a clock set back runs the same scheduled moment a second time.
import assert from "node:assert/strict";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { at, setup } from "./helpers.ts";

const home = setup("schedule");
const rulesFile = join(home, "rules.json");
writeFileSync(rulesFile, readFileSync(process.env.AGENT_AUTOLOOP_RULES!, "utf8"));
process.env.AGENT_AUTOLOOP_RULES = rulesFile;
const { execute, getView, tick } = await import("../host/runtime.ts");
const { ingest } = await import("../host/runtime.ts");
const { claimNext, finish, started, heartbeat } = await import("../host/runtime.ts");
const { all, one, run } = await import("./storage.ts");

const clean = () => {
  for (const table of ["run_events", "runs", "events", "seen", "cards", "deliveries", "timers", "schedules"])
    run(`DELETE FROM ${table}`);
};
const ticks = () =>
  all<{ key: string }>("SELECT key FROM events WHERE type = 'schedule.tick' ORDER BY id").map((e) => e.key);
const claim = (worker: string, now: number) => claimNext(worker, `c${Math.random()}`, now);
const keepWorkersHere = (now: number) => {
  heartbeat("w1", [], now);
  heartbeat("w2", [], now);
};

test("a schedule fires once when it's due, as an event of its own rule", () => {
  clean();
  // 10:00 in Shanghai at at(0): the five-minutely one is next due at 10:05, the morning one tomorrow.
  tick(at(0));
  assert.deepEqual(ticks(), []);
  tick(at(4));
  assert.deepEqual(ticks(), []);
  tick(at(5));
  assert.deepEqual(ticks(), ["巡检@2026-10-18T02:05:00.000Z"]);
  tick(at(5.5));
  assert.equal(ticks().length, 1);
  const job = claim("w1", at(6))!;
  assert.equal(job.rule.name, "巡检");
  assert.deepEqual(
    job.context.events.map((e) => [e.source, e.sourceName, e.type]),
    [["schedule", "定时", "schedule.tick"]],
  );
  assert.deepEqual(JSON.parse(one<{ routed: string }>("SELECT routed FROM events")!.routed), ["巡检"]);
});

test("a hub asleep through several owes only the latest", () => {
  clean();
  tick(at(0));
  tick(at(37));
  assert.deepEqual(ticks(), ["巡检@2026-10-18T02:35:00.000Z"]);
  tick(at(38));
  assert.equal(ticks().length, 1);
  tick(at(40));
  assert.equal(ticks().length, 2);
});

test("a schedule that changes starts counting from the change", () => {
  clean();
  tick(at(0));
  const changed = JSON.parse(readFileSync(rulesFile, "utf8"));
  changed.rules[4].when.cron = "0 12 * * *";
  writeFileSync(rulesFile, JSON.stringify(changed));
  tick(at(6));
  assert.deepEqual(ticks(), [], "the old time doesn't fire under the new schedule");
  tick(at(119));
  assert.deepEqual(ticks(), []);
  tick(at(120));
  assert.deepEqual(ticks(), ["巡检@2026-10-18T04:00:00.000Z"]);
  changed.rules[4].when.cron = "*/5 * * * *";
  writeFileSync(rulesFile, JSON.stringify(changed));
  tick(at(121));
});

test("a run's look-again fires once at its time, on its thread, in its session, with what it left", () => {
  clean();
  ingest("app", { id: "1", type: "feedback.new", subject: "#1" }, at(0));
  const job = claim("w1", at(0))!;
  started(job.run, job.token, { session: "s-1" }, at(0));
  finish(
    job.run,
    job.token,
    { outcome: "done", later: [{ key: "recheck", at: new Date(at(60)).toISOString(), about: "看原站恢复了没有" }] },
    at(1),
  );
  keepWorkersHere(at(59));
  tick(at(59));
  assert.equal(claim("w1", at(59)), null);
  keepWorkersHere(at(60));
  tick(at(60));
  tick(at(60.5));
  // 11:00 is also when the five-minutely rule comes due, on the same worker.
  const poll = claim("w1", at(61))!;
  assert.equal(poll.rule.name, "巡检");
  finish(poll.run, poll.token, { outcome: "nothing" }, at(61));
  const next = claim("w1", at(61))!;
  assert.equal(next.rule.name, "意见");
  assert.equal(next.session, "s-1");
  assert.deepEqual(
    next.context.events.map((e) => [e.type, e.subject]),
    [["timer.due", "#1"]],
  );
  assert.deepEqual(
    next.context.timers.map((t) => [t.key, t.about]),
    [["recheck", "看原站恢复了没有"]],
  );
  finish(
    next.run,
    next.token,
    { outcome: "nothing", later: [{ key: "recheck", at: new Date(at(120)).toISOString(), about: "再看一次" }] },
    at(62),
  );
  assert.equal(
    all("SELECT id FROM timers WHERE event_id IS NULL").length,
    1,
    "the fired one doesn't stop a new one under its key",
  );
});

test("the same key moves a timer; another thread has its own; a run sees what's waiting and can cancel it", () => {
  clean();
  const end = (n: number, now: number, later: object[]) => {
    ingest("app", { id: `${n}:${now}`, type: "feedback.new", subject: `#${n}` }, now);
    const job = claim("w1", now)!;
    const seen = job.context.waiting;
    finish(job.run, job.token, { outcome: "done", later }, now);
    return seen;
  };
  end(1, at(0), [{ key: "k", at: new Date(at(100)).toISOString(), about: "第一次" }]);
  const seen = end(1, at(1), [{ key: "k", at: new Date(at(200)).toISOString(), about: "改了" }]);
  assert.deepEqual(
    seen.map((t) => [t.key, t.about]),
    [["k", "第一次"]],
  );
  end(2, at(2), [{ key: "k", at: new Date(at(300)).toISOString(), about: "别的事项" }]);
  assert.deepEqual(
    all<{ lane: string; about: string; at: string }>("SELECT lane, about FROM timers ORDER BY id").map((t) => [
      t.lane,
      t.about,
    ]),
    [
      ["#1", "改了"],
      ["#2", "别的事项"],
    ],
  );
  end(1, at(3), [{ key: "k", cancel: true }]);
  assert.deepEqual(
    all<{ lane: string }>("SELECT lane FROM timers").map((t) => t.lane),
    ["#2"],
  );
});

test("cancelling a look-again that isn't waiting changes nothing, and the rest of the receipt counts", () => {
  clean();
  ingest("app", { id: "1", type: "feedback.new", subject: "#1" }, at(0));
  const job = claim("w1", at(0))!;
  const later = [
    { key: "never-set", cancel: true },
    { key: "kept", at: new Date(at(100)).toISOString(), about: "再看" },
  ];
  assert.deepEqual(finish(job.run, job.token, { outcome: "done", summary: "好了", later }, at(1)).rejected, []);
  assert.equal(one<{ state: string }>("SELECT state FROM runs WHERE id = ?", [job.run])!.state, "done");
  assert.deepEqual(
    all<{ key: string }>("SELECT key FROM timers").map((t) => t.key),
    ["kept"],
  );
});

test("a look-again coming due after its rule has gone is kept on record, starts nothing and doesn't stop the clock", () => {
  clean();
  ingest("app", { id: "1", type: "feedback.new", subject: "#1" }, at(0));
  const job = claim("w1", at(0))!;
  const later = [{ key: "recheck", at: new Date(at(60)).toISOString(), about: "看原站恢复了没有" }];
  finish(job.run, job.token, { outcome: "done", later }, at(1));
  const before = getView().get("config", "rules")!.value;
  const rules = before.rules.filter((rule: { name: string }) => rule.name !== "意见");
  execute("rules", [{ ...before, rules }], at(2));
  try {
    tick(at(60));
    const event = one<{ routed: string }>("SELECT routed FROM events WHERE type = 'timer.due'")!;
    assert.deepEqual(JSON.parse(event.routed), []);
    assert.deepEqual(all("SELECT id FROM timers WHERE event_id IS NULL"), [], "it doesn't come due again");
    assert.deepEqual(all("SELECT id FROM runs WHERE rule = '意见' AND state = 'queued'"), []);
  } finally {
    execute("rules", [before], at(61));
  }
});

test("a clock set back doesn't run the same scheduled moment twice, even with the schedule changed meanwhile", () => {
  clean();
  tick(at(0));
  tick(at(5));
  assert.deepEqual(ticks(), ["巡检@2026-10-18T02:05:00.000Z"]);
  const before = getView().get("config", "rules")!.value;
  const rules = before.rules.map((rule: { name: string }) =>
    rule.name === "巡检" ? { ...rule, when: { cron: "5 10 * * *" } } : rule,
  );
  // Back at 10:02, a schedule that also reads 10:05 starts counting from there.
  execute("rules", [{ ...before, rules }], at(2));
  try {
    tick(at(2));
    tick(at(5));
    assert.deepEqual(ticks(), ["巡检@2026-10-18T02:05:00.000Z"]);
  } finally {
    execute("rules", [before], at(6));
  }
});

test("a bad rules file keeps the hub going, says so once, and the card closes when it's fixed", () => {
  clean();
  const good = readFileSync(rulesFile, "utf8");
  const bad = JSON.parse(good);
  bad.rules[0].to = "nobody";
  writeFileSync(rulesFile, JSON.stringify(bad));
  const stamp = new Date(Date.now() + 2000);
  tick(at(0));
  tick(at(1));
  const cards = () => all<{ title: string; text: string; state: string }>("SELECT title, text, state FROM cards");
  assert.equal(cards().length, 1);
  assert.match(cards()[0].text, /nobody/);
  assert.equal(cards()[0].state, "open");
  writeFileSync(rulesFile, good);
  void stamp;
  tick(at(2));
  assert.equal(cards()[0].state, "closed");
});

test("a rules file that goes away keeps the hub going, says so once, and the card closes when it's back", () => {
  clean();
  const away = `${rulesFile}.away`;
  // Moving it back keeps its modification time, so coming back must not look like nothing changed.
  renameSync(rulesFile, away);
  tick(at(0));
  tick(at(1));
  const cards = () => all<{ text: string; state: string }>("SELECT text, state FROM cards");
  assert.equal(cards().length, 1);
  assert.match(cards()[0].text, /找不到/);
  assert.equal(cards()[0].state, "open");
  renameSync(away, rulesFile);
  tick(at(2));
  assert.equal(cards()[0].state, "closed");
});

test("a card closed while the rules file is still gone stays closed, and going again after it's back is said again", () => {
  clean();
  const away = `${rulesFile}.away`;
  const cards = () => all<{ id: number; state: string }>("SELECT id, state FROM cards ORDER BY id");
  renameSync(rulesFile, away);
  try {
    tick(at(0));
    assert.equal(cards().length, 1);
    execute("answer", [cards()[0].id, { by: "本人" }], at(1));
    tick(at(2));
    assert.equal(cards().length, 1, "the owner has heard");
    renameSync(away, rulesFile);
    tick(at(3));
    renameSync(rulesFile, away);
    tick(at(4));
    assert.equal(cards().length, 2);
  } finally {
    renameSync(away, rulesFile);
    tick(at(5));
  }
});
