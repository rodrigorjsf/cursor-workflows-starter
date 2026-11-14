// Child process of frozen-cancel.process.test.ts: one execution of a job as `wf run --job` runs it (createJob + startJob: the job
// id is on this process's command line, and the process holds the run's lock). The workflow starts a `sleep` through `ctx.exec`
// and, when asked, another one that it spawns itself in its own process group, as the Cursor SDK's local agent spawns the shell
// commands of its tools. Each `sleep` has its pid written to a file once it runs, and the job stays in the `ctx.exec` until it is
// stopped.
// Usage: exec-job.ts <repo> <jobId> <runId> <pidDir> [detached]
process.env.WF_METRICS = "off";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createJob, installCrashHandlers, startJob } from "../src/runtime/jobs.js";
import { defineWorkflow } from "../src/runtime/workflow.js";

const [repo, jobId, runId, pidDir, mode] = process.argv.slice(2) as [string, string, string, string, string | undefined];
/** A shell that writes its own pid to the file named by its first argument and then becomes `sleep`: the pid in the file is the sleep's. */
const SLEEP = 'echo $$ > "$1"; exec sleep 600';

installCrashHandlers();
const holding = defineWorkflow({
  meta: { name: "exec-job", description: "a job that sits in a long ctx.exec" },
  run: async (ctx) => {
    if (mode === "detached") spawn("sh", ["-c", SLEEP, "sh", join(pidDir, "detached.pid")], { detached: true, stdio: "ignore" }).unref();
    await ctx.exec("sh", ["-c", SLEEP, "sh", join(pidDir, "exec.pid")], { timeoutMs: 30 * 60_000 });
    return { status: "done" };
  },
});
startJob(holding, {}, { cwd: repo }, createJob(repo, "exec-job", { runId, jobId }));
