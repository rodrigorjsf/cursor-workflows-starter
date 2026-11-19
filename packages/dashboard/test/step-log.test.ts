import assert from "node:assert/strict";
import { test } from "node:test";
import { type ContentItem, buildNodeLog } from "../run-view/step-log.js";
import { CommandDetails, CommandList, CommandPanel, PhasePanel, StepLogPanel, closesOnEscape } from "../run-view/StepLogPanel.js";
import { type GraphNode, buildRunGraph } from "../run-view/run-graph.js";
import { render, textOf } from "./render.js";
import { execEnd, execStart, phase, runStart, stamp, stepEnd, stepStart, type Draft } from "./run-log.js";

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
  const log = buildNodeLog([
    prompt("Plan the change."),
    said("I will read the file first."),
    call("read", { path: "src/a.ts" }, "c1"),
    output("read", "export const a = 1;", "c1"),
    call("shell", { command: "npm test" }, "c2"),
    said("Tests pass."),
    output("shell", "ok 12 tests", "c2"),
  ], { attemptIds: [] });
  assert.equal(log.attempts.length, 1);
  const entries = log.attempts[0]!.entries;
  assert.deepEqual(
    entries.map((e) => e.kind),
    ["prompt", "message", "tool", "tool", "message"],
  );
  const [, , read, shell] = entries;
  assert.ok(read && shell, "the two tool calls are there");
  assert.equal(read.kind === "tool" && read.title, "read");
  assert.deepEqual(read.kind === "tool" && read.output.map((o) => o.text), ["export const a = 1;"]);
  assert.equal(shell.kind === "tool" && shell.args, '{\n  "command": "npm test"\n}');
  assert.deepEqual(shell.kind === "tool" && shell.output.map((o) => o.text), ["ok 12 tests"], "the output that arrives after other entries still goes under its call");
});

test("a command of ctx.exec is its command line with the output that came from it, stdout and stderr apart and in order", () => {
  const log = buildNodeLog([
    call("exec", { command: "git", args: ["commit", "-m", "fix: a thing"], cwd: "/work/repo" }, "x1", "x1"),
    output("exec", "one\n", "x1", "x1", "stdout"),
    output("exec", "two\n", "x1", "x1", "stdout"),
    output("exec", "warning: x\n", "x1", "x1", "stderr"),
    output("exec", "three\n", "x1", "x1", "stdout"),
  ], { attemptIds: [] });
  const [command] = log.attempts[0]!.entries;
  assert.ok(command, "the call is there");
  assert.equal(command.kind, "tool");
  if (command.kind !== "tool") return;
  assert.equal(command.title, "$ git commit -m 'fix: a thing'");
  assert.equal(command.args, "in /work/repo");
  assert.deepEqual(
    command.output.map((o) => [o.stream, o.text]),
    [["stdout", "one\ntwo\n"], ["stderr", "warning: x\n"], ["stdout", "three\n"]],
    "chunks of the same stream that follow each other are one block",
  );
});

test("a call to an MCP tool is titled by the tool it reaches, not by the generic name the SDK gives every one of them", () => {
  const log = buildNodeLog([call("mcp", { providerIdentifier: "custom-user-tools", toolName: "submit_result", args: { answer: "pong" } }, "c1")], { attemptIds: [] });
  const [tool] = log.attempts[0]!.entries;
  assert.ok(tool, "the call is there");
  assert.equal(tool.kind === "tool" && tool.title, "mcp: submit_result");
  assert.match(String(tool.kind === "tool" && tool.args), /"answer": "pong"/, "the arguments stay whole");
});

test("each attempt of a step is its own section, in the order the attempts began", () => {
  const log = buildNodeLog([prompt("first try", "a1"), said("hmm", "a1"), prompt("second try", "a2"), said("better", "a2"), prompt("re-prompt: fix the schema", "a2")], { attemptIds: [] });
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
  const log = buildNodeLog([a, b], { attemptIds: [] });
  assert.deepEqual(log.attempts[0]!.entries.map((e) => e.kind), ["prompt", "message"]);
});

