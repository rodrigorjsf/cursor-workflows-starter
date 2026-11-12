// Seam 2, the AgentBackend interface, from the other side: the cloud backend called directly, the way the engine calls it,
// with the fake Cursor SDK underneath and a temporary bare repository as the remote. It holds the contract the engine
// relies on (see backend.ts) for an agent that runs elsewhere: events streamed through the callback, an abort that cancels
// the run in flight and reports the signal's reason, the usage read, the agent disposed, and the snapshot branch gone.
process.env.WF_METRICS = "off";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { calls, costConfig, script, stats } from "@cursor/sdk";
import type { AttemptEvent, AttemptResult, StepOptions } from "../src/runtime/backend.js";
import { createCloudBackend } from "../src/runtime/backend-cloud.js";
import { cloudRepoUrl } from "../src/runtime/cloud-snapshot.js";
import { git, remoteBranches, remoteFiles, repoWithRemote } from "./cloud-fixtures.js";

let root = "";
let repo = "";
let remote = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wf-cloud-backend-"));
  repo = join(root, "repo");
  remote = join(root, "origin.git");
  repoWithRemote(repo, remote);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  script.length = 0;
  calls.length = 0;
  Object.assign(stats, { active: 0, maxActive: 0, disposed: 0, usageReads: 0, cancels: 0, cancelled: 0, turnsDelivered: 0, sends: 0 });
  Object.assign(costConfig, { raw: 9, charged: 7, getUsageError: undefined, createErrorCode: undefined, createHang: undefined, createDelayMs: undefined, createGate: undefined });
});

const options = (extra: Partial<StepOptions> = {}): StepOptions => ({
  name: "wf:step",
  model: { id: "m" },
  cwd: repo,
  settingSources: [],
  sandbox: false,
  writes: false,
  schemaRetries: 2,
  tools: ["read"],
  ...extra,
});

/** Runs one attempt on the cloud backend and collects the events it streams. */
async function attempt(prompt: string, o: StepOptions, signal: AbortSignal = new AbortController().signal, onEvent?: (e: AttemptEvent) => void) {
  const events: AttemptEvent[] = [];
  const result = await createCloudBackend({ remote: "origin", runId: "run-1" }).run(prompt, o, signal, (e) => {
    events.push(e);
    onEvent?.(e);
  });
  return { result, events };
}
const outcomeOf = (r: AttemptResult) => r.outcome;
const SCHEMA = { type: "object", required: ["n"], properties: { n: { type: "integer" } } };
const turn = (tokens: number) => ({ type: "turn-ended", usage: { inputTokens: tokens - 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } });

test("an attempt streams the cloud agent's activity through the callback and reports the answer, the agent, the model and the usage", async () => {
  script.push(() => ({ result: "the answer", deltas: [{ type: "text-delta", text: "thinking" }, { type: "step-completed", stepId: 1 }, turn(110)] }));
  const { result, events } = await attempt("do it", options());

  assert.deepEqual(events.map((e) => e.type), ["warning", "agent", "text", "step", "turn"]);
  assert.deepEqual(events[1], { type: "agent", agentId: "bc-1" });
  assert.deepEqual(outcomeOf(result), { kind: "finished", value: "the answer" });
  assert.equal(result.agentId, "bc-1");
  assert.ok(result.usage && "report" in result.usage);
  assert.deepEqual([result.usage.report.cost?.chargedCents, result.usage.report.usage.totalTokens], [7, 110]);
  assert.equal(stats.disposed, 1, "the agent is disposed before the attempt reports");
  assert.deepEqual(remoteBranches(remote), []);
});

test("the cloud agent is created with the snapshot as its starting ref, no PR, and none of the options a cloud agent rejects or ignores", async () => {
  const seen: string[] = [];
  script.push((o) => {
    seen.push(...remoteBranches(remote));
    assert.equal(o.cloud.repos[0].startingRef, seen[0]);
    return { result: "ok" };
  });
  await attempt("p", options({ apiKey: "k", disallowedTools: ["shell"], settingSources: ["project"], sandbox: true, agents: { sub: { description: "d", prompt: "p" } }, mcpServers: { x: { command: "x" } as never } }));

  const [created] = calls;
  assert.equal(created.apiKey, "k");
  assert.equal(created.name, "wf:step");
  assert.deepEqual(created.model, { id: "m" });
  assert.deepEqual(created.agents, { sub: { description: "d", prompt: "p" } }, "subagents and MCP servers are supported in the cloud");
  assert.deepEqual(created.mcpServers, { x: { command: "x" } });
  assert.deepEqual(Object.keys(created).sort(), ["agents", "apiKey", "cloud", "mcpServers", "model", "name"], "no tools, disallowedTools, systemPrompt or local options");
  assert.deepEqual(created.cloud, { repos: [{ url: remote, startingRef: seen[0] }], autoCreatePR: false });
  assert.match(seen[0]!, /^wf\/cloud-snapshot\/run-1\/[0-9a-f]{8}$/);
});

