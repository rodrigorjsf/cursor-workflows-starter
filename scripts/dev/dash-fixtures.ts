// WHAT: Builds a scratch WF_HOME with fixture runs made by the real engine and the fake Cursor SDK: a finished run with
// phases, parallel groups, cards and a cloud step; a failed run; a cancelled run; an interrupted run (its process killed
// mid-step); and, with --live, a running exec-only job. Prints a JSON manifest (home, repo, run ids) on stdout.
// WHY: Every dashboard review needs runs in every state to look at. Rebuilding them by hand each time costs a session
// hundreds of thousands of tokens and drifts from what the engine really writes.
// WHEN: Before looking at the dashboard (by eye or with scripts/dev/dash-shots.py), after changing the Run view, the
// Board, the Runs table, the Metrics page or the events the engine writes.
// HOW: `npx tsx scripts/dev/dash-fixtures.ts [--home <new-dir>] [--live]`, then
// `WF_HOME=<home> WF_DASH_PORT=<port> npm run dash`. It never touches ~/.cursor-workflows and never calls the Cursor
// API: it re-runs itself under the fake SDK and refuses to run without it. A --live job sleeps 10 minutes; stop it with
// the dashboard's Cancel button or `WF_HOME=<home> npm run wf -- cancel <jobId> --cwd <repo>`.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

const ROOT = resolve(import.meta.dirname, "..", "..");
const RUNTIME = join(ROOT, "packages", "runtime");
const FAKE_SDK_TSCONFIG = join(RUNTIME, "tsconfig.test.json");
const SELF = import.meta.filename;

const { values } = parseArgs({
  options: {
    home: { type: "string" },
    live: { type: "boolean", default: false },
    child: { type: "string" }, // internal: the process the interrupted run is killed in
  },
});

// 1. The fake SDK, always. tsx reads TSX_TSCONFIG_PATH, and the tsconfig maps `@cursor/sdk` to test/fake-sdk.ts. The
// variable is inherited, so the job and child processes this script starts get the fake too.
if (resolve(process.env.TSX_TSCONFIG_PATH ?? "") !== FAKE_SDK_TSCONFIG) {
  if (process.env.WF_DASH_FIXTURES_REEXEC) fail(`TSX_TSCONFIG_PATH is not ${FAKE_SDK_TSCONFIG}`);
  const again = spawnSync(process.execPath, [...process.execArgv, SELF, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, TSX_TSCONFIG_PATH: FAKE_SDK_TSCONFIG, WF_DASH_FIXTURES_REEXEC: "1" },
  });
  process.exit(again.status ?? 1);
}

function fail(message: string): never {
  process.stderr.write(`dash-fixtures: ${message}\n`);
  process.exit(2);
}

// The Metrics page reads the metrics database, which the engine writes with node:sqlite (Node 22.13 and later).
await import("node:sqlite").catch(() => fail(`Node ${process.version} has no node:sqlite: the runs would leave the Metrics page empty (use Node 22.13 or later)`));

// 2. The home: a new directory, never the user's own. Set before the runtime is imported.
const home = values.home ? resolve(values.home) : mkdtempSync(join(tmpdir(), "wf-dash-fixtures-"));
const real = (path: string) => (existsSync(path) ? realpathSync(path) : resolve(path));
const kitHome = real(join(homedir(), ".cursor-workflows"));
if (real(home) === real(homedir()) || real(home) === kitHome || real(home).startsWith(`${kitHome}${sep}`)) fail(`refusing to write fixtures into ${home}`);
if (!values.child && existsSync(home) && readdirSync(home).length > 0) fail(`${home} is not empty: give a new directory`);
mkdirSync(home, { recursive: true });
process.env.WF_HOME = home;
process.env.WF_METRICS_DB = join(home, "metrics.db");
process.env.WF_DASH_AUTOSTART = "off";
delete process.env.WF_METRICS;
const repo = join(home, "repos", "web-app");
const workflowsDir = join(home, "workflows");

// Dynamic imports with computed paths: the root typecheck checks this file against the real SDK, and must not follow
// these modules into the fake one.
const load = (path: string): Promise<any> => import(join(RUNTIME, path));
// The engine first: the fake marks itself loaded, so the flag says which SDK the engine got. Then the same fake module,
// for its `script`.
const { runWorkflow } = await load("src/runtime/engine.ts");
if ((globalThis as { __fakeSdkLoaded?: boolean }).__fakeSdkLoaded !== true) fail("the engine did not load the fake SDK");
const sdk = await load("test/fake-sdk.ts");

