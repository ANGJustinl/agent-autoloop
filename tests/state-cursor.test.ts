// Failure modes: a state snapshot has no log position, or a writer commits between its queries so its cursor describes
// different facts from the returned tasks and totals. Pagination must retain the same snapshot contract.
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { decide } from "../kernel/decide.ts";
import { credential, digest } from "../kernel/credentials.ts";
import { commitLatest } from "../kernel/store.ts";

const home = mkdtempSync(join(tmpdir(), "agent-autoloop-state-cursor-"));
process.env.AGENT_AUTOLOOP_HOME = home;
process.env.AGENT_AUTOLOOP_RULES = join(import.meta.dirname, "rules.fixture.json");
const hub = await import("../host/runtime.ts");
const other = new DatabaseSync(join(home, "hub.db"));
other.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000");
other.function("card_token", { deterministic: true }, (id, at) => credential(hub.environment, "card", id, at));
other.function("card_hash", { deterministic: true }, (id, at) => digest(credential(hub.environment, "card", id, at)));
after(() => {
  other.close();
  hub.db.close();
  rmSync(home, { recursive: true, force: true });
});

test("state and its cursor see one snapshot while another connection commits", () => {
  const before = hub.stateOf();
  const cursor = hub.getView().seq;
  const format = hub.getView().format;
  const prepare = hub.db.prepare.bind(hub.db);
  let injected = false;
  hub.db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (!sql.includes("SELECT kind, name, seen_at FROM seen")) return statement;
    return new Proxy(statement, {
      get(target, key) {
        if (key === "all") {
          return (...args: any[]) => {
            const rows = target.all(...args);
            if (!injected) {
              injected = true;
              commitLatest(
                other,
                format,
                (view) =>
                  decide(
                    view,
                    { type: "ingest", args: ["app", { id: "during-state", type: "feedback.new", subject: "same" }] },
                    Date.now(),
                    hub.environment,
                  ).facts,
              );
            }
            return rows;
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof hub.db.prepare;
  let snapshot;
  try {
    snapshot = hub.stateOf();
  } finally {
    hub.db.prepare = prepare;
  }
  assert.equal(injected, true, "the writer actually committed between state queries");
  assert.equal(snapshot.cursor, cursor);
  assert.equal(snapshot.totals.queued, before.totals.queued);
  assert.deepEqual(snapshot.runs, before.runs);
  const latest = hub.stateOf();
  assert.ok(latest.cursor > cursor);
  assert.equal(latest.totals.queued, before.totals.queued + 1);
  assert.equal(hub.stateOf(Date.now(), latest.runs[0].id + 1).cursor, latest.cursor);
});
