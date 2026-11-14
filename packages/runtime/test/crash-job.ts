// Child process of job-state.test.ts: starts a job whose only step never ends, then dies of an uncaught exception.
// Usage: crash-job.ts <cwd> <jobId> <runId>
process.env.WF_METRICS = "off";
import { script } from "./fake-sdk.js";
import { defineWorkflow } from "../src/runtime/workflow.js";
import { createJob, installCrashHandlers, startJob } from "../src/runtime/jobs.js";

const [cwd, jobId, runId] = process.argv.slice(2) as [string, string, string];
installCrashHandlers();
script.push(() => ({ hang: true }));
const held = defineWorkflow({
  meta: { name: "crashing", description: "a run whose process crashes" },
  defaults: { model: { id: "m" } },
  run: (ctx) => ctx.agent("hold", { label: "hold", retries: 0, timeoutMs: 10 * 60_000 }),
});
startJob(held, {}, { cwd, onEvent: (e) => e.type === "step-start" && setTimeout(() => { throw new Error("boom"); }, 0) }, createJob(cwd, "crashing", { runId, jobId }));