test("the cloud agent is told the step is read-only, since the allowlist that would make it so cannot be sent", async () => {
  const sent: string[] = [];
  script.push((_o, msg) => (sent.push(msg), { result: "ok" }), (_o, msg) => (sent.push(msg), { result: "ok" }));
  await attempt("p", options({ writes: false }));
  await attempt("p", options({ writes: true, tools: undefined }));
  assert.match(sent[0]!, /^p\n\n---\nThis is a read-only step: do not create, edit or delete files, do not commit, and do not push or open a pull request\.$/);
  assert.equal(sent[1], "p");
});

test("the result is the last fenced json block of the final message, however the agent fences it", async () => {
  const forms: Array<[string, string, unknown]> = [
    ["a labelled block among prose", 'Done.\n\n```json\n{"n": 1}\n```\n\nHope that helps.', { n: 1 }],
    ["an upper-case label", '```JSON\n{"n": 2}\n```', { n: 2 }],
    ["no label", '```\n{"n": 3}\n```', { n: 3 }],
    ["Windows line ends", '```json\r\n{"n": 4}\r\n```\r\n', { n: 4 }],
    ["a longer fence, whose body shows a shorter one", '````json\n{"n": 5}\n````', { n: 5 }],
    ["indented by up to three spaces", '   ```json\n   {"n": 6}\n   ```', { n: 6 }],
    ["a draft and then the final block", '```json\n{"n": 0}\n```\nBetter:\n```json\n{"n": 7}\n```', { n: 7 }],
    ["code of another language after the block", '```json\n{"n": 8}\n```\n```ts\nconst x = 1;\n```', { n: 8 }],
    ["a block left open at the end of the message", '```json\n{"n": 9}\n```\n```json\n{"n": 10', { n: 9 }],
  ];
  for (const [what, result, value] of forms) {
    script.push(() => ({ result }));
    const { result: r } = await attempt("p", options({ schema: SCHEMA }));
    assert.deepEqual(outcomeOf(r), { kind: "finished", value }, what);
  }
  assert.equal(stats.sends, forms.length, "none of them needed a follow-up");
});

test("a structured answer that is wrong is corrected by follow-ups in the same conversation, and each follow-up is reported", async () => {
  script.push(
    () => ({ result: "```json\n{\"n\": \"one\"}\n```" }),
    () => ({ result: "no block here" }),
    () => ({ result: "```json\n{\"n\": 1}\n```" }),
  );
  const sent: string[] = [];
  const { result, events } = await attempt("p", options({ schema: SCHEMA }), undefined, (e) => e.type === "reprompt" && sent.push(e.message));

  assert.deepEqual(outcomeOf(result), { kind: "finished", value: { n: 1 } });
  assert.equal(calls.length, 1, "one agent");
  assert.equal(events.filter((e) => e.type === "reprompt").length, 2);
  assert.match(sent[0]!, /^Your last message did not end with a valid result: data\/n must be integer\./);
  assert.match(sent[1]!, /there is no fenced json code block/);
});

test("with the follow-ups used up the attempt ends as a schema error, and a run that ended in error is a run error; both cost and clean up", async () => {
  script.push(() => ({ result: "nothing" }));
  const out = await attempt("p", options({ schema: SCHEMA, schemaRetries: 0 }));
  assert.deepEqual(outcomeOf(out.result), { kind: "schema", message: "the agent did not end with a valid JSON block (there is no fenced json code block)" });
  assert.ok(out.result.usage && "report" in out.result.usage, "the usage is read");

  script.push(() => ({ status: "error", error: { message: "boom" } }));
  const failed = await attempt("p", options({ schema: SCHEMA }));
  assert.deepEqual(outcomeOf(failed.result), { kind: "run-error", message: "run error: boom" });
  assert.equal(stats.sends, 2, "no follow-up for a run that errored");
  assert.deepEqual(remoteBranches(remote), []);
});

