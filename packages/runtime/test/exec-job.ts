// Child process of frozen-cancel.process.test.ts: one execution of a job as `wf run --job` runs it (createJob + startJob: the job
// id is on this process's command line, and the process holds the run's lock). The workflow starts a `sleep` through `ctx.exec`
// and, when asked, another one that it spawns itself, as the Cursor SDK's local agent spawns the shell commands of its tools
// (`detached`: in a process group of its own) and its MCP servers (`grouped`: in the job's group). Each `sleep` has its pid written
// to a file once it runs (sleeper.ts), and the job stays in the `ctx.exec` until it is stopped.
// Usage: exec-job.ts <repo> <jobId> <runId> <pidDir> [detached|grouped]
process.env.WF_METRICS = "off";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createJob, startJob } from "../src/runtime/jobs.js";
import { installCrashHandlers } from "../src/runtime/run-store.js";
import { defineWorkflow } from "../src/runtime/workflow.js";
import { sleepArgs } from "./sleeper.js";

const [repo, jobId, runId, pidDir, mode] = process.argv.slice(2) as [string, string, string, string, "detached" | "grouped" | undefined];

installCrashHandlers();
const holding = defineWorkflow({
  meta: { name: "exec-job", description: "a job that sits in a long ctx.exec" },
  run: async (ctx) => {
    if (mode) spawn("sh", sleepArgs(join(pidDir, "other.pid")), { detached: mode === "detached", stdio: "ignore" }).unref();
    await ctx.exec("sh", sleepArgs(join(pidDir, "exec.pid")), { timeoutMs: 30 * 60_000 });
    return { status: "done" };
  },
});
startJob(holding, {}, { cwd: repo }, createJob(repo, "exec-job", { runId, jobId }));
