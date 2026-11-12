// Seam 1, the run, for a step that runs in the cloud: `runWorkflow` with the fake Cursor SDK in cloud mode, a temp repository
// and a temporary bare repository as its `origin`. The config files are written to disk; the assertions are on the outcome,
// the agent the SDK was asked for, the replayed event log and the git state of the worktree and of the remote.
process.env.WF_METRICS = "off";
import assert from "node:assert/strict";
import "./isolate-home.js";
import { rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { calls, costConfig, script, stats } from "@cursor/sdk";
import { runWorkflow } from "../src/runtime/engine.js";
import { eventLogPath, readEventLog } from "../src/runtime/run-store.js";
import { clearConfig, configWorkflow, runStartOf, writeGlobalConfig, writeRepoConfig } from "./config-fixtures.js";
import { git, remoteBranches, remoteFiles, repoWithRemote, worktreeState } from "./cloud-fixtures.js";

const root = join(import.meta.dirname, ".tmp", `cloud-${process.pid}`);
const cwd = join(root, "repo");
const remote = join(root, "origin.git");

beforeEach(() => repoWithRemote(cwd, remote));
afterEach(() => {
  clearConfig(cwd);
  rmSync(root, { recursive: true, force: true });
  script.length = 0;
  calls.length = 0;
  Object.assign(stats, { active: 0, maxActive: 0, disposed: 0, usageReads: 0, cancels: 0, cancelled: 0, turnsDelivered: 0, sends: 0 });
  Object.assign(costConfig, { raw: 9, charged: 7, getUsageError: undefined, createErrorCode: undefined });
});

const logOf = (runId: string) => readEventLog(eventLogPath(cwd, runId)).events;
/** The `cfg` workflow's roles: classify is `ok`, review is `read-only`, implement.low is `never`. */
const allowCloud = (roles: Record<string, unknown>, caps: Record<string, unknown> = { allowedLocations: ["local", "cloud"] }) =>
  writeGlobalConfig({ caps, workflows: { cfg: { roles } } });
const READ = ["read", "grep"] as const;

test("a read-only step of a role configured for the cloud runs as a cloud agent on a pushed snapshot of the worktree, uncommitted changes included, and the snapshot branch is deleted when the step ends", async () => {
  allowCloud({ review: { location: "cloud" } });
  // The worktree has three kinds of change that no commit holds: an edit, a new file and a deletion.
  writeFileSync(join(cwd, "a.txt"), "a, edited\n");
  writeFileSync(join(cwd, "new.txt"), "new\n");
  unlinkSync(join(cwd, "b.txt"));
  const before = worktreeState(cwd);

  let atSend: { branches: string[]; files: Record<string, string> } | undefined;
  script.push((o) => {
    const ref = o.cloud.repos[0].startingRef;
    atSend = { branches: remoteBranches(remote), files: remoteFiles(remote, ref) };
    return { result: "all good" };
  });
  const wf = configWorkflow((ctx) => ctx.agent<string>("look at it", { role: "review", label: "look", tools: [...READ] }));
  const r = await runWorkflow(wf, {}, { cwd });

  assert.equal(r.status, "finished", r.error);
  assert.equal(r.result, "all good");
  assert.equal(calls.length, 1);
  const [created] = calls;
  assert.deepEqual(created.cloud.repos, [{ url: remote, startingRef: created.cloud.repos[0].startingRef }]);
  assert.match(created.cloud.repos[0].startingRef, /^wf\/cloud-snapshot\//, "a throwaway branch under the workflow's prefix");
  assert.equal(created.cloud.autoCreatePR, false, "the workflow keeps delivery");
  assert.equal(created.name, "cfg:look");
  assert.deepEqual(created.model, { id: "grok-4.7", params: [{ id: "reasoning_effort", value: "high" }] });
  for (const never of ["tools", "disallowedTools", "local", "systemPrompt"]) assert.equal(never in created, false, `${never} is never sent to a cloud agent`);

  // While the agent ran, the remote had the snapshot: the commit's files plus the uncommitted changes.
  assert.deepEqual(atSend!.branches, [created.cloud.repos[0].startingRef]);
  assert.deepEqual(atSend!.files, { "a.txt": "a, edited\n", "new.txt": "new\n" });
  // When the step ended, it was gone, and the user's checkout was not touched.
  assert.deepEqual(remoteBranches(remote), []);
  assert.deepEqual(worktreeState(cwd), before);
  assert.equal(git(cwd, "status", "--porcelain").includes("a.txt"), true, "the edit is still uncommitted");
  assert.equal(stats.disposed, 1);

  const start = logOf(r.runId).find((e) => e.type === "step-start");
  assert.ok(start && start.type === "step-start");
  assert.equal(start.location, "cloud");
});

test("the snapshot goes to the remote the cloud.remote preference names (the origin by default), and a repo file may choose a fork", async () => {
  const fork = join(root, "fork.git");
  git(root, "init", "-q", "--bare", fork);
  git(cwd, "remote", "add", "fork", fork);
  const wf = configWorkflow((ctx) => ctx.agent<string>("look", { role: "review", label: "look", tools: [...READ] }));
  const where = async () => {
    const seen: { origin: string[]; fork: string[]; url?: string } = { origin: [], fork: [] };
    script.push((o) => {
      Object.assign(seen, { origin: remoteBranches(remote), fork: remoteBranches(fork), url: o.cloud.repos[0].url });
      return { result: "ok" };
    });
    const r = await runWorkflow(wf, {}, { cwd });
    assert.equal(r.status, "finished", r.error);
    return { seen, run: r };
  };

  writeGlobalConfig({ caps: { allowedLocations: ["local", "cloud"] }, workflows: { cfg: { roles: { review: { location: "cloud" } } } } });
  const byDefault = await where();
  assert.deepEqual([byDefault.seen.origin.length, byDefault.seen.fork.length, byDefault.seen.url], [1, 0, remote]);
  assert.deepEqual(runStartOf(logOf(byDefault.run.runId)).config.cloud, { remote: "origin" });

  writeGlobalConfig({ caps: { allowedLocations: ["local", "cloud"] }, cloud: { remote: "fork" }, workflows: { cfg: { roles: { review: { location: "cloud" } } } } });
  const global = await where();
  assert.deepEqual([global.seen.origin.length, global.seen.fork.length, global.seen.url], [0, 1, fork]);
  assert.deepEqual(runStartOf(logOf(global.run.runId)).provenance["/cloud/remote"], { layer: "global", ref: join(process.env.WF_HOME!, "config.json") });

  writeRepoConfig(cwd, { cloud: { remote: "origin" } });
  const repo = await where();
  assert.deepEqual([repo.seen.origin.length, repo.seen.fork.length], [1, 0], "the repo file wins over the global one");
  assert.equal(runStartOf(logOf(repo.run.runId)).provenance["/cloud/remote"]?.layer, "repo");
  assert.deepEqual([remoteBranches(remote), remoteBranches(fork)], [[], []], "every snapshot was deleted");
});

test("a remote that does not exist fails the step before any agent is created, naming the remote", async () => {
  writeGlobalConfig({ caps: { allowedLocations: ["local", "cloud"] }, cloud: { remote: "nowhere" }, workflows: { cfg: { roles: { review: { location: "cloud" } } } } });
  const wf = configWorkflow((ctx) => ctx.agent<string>("look", { role: "review", label: "look", tools: [...READ], retries: 0 }));
  const r = await runWorkflow(wf, {}, { cwd });
  assert.equal(r.status, "failed");
  assert.match(r.error!, /cloud snapshot: the remote "nowhere" does not exist/);
  assert.equal(calls.length, 0, "no cloud agent was created");
});

const VERDICT = { type: "object", required: ["verdict"], additionalProperties: false, properties: { verdict: { enum: ["pass", "fail"] }, notes: { type: "array", items: { type: "string" } } } };
const block = (json: string) => `\`\`\`json\n${json}\n\`\`\``;
type StepEnd = Extract<ReturnType<typeof logOf>[number], { type: "step-end" }>;
const stepEnds = (runId: string) => logOf(runId).filter((e): e is StepEnd => e.type === "step-end");

test("a structured cloud step takes its result from the final fenced JSON block; a wrong answer is corrected by follow-ups in the same conversation, within the step's schema retries", async () => {
  allowCloud({ review: { location: "cloud" } });
  const sent: string[] = [];
  const answer = (result: string) => (_o: unknown, msg: string) => {
    sent.push(msg);
    return { result };
  };
  script.push(
    answer(`Looks fine.\n\n${block('{"verdict": "maybe"}')}`), // not in the enum
    answer("Sorry, here it is in words: it passes."), // no block at all
    answer(`Draft:\n${block('{"verdict": "fail"}')}\nOn reflection:\n\n${block('{"verdict": "pass", "notes": ["a", "b"]}')}\n`), // the LAST block counts
  );
  const wf = configWorkflow((ctx) => ctx.agent<{ verdict: string; notes: string[] }>("review it", { role: "review", label: "review", tools: [...READ], schema: VERDICT }));
  const r = await runWorkflow(wf, {}, { cwd });

  assert.equal(r.status, "finished", r.error);
  assert.deepEqual(r.result, { verdict: "pass", notes: ["a", "b"] });
  assert.equal(calls.length, 1, "one cloud agent for the whole conversation");
  assert.equal(stats.sends, 3, "the prompt and two follow-ups");
  assert.ok(sent[0]!.startsWith("review it"), "the step's prompt comes first");
  assert.match(sent[0]!, /read-only step/, "the allowlist cannot be sent, so the prompt says it");
  assert.match(sent[0]!, /fenced code block labelled `json`/);
  assert.ok(sent[0]!.includes('"required": [\n    "verdict"\n  ]'), "the schema is in the prompt: a cloud agent has no tool to carry it");
  assert.match(sent[1]!, /must be equal to one of the allowed values/, "the follow-up carries the validation error");
  assert.match(sent[2]!, /there is no fenced json code block/);
  const [end] = stepEnds(r.runId);
  assert.equal(end!.ok, true);
  assert.equal(end!.schemaReprompts, 2);
  assert.equal(end!.agentId, "bc-1");
  assert.equal(remoteBranches(remote).length, 0);
});

test("a role whose resultVia is artifact has its structured result downloaded from the agent's artifacts after the run, and the step ends like any other", async () => {
  allowCloud({ review: { location: "cloud", resultVia: "artifact" } });
  const sent: string[] = [];
  script.push(
    (_o, msg) => (sent.push(msg), { result: "done", artifacts: { "result.json": '{"verdict": "maybe"}' } }), // not in the enum
    (_o, msg) => (sent.push(msg), { result: "fixed", artifacts: { "result.json": '{"verdict": "pass", "notes": ["a"]}' } }),
  );
  const wf = configWorkflow((ctx) => ctx.agent<{ verdict: string }>("review it", { role: "review", label: "review", tools: [...READ], schema: VERDICT }));
  const r = await runWorkflow(wf, {}, { cwd });

  assert.equal(r.status, "finished", r.error);
  assert.deepEqual(r.result, { verdict: "pass", notes: ["a"] });
  assert.match(sent[0]!, /save the structured result as the file `result\.json` in your artifacts directory/);
  assert.match(sent[1]!, /^The artifact result\.json did not hold a valid result: .*must be equal to one of the allowed values/);
  const [end] = stepEnds(r.runId);
  assert.deepEqual([end!.ok, end!.schemaReprompts, end!.location], [true, 1, "cloud"]);
  assert.deepEqual(remoteBranches(remote), []);
});

test("a cloud step that never delivers a valid block fails as a schema error once the follow-ups are used up", async () => {
  allowCloud({ review: { location: "cloud" } });
  const wf = configWorkflow((ctx) => ctx.agent<unknown>("review it", { role: "review", label: "review", tools: [...READ], schema: VERDICT, retries: 0, schemaRetries: 1 }));
  script.push(() => ({ result: block("{ not json") }), () => ({ result: block('{"verdict": "pass", "extra": 1}') }));
  const r = await runWorkflow(wf, {}, { cwd });

  assert.equal(r.status, "failed");
  assert.match(r.error!, /the agent did not end with a valid JSON block \(data must NOT have additional properties\)/);
  assert.equal(stats.sends, 2, "the prompt and one follow-up, as the step allows");
  const [end] = stepEnds(r.runId);
  assert.deepEqual([end!.ok, end!.errorKind, end!.schemaReprompts], [false, "schema", 1]);
  assert.deepEqual(remoteBranches(remote), [], "the snapshot is deleted on a failed step too");
});

const warningsOf = (runId: string) => logOf(runId).filter((e) => e.type === "warning").map((e) => (e as { message: string }).message);

test("a cloud step warns that setting sources are ignored, and sends no setting sources, no tools and no guard server", async () => {
  allowCloud({ classify: { location: "cloud" } });
  const wf = configWorkflow((ctx) => ctx.agent<string>("look", { role: "classify", label: "look", tools: [...READ], mcpServers: { docs: { command: "docs-server" } as never } }));
  const r = await runWorkflow(wf, {}, { cwd, settingSources: ["project", "team"] });

  assert.equal(r.status, "finished", r.error);
  assert.ok(warningsOf(r.runId).includes('step "look": cloud agents ignore setting sources (requested: project, team): the VM loads the project, team and plugin settings it always loads'));
  const [created] = calls;
  assert.equal(created.local, undefined, "no setting sources reach the cloud agent");
  assert.deepEqual(created.mcpServers, { docs: { command: "docs-server" } }, "the step's own MCP servers go; the local nested-workflow guard (a command of this machine) does not");
});

test("memo is skipped for a cloud step: it says so, writes nothing and asks the cloud agent again on the next run", async () => {
  allowCloud({ review: { location: "cloud" } });
  const wf = configWorkflow((ctx) => ctx.agent<string>("look", { role: "review", label: "look", tools: [...READ], memo: true }));
  const first = await runWorkflow(wf, {}, { cwd });
  const second = await runWorkflow(wf, {}, { cwd });

  assert.deepEqual([first.status, second.status], ["finished", "finished"]);
  assert.equal(calls.length, 2, "the second run did not find a memo");
  for (const run of [first, second]) {
    assert.ok(warningsOf(run.runId).includes('step "look": memo skipped (cloud steps are not memoized)'), "said in the log");
    assert.equal(logOf(run.runId).some((e) => e.type === "step-start" && e.cached === "memo"), false);
  }
});

test("a cloud step's tokens and cost come from the agent's usage and count against the caps", async () => {
  allowCloud({ review: { location: "cloud" } });
  const twoSteps = (maxCents: number | null, maxTokens: number | null) =>
    runWorkflow(
      configWorkflow(async (ctx) => {
        await ctx.agent("one", { role: "review", label: "one", tools: [...READ] });
        await ctx.agent("two", { role: "review", label: "two", tools: [...READ] });
      }),
      {},
      { cwd, maxCents, maxTokens },
    );

  const counted = await runWorkflow(configWorkflow((ctx) => ctx.agent("one", { role: "review", label: "one", tools: [...READ] })), {}, { cwd });
  assert.equal(counted.status, "finished", counted.error);
  assert.deepEqual([counted.spentCents, counted.chargedCents, counted.spentTokens], [9, 7, 110], "the larger of raw and charged counts; the tokens are the agent's");
  assert.ok(stats.usageReads >= 1, "read from the agent's usage");
  const [end] = stepEnds(counted.runId);
  assert.deepEqual([end!.chargedCents, end!.rawCents, end!.usage?.totalTokens, end!.costFinal, end!.location], [7, 9, 110, true, "cloud"]);

  const byCents = await twoSteps(5, null);
  assert.equal(byCents.status, "failed");
  assert.match(byCents.error!, /Cost cap reached: 9¢ of 5¢/, "the first cloud step used the cents cap up");
  assert.equal(calls.length, 2, "the first cloud step ran (one earlier call, one now), the second never started");

  const byTokens = await twoSteps(null, 100);
  assert.equal(byTokens.status, "failed");
  assert.match(byTokens.error!, /Token cap reached/);
});

test("a role the global caps do not let into the cloud runs locally: nothing is pushed and the SDK is asked for a local agent", async () => {
  writeGlobalConfig({ workflows: { cfg: { roles: { review: { location: "cloud" } } } } }); // no allowedLocations: local only
  let sawBranch: string[] | undefined;
  script.push(() => {
    sawBranch = remoteBranches(remote);
    return { result: "ok" };
  });
  const r = await runWorkflow(configWorkflow((ctx) => ctx.agent<string>("look", { role: "review", label: "look", tools: [...READ] })), {}, { cwd });

  assert.equal(r.status, "finished", r.error);
  assert.equal(calls[0].cloud, undefined);
  assert.equal(calls[0].local.cwd, cwd);
  assert.deepEqual(sawBranch, []);
  const events = logOf(r.runId);
  assert.equal(events.find((e) => e.type === "run-start" && e.violations.length === 1) !== undefined, true, "the request is a violation in the log");
  assert.equal(events.find((e) => e.type === "step-start" && e.location === "local") !== undefined, true);
});

test("a step that can write is refused before it spends anything on a role the workflow declares read-only", async () => {
  allowCloud({ review: { location: "cloud" } });
  // No `tools`: the default toolset can edit files. `edit` listed: the same.
  for (const tools of [undefined, ["read", "edit"]]) {
    const r = await runWorkflow(configWorkflow((ctx) => ctx.agent("go", { role: "review", label: "go", tools: tools as never, retries: 0 })), {}, { cwd });
    assert.equal(r.status, "failed");
    assert.match(r.error!, /role "review" is declared cloud: read-only by workflow cfg, but this step can write/);
  }
  assert.equal(calls.length, 0, "no agent was created");
  assert.deepEqual(remoteBranches(remote), [], "and nothing was pushed");
});

test("the snapshot is of the step's own worktree, a linked one included, and not of the main checkout", async () => {
  allowCloud({ review: { location: "cloud" } });
  const linked = join(root, "linked");
  git(cwd, "worktree", "add", "-q", "-b", "feature", linked);
  writeFileSync(join(linked, "only-here.txt"), "linked\n");
  writeFileSync(join(cwd, "only-main.txt"), "main\n");
  let files: Record<string, string> | undefined;
  script.push((o) => {
    files = remoteFiles(remote, o.cloud.repos[0].startingRef);
    return { result: "ok" };
  });
  const r = await runWorkflow(configWorkflow((ctx) => ctx.agent("look", { role: "review", label: "look", tools: [...READ], cwd: linked })), {}, { cwd });

  assert.equal(r.status, "finished", r.error);
  assert.deepEqual(Object.keys(files!).sort(), ["a.txt", "b.txt", "only-here.txt"]);
  assert.deepEqual(remoteBranches(remote), []);
  assert.equal(git(linked, "status", "--porcelain").trim(), "?? only-here.txt", "the linked worktree is as it was");
});

/** The workflow of one read-only cloud step on the `review` role. */
const reviewStep = (extra: Record<string, unknown> = {}) => configWorkflow((ctx) => ctx.agent<string>("look", { role: "review", label: "look", tools: [...READ], retries: 0, ...extra }));

test("the snapshot branch is deleted when the step ends any way it ends: cancelled, timed out, refused by the account, or errored", async () => {
  allowCloud({ review: { location: "cloud" } });
  // A step whose timeout fires before its agent has a message (a loaded machine is slow to push) never consumes its entry of the
  // script: each case starts from an empty one, so that an entry left over cannot be the answer of the next case's agent.
  const alone = () => void (script.length = 0);

  // Cancelled: the run's signal aborts while the cloud agent is running, so its run is cancelled before the branch goes.
  const controller = new AbortController();
  script.push(() => {
    controller.abort();
    return { hang: true };
  });
  const cancelled = await runWorkflow(reviewStep(), {}, { cwd, signal: controller.signal });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(stats.cancelled, 1, "the cloud run was cancelled and waited for");
  assert.deepEqual(remoteBranches(remote), []);

  // Timed out (long enough for the agent to have its message even on a loaded machine; short enough to be quick).
  alone();
  script.push(() => ({ hang: true }));
  const timedOut = await runWorkflow(reviewStep({ timeoutMs: 1500 }), {}, { cwd });
  assert.equal(timedOut.status, "failed");
  assert.match(timedOut.error!, /timeout after 1500 ms/);
  assert.deepEqual(remoteBranches(remote), []);

  // The cloud run itself ended in error.
  alone();
  script.push(() => ({ status: "error", error: { message: "the VM died" } }));
  const errored = await runWorkflow(reviewStep(), {}, { cwd });
  assert.equal(errored.status, "failed");
  assert.match(errored.error!, /run error: the VM died/);
  assert.deepEqual(remoteBranches(remote), []);

  // The account has no cloud agents: the agent is never created, and that ends the run.
  costConfig.createErrorCode = "plan_required";
  const refused = await runWorkflow(reviewStep(), {}, { cwd });
  assert.equal(refused.status, "failed");
  assert.match(refused.error!, /plan does not give access/);
  assert.deepEqual(remoteBranches(remote), []);
  assert.equal(stats.active, 0, "no agent is left running");
});

test("a timeout that arrives while the snapshot is being pushed still leaves no branch on the remote, even though the remote accepts the push after the client gave up", async () => {
  allowCloud({ review: { location: "cloud" } });
  // A remote that takes its time over a push: the step's timeout fires while the push is in flight. (A loaded machine does the same to a fast remote.)
  writeFileSync(join(remote, "hooks", "pre-receive"), "#!/bin/sh\nsleep 0.6\n", { mode: 0o755 });
  script.push(() => ({ result: "never asked" }));
  const r = await runWorkflow(reviewStep({ timeoutMs: 200 }), {}, { cwd });

  assert.equal(r.status, "failed");
  assert.match(r.error!, /timeout after 200 ms/);
  assert.equal(calls.length, 0, "the agent was never created: the step ended with the push");
  await new Promise((resolve) => setTimeout(resolve, 1500)); // a push the client gave up on is still accepted by the remote
  assert.deepEqual(remoteBranches(remote), [], "the branch the push created is gone");
});

test("a snapshot branch the remote will not delete is reported with its name, and the step still delivers", async () => {
  allowCloud({ review: { location: "cloud" } });
  git(remote, "config", "receive.denyDeletes", "true");
  const r = await runWorkflow(reviewStep(), {}, { cwd });

  assert.equal(r.status, "finished", r.error);
  const [left] = remoteBranches(remote);
  assert.match(left!, /^wf\/cloud-snapshot\//);
  assert.ok(warningsOf(r.runId).some((w) => w.includes(`could not delete the snapshot branch ${left} from origin`) && w.endsWith("delete it by hand")), warningsOf(r.runId).join("\n"));
});