test("output with no call before it (a tail that started late) is shown as output, and joins the call when it comes", () => {
  const alone = buildNodeLog([output("shell", "late line", "c9")], { attemptIds: [] });
  assert.deepEqual(alone.attempts[0]!.entries.map((e) => e.kind), ["output"]);
  const joined = buildNodeLog([output("shell", "late line", "c9"), call("shell", { command: "ls" }, "c9")], { attemptIds: [] });
  assert.deepEqual(joined.attempts[0]!.entries.map((e) => e.kind), ["tool"], "a call that arrives after its output still owns it");
});

test("text that retention removed, and text that was cut, say so instead of looking empty", () => {
  const log = buildNodeLog([
    item({ kind: "prompt", attemptId: "a1", chars: 5120 }), // retention: the event stays, the text goes
    item({ kind: "agent-message", attemptId: "a1", text: "begin", chars: 99_000, truncated: true }),
  ], { attemptIds: [] });
  const [kept, cut] = log.attempts[0]!.entries;
  assert.ok(kept && cut, "both entries are there");
  assert.equal(kept.kind === "prompt" && kept.text, undefined);
  assert.equal(kept.kind === "prompt" && kept.chars, 5120);
  assert.equal(cut.kind === "message" && cut.truncated, true);
  assert.equal(cut.kind === "message" && cut.chars, 99_000);
});

test("a tool call whose arguments are not JSON keeps them as written; an unknown kind is left out", () => {
  const log = buildNodeLog([item({ kind: "tool-call", attemptId: "a1", tool: "shell", callId: "c1", text: "not { json" }), item({ kind: "reasoning", attemptId: "a1", text: "from a newer kit" }), said("done")], { attemptIds: [] });
  const [tool, message] = log.attempts[0]!.entries;
  assert.ok(tool && message, "both entries are there");
  assert.equal(tool.kind === "tool" && tool.args, "not { json");
  assert.equal(message.kind, "message");
  assert.equal(log.attempts[0]!.entries.length, 2);
});

test("upTo keeps what the log held at that line: the logs of a replay", () => {
  const items = [prompt("p"), said("one"), said("two")];
  assert.deepEqual(buildNodeLog(items, { attemptIds: [] }, items[1]!.id).attempts[0]!.entries.map((e) => e.kind), ["prompt", "message"]);
  assert.deepEqual(buildNodeLog(items, { attemptIds: [] }, 0).attempts, []);
});

test("a step with no content has no attempts", () => {
  assert.deepEqual(buildNodeLog([], { attemptIds: [] }), { attempts: [], count: 0 });
});

const graphOf = (drafts: Draft[], settled = true) => buildRunGraph(stamp(drafts), { settled });
const attributesOf = (html: string, tag: string) => [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, "g"))].map((m) => Object.fromEntries([...m[1]!.matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1]!, a[2]!])));

const lsFiles = (extra: Record<string, unknown> = {}) => [execStart("x-1", "git ls-files"), execEnd("x-1", "git ls-files", {}, { durationMs: 40, ...extra })];
const betweenSteps = graphOf(
  [runStart, phase("Delivery"), ...lsFiles(), execStart("x-2", "git rev-parse"), execEnd("x-2", "git rev-parse", {}, { ok: false, exitCode: 1, probe: true, durationMs: 30 }), execStart("x-3", "gh pr view")],
  false,
);
const phaseCommands = betweenSteps.lanes[0]!.commands;

test("the commands of a phase are listed as items, in run order, each with its state icon and a name that says its state", () => {
  const html = render(CommandList, { commands: phaseCommands, onSelect: () => {} });

  assert.equal(textOf(html), "Commands 3 ✓ git ls-files ○ git rev-parse ● gh pr view");
  assert.deepEqual(
    attributesOf(html, "button").map((b) => [b.type, b["aria-label"], b["aria-pressed"]]),
    [["button", "git ls-files: ok. Open its output", "false"], ["button", "git rev-parse: neutral. Open its output", "false"], ["button", "gh pr view: running. Open its output", "false"]],
    "each item is a button, so the keyboard reaches it and operates it",
  );
});

