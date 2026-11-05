// Reading the command line: `init --help` used to install instead of printing how to use it, and a misspelt `--port`
// installed with the default in silence. Both are found here by running the real program in a home of its own and
// looking at what it wrote. Nothing is installed, no service is touched and no Agent is called.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";

const program = join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-cli-flags-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let homes = 0;
type Ran = { code: number; stdout: string; stderr: string; home: string };

/** One command, the way a person types it, in a home nothing has been installed into yet. */
async function run(args: string[]): Promise<Ran> {
  const home = join(dir, `home-${++homes}`);
  try {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", program, ...args],
      { env: { ...process.env, AGENT_AUTOLOOP_HOME: home } },
    );
    return { code: 0, stdout, stderr, home };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "", home };
  }
}

test("init --help says how to use it and installs nothing", async () => {
  const ran = await run(["init", "--help"]);
  assert.equal(ran.code, 0);
  assert.match(ran.stdout, /用法：agent-autoloop init/);
  assert.equal(existsSync(join(ran.home, "config.json")), false);
});

test("init -h does the same", async () => {
  const ran = await run(["init", "-h"]);
  assert.equal(ran.code, 0);
  assert.match(ran.stdout, /--no-service/);
  assert.equal(existsSync(join(ran.home, "config.json")), false);
});

test("a flag init does not read stops it instead of installing with the default", async () => {
  const ran = await run(["init", "--prot", "3360", "--no-service"]);
  assert.equal(ran.code, 1);
  assert.match(ran.stderr, /不认识的参数：--prot/);
  assert.equal(existsSync(join(ran.home, "config.json")), false);
});

test("the flags init does read still reach the config", async () => {
  const ran = await run(["init", "--command", "echo {prompt}", "--port", "3361", "--no-service"]);
  assert.equal(ran.code, 0, ran.stderr);
  const config = JSON.parse(readFileSync(join(ran.home, "config.json"), "utf8")) as { url: string };
  assert.equal(config.url, "http://127.0.0.1:3361");
});

test("try --help says how to use it and runs nothing", async () => {
  const ran = await run(["try", "--help"]);
  assert.equal(ran.code, 0);
  assert.match(ran.stdout, /用法：agent-autoloop try/);
});