// 3. What every agent step answers: a few sentences, a tool call and a turn's usage. `[fake:hang]` in the prompt makes a
// step that never ends (for the cancelled and the interrupted runs). The fake takes one entry per send, in any order.
const usage = { inputTokens: 18400, outputTokens: 2200, cacheReadTokens: 12000, cacheWriteTokens: 800 };
const answer = (_o: unknown, msg: string, n: number) =>
  msg.includes("[fake:hang]")
    ? { hang: true }
    : {
        result: "done",
        deltas: [
          { type: "text-delta", text: `I read src/theme.ts and the settings page. The toggle reads the stored preference first, then prefers-color-scheme (note ${n}).` },
          { type: "tool-call-started", callId: "c1", modelCallId: "m1", toolCall: { type: "read", args: { path: "src/theme.ts" } } },
          { type: "step-completed", stepId: 1 },
          { type: "turn-ended", usage },
        ],
      };
const refill = () => {
  sdk.script.length = 0;
  for (let i = 0; i < 50; i++) sdk.script.push(answer);
};

type Mode = "finished" | "failed" | "cancelled" | "interrupted";
const ISSUES: Record<Mode, [number, string]> = {
  finished: [128, "Add a dark mode toggle to the settings page"],
  failed: [131, "Paginate the audit log API"],
  cancelled: [136, "Rate-limit the login endpoint"],
  interrupted: [140, "Migrate the session store to Redis"],
};
/** The label of the step a cancelled or interrupted run stops in. */
const STOP_LABEL = "implement-api";
/** The node a Run view capture focuses on, per run: the cloud step, the failing command, the step the run stopped in. */
const FOCUS: Record<Mode, string> = { finished: "review", failed: "npm test", cancelled: STOP_LABEL, interrupted: STOP_LABEL };

/**
 * An `onEvent` that calls `ready` once the run is stopped in the hung step and nothing else is in flight: the step started,
 * and its siblings in the group (the lint command, the UI pipeline) have ended. Every build then stops in the same place.
 */
function whenOnlyHangLeft(ready: (runId: string) => void): (e: any) => void {
  const seen = new Set<string>();
  let fired = false;
  return (e) => {
    if (e.type === "step-start" && e.label === STOP_LABEL) seen.add("hang");
    if (e.type === "exec-end" && e.label === "lint") seen.add("lint");
    if (e.type === "step-end" && e.label === "ui-tests") seen.add("ui");
    if (!fired && seen.size === 3) {
      fired = true;
      ready(e.runId);
    }
  };
}

/** An implement-issue-like workflow: five phases, a card, a parallel group with a pipeline in it, commands, a cloud review. */
function shipFeature(mode: Mode) {
  const [n, title] = ISSUES[mode];
  const card = { title: `#${n} ${title}`, subtitle: `wf/${n}-branch`, badges: ["tier: medium", "frontend"] };
  const node = (code: string) => ["node", ["-e", code]] as const;
  return {
    meta: {
      name: "ship-feature",
      description: "Dashboard fixture: the shape of implement-issue.",
      phases: [{ title: "Triage" }, { title: "Plan" }, { title: "Build" }, { title: "Review" }, { title: "Deliver" }],
      roles: [
        { name: "work", cloud: "ok", defaults: { model: { id: "composer-2.5" } } },
        { name: "review", cloud: "read-only", defaults: { model: { id: "grok-4.7" }, settingSources: [] } },
      ],
    },
    defaults: { model: { id: "composer-2.5" }, retries: 0 },
    async run(ctx: any) {
      ctx.phase("Triage");
      await ctx.agent("Triage the issue", { label: "triage", role: "work" });
      ctx.card(card);
      ctx.phase("Plan");
      await ctx.agent("Plan the change", { label: "plan", role: "work" });
      ctx.phase("Build");
      const stops = mode === "cancelled" || mode === "interrupted";
      await ctx.parallel([
        async () => {
          await ctx.agent("Implement the UI", { label: "implement-ui", role: "work" });
          await ctx.agent("Write the UI tests", { label: "ui-tests", role: "work" });
        },
        () => ctx.agent(`Implement the API${stops ? " [fake:hang]" : ""}`, { label: STOP_LABEL, role: "work", timeoutMs: 30 * 60_000 }),
        () => ctx.exec(...node("console.log('lint ok: 214 files')"), { label: "lint" }),
      ]);
      const tests = await ctx.exec(
        ...node(mode === "failed" ? "console.log('running 42 specs');console.error('FAIL packages/api/audit.test.ts\\n  expected 50 rows, got 0');process.exit(1)" : "console.log('42 passed')"),
        { label: "npm test" },
      );
      if (!tests.ok) throw new Error(`tests failed: 1 of 42 specs failed (exit ${tests.exitCode})`);
      ctx.phase("Review");
      await ctx.agent("Review the diff", { label: "review", role: "review", tools: ["read", "grep"] }); // a cloud step (config.json)
      ctx.phase("Deliver");
      await ctx.exec("git", ["status", "--short"], { label: "push" });
      ctx.card({ ...card, links: [{ label: "PR #48", url: "https://github.com/example/web-app/pull/48" }] });
      return "delivered";
    },
  };
}

