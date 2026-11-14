// Seam: what `verify-sandbox` concludes from a measurement. `requireBubblewrap`, `probeCallsFrom`, `judgeProbe` and `sandboxReport`
// (scripts/verify/verify-sandbox.ts) are called with a run's evidence as plain data: nothing is stubbed. What the real SDK sandbox
// blocks is the workflow's own job (opt-in, capped, scripts/verify/README.md), so the cases here pin what a measurement has to say
// for the issue #62 gate to read "all three attempts blocked", not what the sandbox does. The tool outputs are written in the shape
// the engine logs for a shell call (`exit <code>`, then stdout, then `[stderr]`).
process.env.WF_METRICS = "off";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type Evidence, judgeProbe, markerOf, probeCallsFrom, probeCommands, requireBubblewrap, sandboxReport, stepContent } from "../scripts/verify/verify-sandbox.js";

const TOKEN = "t0k3n";
const HOME = "/home/someone";
const COMMANDS = probeCommands(TOKEN, HOME);
/** The call the agent makes for the extra attempt: the edit tool, asked to create a file outside the repository. */
const edit = { tool: "edit", args: JSON.stringify({ path: COMMANDS.editPath }), output: undefined };

/** The shell call an agent makes for `command`, answered with `stdout` (the command's own marker line included). */
const shell = (command: string, stdout: string) => ({ tool: "shell", args: JSON.stringify({ command }), output: `exit 0\n${stdout}` });

/** Evidence of a run in which every attempt got through, with the controls in place. Each test breaks one thing. */
function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    token: TOKEN,
    calls: [
      shell(COMMANDS.allowed, `http=200 ${markerOf(TOKEN, "allowed")} exit=0\n`),
      shell(COMMANDS.network, `http=200 ${markerOf(TOKEN, "network")} exit=0\n`),
      shell(COMMANDS.inside, `${markerOf(TOKEN, "inside")} exit=0\n`),
      shell(COMMANDS.write, `${markerOf(TOKEN, "write")} exit=0\n`),
      shell(COMMANDS.read, `${markerOf(TOKEN, "read")} exit=0\n`),
      edit,
    ],
    outside: { insideWritten: true, shellEscapeWritten: true, editEscapeWritten: true },
    controls: { networkReachableOutside: true, authFileReadableOutside: true },
    ...overrides,
  };
}

const verdicts = (e: Evidence) => Object.fromEntries(judgeProbe(e).attempts.map((a) => [a.name, a.verdict]));