test("an abort during the run cancels it, waits for it, reads the usage, disposes the agent, deletes the snapshot and reports the signal's reason", async () => {
  const controller = new AbortController();
  const reason = new Error("stop now");
  script.push(() => ({ hang: true, cancelDelayMs: 30 }));
  const { result } = await attempt("p", options(), controller.signal, (e) => e.type === "agent" && setTimeout(() => controller.abort(reason), 20));

  assert.deepEqual(outcomeOf(result), { kind: "aborted", reason });
  assert.equal(stats.cancelled, 1);
  assert.ok(result.usage && "report" in result.usage, "an aborted attempt also cost");
  assert.equal(stats.disposed, 1);
  assert.deepEqual(remoteBranches(remote), []);
});

test("an attempt that is already aborted pushes nothing and creates no agent", async () => {
  const controller = new AbortController();
  controller.abort(new Error("already over"));
  const { result } = await attempt("p", options(), controller.signal);
  assert.equal(outcomeOf(result).kind, "aborted");
  assert.equal(calls.length, 0);
  assert.deepEqual(remoteBranches(remote), []);
});

test("an agent that cannot be created is a failed attempt of the account's or the step's, and the snapshot is deleted anyway", async () => {
  costConfig.createErrorCode = "plan_required";
  const { result } = await attempt("p", options());
  assert.equal(outcomeOf(result).kind, "error");
  assert.equal((outcomeOf(result) as { reason: string }).reason, "account");
  assert.equal(result.agentId, undefined);
  assert.equal(result.usage, undefined, "no agent, nothing used");
  assert.deepEqual(remoteBranches(remote), []);
});

test("a worktree that cannot be snapshotted is an error that says why, before any agent exists", async () => {
  const outside = join(root, "not-a-repo");
  mkdirSync(outside);
  const unborn = join(root, "unborn");
  mkdirSync(unborn);
  git(unborn, "init", "-q");
  git(unborn, "remote", "add", "origin", remote);
  for (const [cwd, why] of [
    [outside, /is not inside a git repository/],
    [unborn, /has no commit yet/],
  ] as const) {
    const { result } = await attempt("p", options({ cwd }));
    const outcome = outcomeOf(result);
    assert.equal(outcome.kind, "error");
    assert.match((outcome as { message: string }).message, why);
  }
  assert.equal(calls.length, 0);
});

test("the snapshot holds the tracked files as they are on disk and the untracked ones git does not ignore, and never the run's own state", async () => {
  writeFileSync(join(repo, ".gitignore"), "secret.env\n");
  writeFileSync(join(repo, "secret.env"), "TOKEN=1\n");
  writeFileSync(join(repo, "untracked.txt"), "u\n");
  mkdirSync(join(repo, ".workflows", "runs", "r1"), { recursive: true }); // not excluded in git: the snapshot must leave it out itself
  writeFileSync(join(repo, ".workflows", "runs", "r1", "events.jsonl"), "{}\n");
  let files: Record<string, string> | undefined;
  script.push((o) => ((files = remoteFiles(remote, o.cloud.repos[0].startingRef)), { result: "ok" }));
  await attempt("p", options());

  assert.deepEqual(Object.keys(files!).sort(), [".gitignore", "a.txt", "b.txt", "untracked.txt"]);
});

test("a run id that is not a valid git ref name still gives a snapshot branch the remote accepts", async () => {
  for (const runId of ["we..ird.run.", ".hidden", "-dash", "has space/and:colon", "ends.lock", "", "ünï"]) {
    const seen: string[] = [];
    script.push(() => (seen.push(...remoteBranches(remote)), { result: "ok" }));
    const result = await createCloudBackend({ remote: "origin", runId }).run("p", options(), new AbortController().signal, () => {});
    assert.equal(outcomeOf(result).kind, "finished", `run id ${JSON.stringify(runId)}: ${JSON.stringify(outcomeOf(result))}`);
    assert.match(seen[0]!, /^wf\/cloud-snapshot\/[A-Za-z0-9][A-Za-z0-9._-]*\/[0-9a-f]{8}$/, `run id ${JSON.stringify(runId)}`);
    assert.equal(seen[0]!.includes(".."), false);
  }
});

test("the repository URL a cloud agent gets is the code host's web URL", () => {
  for (const [remoteUrl, url] of [
    ["git@github.com:org/repo.git", "https://github.com/org/repo"],
    ["ssh://git@github.com/org/repo.git", "https://github.com/org/repo"],
    ["ssh://git@git.example.com:2222/org/repo", "https://git.example.com/org/repo"],
    ["https://github.com/org/repo.git", "https://github.com/org/repo"],
    ["https://github.com/org/repo", "https://github.com/org/repo"],
    ["/srv/git/origin.git", "/srv/git/origin.git"],
  ] as const) {
    assert.equal(cloudRepoUrl(remoteUrl), url, remoteUrl);
  }
});