test("the item of the command whose output is open is pressed, and a list of no commands draws nothing", () => {
  const pressed = attributesOf(render(CommandList, { commands: phaseCommands, openId: "x-2", onSelect: () => {} }), "button").map((b) => b["aria-pressed"]);
  assert.deepEqual(pressed, ["false", "true", "false"]);
  assert.equal(render(CommandList, { commands: [], onSelect: () => {} }), "");
});

test("a step's log panel lists the commands that ran while the step went, in order, above its log", () => {
  const graph = graphOf([
    runStart,
    phase("Build"),
    stepStart("s-a", "code"),
    execStart("x-during", "git status", { parentId: "s-a" }),
    execEnd("x-during", "git status"),
    execStart("x-nested", "git log", { parentId: "x-during" }),
    execEnd("x-nested", "git log", {}, { ok: false, exitCode: 128 }),
    stepEnd("s-a", "code"),
  ]);
  const code = graph.nodes.find((n) => n.id === "s-a")!;
  const html = render(StepLogPanel, { runId: "wf-1", node: code, now: 0, live: false, onClose: () => {}, onOpenCommand: () => {} });

  assert.match(textOf(html), /Commands 2 ✓ git status ✗ git log/);
  assert.ok(html.indexOf("Commands") < html.indexOf('aria-label="Step log"'), "the commands come before the log");
  assert.doesNotMatch(textOf(render(StepLogPanel, { runId: "wf-1", node: { ...code, commands: [] }, now: 0, live: false, onClose: () => {}, onOpenCommand: () => {} })), /Commands/);
});

test("a phase's workflow entry is a panel of its own that lists the commands that belong to no step, and says when there are none", () => {
  const html = render(PhasePanel, { lane: 0, title: "Delivery", commands: phaseCommands, onSelect: () => {}, onClose: () => {} });
  assert.match(html, /<aside[^>]*aria-label="Workflow commands of Delivery"/);
  assert.match(textOf(html), /Delivery workflow.*Commands 3 ✓ git ls-files ○ git rev-parse ● gh pr view/);
  assert.match(textOf(render(PhasePanel, { lane: 0, title: "", commands: [], onSelect: () => {}, onClose: () => {} })), /No command ran outside a step/);
  assert.match(render(PhasePanel, { lane: 0, title: "", commands: [], onSelect: () => {}, onClose: () => {} }), /aria-label="Workflow commands of the run"/);
});

const callOf = (command: string, args: string[], cwd: string, attemptId = "x-1#1") => item({ kind: "tool-call", attemptId, tool: "exec", callId: attemptId, text: JSON.stringify({ command, args, cwd }) });
const stdout = (text: string, attemptId = "x-1#1") => item({ kind: "command-output", attemptId, tool: "exec", callId: attemptId, stream: "stdout", text });
const stderr = (text: string, attemptId = "x-1#1") => item({ kind: "command-output", attemptId, tool: "exec", callId: attemptId, stream: "stderr", text });
const commandOf = (id: string): GraphNode => graphOf([runStart, phase("Delivery"), ...lsFiles(), execStart("x-2", "git rev-parse"), execEnd("x-2", "git rev-parse", {}, { ok: false, exitCode: 1, probe: true })]).lanes[0]!.commands.find((c) => c.id === id)!;
const detailsOf = (command: GraphNode, items: ContentItem[], status: "loading" | "ready" | "error" = "ready", live = false) => render(CommandDetails, { command, feed: { items, status, ...(status === "error" ? { error: "the dashboard answered 500" } : {}) }, now: 0, live });

