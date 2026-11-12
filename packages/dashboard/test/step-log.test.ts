// Seam: what a step's panel shows. `buildStepLog(items)` turns the `content` events of one step, as the API gives them, into
// what the panel draws: per attempt the prompt, then in order what the agent said and the tools it called with their output; for
// a `ctx.exec` command, the command and its output. Pure: the panel and these tests call the same function on the items they
// have, so the log of a step that is still running and that of a finished one are built the same way.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type ContentItem, buildStepLog } from "../src/ui/step-log.js";

let next = 0;
/** A `content` event the way the API gives it: ids count up, `chars` follows the text. */
const item = (fields: Partial<ContentItem> & Pick<ContentItem, "kind" | "attemptId">): ContentItem => {
  const id = fields.id ?? ++next;
  return { id, chars: fields.text?.length ?? 0, ...fields };
};
const prompt = (text: string, attemptId = "a1") => item({ kind: "prompt", attemptId, text });
const said = (text: string, attemptId = "a1") => item({ kind: "agent-message", attemptId, text });
const call = (tool: string, args: unknown, callId: string, attemptId = "a1") => item({ kind: "tool-call", attemptId, tool, callId, text: JSON.stringify(args) });
const output = (tool: string, text: string, callId: string, attemptId = "a1", stream?: "stdout" | "stderr") => item({ kind: "command-output", attemptId, tool, callId, text, ...(stream ? { stream } : {}) });

test("an agent step reads in the order it happened: prompt, what the agent said, each tool call with its output under it", () => {
  const log = buildStepLog([
    prompt("Plan the change."),
    said("I will read the file first."),
    call("read", { path: "src/a.ts" }, "c1"),
    output("read", "export const a = 1;", "c1"),
    call("shell", { command: "npm test" }, "c2"),
    said("Tests pass."),
    output("shell", "ok 12 tests", "c2"),
  ]);
  assert.equal(log.attempts.length, 1);
  const entries = log.attempts[0]!.entries;
  assert.deepEqual(
    entries.map((e) => e.kind),
    ["prompt", "message", "tool", "tool", "message"],
  );
  const [, , read, shell] = entries;
  assert.equal(read!.kind === "tool" && read.title, "read");
  assert.deepEqual(read!.kind === "tool" && read.output.map((o) => o.text), ["export const a = 1;"]);
  assert.equal(shell!.kind === "tool" && shell.args, '{\n  "command": "npm test"\n}');
  assert.deepEqual(shell!.kind === "tool" && shell.output.map((o) => o.text), ["ok 12 tests"], "the output that arrives after other entries still goes under its call");
});

test("a command of ctx.exec is its command line with the output that came from it, stdout and stderr apart and in order", () => {
  const log = buildStepLog([
    call("exec", { command: "git", args: ["commit", "-m", "fix: a thing"], cwd: "/work/repo" }, "x1", "x1"),
    output("exec", "one\n", "x1", "x1", "stdout"),
    output("exec", "two\n", "x1", "x1", "stdout"),
    output("exec", "warning: x\n", "x1", "x1", "stderr"),
    output("exec", "three\n", "x1", "x1", "stdout"),
  ]);
  const [command] = log.attempts[0]!.entries;
  assert.equal(command!.kind, "tool");
  if (command!.kind !== "tool") return;
  assert.equal(command.title, "$ git commit -m 'fix: a thing'");
  assert.equal(command.args, "in /work/repo");
  assert.deepEqual(
    command.output.map((o) => [o.stream, o.text]),
    [["stdout", "one\ntwo\n"], ["stderr", "warning: x\n"], ["stdout", "three\n"]],
    "chunks of the same stream that follow each other are one block",
  );
});

test("each attempt of a step is its own section, in the order the attempts began", () => {
  const log = buildStepLog([prompt("first try", "a1"), said("hmm", "a1"), prompt("second try", "a2"), said("better", "a2"), prompt("re-prompt: fix the schema", "a2")]);
  assert.deepEqual(
    log.attempts.map((a) => [a.attemptId, a.number, a.entries.map((e) => e.kind)]),
    [["a1", 1, ["prompt", "message"]], ["a2", 2, ["prompt", "message", "prompt"]]],
  );
});

test("items arrive in any order within a batch: the log is by id", () => {
  const a = said("second", "a1");
  const b = prompt("first", "a1");
  b.id = 1;
  a.id = 2;
  const log = buildStepLog([a, b]);
  assert.deepEqual(log.attempts[0]!.entries.map((e) => e.kind), ["prompt", "message"]);
});

test("output with no call before it (a tail that started late) is shown as output, and joins the call when it comes", () => {
  const alone = buildStepLog([output("shell", "late line", "c9")]);
  assert.deepEqual(alone.attempts[0]!.entries.map((e) => e.kind), ["output"]);
  const joined = buildStepLog([output("shell", "late line", "c9"), call("shell", { command: "ls" }, "c9")]);
  assert.deepEqual(joined.attempts[0]!.entries.map((e) => e.kind), ["tool"], "a call that arrives after its output still owns it");
});

test("text that retention removed, and text that was cut, say so instead of looking empty", () => {
  const log = buildStepLog([
    item({ kind: "prompt", attemptId: "a1", chars: 5120 }), // retention: the event stays, the text goes
    item({ kind: "agent-message", attemptId: "a1", text: "begin", chars: 99_000, truncated: true }),
  ]);
  const [kept, cut] = log.attempts[0]!.entries;
  assert.equal(kept!.kind === "prompt" && kept.text, undefined);
  assert.equal(kept!.kind === "prompt" && kept.chars, 5120);
  assert.equal(cut!.kind === "message" && cut.truncated, true);
  assert.equal(cut!.kind === "message" && cut.chars, 99_000);
});

test("a tool call whose arguments are not JSON keeps them as written; an unknown kind is left out", () => {
  const log = buildStepLog([item({ kind: "tool-call", attemptId: "a1", tool: "shell", callId: "c1", text: "not { json" }), item({ kind: "reasoning", attemptId: "a1", text: "from a newer kit" }), said("done")]);
  const [tool, message] = log.attempts[0]!.entries;
  assert.equal(tool!.kind === "tool" && tool.args, "not { json");
  assert.equal(message!.kind, "message");
  assert.equal(log.attempts[0]!.entries.length, 2);
});

test("upTo keeps what the log held at that line: the logs of a replay", () => {
  const items = [prompt("p"), said("one"), said("two")];
  assert.deepEqual(buildStepLog(items, { upTo: items[1]!.id }).attempts[0]!.entries.map((e) => e.kind), ["prompt", "message"]);
  assert.deepEqual(buildStepLog(items, { upTo: 0 }).attempts, []);
});

test("a step with no content has no attempts", () => {
  assert.deepEqual(buildStepLog([]), { attempts: [], count: 0 });
});