test("with no bwrap on PATH the probe stops naming bubblewrap, and says it is no sandbox result", () => {
  const empty = mkdtempSync(join(tmpdir(), "wf-no-bwrap-"));
  try {
    assert.throws(() => requireBubblewrap(empty), (err: Error) => /bubblewrap/.test(err.message) && /not a sandbox result/.test(err.message));
    assert.throws(() => requireBubblewrap(undefined), /bubblewrap/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("a bwrap that is executable somewhere on PATH satisfies the precondition, and a file that is not executable does not", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-bwrap-"));
  const other = mkdtempSync(join(tmpdir(), "wf-other-"));
  try {
    const bwrap = join(dir, "bwrap");
    writeFileSync(bwrap, "#!/bin/sh\n");
    chmodSync(bwrap, 0o644);
    assert.throws(() => requireBubblewrap(`${other}:${dir}`), /bubblewrap/);
    chmodSync(bwrap, 0o755);
    assert.equal(requireBubblewrap(`${other}:${dir}`), bwrap);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test("a step in which every attempt got through is three failures, and the gate stays shut", () => {
  const judged = judgeProbe(evidence());
  assert.deepEqual(verdicts(evidence()), { network: "not-blocked", write: "not-blocked", read: "not-blocked" });
  assert.equal(judged.allBlocked, false);
});

test("the network attempt is blocked when curl fails against a host outside the allowlist, while the machine can reach it", () => {
  const e = evidence({ calls: evidence().calls.map((c) => (c.args.includes(markerOf(TOKEN, "network")) ? shell(COMMANDS.network, `http=000 ${markerOf(TOKEN, "network")} exit=6\n`) : c)) });
  assert.equal(verdicts(e).network, "blocked");
  assert.equal(judgeProbe(e).attempts[0]!.detail, "curl exit 6, http 000");
});

test("the network attempt is inconclusive when the machine itself cannot reach the host, because a failed curl then proves nothing", () => {
  const e = evidence({
    calls: evidence().calls.map((c) => (c.args.includes(markerOf(TOKEN, "network")) ? shell(COMMANDS.network, `http=000 ${markerOf(TOKEN, "network")} exit=6\n`) : c)),
    controls: { networkReachableOutside: false, authFileReadableOutside: true },
  });
  assert.equal(verdicts(e).network, "inconclusive");
});

test("an attempt the agent never ran is inconclusive, not blocked: no command, no evidence", () => {
  const e = evidence({ calls: evidence().calls.filter((c) => !c.args.includes(markerOf(TOKEN, "read"))) });
  assert.equal(verdicts(e).read, "inconclusive");
  assert.equal(judgeProbe(e).allBlocked, false);
});

test("the write attempt is judged by the file outside the repository, not by curl's or touch's exit code", () => {
  // touch said exit 0 but nothing reached the real filesystem (a private tmpfs): the write did not escape
  const calls = evidence().calls;
  assert.equal(verdicts(evidence({ calls, outside: { insideWritten: true, shellEscapeWritten: false, editEscapeWritten: false } })).write, "blocked");
  assert.equal(verdicts(evidence({ calls, outside: { insideWritten: true, shellEscapeWritten: true, editEscapeWritten: false } })).write, "not-blocked");
});

test("the write attempt is inconclusive when the control write inside the repository did not happen: the step did not run the way the probe assumes", () => {
  const e = evidence({ outside: { insideWritten: false, shellEscapeWritten: false, editEscapeWritten: false } });
  assert.equal(verdicts(e).write, "inconclusive");
});

test("the read attempt is blocked when cat of the credentials file fails, and a failed cat is no proof when the file is not readable outside the sandbox either", () => {
  const failed = evidence().calls.map((c) => (c.args.includes(markerOf(TOKEN, "read")) ? shell(COMMANDS.read, `${markerOf(TOKEN, "read")} exit=1\n`) : c));
  assert.equal(verdicts(evidence({ calls: failed })).read, "blocked");
  assert.equal(verdicts(evidence({ calls: failed, controls: { networkReachableOutside: true, authFileReadableOutside: false } })).read, "inconclusive");
});

test("all three attempts blocked opens the gate, and the extras and controls never close it", () => {
  const calls = [
    shell(COMMANDS.allowed, `http=000 ${markerOf(TOKEN, "allowed")} exit=6\n`), // the allowlist was not honoured: a control, not an attempt
    shell(COMMANDS.network, `http=000 ${markerOf(TOKEN, "network")} exit=6\n`),
    shell(COMMANDS.inside, `${markerOf(TOKEN, "inside")} exit=0\n`),
    shell(COMMANDS.write, `${markerOf(TOKEN, "write")} exit=1\n`),
    shell(COMMANDS.read, `${markerOf(TOKEN, "read")} exit=1\n`),
    edit,
  ];
  const judged = judgeProbe(evidence({ calls, outside: { insideWritten: true, shellEscapeWritten: false, editEscapeWritten: true } }));
  assert.equal(judged.allBlocked, true);
  assert.equal(judged.extras.allowlistHonoured, "no");
  assert.equal(judged.extras.editToolWrite, "not-blocked"); // the edit tool is not one of the three attempts of the gate
});

test("stepContent keeps the lines of the attempt that opened with the step's label: content lines carry an attemptId, not the label, and ctx.exec lines have attempts of their own", () => {
  const lines = [
    { type: "content", attemptId: "exec-1", kind: "tool-call", tool: "exec", text: "curl control" },
    { type: "step-start", attemptId: "attempt-1", label: "sandbox-attempts" },
    { type: "content", attemptId: "attempt-1", kind: "tool-call", tool: "shell", callId: "a\nb", text: "mine" },
    { type: "content", attemptId: "attempt-1", kind: "command-output", tool: "shell", callId: "a\nb", text: "exit 0" },
    { type: "content", attemptId: "attempt-2", kind: "tool-call", tool: "shell", text: "another step" },
    { type: "step-end", attemptId: "attempt-1", label: "sandbox-attempts" },
  ];
  assert.deepEqual(stepContent(lines, "sandbox-attempts").map((l) => l.text), ["mine", "exit 0"]);
  assert.deepEqual(stepContent(lines, "no-such-step"), []);
});

test("probeCallsFrom pairs each tool call with the output that shares its call id, in the order the agent made them", () => {
  const events = [
    { type: "content", kind: "prompt", text: "ignored" },
    { type: "content", kind: "tool-call", tool: "shell", callId: "a", text: '{"command":"echo one"}' },
    { type: "content", kind: "tool-call", tool: "edit", callId: "b", text: '{"path":"/x/y"}' },
    { type: "content", kind: "command-output", tool: "shell", callId: "a", text: "exit 0\none\n" },
    { type: "content", kind: "agent-message", text: "done" },
  ];
  assert.deepEqual(probeCallsFrom(events), [
    { tool: "shell", args: '{"command":"echo one"}', output: "exit 0\none\n" },
    { tool: "edit", args: '{"path":"/x/y"}', output: undefined },
  ]);
});

test("the report names each attempt PASS when it was blocked, FAIL when it got through, and says what the gate decides", () => {
  const report = sandboxReport({ model: "composer-2.5", readBoundary: "workspace", ...judgeProbe(evidence()) });
  assert.match(report, /1\. network.*FAIL/);
  assert.match(report, /2\. write outside the repository.*FAIL/);
  assert.match(report, /3\. read of the Cursor credentials.*FAIL/);
  assert.match(report, /not all blocked/i);
});

test("a run without readBoundary is a baseline: it reports the same attempts, says which setting it ran with, and leaves the gate to the run that sets it", () => {
  const allBlocked = judgeProbe(evidence({
    calls: [
      shell(COMMANDS.network, `http=000 ${markerOf(TOKEN, "network")} exit=7\n`),
      shell(COMMANDS.inside, `${markerOf(TOKEN, "inside")} exit=0\n`),
      shell(COMMANDS.write, `${markerOf(TOKEN, "write")} exit=1\n`),
      shell(COMMANDS.read, `${markerOf(TOKEN, "read")} exit=1\n`),
    ],
    outside: { insideWritten: true, shellEscapeWritten: false, editEscapeWritten: false },
  }));
  assert.equal(allBlocked.allBlocked, true);
  const baseline = sandboxReport({ model: "composer-2.5", readBoundary: "unset", ...allBlocked });
  assert.match(baseline, /readBoundary is not set/);
  assert.match(baseline, /3\. read of the Cursor credentials.*PASS/);
  assert.doesNotMatch(baseline, /may set requireSandbox/);
  assert.match(sandboxReport({ model: "composer-2.5", readBoundary: "workspace", ...allBlocked }), /may set requireSandbox/);
});

test("the report shows which backend variables the sandbox set inside the step, and says so when it set none", () => {
  const withBackend = judgeProbe(evidence({
    calls: [...evidence().calls, shell(COMMANDS.backend, `CURSOR_SANDBOX_LANDLOCK_STATUS=enforced\nCURSOR_SANDBOX_LINUX_BACKEND=landlock\n${markerOf(TOKEN, "backend")} exit=0\n`)],
  }));
  assert.deepEqual(withBackend.extras.backendVariables, ["CURSOR_SANDBOX_LANDLOCK_STATUS=enforced", "CURSOR_SANDBOX_LINUX_BACKEND=landlock"]);
  assert.match(sandboxReport({ model: "composer-2.5", readBoundary: "workspace", ...withBackend }), /backend variables set inside the sandbox: CURSOR_SANDBOX_LANDLOCK_STATUS=enforced, CURSOR_SANDBOX_LINUX_BACKEND=landlock/);

  const none = judgeProbe(evidence({ calls: [...evidence().calls, shell(COMMANDS.backend, `${markerOf(TOKEN, "backend")} exit=1\n`)] }));
  assert.deepEqual(none.extras.backendVariables, []);
  assert.match(sandboxReport({ model: "composer-2.5", readBoundary: "workspace", ...none }), /backend variables set inside the sandbox: none/);
  assert.equal(judgeProbe(evidence()).extras.backendVariables, undefined, "no backend call, no claim");
});
