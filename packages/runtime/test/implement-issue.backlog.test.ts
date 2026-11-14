// Seam: the Backlog module's two functions, `readBacklog` and `issuesWithRuns` (workflows/implement-issue/backlog.ts), over a
// throwaway per-user home: a runs index, event logs and job records written the way the runtime writes them. No forge CLI is run.
// What the dashboard makes of them (the HTTP reply, the forge fakes, the cache) is asserted in packages/dashboard/test/backlog.test.ts.
import "./isolate-home.js";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { registerRun } from "../src/runtime/runs-index.js";
import { issuesWithRuns, readBacklog } from "../workflows/implement-issue/backlog.js";

const root = mkdtempSync(join(tmpdir(), "wf-backlog-"));
after(() => rmSync(root, { recursive: true, force: true }));

let sequence = 0;
/** A repository folder of its own. */
const repoFolder = (): string => {
  const repo = join(root, `repo-${++sequence}`);
  mkdirSync(repo);
  return repo;
};

interface FixtureRun {
  workflow?: string;
  /** The job record's `start`: how the job was started. Left out, the run has a job whose record has no `start`. */
  start?: unknown;
  /** Write no job record at all, and no `jobId` in the log: a run of `wf run` in a terminal. */
  noJob?: boolean;
  /** The card's title. */
  card?: string;
  /** Leave the log out: the runs index names a run whose log is gone. */
  noLog?: boolean;
}

/** Registers a run of `repo` in the index and writes its log and job record. */
function run(repo: string, options: FixtureRun): void {
  const runId = `${options.workflow ?? "implement-issue"}-${String(++sequence).padStart(4, "0")}`;
  registerRun({ runId, repo, workflow: options.workflow ?? "implement-issue", startedAt: "2026-01-10T10:00:00.000Z" });
  if (options.noLog) return;
  const jobId = options.noJob ? undefined : `job${sequence}`;
  const line = (event: Record<string, unknown>) => JSON.stringify({ v: 1, ts: "2026-01-10T10:00:00.000Z", runId, ...event });
  const events = [line({ type: "run-start", workflow: options.workflow ?? "implement-issue", ...(jobId ? { jobId } : {}) }), ...(options.card === undefined ? [] : [line({ type: "card", title: options.card })])];
  mkdirSync(join(repo, ".workflows", "runs", runId), { recursive: true });
  writeFileSync(join(repo, ".workflows", "runs", runId, "events.jsonl"), `${events.join("\n")}\n`);
  if (jobId) {
    mkdirSync(join(repo, ".workflows", "jobs"), { recursive: true });
    writeFileSync(join(repo, ".workflows", "jobs", `${jobId}.json`), JSON.stringify({ jobId, runId, pid: 1, heartbeat: "2026-01-10T10:00:00.000Z", ...(options.start === undefined ? {} : { start: options.start }) }));
  }
}

test("a repository the runs index does not name is not read: the answer says it is unknown", async () => {
  const stranger = repoFolder();
  assert.deepEqual(await readBacklog(stranger), { kind: "failed", error: `unknown repository: ${stranger}` });
});

test("an issue has a run when a job was started for it with a whole-number issue and no other repository, or when the card of a run with no job names it", () => {
  const repo = repoFolder();
  run(repo, { start: { args: { issue: 4 } } });
  run(repo, { start: { args: { issue: "5" } } }); // not a number
  run(repo, { start: { args: { issue: 6.5 } } }); // not a whole number
  run(repo, { start: { args: { issue: 7, repo: "owner/elsewhere" } }, card: "#7 the other repository's issue" }); // another repository's issue 7, whatever the card says
  run(repo, { start: { args: "not an object" } });
  run(repo, { noJob: true, card: "#8 a run in a terminal" });
  run(repo, { noJob: true, card: "#9" });
  run(repo, { noJob: true, card: "#10x not an issue number" });
  run(repo, { noJob: true, card: "an issue, #11" });
  run(repo, { card: "#12 a job whose record says nothing of how it started" }); // an older kit's record: the card is all there is
  run(repo, { noLog: true });
  run(repo, { workflow: "smoke", start: { args: { issue: 13 } } });
  run(repoFolder(), { start: { args: { issue: 14 } } }); // another repository's run

  assert.deepEqual([...issuesWithRuns(repo)].sort((a, b) => a - b), [4, 8, 9, 12]);
});
