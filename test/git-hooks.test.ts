// Seam: the process. `.githooks/pre-commit` runs as git runs it (bash, cwd = the repo root), with a PATH that holds no
// gitleaks: the hook must refuse the commit, not let it through unscanned. The scan itself is gitleaks', checked by the
// `secrets` job of CI, which has the binary; this test stays offline and needs none.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const HOOK = join(ROOT, ".githooks", "pre-commit");

let bin: string | undefined;
afterEach(() => {
  if (bin) rmSync(bin, { recursive: true, force: true });
  bin = undefined;
});

/** The absolute path of a command on the test's own PATH. */
const which = (name: string) => spawnSync("bash", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();

test("the pre-commit hook refuses the commit with an error: line when gitleaks is not on the PATH", () => {
  bin = mkdtempSync(join(tmpdir(), "wf-git-hooks-"));
  symlinkSync(which("dirname"), join(bin, "dirname")); // the only external command the hook needs before gitleaks
  const r = spawnSync(which("bash"), [HOOK], { cwd: ROOT, env: { PATH: bin }, encoding: "utf8" });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /^error: gitleaks is not on the PATH/);
});
