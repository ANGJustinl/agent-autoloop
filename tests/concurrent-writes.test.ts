// Failure modes: a command writing to the database (`key new`) while the hub is writing fails with "the log has changed",
// or makes one of the hub's own writes fail, which in a timer would take the hub down.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("concurrent-writes");
const hub = await import("../host/runtime.ts");

const bin = join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
hub.addKey("source", "app");

function keyNew(name: string) {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", bin, "key", "new", "source", name], {
    env: { ...process.env, AGENT_AUTOLOOP_HOME: home },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let said = "";
  child.stderr.on("data", (chunk) => (said += chunk));
  return new Promise<string>((resolve) => child.on("exit", (code) => resolve(code ? said : "")));
}

test("commands and the hub can write at the same time", async () => {
  let running = true;
  const failures: string[] = [];
  const commands = Promise.all(Array.from({ length: 12 }, (_, i) => keyNew(`from-command-${i}`))).finally(() => {
    running = false;
  });
  let written = 0;
  while (running) {
    try {
      hub.ingest("app", { id: `event-${written++}`, type: "other.thing" });
    } catch (error) {
      failures.push(String(error));
    }
    // Not flat out: no real hub writes without a break, and on a slow disk that starves a waiting command past its 5 seconds.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(failures, [], "the hub's own writes");
  assert.deepEqual((await commands).filter(Boolean), [], "the commands' writes");
  assert.ok(written > 12, `the writes overlapped: ${written}`);
});