test("a command's panel shows its command line, its directory, how it ended, how long it took and its output", () => {
  const html = detailsOf(commandOf("x-1"), [callOf("git", ["ls-files", "src dir"], "/work/repo"), stdout("src/a.ts\n"), stdout("src/b.ts\n")]);
  const text = textOf(html);

  assert.match(text, /State ok Exit 0 Duration 40ms/);
  assert.match(text, /\$ git ls-files 'src dir'/);
  assert.match(text, /in \/work\/repo/);
  assert.match(html, /<pre>src\/a\.ts\nsrc\/b\.ts\n<\/pre>/, "the output of a read command is there, in one block");
});

test("a command's panel shows only the attempts of the execution on view, as a step's panel does", () => {
  const text = textOf(detailsOf(commandOf("x-1"), [stdout("from another execution\n", "x-1#7"), callOf("git", ["ls-files"], "/work/repo"), stdout("src/a.ts\n")]));

  assert.match(text, /src\/a\.ts/);
  assert.doesNotMatch(text, /from another execution/);
});

test("a probe's panel says it is a probe, and stderr is told apart from stdout", () => {
  const html = detailsOf(commandOf("x-2"), [callOf("git", ["rev-parse", "--verify", "main"], "/work/repo", "x-2#1"), stderr("fatal: Needed a single revision\n", "x-2#1")]);

  assert.match(textOf(html), /State neutral Exit 1 Probe yes, a non-zero exit is an expected answer/);
  assert.match(html, /class="output stderr"/);
  assert.match(textOf(html), /stderr fatal: Needed a single revision/);
});

test("a command's panel says what it waits for instead of looking empty: reading, nothing written yet, nothing written at all, or a log it could not read", () => {
  assert.match(textOf(detailsOf(commandOf("x-1"), [], "loading")), /Reading the command…/);
  assert.match(textOf(detailsOf(commandOf("x-1"), [], "ready", true)), /Waiting for the command to write something…/);
  assert.match(textOf(detailsOf(commandOf("x-1"), [], "ready")), /This command wrote no output\./);
  const failed = detailsOf(commandOf("x-1"), [], "error");
  assert.match(failed, /role="alert"/);
  assert.match(textOf(failed), /The output of this command could not be read: the dashboard answered 500/);
});

test("the floating panel is a dialog named after its command, with a button that closes it", () => {
  const html = render(CommandPanel, { runId: "wf-1", command: commandOf("x-1"), now: 0, live: false, onClose: () => {} });
  const [dialog] = attributesOf(html, "section");
  assert.equal(dialog?.role, "dialog");
  assert.equal(dialog?.["aria-label"], "Command git ls-files");
  assert.deepEqual(attributesOf(html, "button").map((b) => b["aria-label"]), ["Close the command"]);
});

test("Escape closes a panel, unless something already took it or it belongs to a control such as the replay slider", () => {
  const key = (fields: Partial<{ key: string; defaultPrevented: boolean; target: { tagName: string } | null }>) => ({ key: "Escape", defaultPrevented: false, target: { tagName: "DIV" }, ...fields });
  assert.equal(closesOnEscape(key({})), true);
  assert.equal(closesOnEscape(key({ key: "Enter" })), false);
  assert.equal(closesOnEscape(key({ defaultPrevented: true })), false);
  for (const tagName of ["INPUT", "SELECT", "TEXTAREA"]) assert.equal(closesOnEscape(key({ target: { tagName } })), false, tagName);
  assert.equal(closesOnEscape(key({ target: null })), true);
});

test("a log scoped to some attempts keeps only theirs, and numbers them from 1; no attempts named keeps all", () => {
  const items = [prompt("first try", "a1"), said("it failed", "a1"), prompt("second try", "a2"), said("it worked", "a2")];

  const second = buildNodeLog(items, { attemptIds: ["a2"] });
  assert.deepEqual(second.attempts.map((a) => [a.attemptId, a.number]), [["a2", 1]]);
  assert.equal(second.count, 2);
  assert.deepEqual(buildNodeLog(items, { attemptIds: [] }).attempts.map((a) => a.attemptId), ["a1", "a2"]);
});
