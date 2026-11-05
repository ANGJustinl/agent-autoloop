// Failure modes: a draft mutates its base; filtered reads miss changed/new rows or retain deleted rows;
// restart replays all history, reuses a deleted ID, or trusts an incompatible projection;
// opening a second process briefly drops views used by the running service;
// history size forces a point lookup to scan or populate a whole JavaScript table;
// a draft reads rows in another order than they'll read once committed, or still sees what it replaced or deleted in a
// table whose rows are keyed by their fields.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  empty,
  evolve,
  rows,
  snapshot,
  type Fact,
  type Match,
  type Row,
  type Table,
  type View,
} from "../kernel/evolve.ts";
import { commit, openView } from "../kernel/store.ts";

const fact = (seq: number, changes: Fact["changes"]): Fact => ({ version: 1, seq, at: seq, type: "fixture", changes });
test("a draft overlays filtered reads without changing the base", () => {
  const base = evolve(empty(), [
    fact(1, [
      { table: "cards", key: "1", row: { id: 1, state: "open" } },
      { table: "cards", key: "2", row: { id: 2, state: "closed" } },
    ]),
  ]);
  const before = snapshot(base);
  const draft = base.fork();
  draft.set("cards", "1", { id: 1, state: "closed" });
  draft.set("cards", "2", { id: 2, state: "open" });
  draft.set("cards", "3", { id: 3, state: "open" });
  assert.deepEqual(
    rows(draft, "cards", { state: "open" }).map((r) => r.id),
    [2, 3],
  );
  draft.set("cards", "2", null);
  assert.deepEqual(
    rows(draft, "cards", { state: "open" }).map((r) => r.id),
    [3],
  );
  assert.deepEqual(snapshot(base), before);
  base.close();
});

test("a draft reads what the view will read once it's committed, in the same order, whatever a table is keyed by", () => {
  const reads: [Table, Match?, number?, boolean?][] = [
    ["cards", { state: "open" }],
    ["cards", { state: "open" }, undefined, true],
    ["cards", { state: "open" }, 2, true],
  ];
  const seed: Fact["changes"] = [2, 9, 10, 11].map((id) => ({
    table: "cards",
    key: String(id),
    row: { id, state: "open" },
  }));
  const changes: Fact["changes"] = [
    { table: "cards", key: "9", row: { id: 9, state: "closed" } },
    { table: "cards", key: "100", row: { id: 100, state: "open" } },
    { table: "cards", key: "2", row: null },
  ];
  // A row of one of these is stored under a key made from its fields. The new row sorts ahead of the ones already there.
  const keyed: [Table, (name: string) => [string, Row]][] = [
    ["run_events", (name) => [`1:${name}`, { run_id: 1, event_id: name }]],
    ["deliveries", (name) => [`1:${name}`, { card_id: 1, channel: name }]],
    ["schedules", (name) => [name, { rule: name }]],
    ["seen", (name) => [`worker:${name}`, { kind: "worker", name }]],
    ["keys", (name) => [`source:${name}`, { kind: "source", name }]],
    ["due", (name) => [`retry:${name}`, { kind: "retry", key: name }]],
  ];
  for (const [table, row] of keyed) {
    const [gone, goneRow] = row("b");
    const [kept, keptRow] = row("c");
    const [added, addedRow] = row("a");
    seed.push({ table, key: gone, row: goneRow }, { table, key: kept, row: keptRow });
    changes.push(
      { table, key: gone, row: null },
      { table, key: kept, row: { ...keptRow, changed: true } },
      { table, key: added, row: addedRow },
    );
    reads.push([table], [table, {}, undefined, true], [table, {}, 1]);
  }
  const base = evolve(empty(), [fact(1, seed)]);
  const draft = base.fork();
  for (const { table, key, row } of changes) draft.set(table, key, row);
  const through = (view: View) =>
    reads.map(([table, match, limit, reverse]) => [table, rows(view, table, match, limit, reverse)]);
  const seen = through(draft);
  assert.deepEqual(seen, through(evolve(base, [fact(2, changes)])));
  base.close();
});

test("restart reuses projections and preserves deleted ID high water", () => {
  const db = new DatabaseSync(":memory:");
  let view = openView(db, "format-a");
  view = commit(db, view, () => [fact(1, [{ table: "timers", key: "9", row: { id: 9 } }])]);
  view = commit(db, view, () => [
    fact(2, [
      { table: "timers", key: "9", row: null },
      { table: "events", key: "1", row: { id: 1 } },
    ]),
  ]);
  db.exec(
    "CREATE TEMP TRIGGER no_reset BEFORE DELETE ON projections BEGIN SELECT RAISE(ABORT,'unexpected replay'); END",
  );
  const reopened = openView(db, "format-a");
  assert.equal(reopened.seq, 2);
  assert.equal(reopened.next.timers, 9);
  assert.deepEqual(snapshot(reopened), snapshot(view));
  db.exec("DROP TRIGGER no_reset");
  const expected = snapshot(reopened);
  assert.deepEqual(snapshot(openView(db, "format-b")), expected);
  db.close();
});

test("opening another process never exposes a missing SQL view", async () => {
  const { setup } = await import("./helpers.ts");
  const { join } = await import("node:path");
  const home = setup("projection-open");
  const other = new DatabaseSync(join(home, "hub.db"));
  other.exec(
    "CREATE TABLE projections(collection TEXT,key TEXT,data TEXT,PRIMARY KEY(collection,key)); CREATE VIEW cards AS SELECT data FROM projections WHERE collection='cards'",
  );
  other.function("card_token", (_id, _at) => "");
  const exec = DatabaseSync.prototype.exec;
  let checked = false;
  DatabaseSync.prototype.exec = function (sql) {
    exec.call(this, sql);
    if (sql.includes("DROP VIEW IF EXISTS cards")) {
      checked = true;
      assert.equal(other.prepare("SELECT COUNT(*) AS n FROM cards").get()!.n, 0);
    }
  };
  try {
    const hub = await import("../host/runtime.ts");
    hub.db.close();
    assert.ok(checked);
  } finally {
    DatabaseSync.prototype.exec = exec;
    other.close();
  }
});
