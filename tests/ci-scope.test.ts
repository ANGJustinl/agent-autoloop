// How much CI a change gets. Failure cases: a change to kernel code skips the short simulation; code, or text a test reads,
// counts as text and runs nothing; a file nobody has sorted out yet skips anything; a move out of kernel/ counts only where
// it landed; what reaches main skips the full run, so a commit whose run was cancelled or replaced is never checked; a diff
// that can't be read means less checking rather than more.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

const script = join(import.meta.dirname, "..", "scripts", "ci-scope.sh");
const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-ci-scope-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let repos = 0;
/** A repository whose HEAD is what GitHub checks out for a PR: a merge of the change into main. */
function merged(change: (root: string) => void) {
  const root = join(dir, `repo-${++repos}`);
  mkdirSync(root);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: root,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      stdio: "ignore",
    });
  git("init", "-q", "-b", "main");
  write(root, "kernel/moved.ts");
  git("add", "-A");
  git("commit", "-q", "-m", "first");
  git("switch", "-q", "-c", "change");
  change(root);
  git("add", "-A");
  git("commit", "-q", "-m", "change");
  git("switch", "-q", "main");
  git("merge", "-q", "--no-ff", "-m", "merge", "change");
  return root;
}

function write(root: string, file: string) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), `${repos} ${file}\n`);
}

function scope(root: string, event = "pull_request") {
  const ran = spawnSync("sh", [script], {
    cwd: root,
    env: { ...process.env, GITHUB_EVENT_NAME: event },
    encoding: "utf8",
  });
  assert.equal(ran.status, 0, ran.stderr);
  return ran.stdout.trim();
}

const touching = (...files: string[]) =>
  merged((root) => {
    for (const file of files) write(root, file);
  });

for (const [files, expected] of [
  [["README.md"], "docs"],
  [["README.en.md", "INSTALL.md", "SECURITY.md", "CONTRIBUTING.md", "AGENTS.md", "LICENSE"], "docs"],
  [["docs/protocol.md", ".github/pull_request_template.md"], "docs"],
  [["docs/plugins.md"], "normal"],
  [["worker/worker.ts", "cli/main.ts", "host/up.ts", "plugins/feishu/channel.ts", "tests/http.test.ts"], "normal"],
  [
    ["examples/recipes/x/README.md", "skills/agent-autoloop/SKILL.md", "scripts/x.sh", "install.sh", "bin/x.ts"],
    "normal",
  ],
  [["kernel/decide.ts"], "kernel"],
  [["protocol/rules.ts"], "kernel"],
  [["README.md", "worker/worker.ts", "kernel/decide.ts"], "kernel"],
  [["sim/random.ts"], "full"],
  [["tests/simulation.test.ts"], "full"],
  [["package.json"], "full"],
  [["package-lock.json"], "full"],
  [[".github/workflows/check.yml"], "full"],
  [["somewhere/new.ts"], "full"],
  [["README.md", "kernel/decide.ts", "somewhere/new.ts"], "full"],
] as const) {
  test(`a PR changing ${files.join(", ")} gets ${expected}`, () => {
    assert.equal(scope(touching(...files)), `scope=${expected}`);
  });
}

test("moving a file out of kernel/ counts where it left", () => {
  const root = merged((at) => {
    mkdirSync(join(at, "docs"));
    renameSync(join(at, "kernel", "moved.ts"), join(at, "docs", "moved.md"));
  });
  assert.equal(scope(root), "scope=kernel");
});

test("whatever reaches main gets the full run, text included", () => {
  assert.equal(scope(touching("README.md"), "push"), "scope=full");
  assert.equal(scope(touching("worker/worker.ts"), "push"), "scope=full");
  assert.equal(scope(touching("README.md"), "workflow_dispatch"), "scope=full");
});

test("a diff that can't be read means the full run", () => {
  const root = join(dir, "first-commit");
  mkdirSync(root);
  assert.equal(scope(root), "scope=full", "not a repository at all");
  execFileSync("git", ["init", "-q"], { cwd: root });
  assert.equal(scope(root), "scope=full", "nothing committed");
});
