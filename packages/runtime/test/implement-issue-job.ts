// Child process of implement-issue.cancel.process.test.ts: one execution of implement-issue on issue 7 as a job, the way
// `wf start` runs it (createJob + startJob: the run-start carries the job id, the job id is on this process's command line,
// and the process holds the run's lock). The red step writes a test that hangs, so the process is still in that write step
// when the parent freezes it (SIGSTOP) or kills it (SIGKILL).
// Usage: implement-issue-job.ts <repo> <jobId> <runId>
process.env.WF_METRICS = "off";
import { script } from "./fake-sdk.js";
import { cancelOnSignals, createJob, installCrashHandlers, startJob } from "../src/runtime/jobs.js";
import implementIssue from "../workflows/implement-issue.js";
import { PLAN, labelOf, submit, write } from "./implement-issue.fixture.js";

const [repo, jobId, runId, mode] = process.argv.slice(2) as [string, string, string, string | undefined];
const mainTree = mode === "main-tree";
const HANG = 'import { test } from "node:test";\ntest("subtract", async () => { await new Promise((r) => setTimeout(r, 4000)); throw new Error("red"); });\n';
const handlers: Record<string, (o: any) => unknown> = {
  plan: (o) => submit(o, PLAN),
  "test-1": (o) => {
    write(o, "test/sub.test.js", HANG);
    if (mainTree) return { hang: true };
    submit(o, { testFile: "test/sub.test.js", testName: "subtract" });
  },
};
for (let i = 0; i < 50; i++)
  script.push((o: any) => {
    const h = handlers[labelOf(o).replace(/:\d+$/, "")];
    if (!h) return { hang: true }; // the parent stops this process before any later step
    const held = h(o);
    return held && typeof held === "object" && "hang" in held ? held : { status: "finished", result: "ok" };
  });

installCrashHandlers();
startJob(implementIssue, { issue: 7, testCommand: "node --test", worktree: !mainTree } as any, { cwd: repo, signal: cancelOnSignals() }, createJob(repo, "implement-issue", { runId, jobId }));
