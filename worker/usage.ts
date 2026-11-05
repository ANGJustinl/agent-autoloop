// A session's running total isn't what a launch used; how far the total rose during the launch is. The launch keeps
// where the total stood when it began, because a worker that stops after moving this file on reads that launch again.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  lstatSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { HOME } from "../host/home.ts";
import type { Usage } from "./agents.ts";

const DIRECTORY = path.join(HOME, "worker", "usage");
const FIELDS = ["input", "output", "cached", "cost"] as const;
const KEEP_DAYS = 90;

// A session's name comes from the agent program, so it isn't used as a file name.
const file = (adapter: string, session: string) => {
  const name = createHash("sha256")
    .update(JSON.stringify([adapter, session]))
    .digest("hex");
  return path.join(DIRECTORY, `${name}.json`);
};

export function loadUsage(adapter: string, session: string): Usage | undefined {
  try {
    return JSON.parse(readFileSync(file(adapter, session), "utf8"));
  } catch {
    return undefined;
  }
}

export function saveUsage(adapter: string, session: string, usage: Usage) {
  mkdirSync(DIRECTORY, { recursive: true, mode: 0o700 });
  const target = file(adapter, session);
  writeFileSync(`${target}.tmp`, JSON.stringify(usage), { mode: 0o600 });
  renameSync(`${target}.tmp`, target);
}

/** A session going on after this long reports its next launch as unknown, the same as any it has no total for. */
export function forgetOldUsage(moment: number) {
  if (!existsSync(DIRECTORY)) return;
  for (const name of readdirSync(DIRECTORY)) {
    const target = path.join(DIRECTORY, name);
    if (moment - lstatSync(target).mtimeMs > KEEP_DAYS * 24 * 3600_000)
      rmSync(target, { recursive: true, force: true });
  }
}

/** With no idea where a total began, or one that fell, what the launch used is unknown: neither nothing nor everything. */
export function usageDelta(total: Usage, baseline: Usage | undefined): Usage | undefined {
  if (!baseline) return undefined;
  const rise: Usage = {};
  for (const field of FIELDS) {
    const now = total[field];
    const before = baseline[field];
    if (now === undefined || before === undefined) continue;
    if (now < before) return undefined;
    rise[field] = now - before;
  }
  return Object.keys(rise).length ? rise : undefined;
}