/** Runs the fixture workflow in this process; `onEvent` sees its events. */
async function runShip(mode: Mode, opts: { signal?: AbortSignal; onEvent?: (e: any) => void } = {}): Promise<{ runId: string; status: string }> {
  refill();
  return runWorkflow(shipFeature(mode), {}, { cwd: repo, ...opts });
}

// The interrupted run's process: it starts the run, says so when the step that never ends starts, and waits to be killed.
if (values.child === "interrupted") {
  await runShip("interrupted", { onEvent: whenOnlyHangLeft((runId) => process.stdout.write(`started ${runId}\n`)) });
  process.exit(0);
}

// 4. The repository the runs execute in, with an origin (a cloud step snapshots the worktree to it), and the config that
// sends the review role to the cloud.
const { repoWithRemote } = await load("test/cloud-fixtures.ts");
repoWithRemote(repo, join(home, "repos", "origin.git"));
writeFileSync(
  join(home, "config.json"),
  JSON.stringify({ caps: { allowedLocations: ["local", "cloud"] }, workflows: { "ship-feature": { roles: { review: { location: "cloud" } } } } }, null, 2),
);

const finished = await runShip("finished");
const failed = await runShip("failed");

const abort = new AbortController();
const cancelled = await runShip("cancelled", {
  signal: abort.signal,
  onEvent: whenOnlyHangLeft(() => abort.abort()),
});

const interrupted = await new Promise<string>((done, reject) => {
  const child = spawn(process.execPath, [...process.execArgv, SELF, "--home", home, "--child", "interrupted"], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => {
    out += chunk;
    const started = /started (\S+)/.exec(out);
    if (!started) return;
    child.kill("SIGKILL"); // no run-end, no lock release: the run's process is simply gone
    child.once("exit", () => done(started[1]!));
  });
  child.once("exit", (code) => !/started/.test(out) && reject(new Error(`the interrupted run's process exited (${code}) before its step started`)));
});

// 5. Optional: a live run, as a real detached job that only sleeps (no agent step, so nothing could reach the SDK).
let live: { runId: string; jobId: string; pid: number } | undefined;
if (values.live) {
  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(
    join(workflowsDir, "sleeper.ts"),
    `// Dashboard fixture: an exec-only workflow that stays running for 10 minutes.
export default {
  meta: { name: "sleeper", description: "Dashboard fixture: sleeps.", phases: [{ title: "Setup" }, { title: "Wait" }], argsSchema: { type: "object", properties: {} } },
  defaults: { model: { id: "composer-2.5" } },
  async run(ctx: any) {
    ctx.phase("Setup");
    await ctx.exec("echo", ["preparing"], { label: "prepare" });
    ctx.phase("Wait");
    await ctx.exec("sleep", ["600"], { label: "sleep 600", timeoutMs: 700_000 });
    return "ok";
  },
};
`,
  );
  process.env.WORKFLOWS_DIR = workflowsDir;
  const { spawnJob } = await load("src/runtime/jobs.ts");
  const { job } = spawnJob({ cwd: repo, workflow: "sleeper", args: {} });
  live = { runId: job.runId, jobId: job.jobId, pid: job.pid };
}

// 6. Check what the dashboard will read, through the runtime's own read side, before saying the fixtures are there.
const { readRun } = await load("src/runtime/run-view.ts");
const expected: Array<[string, string, string]> = [
  ["finished", finished.runId, "finished"],
  ["failed", failed.runId, "failed"],
  ["cancelled", cancelled.runId, "cancelled"],
  ["interrupted", interrupted, "failed"], // a run whose process died shows as failed, with its steps interrupted
];
for (const [name, runId, status] of expected) {
  const seen = readRun(runId)?.status;
  if (seen !== status) fail(`the ${name} run ${runId} is "${seen}", expected "${status}"`);
}

const manifest = {
  home,
  repo,
  runs: { finished: finished.runId, failed: failed.runId, cancelled: cancelled.runId, interrupted, ...(live && { live: live.runId }) },
  cloudStep: { runId: finished.runId, label: "review" },
  focus: FOCUS,
  ...(live && { liveJob: { jobId: live.jobId, pid: live.pid, cancel: `WF_HOME=${home} npm run wf -- cancel ${live.jobId} --cwd ${repo}` } }),
  dashboard: `WF_HOME=${home} WF_DASH_PORT=4399 npm run dash`,
};
writeFileSync(join(home, "fixtures.json"), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
