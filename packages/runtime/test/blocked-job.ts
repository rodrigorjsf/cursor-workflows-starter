// Child process of heartbeat.test.ts: starts a job whose workflow blocks the whole main thread for 3 s (like a
// synchronous test run does), says so on stdout, and then finishes.
// Usage: blocked-job.ts <cwd> <jobId> <runId>
process.env.WF_METRICS = "off";
import { createJob, installCrashHandlers, startJob } from "../src/runtime/jobs.js";
import { defineWorkflow } from "../src/runtime/workflow.js";

const [cwd, jobId, runId] = process.argv.slice(2) as [string, string, string];
installCrashHandlers();
const blocking = defineWorkflow({
  meta: { name: "blocking", description: "blocks the main thread" },
  run: async () => {
    process.stdout.write("blocking\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
    return { status: "done" };
  },
});
const { done } = startJob(blocking, {}, { cwd }, createJob(cwd, "blocking", { runId, jobId }));
await done;
process.stdout.write("done\n");
