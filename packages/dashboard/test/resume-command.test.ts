// Seam: the command the "copy resume command" action puts on the clipboard. `resumeCommand(run)` is the line a person pastes in a
// terminal to continue a run that failed or was cancelled; `shellQuote` makes each word safe for the shell.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { ARGS_PLACEHOLDER, EMPTY_ARGS_HASH, argsHashOf, canResume, resumeCommand } from "../src/ui/resume-command.js";
import { shellQuote } from "../src/ui/shell.js";

test("the resume command restarts the same workflow over the same run, in the repo the run lives in", () => {
  assert.equal(
    resumeCommand({ workflow: "implement-issue", runId: "implement-issue-97f23b02", repo: "/home/me/code/app" }),
    `wf start implement-issue --args '${ARGS_PLACEHOLDER}' --resume implement-issue-97f23b02 --cwd /home/me/code/app`,
  );
});

test("the args are not in the log (only their hash), so the command says where they go instead of guessing them", () => {
  assert.match(ARGS_PLACEHOLDER, /args of the first start/);
  // pasted as it is, the placeholder is not JSON: the CLI refuses it before it starts anything
  assert.throws(() => JSON.parse(ARGS_PLACEHOLDER));
});

test("a run whose args were empty gets the exact command: the log's hash of the args says so", () => {
  assert.equal(
    resumeCommand({ workflow: "smoke", runId: "smoke-47b80529", repo: "/home/me/code/app", argsHash: EMPTY_ARGS_HASH }),
    "wf start smoke --args '{}' --resume smoke-47b80529 --cwd /home/me/code/app",
  );
  const other = resumeCommand({ workflow: "implement-issue", runId: "r-1", repo: "/r", argsHash: "0123456789abcdef" });
  assert.ok(other.includes(`'${ARGS_PLACEHOLDER}'`), "any other args are still the person's to fill in");
});

test("the args that count are those of the latest execution: a resume may have been started with others", () => {
  const events = [
    { type: "run-start", argsHash: EMPTY_ARGS_HASH },
    { type: "step-start" },
    { type: "run-end" },
    { type: "run-start", argsHash: "0123456789abcdef" },
  ];
  assert.equal(argsHashOf(events), "0123456789abcdef");
  assert.equal(argsHashOf(events.slice(0, 3)), EMPTY_ARGS_HASH);
  assert.equal(argsHashOf([{ type: "run-start" }, { type: "run-end" }]), undefined, "a log of an older kit may carry no hash");
  assert.equal(argsHashOf([]), undefined);
});

test("a path with spaces or quotes stays one word for the shell, and means the same path", () => {
  const repos = ["/home/me/my code/app", "/home/me/it's here", "/srv/$HOME/`x`/a;b", "/tmp/a b/c\"d"];
  for (const repo of repos) {
    const command = resumeCommand({ workflow: "smoke", runId: "smoke-1", repo });
    const printed = execFileSync("sh", ["-c", `set -- ${command.slice(command.indexOf("--cwd ") + 6)}; printf '%s' "$1"`], { encoding: "utf8" });
    assert.equal(printed, repo, command);
  }
});

test("shellQuote leaves a plain word alone and quotes anything the shell would act on", () => {
  assert.equal(shellQuote("run-1.a_b/c:d@e+f=g,h%i"), "run-1.a_b/c:d@e+f=g,h%i");
  for (const word of ["", "a b", "a;b", "$HOME", "a'b", "*", "a\nb", "é"]) {
    const printed = execFileSync("sh", ["-c", `printf '%s' ${shellQuote(word)}`], { encoding: "utf8" });
    assert.equal(printed, word, JSON.stringify(word));
  }
});

test("only a run that stopped without finishing can be resumed", () => {
  for (const status of ["failed", "cancelled"] as const) assert.equal(canResume(status), true, status);
  for (const status of ["running", "finished", "missing", undefined] as const) assert.equal(canResume(status), false, String(status));
});
